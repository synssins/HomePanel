"""Daedalus Workshop server.

One process, one port. It does four jobs:
  1. Tablets: say hello, wait for approval, fetch their design, hear about changes (/api/...).
  2. Home Assistant relay: tablets talk to HA through here, so they hold a tablet key, never an HA token.
  3. Studio: the page in the HA sidebar, plus its admin API (/admin/...), reachable only through HA.
  4. mDNS: advertises _daedalus._tcp so tablets find the server by themselves.

Runs as an HA add-on (Supervisor gives the HA connection) or standalone for development:
    HA_URL=http://ha:8123 HA_TOKEN=... python -m server
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import os
import re
import socket
import time
from pathlib import Path

from aiohttp import ClientSession, WSMsgType, web

from .scenes import capture, lights_of
from .store import Store

log = logging.getLogger("daedalus")
ROOT = Path(__file__).resolve().parents[1]
PORT = int(os.environ.get("DAEDALUS_PORT", "8722"))
DATA = Path(os.environ.get("DAEDALUS_DATA", "/data" if Path("/data").is_dir() else ROOT / "data"))
# Renderer files: shipped inside the add-on image, or the repo's web/ folder in development.
# The repo's web/ wins when it is there (development); the add-on image only has the copy in renderer/.
RENDERER = next(p for p in (ROOT.parent / "web", ROOT / "renderer") if p.is_dir())

SUPERVISOR_TOKEN = os.environ.get("SUPERVISOR_TOKEN")
if SUPERVISOR_TOKEN:
    HA_HTTP, HA_WS, HA_TOKEN = "http://supervisor/core/api", "ws://supervisor/core/websocket", SUPERVISOR_TOKEN
else:
    _u = os.environ.get("HA_URL", "http://homeassistant.local:8123").rstrip("/")
    HA_HTTP, HA_WS, HA_TOKEN = _u + "/api", _u.replace("http", "ws", 1) + "/api/websocket", os.environ.get("HA_TOKEN", "")

# The Studio and its admin API are for the HA sidebar only. Requests through HA ingress arrive from the
# Supervisor's address; in development they arrive from this machine. Tablets on the LAN get 403.
ADMIN_PEERS = {"172.30.32.2", "127.0.0.1", "::1"}
PREVIEW_KEY = "studio-preview"  # the Studio's own preview pane; honoured only from an admin peer


def is_admin(request: web.Request) -> bool:
    return request.remote in ADMIN_PEERS


def tablet_for(request: web.Request, key: str | None = None) -> dict | None:
    store: Store = request.app["store"]
    if key is None:
        auth = request.headers.get("Authorization", "")
        key = auth[7:] if auth.startswith("Bearer ") else request.query.get("key")
    if key == PREVIEW_KEY and is_admin(request):
        return {"id": "preview", "name": "Preview", "design": request.query.get("design"), "start_page": None}
    return store.tablet_by_key(key)


@web.middleware
async def guard(request: web.Request, handler):
    if request.path.startswith("/admin") and not is_admin(request):
        raise web.HTTPForbidden(text="Studio is only reachable through Home Assistant")
    if request.method == "OPTIONS":  # the tablet app is a bundled page, so every call is cross-origin
        resp = web.Response()
    else:
        try:
            resp = await handler(request)
        except web.HTTPException as e:
            resp = e
    if not isinstance(resp, web.WebSocketResponse):
        if request.path.startswith(("/admin/studio", "/renderer")):
            # Always revalidate, so an updated add-on is never shown with a stale script from the browser cache.
            resp.headers["Cache-Control"] = "no-cache"
        resp.headers["Access-Control-Allow-Origin"] = "*"
        resp.headers["Access-Control-Allow-Headers"] = "Authorization, Content-Type"
        resp.headers["Access-Control-Allow-Methods"] = "GET, POST, PUT, PATCH, DELETE, OPTIONS"
    return resp


# ---------------------------------------------------------------- tablets
async def hello(request: web.Request):
    try:
        t = request.app["store"].hello(await request.json())
    except (ValueError, json.JSONDecodeError) as e:
        raise web.HTTPBadRequest(text=str(e))
    await notify_admins(request.app)
    # shortcut: the tablet id doubles as its claim to the key (ids are random per device and LAN-only);
    # move to a pairing code shown on the tablet if panels are ever exposed beyond the home network.
    return web.json_response({"status": t["status"], "name": t["name"], "key": t["key"] if t["status"] == "approved" else None})


def build_engine() -> dict:
    """The tablet's drawing engine as one self-contained page: engine.html with its stylesheet and scripts
    written into it. Tablets fetch it, keep it and run their own copy, so updating the add-on updates them."""
    def read(name: str) -> str | None:
        f = RENDERER / name
        return f.read_text(encoding="utf-8") if f.is_file() else None

    def style(m):
        text = read(m.group(1))
        return f"<style>\n{text}\n</style>" if text is not None else ""

    def script(m):
        text = read(m.group(1))
        if text is None:  # design.js exists only inside the app, as its built-in fallback
            return ""
        return "<script>\n" + text.replace("</script", "<\\/script") + f"\n//# sourceURL={m.group(1)}\n</script>"

    html = read("engine.html") or ""
    html = re.sub(r'<link rel="stylesheet" href="([^"]+)">', style, html)
    html = re.sub(r'<script src="([^"]+)"></script>', script, html)
    return {"version": hashlib.sha1(html.encode()).hexdigest()[:12], "html": html}


async def tablet_engine(request: web.Request):
    eng = request.app["engine"]
    if request.query.get("have") == eng["version"]:
        return web.Response(status=204)
    return web.json_response(eng)


# Wake words are recognised on the tablet. It needs a small runtime and the model files; they are fetched from
# their publishers the first time a tablet asks and kept in the data folder. Custom words are read from the
# folder Home Assistant's own openWakeWord uses.
WAKE_DIR = DATA / "wake"
WAKE_CUSTOM = Path("/share/openwakeword")
_TFLITE_WEB = "https://cdn.jsdelivr.net/npm/@tensorflow/tfjs-tflite@0.0.1-alpha.10/wasm/"
_OWW = "https://raw.githubusercontent.com/rhasspy/pyopen-wakeword/6bc5c5f5c9c71e46a723b6c9277b1d50f2ba13fd/pyopen_wakeword/models/"
WAKE_SOURCES = {n: _TFLITE_WEB + n for n in ("tflite_web_api_client.js", "tflite_web_api_cc.js", "tflite_web_api_cc.wasm",
                                             "tflite_web_api_cc_simd.js", "tflite_web_api_cc_simd.wasm")}
WAKE_SOURCES.update({n + ".tflite": _OWW + n + ".tflite" for n in ("embedding_model", "okay_nabu", "hey_jarvis", "hey_mycroft", "alexa", "hey_rhasspy")})


async def wake_file(request: web.Request):
    name = Path(request.match_info["name"]).name
    for base in (WAKE_CUSTOM, WAKE_DIR):
        if (base / name).is_file():
            return web.FileResponse(base / name, headers={"Cache-Control": "max-age=86400"})
    if name not in WAKE_SOURCES:
        raise web.HTTPNotFound()
    async with request.app["wake_lock"]:
        if not (WAKE_DIR / name).is_file():
            WAKE_DIR.mkdir(parents=True, exist_ok=True)
            try:
                async with request.app["http"].get(WAKE_SOURCES[name], timeout=120) as up:
                    up.raise_for_status()
                    tmp = WAKE_DIR / (name + ".part")
                    tmp.write_bytes(await up.read())
                    tmp.replace(WAKE_DIR / name)
                    log.info("fetched wake word file %s", name)
            except Exception as e:
                raise web.HTTPBadGateway(text=f"could not fetch {name}: {e}")
    return web.FileResponse(WAKE_DIR / name, headers={"Cache-Control": "max-age=86400"})


async def tablet_log(request: web.Request):
    """A device reports a script error or a milestone. It goes to the add-on log with the device's name, so a
    panel that misbehaves on the wall can be diagnosed without plugging it in."""
    t = tablet_for(request)
    if not t:
        raise web.HTTPUnauthorized()
    body = await request.json()
    log.info("device %s: %s", t["name"], str(body.get("text", ""))[:500])
    return web.json_response({})


async def tablet_design(request: web.Request):
    t = tablet_for(request)
    if not t:
        raise web.HTTPUnauthorized()
    s: Store = request.app["store"]
    recs = [r for r in (s.get_design(i) for i in s.panels_of(t)) if r]
    # A panel that follows a theme gets the theme as it is now, so editing a theme changes every panel using it.
    panels = [{"id": r["id"], "name": r["name"], "design": r["design"], "theme": s.get_theme(r["design"].get("themeId")),
               "fxlist": s.get_playlist(r["design"].get("fxList"))} for r in recs]
    first = next((p for p in panels if p["id"] == t.get("design")), panels[0] if panels else {})
    # "panels" is everything on the device in swipe order; "id" names the default, where the device starts.
    # "design" and "theme" repeat the default for engines that predate several panels per device.
    return web.json_response({"panels": panels, "design": first.get("design"), "theme": first.get("theme"), "id": first.get("id"),
                              "tablet": {"name": t["name"], "start_page": t.get("start_page"), "bar": bool(t.get("bar"))}})


async def tablet_events(request: web.Request):
    """Tablets hold this socket open; the server says when their design changed."""
    t = tablet_for(request)
    if not t:
        raise web.HTTPUnauthorized()
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    request.app["tablet_sockets"].setdefault(t["id"], set()).add(ws)
    try:
        async for _ in ws:
            pass
    finally:
        request.app["tablet_sockets"][t["id"]].discard(ws)
    return ws


async def push_design(app: web.Application, design_id: str | None = None, tablet_id: str | None = None, everyone: bool = False):
    for t in app["store"].tablets.values():
        if everyone or (tablet_id and t["id"] == tablet_id) or (design_id and design_id in Store.panels_of(t)):
            for ws in list(app["tablet_sockets"].get(t["id"], ())):
                await ws.send_json({"type": "design"})


# ---------------------------------------------------------------- Home Assistant relay
async def ha_socket(request: web.Request):
    """Speaks HA's websocket protocol to the tablet. The tablet authenticates with its tablet key;
    the relay authenticates upstream with the real HA token and then passes frames both ways."""
    ws = web.WebSocketResponse(max_msg_size=0, heartbeat=30)
    await ws.prepare(request)
    await ws.send_json({"type": "auth_required", "ha_version": "relay"})
    try:
        first = await ws.receive_json(timeout=15)
    except (asyncio.TimeoutError, TypeError, ValueError):
        await ws.close()
        return ws
    if not tablet_for(request, first.get("access_token") or ""):
        await ws.send_json({"type": "auth_invalid", "message": "Tablet not approved in Daedalus Workshop"})
        await ws.close()
        return ws
    try:
        async with request.app["http"].ws_connect(HA_WS, max_msg_size=0, heartbeat=30) as up:
            await up.receive_json()
            await up.send_json({"type": "auth", "access_token": HA_TOKEN})
            verdict = await up.receive_json()
            await ws.send_json(verdict)
            if verdict.get("type") != "auth_ok":
                log.error("Home Assistant refused the relay's own token: %s", verdict)
                return ws

            async def pump(src, dst):
                async for m in src:
                    if m.type == WSMsgType.TEXT:
                        await dst.send_str(m.data)
                    elif m.type == WSMsgType.BINARY:
                        await dst.send_bytes(m.data)
                    else:
                        break

            done, pending = await asyncio.wait([asyncio.create_task(pump(ws, up)), asyncio.create_task(pump(up, ws))],
                                               return_when=asyncio.FIRST_COMPLETED)
            for p in pending:
                p.cancel()
    except Exception as e:  # HA restarting, network blip: the tablet reconnects by itself
        log.warning("relay closed: %s", e)
    await ws.close()
    return ws


async def ha_media(request: web.Request):
    """Camera stills, HLS video and spoken replies. These HA paths carry their own short-lived tokens in the URL,
    so no tablet key is asked for; the relay only adds the HA token HA wants for the API route."""
    url = HA_HTTP + request.path[len("/api"):]
    async with request.app["http"].get(url, params=request.query, headers={"Authorization": f"Bearer {HA_TOKEN}"}) as up:
        resp = web.StreamResponse(status=up.status)
        for h in ("Content-Type", "Cache-Control"):
            if h in up.headers:
                resp.headers[h] = up.headers[h]
        resp.headers["Access-Control-Allow-Origin"] = "*"
        await resp.prepare(request)
        async for chunk in up.content.iter_chunked(64 * 1024):
            await resp.write(chunk)
        return resp


async def find_core(app: web.Application):
    """Where Home Assistant itself answers, for the links it signs. As an add-on the usual road to it goes through
    the Supervisor, which lets everything through on the add-on's own token: a signature would mean nothing there.
    So signed links go to Home Assistant directly, where it checks them itself."""
    app["ha_direct"] = None if SUPERVISOR_TOKEN else HA_HTTP
    if SUPERVISOR_TOKEN:
        try:
            async with app["http"].get("http://supervisor/core/info", headers={"Authorization": f"Bearer {SUPERVISOR_TOKEN}"}, timeout=10) as r:
                d = (await r.json())["data"]
            app["ha_direct"] = f"http{'s' if d.get('ssl') else ''}://{d['ip_address']}:{d['port']}/api"
        except Exception as e:  # pictures that need a signed link stay blank; everything else works
            log.warning("Home Assistant's own address not found, signed links are off: %r", e)


async def ha_signed(request: web.Request):
    """A picture Home Assistant has signed a link for: the cover of what a player plays, the picture of a folder in
    its media browser, whichever integration it comes from. The panel asks Home Assistant for the link over its
    own connection; the signature is Home Assistant's leave, checked by Home Assistant. The Workshop adds no leave
    of its own here and passes on nothing that is not signed."""
    base = request.app.get("ha_direct")
    if "authSig" not in request.query or not base:
        raise web.HTTPNotFound()
    async with request.app["http"].get(base + request.path[len("/api"):], params=request.query, ssl=False) as up:
        resp = web.StreamResponse(status=up.status)
        for h in ("Content-Type", "Cache-Control"):
            if h in up.headers:
                resp.headers[h] = up.headers[h]
        resp.headers["Access-Control-Allow-Origin"] = "*"
        await resp.prepare(request)
        async for chunk in up.content.iter_chunked(64 * 1024):
            await resp.write(chunk)
        return resp


async def ha_call(app: web.Application, msgs: list[dict]) -> list:
    """One-shot websocket commands to HA, for the Studio's pickers."""
    async with app["http"].ws_connect(HA_WS, max_msg_size=0) as up:
        await up.receive_json()
        await up.send_json({"type": "auth", "access_token": HA_TOKEN})
        if (await up.receive_json()).get("type") != "auth_ok":
            raise web.HTTPBadGateway(text="Home Assistant refused the connection")
        out = []
        for i, m in enumerate(msgs, 1):
            await up.send_json({"id": i, **m})
            while True:
                r = await up.receive_json()
                if r.get("id") == i and r.get("type") == "result":
                    out.append(r.get("result"))
                    break
        return out


