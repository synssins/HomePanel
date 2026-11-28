'use strict';
// Daedalus renderer. The app is a placeholder: everything on screen comes from a design file: a theme, and
// dashboards (pages) of buttons (tiles) placed on a small-cell grid. Tile types are plugins registered with
// HP.tile(); see tiles.js. The design, and the theme it follows, come from Daedalus Workshop (the HA add-on).

const HP = window.HP = Object.assign(window.HP || {}, {tiles: {}, icons: window.HP_ICONS || {}, S: {states: {}, areas: {}, reg: {}}, design: null, live: [], stack: []});
HP.tile = (name, def) => { HP.tiles[name] = def; };
/** Pictures named in a design live on the server; without one, in the app bundle. */
HP.asset = p => !p || /^(https?:|data:)/.test(p) || !HP.server ? p : HP.server + '/' + p.replace(/^\//, '');

const $ = id => document.getElementById(id);
const S = HP.S;
const BINARY = {door: ['Open', 'Closed'], garage_door: ['Open', 'Closed'], window: ['Open', 'Closed'], opening: ['Open', 'Closed'], lock: ['Unlocked', 'Locked'],
  motion: ['Detected', 'Clear'], occupancy: ['Detected', 'Clear'], presence: ['Home', 'Away'], vibration: ['Detected', 'Clear'], sound: ['Detected', 'Clear'], moving: ['Moving', 'Stopped'],
  moisture: ['Wet', 'Dry'], smoke: ['Detected', 'Clear'], gas: ['Detected', 'Clear'], carbon_monoxide: ['Detected', 'Clear'], tamper: ['Tampering detected', 'Clear'],
  problem: ['Problem', 'OK'], safety: ['Unsafe', 'Safe'], battery: ['Low', 'Normal'], battery_charging: ['Charging', 'Not charging'], connectivity: ['Connected', 'Disconnected'],
  plug: ['Plugged in', 'Unplugged'], power: ['Power', 'No power'], running: ['Running', 'Not running'], heat: ['Hot', 'Normal'], cold: ['Cold', 'Normal'], light: ['Light', 'No light'], update: ['Update available', 'Up-to-date']};
const U = HP.util = {
  esc: s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c])),
  st: e => S.states[e],
  avail: e => !!S.states[e] && S.states[e].state !== 'unavailable',
  fname: e => (S.states[e] && S.states[e].attributes.friendly_name) || e,
  cap: s => (s.charAt(0).toUpperCase() + s.slice(1)).replace(/_/g, ' '),
  active: e => !!S.states[e] && (['on', 'open', 'opening', 'playing', 'home', 'unlocked', 'triggered'].includes(S.states[e].state) || S.states[e].state.startsWith('armed_')),
  stateLabel(e) {
    const s = S.states[e];
    if (!s) return HP.ready ? 'Not found' : '';
    if (s.state === 'unavailable') return 'Offline';
    // a yes-or-no sensor says what it watches: a door is open or closed, not on or off (Home Assistant's own words)
    if (e.startsWith('binary_sensor.') && (s.state === 'on' || s.state === 'off')) { const w = BINARY[s.attributes.device_class]; if (w) return w[s.state === 'on' ? 0 : 1]; }
    if (e.startsWith('update.') && (s.state === 'on' || s.state === 'off')) return s.state === 'on' ? 'Update available' : 'Up-to-date';
    if (e.startsWith('event.') && s.attributes.event_type) return U.cap(String(s.attributes.event_type));
    if (s.state === 'on' && s.attributes.brightness) return Math.round(s.attributes.brightness / 2.55) + '%';
    const unit = s.attributes.unit_of_measurement;
    if (unit && !isNaN(parseFloat(s.state))) return (Math.round(parseFloat(s.state) * 10) / 10) + (unit.length > 2 ? ' ' : '') + unit;
    return U.cap(s.state);
  },
  /** 'Master Bedroom Arc Lamp 2' in Master Bedroom -> 'Arc Lamp 2' */
  short(name, room) {
    const n = name.trim(), out = room && n.toLowerCase().startsWith(room.toLowerCase() + ' ') ? n.slice(room.length + 1) : n;
    return out ? out.charAt(0).toUpperCase() + out.slice(1) : name;
  },
  inArea: (area, domain) => Object.keys(S.states).filter(e => e.startsWith(domain + '.') && S.reg[e] && S.reg[e].area === area && !S.reg[e].skip && U.avail(e)).sort(),
  /** Icons are single SVG paths on a 24x24 box (Material Design Icons format), tinted by the text colour. */
  icon: name => HP.icons[name] ? `<svg viewBox="0 0 24 24"><path d="${HP.icons[name]}"/></svg>` : '',
  /** Standard tile body: optional icon, a name line and a label line. Returns the parts for cheap updates. */
  card(body, icon) {
    body.innerHTML = `<div class="ic">${U.icon(icon)}</div><div class="tx"><div class="n"></div><div class="l"></div></div>`;
    return {ic: body.querySelector('.ic'), n: body.querySelector('.n'), l: body.querySelector('.l')};
  },
  /** Set text only when it changed; a name too long for its tile shrinks to fit (down to 70%) before it truncates. */
  set(el, text) {
    if (el.textContent === text) return;
    el.textContent = text;
    if (!el.classList.contains('n')) return;
    el.style.fontSize = '';
    if (el.scrollWidth > el.clientWidth) el.style.fontSize = Math.max(70, Math.floor(el.clientWidth / el.scrollWidth * 98)) + '%';
  },
  /** Type scale for a box of this size: everything inside is sized in multiples of it. */
  unit: (w, h) => Math.max(11, Math.min(h * 0.2, w * 0.11, 64)),
  /** The battery of the device a thing belongs to, where Home Assistant has one: a battery sensor on the same device. */
  battery(e) {
    const d = S.reg[e] && S.reg[e].dev;
    return d ? Object.keys(S.states).find(id => id.startsWith('sensor.') && S.states[id].attributes.device_class === 'battery' && !!S.reg[id] && S.reg[id].dev === d) || null : null;
  },
};

// ---------- theme ----------
/** A button look (from the theme, a saved button design, or one tile's own overrides) as CSS variables.
 *  A fade is drawn at a fixed length and then holds its end colour, so a tall button and a short one beside it
 *  fade over the same distance instead of each stretching the fade to its own size. */