# ---------------------------------------------------------------- Studio admin API
def state(app: web.Application) -> dict:
    s: Store = app["store"]
    online = {tid for tid, socks in app["tablet_sockets"].items() if socks}
    return {"tablets": [dict(t, key=None, online=t["id"] in online, panels=s.panels_of(t)) for t in s.tablets.values()],
            "designs": s.list_designs(), "assets": s.list_assets(), "library": s.get_library()}


async def notify_admins(app: web.Application):
    for ws in list(app["admin_sockets"]):
        await ws.send_json({"type": "state", "state": state(app)})


async def admin_state(request):
    return web.json_response(state(request.app))


async def admin_live(request: web.Request):
    """The Studio page listens here so a tablet that just said hello shows up without a refresh."""
    ws = web.WebSocketResponse(heartbeat=30)
    await ws.prepare(request)
    request.app["admin_sockets"].add(ws)
    try:
        async for _ in ws:
            pass
    finally:
        request.app["admin_sockets"].discard(ws)
    return ws


async def admin_tablet(request: web.Request):
    s: Store = request.app["store"]
    tid = request.match_info["id"]
    if tid not in s.tablets:
        raise web.HTTPNotFound()
    if request.method == "DELETE":
        s.remove_tablet(tid)
    elif request.path.endswith("/approve"):
        s.approve(tid)
    else:
        s.update_tablet(tid, await request.json())
        await push_design(request.app, tablet_id=tid)
    await notify_admins(request.app)
    return web.json_response(state(request.app))