function lookVars(s) {
  const v = {};
  if (!s) return v;
  if (s.fill) {
    if (s.fillTo) {
      const across = s.fadeDir === 'right', len = (s.fadeLen || 160) + 'px';
      v['--fill'] = `linear-gradient(${across ? 'to right' : 'to bottom'}, ${s.fill}, ${s.fillTo})`;
      v['--fill-size'] = across ? `${len} 100%` : `100% ${len}`; v['--fill-base'] = s.fillTo;
    } else { v['--fill'] = s.fill; v['--fill-size'] = 'auto'; v['--fill-base'] = s.fill; }  // the base colour is what shows for a plain fill
  }
  const px = {radius: '--radius', gap: '--gap', borderWidth: '--bw'}, plain = {fillOn: '--fill-on', text: '--text', textOn: '--text-on', border: '--border', glowOn: '--glow-on', glow: '--glow', font: '--font', depth: '--depth'};
  for (const k in px) if (s[k] != null) v[px[k]] = s[k] + 'px';
  for (const k in plain) if (s[k] != null && s[k] !== '') v[plain[k]] = String(s[k]);
  return v;
}
/** The parts of a look that are not a single value: the kind of shadow, the shape, lit edge and frosting. */
const lookClasses = s => (s.shadow ? ' sh-' + s.shadow : '') + (s.shape === 'tab' ? ' shape-tab' : '') + (s.rim === false ? ' norim' : s.rim === true ? ' rim-on' : '') + (s.glass === false ? ' solid' : '');
const LOOK_VARS = ['--glow', '--fill', '--fill-size', '--fill-base', '--radius', '--gap', '--bw', '--fill-on', '--text', '--text-on', '--border', '--glow-on', '--font', '--depth'];

/** A panel either carries its own look, or follows a theme from the Studio's library. The theme arrives beside
 *  the design and is folded in here, so changing a theme changes every panel that follows it. */
function resolveTheme(d, rec) {
  const own = d.theme || {};
  if (!rec) return Object.assign({looks: {}, barStyle: own.tile || {}}, own);
  const bgs = rec.backgrounds || [], btns = rec.buttons || [], bg = id => bgs.find(b => b.id === id);
  const looks = {}; btns.forEach(b => { looks[b.name] = b.style || {}; looks[b.id] = b.style || {}; });
  const night = Object.assign({}, own.night);
  if (night.bg && bg(night.bg)) night.background = bg(night.bg);
  return {background: bg(d.bg) || bg(rec.background) || bgs[0] || own.background || {}, tile: (btns.find(b => b.id === rec.button) || btns[0] || {}).style || own.tile || {},
    looks, night, depth: own.depth, text: own.text, font: own.font,
    barStyle: (btns.find(b => b.id === rec.bar) || btns.find(b => b.id === rec.button) || btns[0] || {}).style || {}};
}

function paint(bg) {
  const pos = ' center / cover no-repeat';
  // Server copy first; the copy bundled with the app sits underneath in case the server is away.
  const layers = !bg.image ? [] : HP.asset(bg.image) === bg.image ? [bg.image] : [HP.asset(bg.image), bg.image];
  return layers.map(u => `url("${u}")` + pos + ', ').join('') + (bg.color || '#141a5c');
}

function applyTheme(th) {
  HP.theme = th;
  th.background = th.background || {};  // one object for the life of the theme: daylight() compares by identity
  const r = document.documentElement.style, t = th.tile || {};
  LOOK_VARS.forEach(k => r.removeProperty(k));
  const vars = lookVars(Object.assign({text: th.text, font: th.font}, t));
  for (const k in vars) r.setProperty(k, vars[k]);
  document.body.classList.toggle('noglass', t.glass === false);
  document.body.classList.toggle('norim', t.rim === false);
  HP.night = null;  // forces the backdrop to be drawn
  daylight();
  tiltSetup();
}

/** Day or night backdrop, and the light that follows the sun. Runs whenever the house state changes. */
function daylight() {
  const th = HP.theme; if (!th) return;
  const n = th.night || {}, sun = S.states['sun.sun'], now = Date.now();
  let night = false, elev = null;
  if (n.mode === 'switch' || n.mode === 'sun') {
    if (sun) {
      const set = Date.parse(sun.attributes.next_setting), rise = Date.parse(sun.attributes.next_rising), DAY = 864e5;
      elev = sun.attributes.elevation;
      // Night can begin before the sun is down, and end after it is up: it is dark well inside those margins.
      night = sun.state === 'below_horizon' ? true : now >= set - (n.before || 0) * 6e4;
      if (sun.state === 'above_horizon' && now < rise - DAY + (n.after || 0) * 6e4) night = true;
    } else { const h = new Date().getHours(); night = h >= 19 || h < 7; }  // no sun entity yet: by the clock
  }
  const useNight = n.mode === 'switch' && night && n.background;
  const bg = useNight ? n.background : th.background || {};
  if (HP.night !== !!useNight || HP.bgShown !== bg) {
    const first = HP.night == null;
    HP.night = !!useNight; HP.bgShown = bg;
    const layer = $('bgi'), paintNow = () => {
      layer.style.background = paint(bg); $('blur').style.background = layer.style.background;
      layer.className = bg.motion && bg.motion !== 'none' ? 'm-' + bg.motion : '';
      const v = layer.querySelector('video');
      if (v && (!bg.video || v.dataset.src !== bg.video)) v.remove();
      if (bg.video && !layer.querySelector('video')) {
        const nv = document.createElement('video'); nv.muted = true; nv.loop = true; nv.autoplay = true; nv.playsInline = true; nv.setAttribute('playsinline', '');
        nv.dataset.src = bg.video; nv.src = HP.asset(bg.video); layer.append(nv); nv.play().catch(() => {});
      }
    };
    if (first) paintNow(); else { layer.style.opacity = 0; setTimeout(() => { paintNow(); layer.style.opacity = 1; }, 900); }  // fade through dark, not a hard cut
  }
  let dim = `rgba(0,0,0,${bg.dim || 0})`;
  if (n.mode === 'sun') {
    // Light that follows the sun: clear by day, warm as it nears the horizon, deep blue once it is down.
    const e = elev == null ? (night ? -12 : 30) : elev - (night && elev > 0 ? 8 : 0);  // the "before sunset" margin pulls dusk earlier
    const low = Math.max(0, Math.min(1, (12 - e) / 12)), down = Math.max(0, Math.min(1, -e / 8)), warm = low * (1 - down);
    const a = (bg.dim || 0) + warm * 0.22 + down * 0.5;
    dim = `rgba(${Math.round(120 * warm + 6 * down)},${Math.round(50 * warm + 10 * down)},${Math.round(10 * warm + 40 * down)},${Math.min(0.85, a).toFixed(3)})`;
  }
  if ($('dim').style.background !== dim) $('dim').style.background = dim;
}

// ---------- depth: the tablet's tilt moves the buttons a little against the backdrop ----------
const tilt = {on: false, x: 0, y: 0, bx: null, by: null};
function tiltApply(x, y) {  // x, y in -1..1
  const d = (HP.theme && HP.theme.depth) || 0, px = 16 * d;
  tilt.x += (x - tilt.x) * 0.25; tilt.y += (y - tilt.y) * 0.25;
  const bx = (-tilt.x * px).toFixed(1), by = (-tilt.y * px).toFixed(1), gx = (tilt.x * px * 0.45).toFixed(1), gy = (tilt.y * px * 0.45).toFixed(1);
  $('bg').style.transform = `translate3d(${bx}px,${by}px,0) scale(1.06)`;
  if (!swipe.active) { $('grid').style.transform = `translate3d(${gx}px,${gy}px,0)`; $('blurclip').style.transform = `translate3d(${gx}px,${gy}px,0)`; }
}
/** Gravity from the tablet (native shell) or the browser. A slowly following average is "level", so a tablet
 *  that rests at an angle on a stand sits still and only a change of angle moves things. */