async def admin_fx(request: web.Request):
    """Set off an overlay event on one device: passed down the socket the device already holds open."""
    tid = request.match_info["id"]
    if tid not in request.app["store"].tablets:
        raise web.HTTPNotFound()
    body = await request.json()
    msg = {"type": "fx", "kind": str(body.get("kind", ""))[:40], "event": str(body.get("event", ""))[:40]}
    socks = list(request.app["tablet_sockets"].get(tid, ()))
    for ws in socks:
        await ws.send_json(msg)
    return web.json_response({"sent": len(socks)})


async def admin_design(request: web.Request):
    s: Store = request.app["store"]
    did = request.match_info.get("id")
    try:
        if request.method == "GET":
            rec = s.get_design(did)
            if not rec:
                raise web.HTTPNotFound()
            return web.json_response(rec)
        if request.method == "DELETE":
            s.delete_design(did)
        elif request.path.endswith("/duplicate"):
            s.duplicate_design(did)
        else:  # POST creates, PUT replaces
            body = await request.json()
            rec = s.save_design(did, body.get("name", ""), body.get("design"))
            await push_design(request.app, design_id=rec["id"])
            await notify_admins(request.app)
            return web.json_response(rec)
    except (ValueError, KeyError, json.JSONDecodeError) as e:
        raise web.HTTPBadRequest(text=str(e))
    await notify_admins(request.app)
    return web.json_response(state(request.app))


async def admin_asset(request: web.Request):
    s: Store = request.app["store"]
    if request.method == "DELETE":
        s.delete_asset(request.match_info["name"])
    else:
        part = await (await request.multipart()).next()
        if part is None or not part.filename:
            raise web.HTTPBadRequest(text="no file")
        data = await part.read(decode=False)
        if len(data) > 64 * 1024 * 1024:  # room for a short background video
            raise web.HTTPRequestEntityTooLarge(max_size=64 * 1024 * 1024, actual_size=len(data))
        s.save_asset(part.filename, bytes(data))
    await notify_admins(request.app)
    return web.json_response(state(request.app))


async def admin_entities(request: web.Request):
    """What the Studio's pickers offer: every entity with its name and room, plus the rooms."""
    areas, devices, ents, states, floors = await ha_call(request.app, [
        {"type": "config/area_registry/list"}, {"type": "config/device_registry/list"},
        {"type": "config/entity_registry/list"}, {"type": "get_states"}, {"type": "config/floor_registry/list"}])
    dev_area = {d["id"]: d.get("area_id") for d in devices}
    reg = {e["entity_id"]: e for e in ents}
    out, by_dev = [], {}
    for st in states:
        e = reg.get(st["entity_id"], {})
        if e.get("hidden_by") or e.get("disabled_by"):
            continue
        ent = {"id": st["entity_id"], "name": st["attributes"].get("friendly_name") or st["entity_id"],
               "area": e.get("area_id") or dev_area.get(e.get("device_id")), "state": st["state"]}
        if st["attributes"].get("device_class"):
            ent["dc"] = st["attributes"]["device_class"]
        if e.get("device_id"):
            ent["device"] = e["device_id"]
            by_dev.setdefault(e["device_id"], []).append((e, ent))
        if e.get("entity_category"):
            ent["cat"] = e["entity_category"]
        out.append(ent)
    devs = []
    for d in devices:
        mine = by_dev.get(d["id"])
        if not mine or d.get("disabled_by"):
            continue
        devs.append({"id": d["id"], "name": d.get("name_by_user") or d.get("name") or "Device", "area": d.get("area_id"),
                     "entities": [x["id"] for _, x in mine], "primary": primary_entity(mine)})
    devs.sort(key=lambda d: d["name"].lower())
    return web.json_response({"entities": out, "devices": devs, "areas": [{"id": a["area_id"], "name": a["name"]} for a in areas],
                              "floors": [{"id": f["floor_id"], "name": f["name"]} for f in floors or []]})