window.nativeMotion = (gx, gy) => {
  if (!tilt.on) return;
  if (tilt.bx == null) { tilt.bx = gx; tilt.by = gy; }
  tilt.bx += (gx - tilt.bx) * 0.01; tilt.by += (gy - tilt.by) * 0.01;
  const c = v => Math.max(-1, Math.min(1, v * 3.2));
  tiltApply(c(gx - tilt.bx), c(gy - tilt.by));
};
function tiltSetup() {
  const want = !!(HP.theme && HP.theme.depth > 0) && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (want === tilt.on) return;
  tilt.on = want;
  native('motion', {on: want}).catch(() => {});
  if (!want) { ['bg', 'grid', 'blurclip'].forEach(id => { $(id).style.transform = ''; }); return; }
  if (tiltSetup.bound) return;
  tiltSetup.bound = true;
  window.addEventListener('deviceorientation', e => { if (e.gamma != null) window.nativeMotion(e.gamma / 90, e.beta / 90); });
  // In the Studio's preview there is no tablet to tilt: the pointer stands in for it.
  if (HP.preview) window.addEventListener('pointermove', e => { if (tilt.on) tiltApply(e.clientX / innerWidth * 2 - 1, e.clientY / innerHeight * 2 - 1); });
}

// ---------- pages ----------
const ctx = HP.ctx = {
  service: (domain, svc, entity, data) => HP.ha.call({type: 'call_service', domain, service: svc, target: entity ? {entity_id: entity} : undefined, service_data: data || {}})
    .catch(e => toast(e.message)),
  go: (page, param) => { HP.stack.push({panel: HP.cur, page, param}); show(); },
  /** Open another of this device's panels, on its first dashboard. Back returns to where the button was. */
  goPanel: id => {
    const k = HP.panels.findIndex(p => p.id === id);
    if (k < 0) return toast('That panel is not on this device');
    const d = HP.panels[k].design;
    HP.stack.push({panel: k, page: d.start || d.pages[0].id}); show();
  },
  back: () => { if (HP.stack.length > 1) HP.stack.pop(); show(); },
  relayout: () => { clearTimeout(ctx._rl); ctx._rl = setTimeout(layout, 50); },
};

/** The single lights behind a light: itself, or for a group Home Assistant knows the members of, theirs (a
 *  Zigbee2MQTT group shows no members, and so counts as one light). */
function leaves(e, seen) {
  seen = seen || {}; if (seen[e] || !S.states[e]) return []; seen[e] = 1;
  const m = S.states[e].attributes.entity_id;
  return Array.isArray(m) ? [].concat(...m.map(x => leaves(x, seen))) : [e];
}
/** A room's lights as its page shows them. A group whose lights are all in the room is either the room's "all
 *  lights" (the widest one, unless the design names one) or a fixture: one button, and its bulbs get none of their
 *  own (they are in its popup). A group that holds a smaller group of the room is a collection and is not shown. */
function roomLights(area, cfg) {
  const inRoom = e => !!S.reg[e] && S.reg[e].area === area, has = (a, b) => b.m.every(x => a.m.includes(x));
  const groups = Object.keys(S.states).filter(e => e.startsWith('light.') && Array.isArray(S.states[e].attributes.entity_id) && U.avail(e))
    .map(e => ({e, m: [...new Set(leaves(e))]})).filter(g => g.m.length && g.m.every(inRoom))
    .sort((a, b) => b.m.length - a.m.length || (a.e < b.e ? -1 : 1));
  const all = cfg.group && U.avail(cfg.group) ? cfg.group : groups.length && groups[0].m.length > 1 ? groups[0].e : null;
  const rest = groups.filter(g => g.e !== all);
  const fixtures = rest.filter(g => !rest.some(o => o.m.length < g.m.length && has(g, o)))  // holds no smaller group
    .filter((g, i, l) => l.findIndex(o => o.m.length === g.m.length && has(o, g)) === i);  // two groups of the same lights are one
  const used = new Set([all].concat(...fixtures.map(g => [g.e].concat(g.m)), rest.map(g => g.e)));
  return {all, fixtures: fixtures.map(g => g.e), singles: U.inArea(area, 'light').filter(e => !used.has(e))};
}

/** Room pages are generated from the area's entities, so a new lamp appears without touching the design. */
function roomPage(area) {
  const d = HP.design, room = S.areas[area] || area, cols = d.grid.cols, cfg = (d.rooms || {})[area] || {};
  const tiles = [{type: 'nav', back: true, x: 2, y: 2, w: 10, h: 5, name: 'Back', icon: 'chevron-left'},
    {type: 'label', text: room, x: 13, y: 2, w: cols - 15, h: 5, flat: true, size: 0.62}];
  let x = 2, y = 9;
  const put = (t, w) => { if (x + w > cols - 2) { x = 2; y += 8; } tiles.push(Object.assign(t, {x, y, w, h: 8})); x += w; };
  const lights = roomLights(area, cfg);
  if (lights.all) put({type: 'entity', entity: lights.all, name: 'All lights', icon: 'lightbulb-group'}, 12);
  lights.fixtures.forEach(e => put({type: 'entity', entity: e, name: U.short(U.fname(e), room), icon: 'lightbulb-group'}, 12));
  lights.singles.forEach(e => put({type: 'entity', entity: e, name: U.short(U.fname(e), room), icon: 'lightbulb'}, 12));
  if (U.inArea(area, 'scene').length) put({type: 'scenes', scope: 'area:' + area}, 12);
  if (HP.server) put({type: 'savescene', scope: 'area:' + area}, 12);
  U.inArea(area, 'cover').forEach(e => put({type: 'entity', entity: e, icon: 'garage'}, 12));  // doors ask before they move: see HP.act
  U.inArea(area, 'media_player').forEach(e => put({type: 'media', entity: e}, 24));
  return {id: '@room', tiles};
}

function show() {
  if (HP.assist && HP.assist.busy) HP.assist.close();
  pop.close();
  const top = HP.stack[HP.stack.length - 1];
  if ((top.panel || 0) !== HP.cur) {  // crossing into another panel: its design and its look take over
    HP.cur = top.panel || 0;
    const p = HP.panels[HP.cur];
    HP.design = p.design; applyTheme(resolveTheme(p.design, p.theme));
  }
  panelBar();
  const d = HP.design, grid = $('grid'), looks = (HP.theme && HP.theme.looks) || {};
  HP.live.forEach(i => { if (i.data && i.data.destroy) i.data.destroy(); });
  HP.live = []; grid.innerHTML = '';
  const page = top.page === '@room' ? roomPage(top.param) : d.pages.find(p => p.id === top.page) || d.pages[0];
  grid.style.gridTemplateColumns = `repeat(${d.grid.cols}, 1fr)`;
  grid.style.gridTemplateRows = `repeat(${d.grid.rows}, 1fr)`;
  for (const t of page.tiles) {
    const def = HP.tiles[t.type] || HP.tiles.label, el = document.createElement('div');
    // The tile's look: a saved button design by name (from the theme), then this tile's own overrides.
    const s = Object.assign({}, looks[t.look], t.style), vars = lookVars(s), base = HP.theme.tile || {};
    el.className = 'tile t-' + t.type + (t.flat ? ' flat' : '') + lookClasses(Object.assign({shadow: base.shadow, shape: base.shape}, s));
    el.style.gridArea = `${t.y + 1} / ${t.x + 1} / span ${t.h} / span ${t.w}`;
    for (const k in vars) el.style.setProperty(k, vars[k]);
    if (s.opacity != null) el.style.opacity = s.opacity;
    if (t.demoOn) el.classList.add('on');  // the Studio's sample buttons: show the lit state without a real entity
    el.innerHTML = '<div class="fill"></div>' + (s.image ? `<div class="pic" style="background-image:url('${U.esc(HP.asset(s.image))}')"></div>` : '') + '<div class="body"></div><div class="rim"></div>';
    grid.append(el);
    // lightState: the button design asks for a lit light's own colour and level instead of its own lit look
    const inst = {t, el, def, body: el.querySelector('.body'), lightState: (s.lightState != null ? s.lightState : base.lightState) === true};
    const tap = () => { const a = def.tap ? def.tap(t, ctx, inst) : null; HP.fx.press(HP.live.indexOf(inst)); if (a) (t.confirm ? confirmBox(t.confirm, a) : a()); };
    if (def.tap && !t.info) { el.classList.add('tap'); el.addEventListener('click', tap); }
    HP.live.push(inst);
  }
  fxUse.page = page.id; fxUse(true);  // overlays; layout() below hands them the rectangles
  layout();
  // create after layout so tiles know their pixel size
  HP.live.forEach(i => { i.data = i.def.create ? i.def.create(i.t, i.body, ctx, i) : null; });
  update();
}

/** Size each tile's type scale from its pixels, and cut the blurred backdrop to the tile shapes (cheap glass:
 *  one blurred layer for the whole screen instead of a backdrop filter per tile, which the Air 2 cannot afford). */
function layout() {
  const radius = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius')) || 0;
  const boxes = [];
  for (const i of HP.live) {
    const r = i.el.getBoundingClientRect();
    i.w = r.width; i.h = r.height;
    boxes.push({x: r.left, y: r.top, w: r.width, h: r.height, r: Math.min(radius, r.width / 2, r.height / 2), on: i.el.classList.contains('on'), flat: i.el.classList.contains('flat'), hidden: i.el.hidden || !r.width, type: i.t.type, el: i.el, tile: i.t});
    i.el.style.setProperty('--u', U.unit(r.width, r.height).toFixed(1) + 'px');
    i.el.classList.toggle('wide', r.width / r.height > 2.4);
  }
  cut();
  HP.fx.layout(boxes);
}
/** Cut the blurred backdrop to the tiles' shapes. Also called by an overlay that takes a tile away for a while
 *  (it hides the tile or stops it taking touches): that tile's frosted patch goes with it. */
function cut() {
  const radius = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--radius')) || 0, off = $('grid').getBoundingClientRect();
  let path = '';
  for (const i of HP.live) {
    const r = {left: off.left + i.el.offsetLeft, top: off.top + i.el.offsetTop, width: i.el.offsetWidth, height: i.el.offsetHeight};
    if (i.el.classList.contains('flat') || i.el.classList.contains('solid') || i.el.hidden || !r.width || i.el.style.visibility === 'hidden' || i.el.style.pointerEvents === 'none') continue;
    // measured relative to the grid, so the cut stays right while the grid is shifted by a swipe or by tilt
    const rr = Math.min(parseFloat(getComputedStyle(i.el).borderTopLeftRadius) || radius, r.width / 2, r.height / 2), x = r.left - off.left, y = r.top - off.top, w = r.width, h = r.height;
    // a corner is its round arc, or a straight cut where an overlay has sliced it off (see HP.chip)
    const c = i.el.hpCuts || {}, arc = (ex, ey) => `A${rr},${rr} 0 0 1 ${ex},${ey}`;
    path += `M${x + (c.tl ? c.tl[0] : rr)},${y}L${x + w - (c.tr ? c.tr[0] : rr)},${y}` + (c.tr ? `L${x + w},${y + c.tr[1]}` : arc(x + w, y + rr))
      + `L${x + w},${y + h - (c.br ? c.br[1] : rr)}` + (c.br ? `L${x + w - c.br[0]},${y + h}` : arc(x + w - rr, y + h))
      + `L${x + (c.bl ? c.bl[0] : rr)},${y + h}` + (c.bl ? `L${x},${y + h - c.bl[1]}` : arc(x, y + h - rr))
      + `L${x},${y + (c.tl ? c.tl[1] : rr)}` + (c.tl ? `L${x + c.tl[0]},${y}` : arc(x + rr, y)) + 'z';
    // holes an overlay has cut in the tile (el.hpHoles: boxes [x1, y1, x2, y2] that do not overlap): drawn the other way round, so they are left out
    for (const q of i.el.hpHoles || []) path += `M${x + q[0]},${y + q[1]}V${y + q[3]}H${x + q[2]}V${y + q[1]}z`;
  }
  $('blurclip').style.clipPath = $('blurclip').style.webkitClipPath = path ? `path('${path}')` : 'inset(50%)';
}
HP.cut = cut;
/** Slice corners off a real tile, for an overlay that damages the dashboard for show. cuts: {tl, tr, br, bl}, each
 *  [across, down] in pixels measured from that corner; null or {} mends the tile. The tile keeps working: only the
 *  cut-off triangles are gone, and its frosted patch is cut to match. */
HP.chip = (el, cuts) => {
  const c = cuts || {}, w = el.offsetWidth, h = el.offsetHeight, any = c.tl || c.tr || c.br || c.bl;
  el.hpCuts = any ? c : null;
  const pts = [c.tl ? `0 ${c.tl[1]}px, ${c.tl[0]}px 0` : '0 0', c.tr ? `${w - c.tr[0]}px 0, ${w}px ${c.tr[1]}px` : `${w}px 0`,
    c.br ? `${w}px ${h - c.br[1]}px, ${w - c.br[0]}px ${h}px` : `${w}px ${h}px`, c.bl ? `${c.bl[0]}px ${h}px, 0 ${h - c.bl[1]}px` : `0 ${h}px`];
  el.style.clipPath = el.style.webkitClipPath = any ? `polygon(${pts.join(', ')})` : '';
  cut();
};

/** Hand the overlay engine today's overlays for the dashboard on screen. Called again when the day or the weather
 *  changes what should show. */
function fxUse(wait) {
  const p = HP.panels[HP.cur] || {}, list = HP.fx.pick(HP.design.fx, p.fxlist), sig = JSON.stringify(list);
  if (!wait && sig === fxUse.sig) return;
  fxUse.sig = sig;
  const all = []; HP.panels.forEach(q => q.design.pages.forEach(pg => all.push((q.id || '') + '/' + pg.id)));
  HP.fx.use(list, (p.id || '') + '/' + fxUse.page, wait, all);
}