# Which entity stands for a device when it is added to a button: the one a person would operate.
MAIN_DOMAINS = ["light", "switch", "fan", "cover", "lock", "climate", "media_player", "vacuum", "humidifier", "water_heater",
                "alarm_control_panel", "camera", "remote", "siren", "valve", "lawn_mower", "scene", "button", "binary_sensor", "sensor"]


def primary_entity(mine: list) -> str:
    def rank(pair):
        e, ent = pair
        dom = ent["id"].split(".")[0]
        return (bool(e.get("entity_category")),  # controls before diagnostics and settings
                MAIN_DOMAINS.index(dom) if dom in MAIN_DOMAINS else len(MAIN_DOMAINS),
                e.get("name") is not None or e.get("original_name") is not None,  # the device's own unnamed main feature first
                ent["id"])
    return min(mine, key=rank)[1]["id"]


async def admin_pipelines(request: web.Request):
    """The voice assistants set up in Home Assistant, for the assistant button's picker."""
    res, states = await ha_call(request.app, [{"type": "assist_pipeline/pipeline/list"}, {"type": "get_states"}])
    engines = [s["entity_id"] for s in states if s["entity_id"].startswith("wake_word.")]
    words = {}
    for info in await ha_call(request.app, [{"type": "wake_word/info", "entity_id": e} for e in engines]) if engines else []:
        for w in (info or {}).get("wake_words", []):
            words.setdefault(w["id"], w.get("name") or w["id"])
    return web.json_response({"pipelines": [{"id": p["id"], "name": p["name"]} for p in (res or {}).get("pipelines", [])],
                              "wakewords": [{"id": k, "name": v} for k, v in words.items()]})