/** What the overlays know about the world outside: night, sun, weather, temperature, the month. */
function fxWorld() {
  const sun = S.states['sun.sun'], hour = new Date().getHours();
  let wid = null;
  if (HP.panels) HP.panels.some(p => p.design.pages.some(pg => pg.tiles.some(t => t.type === 'weather' && t.entity && (wid = t.entity))));
  const w = S.states[wid] || S.states[Object.keys(S.states).find(k => k.startsWith('weather.'))];
  const temp = w ? w.attributes.temperature : null, freezing = w && /C/.test(w.attributes.temperature_unit || '') ? 0 : 32;
  HP.fx.env({night: sun ? sun.state === 'below_horizon' : hour >= 19 || hour < 7, elevation: sun ? sun.attributes.elevation : null, weather: w ? w.state : null,
    temp, freezing, cold: temp != null && temp <= freezing, month: new Date().getMonth() + 1, date: new Date()});
  HP.fx.lights(HP.live.map(i => i.el.classList.contains('on')));
  if (HP.design && fxUse.page) fxUse();
}

function update() {
  daylight();
  setTimeout(fxWorld, 0);  // after the buttons below have updated their on and off
  for (const i of HP.live) if (i.def.update) { try { i.def.update(i.t, i.body, ctx, i); } catch (e) { console.error('tile ' + i.t.type + ': ' + e.message); if (!i.bad) { i.bad = 1; HP.report('button ' + i.t.type + ': ' + e.message); } } }
  pop.update();
}
/** State changes arrive in bursts; tiles patch their own text and classes, so this is cheap and never eats a tap. */
function dirty() { if (!dirty.t) dirty.t = setTimeout(() => { dirty.t = null; update(); }, 250); }

// ---------- the bar of panels ----------
/** Optional, per device: one tab for each of the device's panels along the top, the current one lit. Tabs are drawn
 *  as buttons, so they take the theme's button design. */
function panelBar() {
  const el = $('tabs'), on = !!HP.bar && HP.panels.length > 1;
  document.body.classList.toggle('hasbar', on);
  // the tabs wear the button design the panel's theme names for the bar
  const bs = Object.assign({}, HP.theme.tile, HP.theme.barStyle), vars = lookVars(bs), css = Object.keys(vars).map(k => k + ':' + vars[k]).join(';');
  const html = on ? HP.panels.map((p, k) => `<div class="tile tap tab${lookClasses(bs)}${k === HP.cur ? ' on' : ''}" data-k="${k}" style="${U.esc(css)}"><div class="fill"></div><div class="tabn">${U.esc(p.name || 'Panel ' + (k + 1))}</div><div class="rim"></div></div>`).join('') : '';
  if (el.innerHTML !== html) el.innerHTML = html;
  if (!el.onclick) el.onclick = e => {
    const t = e.target.closest('.tab'); if (!t) return;
    const k = +t.dataset.k, d = HP.panels[k].design;
    if (k !== HP.cur || HP.stack.length > 1) { HP.stack = [{panel: k, page: d.start || d.pages[0].id}]; show(); }
  };
}

// ---------- wake words ----------
/** Assistant buttons may name a wake word. The tablet listens for those words itself (wake.js) and starts the
 *  button that owns the word, whichever dashboard is showing. */
function wakeSetup() {
  if (HP.preview || !HP.server || !HP.wake) return;
  const owners = {};
  HP.panels.forEach(pn => pn.design.pages.forEach(p => p.tiles.forEach(t => { if (t.type === 'assistant' && t.wake && !owners[t.wake]) owners[t.wake] = t; })));
  HP.wake.listen(Object.keys(owners), id => { if (!HP.assist.busy && owners[id]) HP.assist.start(owners[id]); });
}

// ---------- swipe between dashboards ----------
// A tap is a touch that barely moved. A swipe is a long, mostly sideways drag, or a quick flick. Anything in
// between (a hand that slipped on the way to a button) does nothing at all: no button, no page change.
const swipe = {active: false, s: null, quiet: 0};
/** Every dashboard of every panel on this device, in order: swiping past a panel's last dashboard enters the next panel. */
function swipePages() {
  if (!HP.design || HP.stack.length !== 1) return [];
  const out = [];
  HP.panels.forEach((pn, k) => pn.design.pages.forEach(p => out.push({panel: k, id: p.id})));
  return out;
}
function slide(px, ms) {
  const t = ms ? `transform ${ms}ms cubic-bezier(.2,.7,.2,1)` : '';
  $('grid').style.transition = $('blurclip').style.transition = $('blur').style.transition = $('fx').style.transition = t;
  $('grid').style.transform = $('blurclip').style.transform = $('fx').style.transform = px ? `translate3d(${px}px,0,0)` : '';  // the overlays ride along with their tiles
  $('blur').style.transform = `translate3d(${-px}px,0,0) scale(1.1)`;  // the frosted backdrop stays put while its cut-outs travel
}
function swipeSetup() {
  const g = $('grid');
  g.addEventListener('pointerdown', e => { if (e.isPrimary && !swipe.turning) swipe.s = {x: e.clientX, y: e.clientY, t: performance.now(), moved: 0}; });
  window.addEventListener('pointermove', e => {
    const s = swipe.s; if (!s) return;
    const dx = e.clientX - s.x, dy = e.clientY - s.y;
    s.moved = Math.max(s.moved, Math.abs(dx), Math.abs(dy)); s.dx = dx;
    if (!swipe.active && Math.abs(dx) > 26 && Math.abs(dx) > Math.abs(dy) * 1.8 && swipePages().length > 1) { swipe.active = true; document.body.classList.add('swiping'); HP.fx.swipe(dx < 0 ? -1 : 1); }
    if (swipe.active) slide(dx * 0.92);
  });
  const end = () => {
    const s = swipe.s; if (!s) return;
    swipe.s = null;
    if (s.moved > 10) swipe.quiet = performance.now() + 400;  // this touch was not a tap
    if (!swipe.active) return;
    const dx = s.dx || 0, fast = Math.abs(dx) / (performance.now() - s.t) > 0.55 && Math.abs(dx) > 70;
    // round and round: past the last dashboard of the last panel comes the first again
    const pages = swipePages(), at = pages.findIndex(p => p.panel === HP.cur && p.id === HP.stack[0].page), next = pages[(at + (dx < 0 ? 1 : -1) + pages.length) % pages.length];
    if (next && (Math.abs(dx) > innerWidth * 0.25 || fast)) {
      swipe.turning = true;
      const dir = dx < 0 ? -1 : 1;
      slide(dir * innerWidth, 180);
      setTimeout(() => {
        HP.stack = [{panel: next.panel, page: next.id}]; show();
        slide(-dir * innerWidth); void $('grid').offsetWidth;  // start the new dashboard off-screen on the other side
        slide(0, 240);
        setTimeout(() => { swipe.turning = swipe.active = false; document.body.classList.remove('swiping'); slide(0); }, 260);
      }, 190);
    } else {
      slide(0, 200);
      setTimeout(() => { swipe.active = false; document.body.classList.remove('swiping'); slide(0); }, 210);
    }
  };
  window.addEventListener('pointerup', end); window.addEventListener('pointercancel', end);
  // Capture phase: a touch that travelled never reaches a button.
  g.addEventListener('click', e => { if (performance.now() < swipe.quiet) { e.stopPropagation(); e.preventDefault(); } }, true);
}

// ---------- small UI ----------
function toast(text) { const b = $('bar'); b.textContent = text; clearTimeout(toast.t); toast.t = setTimeout(() => { b.textContent = ''; }, 5000); }
HP.toast = toast;
// Own dialog: the web view has no built-in confirm().
function confirmBox(text, yes, no) {
  const m = $('modal');
  m.innerHTML = `<div class="box"><div class="q">${U.esc(text)}</div><div class="row"><div class="mb" data-m="no">${no || 'Cancel'}</div><div class="mb go" data-m="yes">Yes</div></div></div>`;
  m.className = 'open';
  m.onclick = e => { const b = e.target.closest('[data-m]'); if (!b && e.target !== m) return; m.className = ''; if (b && b.dataset.m === 'yes') yes(); };
}
HP.confirm = confirmBox;
/** Asks for the code of a lock or an alarm. Home Assistant checks it: a wrong one comes back as its own message. */
HP.pin = (name, ok) => {
  const m = $('modal'), DEL = '<svg viewBox="0 0 24 24"><path d="M9 5h12v14H9l-6-7z M12 9l6 6 M18 9l-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/></svg>';
  let pin = '';
  m.innerHTML = `<div class="box"><div class="q">Enter PIN</div><div class="sub">${U.esc(name)}</div><div class="pin"></div><div class="keys">`
    + [1, 2, 3, 4, 5, 6, 7, 8, 9, '', 0, 'del'].map(k => k === '' ? '<div></div>' : `<div class="key" data-k="${k}">${k === 'del' ? DEL : k}</div>`).join('')
    + '</div><div class="row"><div class="mb" data-m="no">Cancel</div><div class="mb go" data-m="yes">OK</div></div></div>';
  m.className = 'open';
  m.onclick = e => {
    const k = e.target.closest('[data-k]'), b = e.target.closest('[data-m]');
    if (k) { pin = k.dataset.k === 'del' ? pin.slice(0, -1) : (pin + k.dataset.k).slice(0, 12); m.querySelector('.pin').textContent = '•'.repeat(pin.length); return; }
    if ((!b && e.target !== m) || (b && b.dataset.m === 'yes' && !pin)) return;
    m.className = ''; if (b && b.dataset.m === 'yes') ok(pin);
  };
};

/** Save the lights of a room or a floor, as they are now, as a scene in Home Assistant: a new one by the name typed
 *  on the device's own keyboard, or over one of that place's scenes. The Workshop does the saving (the panel holds
 *  no Home Assistant token); scope is 'area:<id>' or 'floor:<id>'. */
HP.saveScene = scope => {
  const m = $('modal'), key = scope.slice(scope.indexOf(':') + 1), areas = scope.startsWith('floor:') ? Object.keys(S.floor || {}).filter(a => S.floor[a] === key) : [key];
  // only scenes Home Assistant's editor made can be written over: they carry an id
  const scenes = Object.keys(S.states).filter(e => e.startsWith('scene.') && S.reg[e] && areas.includes(S.reg[e].area) && S.states[e].attributes.id).sort();
  m.innerHTML = '<div class="box"><div class="q">Save scene</div><input class="tin" data-r="1" placeholder="Name" maxlength="80" autocomplete="off">'
    + (scenes.length ? '<div class="sub2">Replace</div><div class="slist">' + scenes.map(e => `<div class="mb" data-m="rep" data-e="${U.esc(e)}">${U.esc(U.fname(e))}</div>`).join('') + '</div>' : '')
    + '<div class="row"><div class="mb" data-m="no">Cancel</div><div class="mb go" data-m="yes">Save</div></div></div>';
  m.className = 'open';
  const send = body => fetch(HP.server + '/api/scene', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + HP.key}, body: JSON.stringify(Object.assign({scope}, body))})
    .then(async r => { if (!r.ok) throw new Error(await r.text()); toast('Scene saved'); HP.loadScenes(); }).catch(e => toast(e.message));
  m.onclick = e => {
    const b = e.target.closest('[data-m]'), inp = m.querySelector('.tin'), what = b && b.dataset.m;
    if (e.target === inp || (what === 'yes' && !inp.value.trim())) return inp.focus();  // the device's keyboard comes up
    if (!b && e.target !== m) return;
    m.className = '';
    if (what === 'yes') send({name: inp.value.trim()});
    else if (what === 'rep') confirmBox(`This will replace ${U.fname(b.dataset.e)}. Are you sure?`, () => send({replace: b.dataset.e}), 'No');
  };
};

/** One value typed on the device's own keyboard, or picked with its own time and date pickers (type: text, time,
 *  date, datetime-local). */
HP.textBox = (title, value, type, ok) => {
  const m = $('modal');
  m.innerHTML = `<div class="box"><div class="q">${U.esc(title)}</div><input class="tin" data-r="1" type="${type}" autocomplete="off"><div class="row"><div class="mb" data-m="no">Cancel</div><div class="mb go" data-m="yes">OK</div></div></div>`;
  const inp = m.querySelector('.tin'); inp.value = value == null || value === 'unknown' ? '' : value;
  m.className = 'open';
  m.onclick = e => {
    const b = e.target.closest('[data-m]');
    if (e.target === inp) return inp.focus();
    if (!b && e.target !== m) return;
    m.className = ''; if (b && b.dataset.m === 'yes') ok(inp.value);
  };
};

// ---------- scenes ----------
/** Home Assistant keeps no "scene in use": a scene only knows when it was last set. So a scene counts as in use
 *  while the lights are as it sets them, and stops the moment one of them is changed. What each scene sets comes
 *  from the Workshop (HP.scenes: {scene: [{e, on, bri, mode, k, hs, rgb}]}), read again when scenes come or go. */
HP.scenes = {};
HP.loadScenes = () => {
  clearTimeout(HP.loadScenes.t);
  HP.loadScenes.t = setTimeout(() => { if (!HP.server || !HP.key) return;
    fetch(HP.server + '/api/scenes', {headers: {Authorization: 'Bearer ' + HP.key}}).then(r => r.ok ? r.json() : null).then(j => { if (j) { HP.scenes = j; dirty(); } }).catch(() => {}); }, 1500);
};
/** A scene set from this panel shows at once; the lights get a few seconds to arrive there before they are compared. */
HP.sceneMark = id => { HP.sceneSet = {id, until: Date.now() + 8000}; dirty(); setTimeout(dirty, 8300); };
HP.sceneActive = id => {
  if (HP.sceneSet && HP.sceneSet.id === id && Date.now() < HP.sceneSet.until) return true;
  const near = (a, b, by) => Math.abs(a - b) <= by;
  let seen = 0;
  for (const l of HP.scenes[id] || []) {
    const s = S.states[l.e]; if (!s || s.state === 'unavailable') continue;  // a light that is away does not decide
    const a = s.attributes; seen++;
    if ((s.state === 'on') !== l.on) return false;
    if (!l.on) continue;
    // lights answer with values a little off what they were sent, so near is enough
    if (l.bri != null && a.brightness != null && !near(a.brightness, l.bri, 10)) return false;
    if (l.mode === 'color_temp') { if (a.color_mode !== 'color_temp' || (l.k && a.color_temp_kelvin && !near(a.color_temp_kelvin, l.k, 150))) return false; }
    else if (l.hs && a.hs_color) {
      const turn = Math.abs(a.hs_color[0] - l.hs[0]);
      if (a.color_mode === 'color_temp' || !near(a.hs_color[1], l.hs[1], 8) || (l.hs[1] > 5 && Math.min(turn, 360 - turn) > 8)) return false;
    }
  }
  return seen > 0;
};