async def admin_library(request: web.Request):
    s: Store = request.app["store"]
    if request.method == "PUT":
        try:
            s.save_library(await request.json())
        except (ValueError, json.JSONDecodeError) as e:
            raise web.HTTPBadRequest(text=str(e))
        await push_design(request.app, everyone=True)
        await notify_admins(request.app)
    return web.json_response(state(request.app))


async def admin_settings(request: web.Request):
    s: Store = request.app["store"]
    if request.method == "PUT":
        s.save_settings(await request.json())
    llm = dict(s.get_settings().get("llm") or {})
    llm["key"] = bool(llm.get("key"))  # the key is write-only: the page learns only whether one is stored
    return web.json_response({"llm": llm})


async def admin_backup(request: web.Request):
    s: Store = request.app["store"]
    if request.method == "GET":
        return web.json_response(s.backup(), headers={"Content-Disposition": 'attachment; filename="daedalus.dbackup"'})
    try:
        done = s.restore(await request.json())
    except (ValueError, json.JSONDecodeError) as e:
        raise web.HTTPBadRequest(text=str(e))
    await push_design(request.app, everyone=True)
    await notify_admins(request.app)
    return web.json_response({"restored": done, "state": state(request.app)})


async def tablet_scene(request: web.Request):
    """Save the lights of a room or a floor, as they are now, as a scene in Home Assistant: a new one by name, or
    over one that exists. It is written the way Home Assistant's own scene editor writes it, so it is kept across
    restarts and can be edited there. The server holds the Home Assistant token; the panel only asks."""
    if not tablet_for(request):
        raise web.HTTPUnauthorized()
    body = await request.json()
    scope, replace, app = str(body.get("scope", "")), body.get("replace"), request.app
    areas, devices, ents, states = await ha_call(app, [
        {"type": "config/area_registry/list"}, {"type": "config/device_registry/list"},
        {"type": "config/entity_registry/list"}, {"type": "get_states"}])
    entities = capture(scope, areas, devices, ents, states)
    if not entities:
        raise web.HTTPBadRequest(text="No lights to save there")
    headers = {"Authorization": f"Bearer {HA_TOKEN}"}
    if replace:
        old = next((s for s in states if s["entity_id"] == replace and str(replace).startswith("scene.")), None)
        sid = old and old["attributes"].get("id")
        if not sid:  # a scene written by hand in YAML has no identity the editor's API can save under
            raise web.HTTPBadRequest(text="That scene cannot be replaced from here")
        async with app["http"].get(f"{HA_HTTP}/config/scene/config/{sid}", headers=headers) as r:
            was = await r.json() if r.status == 200 else {}
        cfg = {"name": was.get("name") or old["attributes"].get("friendly_name") or "Scene"}
        if was.get("icon"):
            cfg["icon"] = was["icon"]
    else:
        name = str(body.get("name", "")).strip()[:80]
        if not name:
            raise web.HTTPBadRequest(text="The scene needs a name")
        sid, cfg = str(int(time.time() * 1000)), {"name": name}
    cfg["entities"] = entities
    async with app["http"].post(f"{HA_HTTP}/config/scene/config/{sid}", json=cfg, headers=headers) as r:
        if r.status >= 400:
            raise web.HTTPBadGateway(text=f"Home Assistant refused the scene: {(await r.text())[:200]}")
    if not replace and scope.startswith("area:"):  # a room's new scene is put in that room, so the room's dashboard lists it
        for _ in range(10):
            await asyncio.sleep(0.5)
            reg = (await ha_call(app, [{"type": "config/entity_registry/list"}]))[0] or []
            ent = next((e for e in reg if e.get("unique_id") == sid and e["entity_id"].startswith("scene.")), None)
            if ent:
                await ha_call(app, [{"type": "config/entity_registry/update", "entity_id": ent["entity_id"], "area_id": scope[5:]}])
                break
    log.info("scene %s saved for %s with %d lights", sid, scope, len(entities))
    return web.json_response({"id": sid, "lights": len(entities)})