// ---------- popup tile ----------
/** A button's settings, drawn above the dashboard and its overlays; questions (above) come over it. One at a time.
 *  It closes by its X, by a touch outside it (which reaches nothing underneath), by Back, or after 30 seconds left alone.
 *  build(body, head) fills it and returns a function that redraws it from the house's state and gives the line under the name. */
const pop = HP.pop = {
  el: null, cur: null, t: 0,
  layer() {
    const p = pop.el || (pop.el = $('pop') || document.body.appendChild(Object.assign(document.createElement('div'), {id: 'pop'})));
    if (!p.onclick) { p.onclick = e => { if (e.target === p || e.target.closest('.px')) pop.close(); }; p.addEventListener('pointerdown', pop.touch); }
    return p;
  },
  /** A list that drops from a tile, for a tile that is a choice and not a switch. It is on the popup's layer and
   *  closes the same ways, and it wears the tile's own look. items: [[id, text]]; now: the id in use. */
  menu(anchor, items, now, pick) {
    const p = pop.layer(), r = anchor.getBoundingClientRect(), up = r.top + r.height / 2 > innerHeight / 2, cs = getComputedStyle(anchor), w = Math.max(r.width, 240);
    p.innerHTML = '<div class="mlist">' + items.map(([id, text]) => `<div data-r="1" data-id="${U.esc(id)}"${id === now ? ' class="cur"' : ''}>${U.esc(text)}</div>`).join('') + '</div>';
    const l = p.firstChild;
    LOOK_VARS.forEach(k => { const v = cs.getPropertyValue(k); if (v) l.style.setProperty(k, v); });
    l.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px'; l.style.width = w + 'px';
    // towards the middle of the screen, so a tile at the bottom opens upward
    if (up) { l.style.bottom = innerHeight - r.top + 6 + 'px'; l.style.maxHeight = r.top - 14 + 'px'; } else { l.style.top = r.bottom + 6 + 'px'; l.style.maxHeight = innerHeight - r.bottom - 14 + 'px'; }
    l.onclick = e => { const o = e.target.closest('[data-id]'); if (o) { pop.close(); pick(o.dataset.id); } };
    pop.cur = () => ''; p.className = 'open menu'; pop.touch();
  },
  open(name, build) {
    const p = pop.layer();
    p.innerHTML = '<div class="box"><div class="ph"><div class="pn"><div></div><div class="ps"></div></div><div class="rb px" data-r="1"><svg viewBox="0 0 24 24"><path d="M19 6.4 17.6 5 12 10.6 6.4 5 5 6.4 10.6 12 5 17.6 6.4 19 12 13.4 17.6 19 19 17.6 13.4 12z"/></svg></div></div><div class="pb"></div></div>';
    p.querySelector('.pn').firstChild.textContent = name;
    pop.cur = build(p.querySelector('.pb'), p.querySelector('.ph')) || (() => '');
    p.className = 'open'; pop.update(); pop.touch();
  },
  update() { if (!pop.cur) return; try { const text = pop.cur() || '', line = pop.el.querySelector('.ps'); if (line) line.textContent = text; } catch (e) { console.error('popup: ' + e.message); pop.close(); } },
  touch() { clearTimeout(pop.t); pop.t = setTimeout(pop.close, 30000); },
  close() { if (!pop.cur) return; pop.cur = null; clearTimeout(pop.t); pop.el.className = ''; pop.el.innerHTML = ''; },
};

// ---------- boot ----------
const keep = {  // survives restarts, so the panel still draws its last design when the server is away
  get(k) { try { return JSON.parse(localStorage.getItem('hp:' + k)); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem('hp:' + k, JSON.stringify(v)); } catch (e) {} },
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
function splash(title, text) {
  $('splash').innerHTML = title ? `<div><div class="st">${U.esc(title)}</div><div class="sx">${U.esc(text || '')}</div></div>` : '';
  $('splash').className = title ? 'open' : '';
  if (title && window.HP_ENGINE) HP_ENGINE.ok();  // waiting for approval or for a panel is a working engine too
}

async function loadAll() {
  const ha = HP.ha, [areas, devices, ents, states] = await Promise.all([
    ha.call({type: 'config/area_registry/list'}), ha.call({type: 'config/device_registry/list'}),
    ha.call({type: 'config/entity_registry/list'}), ha.call({type: 'get_states'})]);
  S.areas = {}; S.floor = {}; areas.forEach(a => { S.areas[a.area_id] = a.name; S.floor[a.area_id] = a.floor_id || null; });
  keep.set('areas', S.areas);  // room names for the next start, in case Home Assistant is away then
  const dev = {}; devices.forEach(d => { dev[d.id] = d.area_id; });
  S.reg = {}; ents.forEach(e => { S.reg[e.entity_id] = {area: e.area_id || dev[e.device_id] || null, dev: e.device_id || null, plat: e.platform || null, skip: !!(e.hidden_by || e.entity_category || e.disabled_by)}; });
  S.states = {}; states.forEach(s => { S.states[s.entity_id] = s; });
  await ha.subscribe({type: 'subscribe_events', event_type: 'state_changed'}, ev => {
    const d = ev.data;
    if (d.new_state) S.states[d.entity_id] = d.new_state; else delete S.states[d.entity_id];
    if (d.entity_id.startsWith('scene.') && (!d.new_state || !d.old_state)) HP.loadScenes();  // a scene was made, changed or removed
    dirty();
  });
  HP.ready = true;
  HP.loadScenes();
  if (HP.design) show();
}

/** Put a design on screen. Called at start, when the server says it changed, and by the Studio while editing.
 *  rec is the theme the panel follows, if any (see resolveTheme). */
HP.setDesign = (d, page, rec) => HP.setPanels([{id: '', design: d, theme: rec}], page);
/** A device holds one or more panels, each {id, design, theme}. startId names its default: where it starts.
 *  When the list changes while running, the screen stays on the dashboard it was showing if that still exists. */
HP.setPanels = (list, page, startId) => {
  const was = HP.panels && HP.stack[0] ? {id: (HP.panels[HP.stack[0].panel || 0] || {}).id, page: HP.stack[0].page} : null;
  HP.panels = list; HP.cur = -1;
  let k = Math.max(0, list.findIndex(p => p.id === startId)), pg = page;
  const home = k;
  if (!pg && was) { const i = list.findIndex(p => p.id === was.id); if (i >= 0 && list[i].design.pages.some(x => x.id === was.page)) { k = i; pg = was.page; } }
  const d = list[k].design;
  HP.stack = [{panel: k, page: pg || (k === home && HP.startPage) || d.start || d.pages[0].id}];
  splash();
  show();  // without Home Assistant yet, tiles draw in their offline state rather than leaving the screen blank
  wakeSetup();
  if (window.HP_ENGINE) HP_ENGINE.ok();
};

function connectHA(url, token) {
  HP.ha = new HA(url, token);
  HP.ha.onstate = s => { if (s === 'online') $('bar').textContent = ''; else toast((HP.server ? 'Daedalus Workshop: ' : 'Home Assistant: ') + s); console.log('HA ' + s); };
  HP.ha.onready = () => loadAll().catch(e => toast('load failed: ' + e.message));
  HP.ha.connect();
}

/** Tell the Studio's log what went wrong here (or that all is well): nobody can open a console on a wall tablet. */
HP.report = text => { if (HP.server && HP.key && !HP.preview) fetch(HP.server + '/api/log', {method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + HP.key}, body: JSON.stringify({text})}).catch(() => {}); };
window.addEventListener('error', e => HP.report('script error: ' + e.message + ' @' + String(e.filename || '').split('/').pop() + ':' + e.lineno));
window.addEventListener('unhandledrejection', e => HP.report('failed: ' + (e.reason && e.reason.message || e.reason)));

/** Normal mode: everything comes from Daedalus Workshop (the HA add-on). */
async function serverMode(server, cfg) {
  HP.server = server; keep.set('server', server);
  const auth = () => ({headers: {Authorization: 'Bearer ' + HP.key}});
  const pull = async () => {
    const r = await fetch(server + '/api/design' + (cfg.design ? '?design=' + encodeURIComponent(cfg.design) : ''), auth());
    if (r.status === 401) { keep.set('key', null); location.reload(); return; }  // approval was withdrawn: start over
    const j = await r.json();
    HP.startPage = j.tablet && j.tablet.start_page; HP.bar = !!(j.tablet && j.tablet.bar);
    const panels = j.panels || (j.design ? [{id: j.id || '', design: j.design, theme: j.theme}] : []);
    if (!panels.length && cfg.preview) return;  // the Studio is about to send one itself
    if (!panels.length) return splash('No panel yet', 'Choose one for "' + ((j.tablet && j.tablet.name) || 'this device') + '" in Daedalus Workshop.');
    keep.set('panels', panels); keep.set('start', j.id || null);
    HP.setPanels(panels, null, j.id);
    HP.report('engine ' + (window.HP_ENGINE ? HP_ENGINE.version : 'none') + ', drew ' + HP.live.length + ' buttons, ' + innerWidth + 'x' + innerHeight + (HP.orb ? '' : ', orb missing') + (HP.assist ? '' : ', assistant missing'));
  };

  HP.key = cfg.key || null;
  while (!HP.key) {  // say hello until someone approves this tablet in the Studio
    try {
      const dev = Object.assign({width: innerWidth, height: innerHeight, scale: devicePixelRatio}, HP.device);
      const r = await (await fetch(server + '/api/hello', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(dev)})).json();
      if (r.status === 'approved') HP.key = r.key;
      else splash('Waiting for approval', 'Open Daedalus Workshop in Home Assistant and approve "' + r.name + '".');
    } catch (e) {
      if (keep.get('key')) HP.key = keep.get('key');  // server away: carry on with what we had
      else splash('Looking for Daedalus Workshop', server);
    }
    if (!HP.key) await sleep(4000);
  }
  keep.set('key', HP.key);
  if (window.HP_ENGINE) HP_ENGINE.check(server);

  if (keep.get('panels') && !cfg.preview) HP.setPanels(keep.get('panels'), null, keep.get('start'));  // last known panels at once, fresh ones right after
  connectHA(server, HP.key);
  pull().catch(e => { if (!HP.design) splash('Cannot reach Daedalus Workshop', e.message); });

  if (cfg.preview) {  // the Studio sends unsaved edits straight in
    window.addEventListener('message', ev => {
      const m = ev.data || {}; if (m.type !== 'hp-design') return;
      // the Studio's theme pages also want to see the panel bar: m.bar is a list of tab names to show over the same design
      HP.bar = !!m.bar;
      HP.fx.demo = !!m.demo;
      HP.fx.preview(m.grow == null ? null : m.grow);  // show growing overlays at a chosen point of their cycle
      if (m.bar) HP.setPanels(m.bar.map((name, k) => ({id: 'demo' + k, name, design: m.design, theme: m.theme})), m.page); else HP.setPanels([{id: '', design: m.design, theme: m.theme, fxlist: m.fxlist}], m.page);
    });
    if (window.parent !== window) window.parent.postMessage({type: 'hp-ready'}, '*');
    return;
  }
  let ws = null;
  (function listen() {  // the server says when this tablet's design changed
    const w = ws = new WebSocket(server.replace(/^http/, 'ws') + '/api/events?key=' + encodeURIComponent(HP.key));
    w.onopen = () => pull().catch(() => {});  // on connect too: catches changes made while the server was away
    // a message is "your design changed", or an overlay event set off by hand in Daedalus Workshop
    w.onmessage = ev => { let m = null; try { m = JSON.parse(ev.data); } catch (e) {} if (m && m.type === 'fx') HP.fx.fire(m.kind, m.event); else pull().catch(() => {}); };
    w.addEventListener('open', () => HP_ENGINE.check(server));  // the add-on restarts when it is updated: that is when a new engine appears
    w.onclose = () => { if (ws === w) { ws = null; setTimeout(listen, 5000); } };
  })();
  // Belt and braces: once a tablet was seen to miss an update because the reopening above never came. Every minute,
  // ask for a newer engine anyway, and if the connection is neither open nor on its way, start it again.
  setInterval(() => {
    if (window.HP_ENGINE) HP_ENGINE.check(server);
    if (ws && ws.readyState > 1) { const dead = ws; ws = null; try { dead.close(); } catch (e) {} setTimeout(() => { if (!ws) location.reload(); }, 8000); }
  }, 60000);
}

native('ping').then(async m => {
  const cfg = m.config || {};
  HP.device = m.device || {}; HP.preview = !!cfg.preview;
  S.areas = keep.get('areas') || {};
  swipeSetup();
  setInterval(dirty, 20000);  // keeps clocks current
  let server = cfg.server;
  if (!server) {
    try { const s = ((await native('discover', {}, 6000)).servers || [])[0]; if (s) server = 'http://' + s.host + ':' + s.port; } catch (e) { console.log('discover: ' + e.message); }
  }
  server = server || keep.get('server');
  if (server) return serverMode(server.replace(/\/$/, ''), cfg);

  // No server known: draw the design bundled with the app and talk to Home Assistant directly.
  if (!window.HP_DESIGN) return splash('Looking for Daedalus Workshop', 'No server found on the network yet.');
  if (!cfg.ha_url || !cfg.ha_token) return splash('Not set up', 'No Daedalus Workshop found and no Home Assistant address in config.json.');
  HP.startPage = cfg.start_page;
  HP.setDesign(window.HP_DESIGN);
  connectHA(cfg.ha_url, cfg.ha_token);
}).catch(e => splash('Cannot start', e.message));