async def tablet_scenes(request: web.Request):
    """What each scene made in Home Assistant's editor sets its lights to. A panel uses it to light a scene's button
    while the lights are as the scene left them, and to draw the scene's colours on it."""
    if not tablet_for(request):
        raise web.HTTPUnauthorized()
    app, headers = request.app, {"Authorization": f"Bearer {HA_TOKEN}"}
    states = (await ha_call(app, [{"type": "get_states"}]))[0] or []
    ids = {s["entity_id"]: s["attributes"]["id"] for s in states if s["entity_id"].startswith("scene.") and s["attributes"].get("id")}

    async def one(eid: str, sid: str):
        try:
            async with app["http"].get(f"{HA_HTTP}/config/scene/config/{sid}", headers=headers) as r:
                return eid, lights_of(await r.json()) if r.status == 200 else []
        except Exception:
            return eid, []

    return web.json_response(dict(await asyncio.gather(*(one(e, i) for e, i in ids.items()))))


async def tablet_llm(request: web.Request):
    """Assistant buttons set to a direct LLM send the heard text here. The server holds the address and key
    (Studio, Assistant settings); the tablet never sees them. Speaks the OpenAI chat-completions format,
    which local servers (llama.cpp, Ollama, LM Studio) and most hosted ones accept."""
    if not tablet_for(request):
        raise web.HTTPUnauthorized()
    llm = request.app["store"].get_settings().get("llm") or {}
    if not llm.get("url"):
        raise web.HTTPBadRequest(text="No LLM address is set in Daedalus Workshop")
    body = await request.json()
    msgs = [m for m in body.get("messages", []) if m.get("role") in ("user", "assistant") and isinstance(m.get("content"), str)][-20:]
    if llm.get("system"):
        msgs.insert(0, {"role": "system", "content": llm["system"]})
    url = llm["url"].rstrip("/")
    if not url.endswith("/chat/completions"):
        url += "/chat/completions"
    headers = {"Authorization": f"Bearer {llm['key']}"} if llm.get("key") else {}
    try:
        async with request.app["http"].post(url, json={"model": llm.get("model") or "default", "messages": msgs},
                                            headers=headers, timeout=120) as up:
            data = await up.json(content_type=None)
            if up.status >= 400:
                raise web.HTTPBadGateway(text=f"The LLM answered {up.status}: {str(data)[:200]}")
            return web.json_response({"text": data["choices"][0]["message"]["content"]})
    except web.HTTPException:
        raise
    except Exception as e:
        raise web.HTTPBadGateway(text=f"The LLM could not be reached: {e}")


# ---------------------------------------------------------------- static files
async def studio_index(request):
    if not is_admin(request):
        raise web.HTTPForbidden(text="Studio is only reachable through Home Assistant")
    return web.FileResponse(ROOT / "studio" / "index.html", headers={"Cache-Control": "no-store"})


async def asset(request: web.Request):
    """Uploaded images first, then the pictures that ship with the renderer."""
    name = Path(request.match_info["name"]).name
    for base in (request.app["store"].assets_dir, RENDERER / "assets"):
        if (base / name).is_file():
            return web.FileResponse(base / name)
    raise web.HTTPNotFound()


# ---------------------------------------------------------------- mDNS
def lan_ip() -> str:
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("10.255.255.255", 1))  # no packet is sent; this only asks the OS which interface it would use
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


async def start_mdns(app: web.Application):
    if os.environ.get("DAEDALUS_MDNS") == "0":  # a development copy must not draw the tablets away from the real one
        return
    try:
        from zeroconf import ServiceInfo
        from zeroconf.asyncio import AsyncZeroconf
        ip = lan_ip()
        info = ServiceInfo("_daedalus._tcp.local.", "Daedalus Workshop._daedalus._tcp.local.", addresses=[socket.inet_aton(ip)],
                           port=PORT, properties={"v": "1"}, server=f"daedalus-{ip.replace('.', '-')}.local.")
        app["zc"] = AsyncZeroconf()
        # Another copy on the network (a development server) may hold the name: take a numbered one instead of failing.
        await app["zc"].async_register_service(info, allow_name_change=True)
        app["zc_info"] = info
        log.info("advertising _daedalus._tcp at %s:%s", ip, PORT)
    except Exception as e:  # discovery is a convenience; the server works without it
        log.warning("mDNS advertising off: %r", e)


async def stop_mdns(app: web.Application):
    if app.get("zc"):
        if app.get("zc_info"):
            await app["zc"].async_unregister_service(app["zc_info"])
        await app["zc"].async_close()


async def seed(app: web.Application):
    """First start: give the Studio one design to look at."""
    s: Store = app["store"]
    sample = ROOT / "server" / "seed.json"
    if not s.list_designs() and sample.is_file():
        s.save_design(None, "Sample", json.loads(sample.read_text(encoding="utf-8")))


def build_app() -> web.Application:
    app = web.Application(middlewares=[guard], client_max_size=96 * 1024 * 1024)
    app["store"] = Store(DATA)
    app["tablet_sockets"] = {}
    app["engine"] = build_engine()
    app["wake_lock"] = asyncio.Lock()
    app["admin_sockets"] = set()

    async def http_ctx(app):
        app["http"] = ClientSession()
        yield
        await app["http"].close()

    app.cleanup_ctx.append(http_ctx)
    app.on_startup.extend([seed, find_core, start_mdns])
    app.on_cleanup.append(stop_mdns)

    r = app.router
    r.add_post("/api/hello", hello)
    r.add_get("/api/design", tablet_design)
    r.add_post("/api/log", tablet_log)
    r.add_get("/api/engine", tablet_engine)
    r.add_get("/wake/{name}", wake_file)
    r.add_get("/api/events", tablet_events)
    r.add_get("/api/websocket", ha_socket)
    r.add_post("/api/llm", tablet_llm)
    r.add_post("/api/scene", tablet_scene)
    r.add_get("/api/scenes", tablet_scenes)
    for p in ("/api/camera_proxy/{t:.*}", "/api/camera_proxy_stream/{t:.*}", "/api/hls/{t:.*}", "/api/tts_proxy/{t:.*}", "/api/media_player_proxy/{t:.*}", "/api/brands/{t:.*}"):
        r.add_get(p, ha_media)
    r.add_get("/api/{t:.*}", ha_signed)  # last of the /api paths: whatever else Home Assistant has signed a link for
    r.add_route("OPTIONS", "/api/{t:.*}", lambda request: web.Response())

    r.add_get("/admin/api/state", admin_state)
    r.add_get("/admin/api/live", admin_live)
    r.add_get("/admin/api/entities", admin_entities)
    r.add_post("/admin/api/tablets/{id}/approve", admin_tablet)
    r.add_post("/admin/api/tablets/{id}/fx", admin_fx)
    r.add_route("PATCH", "/admin/api/tablets/{id}", admin_tablet)
    r.add_delete("/admin/api/tablets/{id}", admin_tablet)
    r.add_post("/admin/api/designs", admin_design)
    r.add_get("/admin/api/designs/{id}", admin_design)
    r.add_put("/admin/api/designs/{id}", admin_design)
    r.add_delete("/admin/api/designs/{id}", admin_design)
    r.add_post("/admin/api/designs/{id}/duplicate", admin_design)
    r.add_post("/admin/api/assets", admin_asset)
    r.add_delete("/admin/api/assets/{name}", admin_asset)
    r.add_get("/admin/api/pipelines", admin_pipelines)
    r.add_get("/admin/api/library", admin_library)
    r.add_put("/admin/api/library", admin_library)
    r.add_get("/admin/api/settings", admin_settings)
    r.add_put("/admin/api/settings", admin_settings)
    r.add_get("/admin/api/backup", admin_backup)
    r.add_post("/admin/api/restore", admin_backup)

    r.add_get("/assets/{name}", asset)
    r.add_get("/", studio_index)
    r.add_get("/admin", studio_index)
    r.add_static("/admin/studio", ROOT / "studio")
    r.add_static("/renderer", RENDERER)
    return app


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    log.info("Daedalus Workshop on port %s, data in %s, Home Assistant at %s", PORT, DATA, HA_HTTP)
    app = build_app()
    log.info("tablet engine %s", app["engine"]["version"])
    web.run_app(app, port=PORT, access_log=None)


if __name__ == "__main__":
    main()
