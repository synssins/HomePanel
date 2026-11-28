'use strict';
// Built-in tile types. A tile type is a plugin: HP.tile(name, {create, update, tap}).
//   create(t, body, ctx, inst) -> optional data object (may carry destroy())   builds the DOM once
//   update(t, body, ctx, inst)                                                patches it on state changes
//   tap(t, ctx, inst) -> function to run, or null                             what a touch does
// "t" is the tile's entry from the design file; inst.el is the tile element (add class "on" for the lit look).
(() => {
  const U = HP.util, st = U.st;

  HP.tile('label', {
    create(t, body) { body.innerHTML = `<div class="big" style="font-size:${(t.size || 0.5) * 100}%;text-align:${t.align || 'left'}">${U.esc(t.text || '')}</div>`; },
  });

  HP.tile('image', {create() {}});  // the picture is the tile's style.image

  HP.tile('clock', {
    create(t, body) { body.innerHTML = '<div class="time"></div><div class="date"></div>'; },
    update(t, body) {
      const now = new Date();
      U.set(body.firstChild, now.toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'}).replace(/\s?[AP]M$/i, ''));
      U.set(body.lastChild, now.toLocaleDateString([], {weekday: 'long', month: 'long', day: 'numeric'}));
    },
  });

  // shortcut: the starter icon set has three sky icons; everything that is not clear shows the cloud until the full set ships.
  const SKY = {sunny: 'weather-sunny', 'clear-night': 'weather-night'};
  HP.tile('weather', {
    create(t, body, ctx, i) { i.p = U.card(body, 'weather-cloudy'); },
    update(t, body, ctx, i) {
      const w = st(t.entity); if (!w) return;
      const ic = U.icon(SKY[w.state] || 'weather-cloudy'); if (i.p.ic.innerHTML !== ic) i.p.ic.innerHTML = ic;
      U.set(i.p.n, Math.round(w.attributes.temperature) + '°');
      U.set(i.p.l, ({partlycloudy: 'Partly cloudy', 'clear-night': 'Clear'})[w.state] || U.cap(w.state));
    },
  });

  HP.tile('people', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'account-multiple'); },
    update(t, body, ctx, i) {
      const ps = (t.entities || []).filter(st), first = p => U.fname(p).split(' ')[0];
      const home = ps.filter(p => st(p).state === 'home'), away = ps.filter(p => st(p).state !== 'home');
      U.set(i.p.n, home.length === ps.length ? 'Everyone home' : home.length ? home.map(first).join(', ') + ' home' : 'Nobody home');
      U.set(i.p.l, away.map(p => first(p) + ': ' + (st(p).state === 'not_home' ? 'away' : st(p).state)).join(', '));
    },
  });

  // Shows only when something is wrong; hidden otherwise.
  HP.tile('alerts', {
    create(t, body, ctx, i) { i.p = U.card(body, 'alert'); i.el.classList.add('warn'); },
    update(t, body, ctx, i) {
      const bad = (t.alerts || []).filter(a => st(a.entity) && st(a.entity).state === a.bad).map(a => a.text);
      const off = Object.keys(t.offline || {}).filter(e => !U.avail(e)).map(e => t.offline[e]);
      const hide = !bad.length && !off.length;
      if (i.el.hidden !== hide) { i.el.hidden = hide; ctx.relayout(); }
      i.el.classList.toggle('alert', bad.length > 0);
      U.set(i.p.n, bad.length ? bad.join(' · ') : 'Offline');
      U.set(i.p.l, off.length ? (bad.length ? 'Offline: ' : '') + off.join(', ') : '');
    },
  });

  // ---------- what a touch does, by what the thing is ----------
  const DOMAIN_ICON = {light: 'lightbulb', switch: 'power', fan: 'power', input_boolean: 'power', cover: 'garage', lock: 'lock', alarm_control_panel: 'shield', vacuum: 'robot-vacuum', lawn_mower: 'robot-vacuum', media_player: 'play', camera: 'video',
    scene: 'star', script: 'star', button: 'gesture-tap', input_button: 'gesture-tap', climate: 'thermometer', person: 'account-multiple', weather: 'weather-cloudy'};
  /** Locks, doors and alarms ask before they act: for the code where Home Assistant wants one, else yes or no (when
   *  there is a question to ask). A panel can switch the asking off (design.guard === false, the Studio's Dashboard
   *  tab); a code Home Assistant insists on is then Home Assistant's to refuse. */
  const guard = (name, question, needsCode, run) => HP.design.guard === false ? run() : needsCode ? HP.pin(name, run) : question ? HP.confirm(question, run, 'No') : run();
  const withCode = code => code ? {code} : {};
  const DOORS = ['garage', 'door', 'gate'];
  /** Used by the single button and by each thing on a button that holds several. name is the button's own name for it. */
  HP.act = (e, ctx, name, el) => {
    const dom = e.split('.')[0], s = st(e), a = s ? s.attributes : {}, nm = name || U.fname(e);
    if (dom === 'light') return lightCan(e).dim ? lightPop(e, ctx, nm) : ctx.service('light', 'toggle', e);  // nothing to set on an on/off light: it switches
    if (dom === 'lock') {
      const unlock = s.state === 'locked';  // locking a door that has no code needs no question
      return guard(nm, unlock ? `This will unlock ${nm}. Are you sure?` : null, !!a.code_format, code => ctx.service('lock', unlock ? 'unlock' : 'lock', e, withCode(code)));
    }
    if (dom === 'cover' && DOORS.includes(a.device_class)) {
      const open = s.state !== 'open' && s.state !== 'opening';
      return guard(nm, `This will ${open ? 'open' : 'close'} ${nm}. Are you sure?`, false, () => ctx.service('cover', open ? 'open_cover' : 'close_cover', e));
    }
    if (dom === 'alarm_control_panel') return alarmPop(e, ctx, nm);
    if (dom === 'climate') return climatePop(e, ctx, nm);
    if (dom === 'media_player') return mediaPop(e, ctx, nm);
    // a blind or a fan with something to set opens its controls; one that only opens and closes, or switches, does that
    if (dom === 'cover') return (a.supported_features || 0) & 140 ? coverPop(e, ctx, nm) : ctx.service('cover', s.state === 'open' || s.state === 'opening' ? 'close_cover' : 'open_cover', e);
    if (dom === 'fan' && (a.supported_features || 0) & 15) return fanPop(e, ctx, nm);
    const f = a.supported_features || 0, has = list => list.filter(x => f & x[0]).map(x => x.slice(1));
    if (dom === 'valve') return f & 12 ? coverPop(e, ctx, nm, 'valve') : ctx.service('valve', s.state === 'open' || s.state === 'opening' ? 'close_valve' : 'open_valve', e);
    if (dom === 'number' || dom === 'input_number') return numberPop(e, ctx, nm, dom);
    // a choice drops its list from the button that was touched
    if (dom === 'select' || dom === 'input_select') return el ? HP.pop.menu(el, (a.options || []).map(o => [o, o]), s.state, o => ctx.service(dom, 'select_option', e, {option: o})) : null;
    if (dom === 'text' || dom === 'input_text') return HP.textBox(nm, s.state, 'text', v => ctx.service(dom, 'set_value', e, {value: v}));
    if (dom === 'time') return HP.textBox(nm, s.state.slice(0, 5), 'time', v => v && ctx.service('time', 'set_value', e, {time: v}));
    if (dom === 'date') return HP.textBox(nm, s.state, 'date', v => v && ctx.service('date', 'set_value', e, {date: v}));
    if (dom === 'datetime') return HP.textBox(nm, s.state.slice(0, 16), 'datetime-local', v => v && ctx.service('datetime', 'set_value', e, {datetime: v}));
    if (dom === 'input_datetime') {
      const kind = a.has_date && a.has_time ? 'datetime' : a.has_date ? 'date' : 'time';
      return HP.textBox(nm, kind === 'time' ? s.state.slice(0, 5) : kind === 'date' ? s.state : s.state.replace(' ', 'T').slice(0, 16), kind === 'datetime' ? 'datetime-local' : kind,
        v => v && ctx.service('input_datetime', 'set_datetime', e, {[kind]: v.replace('T', ' ')}));
    }
    if (dom === 'counter') return listPop(e, ctx, nm, dom, [['increment', 'Increment'], ['decrement', 'Decrement'], ['reset', 'Reset']]);
    if (dom === 'timer') return listPop(e, ctx, nm, dom, [['start', 'Start'], ['pause', 'Pause'], ['cancel', 'Cancel'], ['finish', 'Finish']]);
    if (dom === 'lawn_mower') return listPop(e, ctx, nm, dom, has([[1, 'start_mowing', 'Start'], [2, 'pause', 'Pause'], [4, 'dock', 'Dock']]));
    if (dom === 'vacuum') return listPop(e, ctx, nm, dom, has([[8192, 'start', 'Start'], [4, 'pause', 'Pause'], [8, 'stop', 'Stop'], [16, 'return_to_base', 'Dock'], [512, 'locate', 'Locate']]),
      f & 32 && (a.fan_speed_list || []).length ? body => { const d = dropdown(part(body, 'pr'), () => [attr(e, 'fan_speed_list') || [], attr(e, 'fan_speed')], x => ctx.service('vacuum', 'set_fan_speed', e, {fan_speed: x}), null, U.cap);
        return () => { d.firstChild.textContent = attr(e, 'fan_speed') ? U.cap(String(attr(e, 'fan_speed'))) : 'Fan speed'; }; } : null);
    if (dom === 'humidifier') return levelPop(e, ctx, nm, dom, 'humidity', 'min_humidity', 'max_humidity', 0, 100, 'set_humidity', '%', 'available_modes', 'mode', 'set_mode', 'mode', true);
    if (dom === 'water_heater') return levelPop(e, ctx, nm, dom, 'temperature', 'min_temp', 'max_temp', 30, 60, 'set_temperature', '\u00b0', 'operation_list', 'operation_mode', 'set_operation_mode', 'operation_mode', false);
    // loud, or not undone with a second touch: these ask whatever the panel's lock setting says
    if (dom === 'siren' && s.state !== 'on') return HP.confirm(`This will sound ${nm}. Are you sure?`, () => ctx.service('siren', 'turn_on', e), 'No');
    if (dom === 'update') return s.state === 'on' ? HP.confirm(`This will install the update for ${nm}. Are you sure?`, () => ctx.service('update', 'install', e), 'No') : null;
    if (dom === 'remote') return remotePop(e, ctx, nm);
    if (dom === 'scene') HP.sceneMark(e);
    if (dom === 'scene' || dom === 'script') return ctx.service(dom, 'turn_on', e);
    if (dom === 'button' || dom === 'input_button') return ctx.service(dom, 'press', e);
    return ctx.service('homeassistant', 'toggle', e);
  };

  /** A lit light's own colour at its own level as the button's lit fill, where the button design asks for it
   *  (lightState). Off, not a light, or not asked for: the design's own look. */
  function lit(el, e, want) {
    const s = st(e), on = want && s && s.state === 'on' && e.startsWith('light.');
    paint(el, on ? [[s.attributes.rgb_color || WARM, level(s.attributes.brightness)]] : null);
  }
  const WARM = [255, 196, 110], level = b => b == null ? 1 : 0.1 + 0.9 * b / 255;
  /** A button's lit fill from light: stops of [[r, g, b], level 0 to 1]. One stop is a plain fill; several fade into
   *  each other from left to right. null gives the button its design's own look back. */
  function paint(el, stops) {
    const sig = stops ? JSON.stringify(stops) : '';
    if ((el.hpLit || '') === sig) return;
    el.hpLit = sig;
    if (!stops) { ['--fill-on', '--glow-on'].forEach(k => el.style.removeProperty(k)); el.style.color = ''; return; }
    const css = (s, k) => `rgba(${s[0].slice(0, 3).map(Math.round)},${(s[1] * k).toFixed(2)})`;
    el.style.setProperty('--fill-on', stops.length === 1 ? `linear-gradient(155deg, ${css(stops[0], 1)}, ${css(stops[0], 0.86)})` : `linear-gradient(90deg, ${stops.map(s => css(s, 1)).join(', ')})`);
    el.style.setProperty('--glow-on', css(stops[0], 0.5));
    const lum = stops.reduce((n, s) => n + (0.299 * s[0][0] + 0.587 * s[0][1] + 0.114 * s[0][2]) / 255 * s[1], 0) / stops.length;
    el.style.color = lum < 0.55 ? '#fff' : '#1c1408';  // words stay readable on a dim or dark fill
  }
  /** A scene's button is lit while the lights are as the scene sets them (HP.sceneActive). Where the button design
   *  asks for light status, it is lit in the scene's own colours: its lights that are on, one fading into the next. */
  function sceneLook(el, id, want) {
    const on = !!id && HP.sceneActive(id), ls = on && want ? (HP.scenes[id] || []).filter(l => l.on) : [];
    el.classList.toggle('on', on);
    paint(el, ls.length ? ls.map(l => [l.rgb || WARM, level(l.bri)]) : null);
  }
  /** The scenes of a place: all of them, or those of a room ('area:<id>') or of a floor's rooms ('floor:<id>'). */
  const scenesIn = scope => {
    const S = HP.S, key = (scope || '').slice((scope || '').indexOf(':') + 1), areas = !scope ? null : scope.startsWith('floor:') ? Object.keys(S.floor || {}).filter(a => S.floor[a] === key) : [key];
    return Object.keys(S.states).filter(e => e.startsWith('scene.') && U.avail(e) && (!areas || (!!S.reg[e] && areas.includes(S.reg[e].area)))).sort((a, b) => U.fname(a).localeCompare(U.fname(b)));
  };
  const sceneName = (e, scope) => U.short(U.fname(e).split(':').pop().trim(), (scope || '').startsWith('area:') ? HP.S.areas[scope.slice(5)] : '');

  // ---------- controls on a popup tile ----------
  /** A finger moves a control, or the remote does while it holds it. move(x, y): the place inside it, 0 to 1.
   *  nudge(dx, dy): one arrow press. The house is told a few times a second on the way and once more at the end;
   *  for two seconds after, the control keeps the finger's value and not the house's, which is still catching up. */
  function drag(el, move, nudge, send, live) {
    let last = 0, timer = 0;
    const tell = now => { clearTimeout(timer); if (now || performance.now() - last > 300) { last = performance.now(); send(); } else timer = setTimeout(() => tell(true), 300); };
    const hold = () => { el.hpHold = performance.now() + 2000; };
    const at = e => { const r = el.getBoundingClientRect(); hold(); move(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), Math.max(0, Math.min(1, (e.clientY - r.top) / r.height))); };
    el.addEventListener('pointerdown', e => { try { el.setPointerCapture(e.pointerId); } catch (x) {} at(e); if (live !== false) tell(); });
    el.addEventListener('pointermove', e => { if (e.buttons) { at(e); if (live !== false) tell(); } });
    el.addEventListener('pointerup', () => tell(true));
    el.addEventListener('hp-nudge', e => { hold(); nudge(e.detail.dx, e.detail.dy); tell(true); });
  }
  /** A list that opens upward from its well: a light's effects, or a choice kept on the light's own device (a WLED
   *  preset). options() gives [the list, the one in use]. */
  function dropdown(parent, options, pick, mark, show) {
    const d = part(parent, 'dd', '1', '<div class="ddv"></div><div class="ddl"></div>');
    d.onclick = ev => {
      const o = ev.target.closest('.ddl div'), open = d.classList.contains('open');
      parent.querySelectorAll('.dd.open').forEach(x => x.classList.remove('open'));  // one list at a time
      if (o) return pick(o.dataset.v);
      if (open) return;
      const [list, now] = options();
      d.lastChild.innerHTML = list.map(x => `<div data-r="1" data-v="${U.esc(x)}"${x === now ? ' class="cur"' : ''}><span class="dn">${U.esc(show ? show(x) : x)}</span>${mark ? mark(x) : ''}</div>`).join('');
      d.classList.add('open');
    };
    return d;
  }
  const part = (parent, cls, r, html) => { const d = document.createElement('div'); d.className = cls; if (r) d.dataset.r = r; d.innerHTML = html || ''; parent.append(d); return d; };
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  const COLOUR = ['hs', 'xy', 'rgb', 'rgbw', 'rgbww'];
  /** What a light can do, as Home Assistant reports it. Nothing about it is chosen in the Studio. */
  const lightCan = e => { const a = (st(e) || {attributes: {}}).attributes, m = a.supported_color_modes || [];
    return {dim: m.some(x => x !== 'onoff'), ct: m.includes('color_temp') || m.includes('rgbww'), colour: m.some(x => COLOUR.includes(x)), fx: (a.effect_list || []).length > 0}; };
  /** Left to right: level, warm to cool white, colour, with the light's effects under the colour. Only what the light has.
   *  Setting any of them switches an off light on at that value. */
  function lightPop(e, ctx, name, up) {
    const can = lightCan(e), a0 = st(e).attributes, lo = a0.min_color_temp_kelvin || 2000, hi = a0.max_color_temp_kelvin || 6500;
    const call = data => ctx.service('light', 'turn_on', e, data);
    // Each step fades into the next, so a drag reads as one smooth change and not as a row of jumps.
    const fade = data => call(Object.assign(data, {transition: 0.3}));
    // A new white or colour would not show under a running effect: the light's own "no effect" goes with it.
    const NONE = /^(off|none)$/i;
    const tune = data => { const a = st(e).attributes, none = (a.effect_list || []).find(x => NONE.test(x)); return fade(Object.assign(a.effect && none && !NONE.test(a.effect) ? {effect: none} : {}, data)); };
    HP.pop.open(name, (body, head) => {
      const v = {on: false, bri: 0, k: lo, h: 0, s: 0, white: true};  // what the controls show
      const power = part(head, 'rb', '1', U.icon('power')); head.insertBefore(power, head.querySelector('.px'));
      // opened from a group's popup: a way back to the group
      if (up) { const back = part(head, 'rb', '1', FACE.back); head.insertBefore(back, power); back.onclick = up; }
      power.onclick = () => ctx.service('light', 'toggle', e);
      const MARK = '<div class="mark"></div>', y = p => 4 + (100 - p) * 0.92 + '%';  // keeps the mark inside the bar at both ends
      const bri = part(body, 'vbar bri', 'adj', MARK), ct = can.ct ? part(body, 'vbar ct', 'adj', MARK) : null;
      // Choices kept on the same device as the light, as Home Assistant has them: a WLED strip's presets and playlists.
      const reg = HP.S.reg, dev = reg[e] && reg[e].dev;
      const picks = dev ? Object.keys(HP.S.states).filter(id => id.startsWith('select.') && reg[id] && reg[id].dev === dev && !reg[id].skip).sort() : [];
      const side = can.colour || can.fx || picks.length ? part(body, 'pr') : null, wheel = can.colour ? part(side, 'wheel', 'adj', MARK) : null;
      const fx = can.fx ? dropdown(side, () => [st(e).attributes.effect_list || [], st(e).attributes.effect], x => call({effect: x})) : null;
      const sel = picks.map(id => [id, dropdown(side, () => [(st(id) || {attributes: {}}).attributes.options || [], (st(id) || {}).state], x => ctx.service('select', 'select_option', id, {option: x}))]);
      // A group Home Assistant knows the members of: each one under the controls, to open by itself.
      const mem = (Array.isArray(a0.entity_id) ? a0.entity_id : []).filter(st), chips = mem.length ? part(body.parentNode, 'pmem') : null;
      if (chips) { chips.innerHTML = mem.map(() => '<div class="mb" data-r="1"></div>').join(''); chips.onclick = ev => { const k = [...chips.children].indexOf(ev.target.closest('.mb')); if (k < 0 || !U.avail(mem[k])) return;
        // one of the group's lights by itself, with a way back here; a light that only switches, switches
        if (mem[k].startsWith('light.') && lightCan(mem[k]).dim) lightPop(mem[k], ctx, U.fname(mem[k]), () => lightPop(e, ctx, name, up)); else HP.act(mem[k], ctx); }; }
      const place = () => {
        bri.firstChild.style.top = y(v.on ? v.bri : 0);
        // the mark sits on whichever of the two the light is using: the white bar or the colour wheel
        if (ct) { ct.firstChild.hidden = !v.white; ct.firstChild.style.top = y((v.k - lo) / (hi - lo) * 100); }
        if (wheel) { const g = v.h * Math.PI / 180, r = v.s / 2; wheel.firstChild.hidden = v.white && !!ct; wheel.firstChild.style.left = 50 + Math.sin(g) * r + '%'; wheel.firstChild.style.top = 50 - Math.cos(g) * r + '%'; }
      };
      drag(bri, (x, py) => { v.bri = Math.max(1, Math.round((1 - py) * 100)); v.on = true; place(); },
        (dx, dy) => { v.bri = clamp((v.on ? v.bri : 0) - dy * 5, 1, 100); v.on = true; place(); }, () => fade({brightness_pct: v.bri}));
      if (ct) drag(ct, (x, py) => { v.k = Math.round((hi - py * (hi - lo)) / 50) * 50; v.white = v.on = true; place(); },
        (dx, dy) => { v.k = clamp(v.k - dy * 250, lo, hi); v.white = v.on = true; place(); }, () => tune({color_temp_kelvin: v.k}));
      if (wheel) drag(wheel, (px, py) => { v.h = Math.round((Math.atan2(px - 0.5, 0.5 - py) * 180 / Math.PI + 360) % 360); v.s = Math.round(Math.min(1, Math.hypot(px - 0.5, py - 0.5) * 2) * 100); v.white = false; v.on = true; place(); },
        (dx, dy) => { v.h = (v.h + dx * 15 + 360) % 360; v.s = clamp(v.s - dy * 10, 0, 100); v.white = false; v.on = true; place(); }, () => tune({hs_color: [v.h, v.s]}));
      return () => {
        const s = st(e); if (!s) return 'Not found';
        const a = s.attributes, on = s.state === 'on', white = a.color_mode === 'color_temp' || !can.colour;
        if (![bri, ct, wheel].some(c => c && c.hpHold > performance.now())) {
          v.on = on; v.bri = a.brightness ? Math.round(a.brightness / 2.55) : 0; v.white = white;
          if (a.color_temp_kelvin) v.k = clamp(a.color_temp_kelvin, lo, hi);
          if (a.hs_color) { v.h = a.hs_color[0]; v.s = a.hs_color[1]; }
          place();
        }
        power.classList.toggle('lit', on);
        if (fx) fx.firstChild.textContent = on && a.effect && !NONE.test(a.effect) ? a.effect : 'Effect';  // some lights only play an effect once and never report one
        // a choice with nothing chosen shows what it is: "Preset" from select.strip_preset
        sel.forEach(([id, d]) => { const v = (st(id) || {}).state; d.firstChild.textContent = v && v !== 'unknown' && v !== 'unavailable' ? v : U.cap(id.split('_').pop()); });
        if (chips) mem.forEach((m, k) => { const c = chips.children[k], text = U.short(U.fname(m), U.fname(e)); if (c.textContent !== text) c.textContent = text; c.classList.toggle('go', U.active(m)); c.classList.toggle('off', !U.avail(m)); });
        // beside the level: the white a tunable light is at, or its colour as a hex code
        const more = !on ? '' : white && a.color_temp_kelvin ? a.color_temp_kelvin + 'K' : can.colour && a.rgb_color ? '#' + a.rgb_color.map(n => n.toString(16).padStart(2, '0')).join('').toUpperCase() : '';
        return [U.stateLabel(e), more].filter(Boolean).join(' · ');
      };
    });
  }

  // ---------- other things with settings: the same popup, the same controls ----------
  /** A tall bar for one number from lo to hi. get() reads it from the house; set(v) sends it when the finger lets go
   *  (a thermostat or a blind is not sent every value on the way). Returns a function that redraws it and gives its value. */
  function slider(parent, cls, lo, hi, step, get, set) {
    const el = part(parent, 'vbar ' + cls, 'adj', '<div class="mark"></div>'), snap = x => +clamp(Math.round(x / step) * step, lo, hi).toFixed(2);
    let v = null;
    const place = () => { el.firstChild.hidden = v == null; if (v != null) el.firstChild.style.top = 4 + (1 - (v - lo) / (hi - lo)) * 92 + '%'; };
    const moved = () => { place(); HP.pop.update(); };
    drag(el, (x, y) => { v = snap(lo + (1 - y) * (hi - lo)); moved(); }, (dx, dy) => { v = snap((v == null ? lo : v) - dy * step); moved(); },
      () => { el.hpHold = performance.now() + 5000; set(v); }, false);  // slow things take a few seconds to say they have arrived
    return () => { if (!(el.hpHold > performance.now())) { const g = get(); v = g == null || isNaN(g) ? null : clamp(+g, lo, hi); place(); } return v; };
  }
  const powerBtn = (head, press) => { const b = part(head, 'rb', '1', U.icon('power')); head.insertBefore(b, head.querySelector('.px')); b.onclick = press; return b; };
  const attr = (e, k) => st(e) ? st(e).attributes[k] : null;

  /** A thermostat: the temperature it aims for (two bars where it keeps a room between two), and its modes. */
  function climatePop(e, ctx, name) {
    const call = (svc, data) => ctx.service('climate', svc, e, data);
    HP.pop.open(name, body => {
      const a = st(e).attributes, lo = a.min_temp == null ? 7 : a.min_temp, hi = a.max_temp == null ? 35 : a.max_temp, step = a.target_temp_step || 1;
      const both = a.temperature == null && a.target_temp_low != null;
      const bars = both
        ? [slider(body, 'tmp', lo, hi, step, () => attr(e, 'target_temp_low'), v => call('set_temperature', {target_temp_low: v, target_temp_high: attr(e, 'target_temp_high')})),
          slider(body, 'tmp', lo, hi, step, () => attr(e, 'target_temp_high'), v => call('set_temperature', {target_temp_low: attr(e, 'target_temp_low'), target_temp_high: v}))]
        : [slider(body, 'tmp', lo, hi, step, () => attr(e, 'temperature'), v => call('set_temperature', {temperature: v}))];
      const side = part(body, 'pr'), lists = [];
      const list = (label, key, now, svc, field) => { if ((a[key] || []).length) lists.push([label, now, dropdown(side, () => [attr(e, key) || [], now()], x => call(svc, {[field]: x}), null, U.cap)]); };
      list('Mode', 'hvac_modes', () => st(e) && st(e).state, 'set_hvac_mode', 'hvac_mode');
      list('Fan', 'fan_modes', () => attr(e, 'fan_mode'), 'set_fan_mode', 'fan_mode');
      list('Preset', 'preset_modes', () => attr(e, 'preset_mode'), 'set_preset_mode', 'preset_mode');
      if (!lists.length) side.remove();
      return () => {
        const s = st(e); if (!s) return 'Not found';
        const set = bars.map(b => b()).filter(v => v != null).map(v => v + '\u00b0').join(' \u2013 '), is = s.attributes.current_temperature;
        lists.forEach(([label, now, d]) => { d.firstChild.textContent = now() ? label + ': ' + U.cap(String(now())) : label; });
        return [U.cap(s.state), is != null ? 'Now ' + is + '\u00b0' : '', set ? 'Set ' + set : ''].filter(Boolean).join(' \u00b7 ');
      };
    });
  }

  /** A blind, shade or awning: how far open (and how far tilted) where it can be set, and open, stop, close. */
  function coverPop(e, ctx, name, dom) {
    dom = dom || 'cover';
    const call = (svc, data) => ctx.service(dom, svc, e, data);
    HP.pop.open(name, body => {
      const f = st(e).attributes.supported_features || 0, bars = [];
      if (f & 4) bars.push(slider(body, 'lvl', 0, 100, 1, () => attr(e, 'current_position'), v => call('set_' + dom + '_position', {position: v})));
      if (f & 128) bars.push(slider(body, 'lvl', 0, 100, 1, () => attr(e, 'current_tilt_position'), v => call('set_cover_tilt_position', {tilt_position: v})));
      const col = part(body, 'modes side');
      col.innerHTML = [[1, 'open_' + dom, 'Open'], [8, 'stop_' + dom, 'Stop'], [2, 'close_' + dom, 'Close']].filter(b => f & b[0]).map(b => `<div class="mb" data-r="1" data-s="${b[1]}">${b[2]}</div>`).join('');
      col.onclick = ev => { const b = ev.target.closest('[data-s]'); if (b) call(b.dataset.s); };
      return () => { if (!st(e)) return 'Not found'; const v = bars.map(b => b()); return [U.stateLabel(e), v[0] != null ? v[0] + '%' : ''].filter(Boolean).join(' \u00b7 '); };
    });
  }

  /** A fan: its speed, and what else it has of presets, turning from side to side and direction. */
  function fanPop(e, ctx, name) {
    const call = (svc, data) => ctx.service('fan', svc, e, data);
    HP.pop.open(name, (body, head) => {
      const a = st(e).attributes, f = a.supported_features || 0, power = powerBtn(head, () => call('toggle'));
      const speed = f & 1 ? slider(body, 'lvl', 0, 100, a.percentage_step || 1, () => st(e) && st(e).state === 'on' ? attr(e, 'percentage') : 0, v => v > 0 ? call('set_percentage', {percentage: v}) : call('turn_off')) : null;
      const side = f & 14 ? part(body, 'pr') : null;
      const preset = f & 8 && (a.preset_modes || []).length ? dropdown(side, () => [attr(e, 'preset_modes') || [], attr(e, 'preset_mode')], x => call('set_preset_mode', {preset_mode: x}), null, U.cap) : null;
      const osc = f & 2 ? part(side, 'mb', '1', 'Oscillate') : null, dir = f & 4 ? part(side, 'mb', '1') : null;
      if (osc) osc.onclick = () => call('oscillate', {oscillating: !attr(e, 'oscillating')});
      if (dir) dir.onclick = () => call('set_direction', {direction: attr(e, 'direction') === 'reverse' ? 'forward' : 'reverse'});
      return () => {
        const s = st(e); if (!s) return 'Not found';
        const v = speed ? speed() : null, on = s.state === 'on';
        power.classList.toggle('lit', on);
        if (preset) preset.firstChild.textContent = s.attributes.preset_mode ? U.cap(s.attributes.preset_mode) : 'Preset';
        if (osc) osc.classList.toggle('go', !!s.attributes.oscillating);
        if (dir) dir.textContent = s.attributes.direction === 'reverse' ? 'Reverse' : 'Forward';
        return on && v != null ? Math.round(v) + '%' : U.stateLabel(e);
      };
    });
  }

  const PREV = '<svg viewBox="0 0 24 24"><path d="M18 5l-9 7 9 7zM6 5h2v14H6z"/></svg>', NEXT = '<svg viewBox="0 0 24 24"><path d="M6 5l9 7-9 7zM16 5h2v14h-2z"/></svg>',
    MUTE = '<svg viewBox="0 0 24 24"><path d="M4 9h4l5-4v14l-5-4H4zM16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
  /** A player: what it plays, its volume, back, play or pause, on, mute, and where it plays from. Only what it has. */
  function mediaPop(e, ctx, name) {
    const call = (svc, data) => ctx.service('media_player', svc, e, data);
    HP.pop.open(name, (body, head) => {
      const a = st(e).attributes, f = a.supported_features || 0, power = f & 384 ? powerBtn(head, () => call('toggle')) : null;
      const vol = f & 4 ? slider(body, 'lvl', 0, 100, 1, () => { const v = attr(e, 'volume_level'); return v == null ? null : Math.round(v * 100); }, v => call('volume_set', {volume_level: v / 100})) : null;
      const side = part(body, 'pr'), art = part(side, 'art', '1'), row = part(side, 'trow');
      art.onclick = () => { if (f & 131072) browse(e, ctx, name); };
      row.innerHTML = (f & 16 ? `<div class="rb" data-r="1" data-b="prev">${PREV}</div>` : '') + (f & 16385 ? '<div class="rb" data-r="1" data-b="play"></div>' : '')
        + (f & 32 ? `<div class="rb" data-r="1" data-b="next">${NEXT}</div>` : '') + (f & 8 ? `<div class="rb" data-r="1" data-b="mute">${MUTE}</div>` : '');
      row.onclick = ev => { const b = (ev.target.closest('[data-b]') || {dataset: {}}).dataset.b;
        if (b === 'mute') call('volume_mute', {is_volume_muted: !attr(e, 'is_volume_muted')}); else if (b) call({prev: 'media_previous_track', play: 'media_play_pause', next: 'media_next_track'}[b]); };
      const play = row.querySelector('[data-b=play]'), mute = row.querySelector('[data-b=mute]');
      const src = f & 2048 && (a.source_list || []).length ? dropdown(side, () => [attr(e, 'source_list') || [], attr(e, 'source')], x => call('select_source', {source: x})) : null;
      const mode = f & 65536 && (a.sound_mode_list || []).length ? dropdown(side, () => [attr(e, 'sound_mode_list') || [], attr(e, 'sound_mode')], x => call('select_sound_mode', {sound_mode: x})) : null;
      return () => {
        const s = st(e); if (!s) return 'Not found';
        const x = s.attributes, pic = x.entity_picture || '';
        if (vol) vol();
        if (art.dataset.pic !== pic) { art.dataset.pic = pic; art.hidden = !pic; art.style.backgroundImage = ''; picture(pic, url => { if (url && art.dataset.pic === pic) art.style.backgroundImage = cssUrl(url); }); }
        if (power) power.classList.toggle('lit', s.state !== 'off' && s.state !== 'standby');
        if (play) { const ic = U.icon(s.state === 'playing' ? 'pause' : 'play'); if (play.innerHTML !== ic) play.innerHTML = ic; }
        if (mute) mute.classList.toggle('lit', !!x.is_volume_muted);
        if (src) src.firstChild.textContent = x.source || 'Source';
        if (mode) mode.firstChild.textContent = x.sound_mode || 'Sound mode';
        return [x.media_title, x.media_artist].filter(Boolean).join(' \u00b7 ') || U.cap(s.state);
      };
    });
  }

  /** A number that can be set: one bar over its range. */
  function numberPop(e, ctx, name, dom) {
    HP.pop.open(name, body => {
      const a = st(e).attributes, lo = a.min == null ? 0 : a.min, hi = a.max == null ? 100 : a.max;
      const bar = slider(body, 'lvl', lo, hi, a.step || 1, () => st(e) ? parseFloat(st(e).state) : null, v => ctx.service(dom, 'set_value', e, {value: v}));
      return () => { if (!st(e)) return 'Not found'; const v = bar(), u = st(e).attributes.unit_of_measurement; return v == null ? U.stateLabel(e) : v + (u ? (u.length > 2 ? ' ' : '') + u : ''); };
    });
  }
  /** Something whose controls are a few plain actions: a robot vacuum, a mower, a timer, a counter. build(body) may add more. */
  function listPop(e, ctx, name, dom, acts, build) {
    HP.pop.open(name, body => {
      const col = part(body, 'modes');
      col.innerHTML = acts.map(a => `<div class="mb" data-r="1" data-s="${a[0]}">${a[1]}</div>`).join('');
      col.onclick = ev => { const b = ev.target.closest('[data-s]'); if (b) ctx.service(dom, b.dataset.s, e); };
      const more = build ? build(body) : null;
      return () => { if (!st(e)) return 'Not found'; if (more) more(); return U.stateLabel(e); };
    });
  }
  /** One level and a list of modes, with or without a power button: a humidifier, a water heater. */
  function levelPop(e, ctx, name, dom, key, loKey, hiKey, lo0, hi0, setSvc, unit, listKey, modeKey, modeSvc, modeField, power) {
    const call = (svc, data) => ctx.service(dom, svc, e, data);
    HP.pop.open(name, (body, head) => {
      const a = st(e).attributes, btn = power ? powerBtn(head, () => call('toggle')) : null;
      const bar = slider(body, key === 'temperature' ? 'tmp' : 'lvl', a[loKey] == null ? lo0 : a[loKey], a[hiKey] == null ? hi0 : a[hiKey], a.target_temp_step || 1, () => attr(e, key), v => call(setSvc, {[key]: v}));
      const modes = (a[listKey] || []).length ? dropdown(part(body, 'pr'), () => [attr(e, listKey) || [], attr(e, modeKey)], x => call(modeSvc, {[modeField]: x}), null, U.cap) : null;
      return () => {
        const s = st(e); if (!s) return 'Not found'; const v = bar();
        if (btn) btn.classList.toggle('lit', s.state === 'on');
        if (modes) modes.firstChild.textContent = s.attributes[modeKey] ? U.cap(String(s.attributes[modeKey])) : 'Mode';
        return [U.cap(s.state), v != null ? v + unit : ''].filter(Boolean).join(' \u00b7 ');
      };
    });
  }

  // ---------- remote controls ----------
  // Home Assistant passes a remote's buttons on as words each integration has its own spelling for, and does not say
  // which words a remote knows. So the usual buttons are spelt out here for the usual integrations, from each one's
  // documentation. A remote of another kind shows what Home Assistant does know: power, its activities, and the
  // volume and source of the player on the same device. Add a kind by adding its line.
  const KEYS = {
    androidtv_remote: {up: 'DPAD_UP', down: 'DPAD_DOWN', left: 'DPAD_LEFT', right: 'DPAD_RIGHT', ok: 'DPAD_CENTER', back: 'BACK', home: 'HOME', menu: 'MENU', volup: 'VOLUME_UP', voldown: 'VOLUME_DOWN', mute: 'VOLUME_MUTE', chup: 'CHANNEL_UP', chdown: 'CHANNEL_DOWN', play: 'MEDIA_PLAY_PAUSE'},
    samsungtv: {up: 'KEY_UP', down: 'KEY_DOWN', left: 'KEY_LEFT', right: 'KEY_RIGHT', ok: 'KEY_ENTER', back: 'KEY_RETURN', home: 'KEY_HOME', menu: 'KEY_MENU', volup: 'KEY_VOLUP', voldown: 'KEY_VOLDOWN', mute: 'KEY_MUTE', chup: 'KEY_CHUP', chdown: 'KEY_CHDOWN', play: 'KEY_PLAY', source: 'KEY_SOURCE'},
    roku: {up: 'up', down: 'down', left: 'left', right: 'right', ok: 'select', back: 'back', home: 'home', menu: 'info', volup: 'volume_up', voldown: 'volume_down', mute: 'volume_mute', chup: 'channel_up', chdown: 'channel_down', play: 'play'},
    apple_tv: {up: 'up', down: 'down', left: 'left', right: 'right', ok: 'select', back: 'menu', home: 'home', menu: 'top_menu', volup: 'volume_up', voldown: 'volume_down', play: 'play_pause'},
    braviatv: {up: 'Up', down: 'Down', left: 'Left', right: 'Right', ok: 'Confirm', back: 'Return', home: 'Home', menu: 'Options', volup: 'VolumeUp', voldown: 'VolumeDown', mute: 'Mute', chup: 'ChannelUp', chdown: 'ChannelDown', play: 'Play', source: 'Input'},
    webostv: {up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', ok: 'ENTER', back: 'BACK', home: 'HOME', menu: 'MENU', volup: 'VOLUMEUP', voldown: 'VOLUMEDOWN', mute: 'MUTE', chup: 'CHANNELUP', chdown: 'CHANNELDOWN', play: 'PLAY'},
  };
  const ARROW = turn => `<svg viewBox="0 0 24 24" style="transform:rotate(${turn}deg)"><path d="M7.4 15.4 12 10.8l4.6 4.6L18 14l-6-6-6 6z"/></svg>`;
  const FACE = {up: ARROW(0), right: ARROW(90), down: ARROW(180), left: ARROW(270), ok: 'OK', volup: '+', voldown: '\u2212', chup: '+', chdown: '\u2212', mute: MUTE,
    back: '<svg viewBox="0 0 24 24"><path d="M11 5 4 12l7 7v-4.5h9v-5h-9z"/></svg>', menu: '<svg viewBox="0 0 24 24"><path d="M4 6h16v2.4H4zM4 10.8h16v2.4H4zM4 15.6h16V18H4z"/></svg>'};
  /** A remote control drawn from what its integration takes: volume at the left, the four directions with OK in the
   *  middle (back, home, menu and play in the corners), channels at the right, then sources and activities. A button
   *  the remote has no word for is left out. Volume goes to the player on the same device where there is one, or to
   *  another player the Studio names (a soundbar). A held volume, channel or direction button repeats. */
  function remotePop(e, ctx, name, volume) {
    const reg = HP.S.reg, plat = reg[e] && reg[e].plat, keys = KEYS[plat] || {}, isRemote = e.startsWith('remote.'), bits = id => (id && attr(id, 'supported_features')) || 0;
    const mp = !isRemote ? e : Object.keys(HP.S.states).find(id => id.startsWith('media_player.') && !!reg[id] && !!reg[e] && !!reg[id].dev && reg[id].dev === reg[e].dev) || null;
    const vol = volume && st(volume) ? volume : bits(mp) & 1028 ? mp : null;
    const send = k => plat === 'webostv' ? ctx.service('webostv', 'button', e, {button: keys[k]}) : ctx.service('remote', 'send_command', e, {command: keys[k]});
    const act = {};
    Object.keys(keys).forEach(k => { act[k] = () => send(k); });
    if (vol) { act.volup = () => ctx.service('media_player', 'volume_up', vol); act.voldown = () => ctx.service('media_player', 'volume_down', vol); }
    if (vol && bits(vol) & 8) act.mute = () => ctx.service('media_player', 'volume_mute', vol, {is_volume_muted: !attr(vol, 'is_volume_muted')});
    if (!act.play && bits(mp) & 16385) act.play = () => ctx.service('media_player', 'media_play_pause', mp);
    HP.pop.open(name, (body, head) => {
      const power = powerBtn(head, () => ctx.service(isRemote ? 'remote' : 'media_player', 'toggle', e));
      const key = (k, extra) => act[k] ? `<div class="rb${extra || ''}" data-r="1" data-b="${k}">${k === 'home' ? U.icon('home') : k === 'play' ? U.icon('play') : FACE[k]}</div>` : '<div class="rb none"></div>';
      const rocker = (a, b, word, more) => act[a] || act[b] ? `<div class="rk">${key(a, ' rep')}<span>${word}</span>${key(b, ' rep')}${more && act[more] ? key(more) : ''}</div>` : '';
      const any = ['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'play'].some(k => act[k]);
      body.innerHTML = rocker('volup', 'voldown', 'VOL', 'mute')
        + (any ? '<div class="pad">' + ['back', 'up', 'home', 'left', 'ok', 'right', 'menu', 'down', 'play'].map(k => key(k, k.length < 6 && 'updownleftright'.includes(k) ? ' rep' : '')).join('') + '</div>' : '')
        + rocker('chup', 'chdown', 'CH');
      // a touch presses at once, and a held button repeats; the click that follows a touch is not a second press
      const press = k => { if (act[k]) act[k](); };
      let timer = 0; const stop = () => { clearInterval(timer); clearTimeout(timer); };
      body.addEventListener('pointerdown', ev => { const b = ev.target.closest('[data-b]'); if (!b) return; b.hpDown = performance.now(); press(b.dataset.b); stop();
        if (b.classList.contains('rep')) timer = setTimeout(() => { timer = setInterval(() => { HP.pop.touch(); press(b.dataset.b); }, 260); }, 450); });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(n => body.addEventListener(n, stop));
      body.addEventListener('click', ev => { const b = ev.target.closest('[data-b]'); if (b && !(performance.now() - (b.hpDown || 0) < 800)) press(b.dataset.b); });
      const under = part(body.parentNode, 'rlists');
      const src = bits(mp) & 2048 && (attr(mp, 'source_list') || []).length ? dropdown(under, () => [attr(mp, 'source_list') || [], attr(mp, 'source')], x => ctx.service('media_player', 'select_source', mp, {source: x}))
        : act.source ? Object.assign(part(under, 'mb', '1', 'Source'), {onclick: () => act.source()}) : null;
      const acts = isRemote && (attr(e, 'activity_list') || []).length ? dropdown(under, () => [attr(e, 'activity_list') || [], attr(e, 'current_activity')], x => ctx.service('remote', 'turn_on', e, {activity: x})) : null;
      if (!src && !acts) under.remove();
      return () => {
        const s = st(e); if (!s) return 'Not found';
        power.classList.toggle('lit', s.state !== 'off' && s.state !== 'standby' && s.state !== 'unavailable');
        const mute = body.querySelector('[data-b=mute]'); if (mute) mute.classList.toggle('lit', !!(vol && attr(vol, 'is_volume_muted')));
        if (src && src.classList.contains('dd')) src.firstChild.textContent = attr(mp, 'source') || 'Source';
        if (acts) acts.firstChild.textContent = s.attributes.current_activity || 'Activity';
        return [U.stateLabel(e), (mp && attr(mp, 'source')) || s.attributes.current_activity].filter(Boolean).join(' \u00b7 ');
      };
    });
  }

  /** A picture Home Assistant names: one of its own paths (fetched through the Workshop), or an address elsewhere. */
  /** A picture Home Assistant names, handed to use(url). An address elsewhere is used as it is. One of Home
   *  Assistant's own paths needs leave to be fetched, whichever integration it belongs to: Home Assistant signs a
   *  link for it (good for an hour, kept for most of that). Where it will not sign, the path is tried as it is. */
  const signed = {};
  function picture(p, use) {
    if (!p || /^https?:/.test(p)) return use(p || '');
    const had = signed[p], now = Date.now();
    if (had && had.until > now) return use(had.url);
    HP.ha.call({type: 'auth/sign_path', path: p, expires: 3600}).then(r => { signed[p] = {url: HP.asset(r.path), until: now + 3e6}; use(signed[p].url); }, () => use(HP.asset(p)));
  }
  const cssUrl = u => `url("${u.replace(/"/g, '%22')}")`;
  /** What a player can play, as Home Assistant lists it for that player: folders that open, and things that play.
   *  A folder that can also be played whole (an album, a playlist) carries a play button of its own. Playing closes it. */
  function browse(e, ctx, name) {
    HP.pop.open(name, (body, head) => {
      const back = part(head, 'rb', '1', FACE.back), trail = [];
      head.insertBefore(back, head.querySelector('.px')); body.parentNode.classList.add('wide'); body.className = 'pb bgrid';
      // Search is Home Assistant's: the field shows only where Home Assistant says this folder can be searched, or
      // that this player can search at all, and the looking is done by Home Assistant's own search for that player.
      const bar = document.createElement('div'); bar.className = 'bsearch'; bar.hidden = true;
      bar.innerHTML = '<input class="tin" data-r="1" placeholder="Search" autocomplete="off"><div class="mb" data-r="1">Search</div>';
      body.parentNode.insertBefore(bar, body);
      const find = () => { const q = bar.firstChild.value.trim(), at = trail[trail.length - 1]; if (!q || !at) return;
        HP.ha.call(Object.assign({type: 'media_player/search_media', entity_id: e, search_query: q},
          at.can_search && at.media_content_id ? {media_content_id: at.media_content_id, media_content_type: at.media_content_type, media_filter_classes: at.search_media_classes || undefined} : {}))
          .then(r => { trail.push({title: q, children: (r && r.result) || [], found: true}); bar.firstChild.value = ''; show(); }, err => HP.toast(err.message)); };
      bar.lastChild.onclick = find; bar.firstChild.onclick = () => bar.firstChild.focus();
      bar.firstChild.addEventListener('keydown', ev => { if (ev.key === 'Enter') { ev.stopPropagation(); find(); } });
      const show = () => {
        const kids = trail[trail.length - 1].children || [];
        back.hidden = trail.length < 2;
        const at = trail[trail.length - 1];
        bar.hidden = !!at.found || !(at.can_search || (trail.length === 1 && (attr(e, 'supported_features') || 0) & 4194304));
        body.innerHTML = kids.map((c, k) => `<div class="bi" data-r="1" data-n="${k}"><div class="bth">${c.can_expand ? FOLDER : U.icon('play')}</div><div class="bnm">${U.esc(c.title || '')}</div>`
          + (c.can_expand && c.can_play ? `<div class="rb bplay" data-r="1">${U.icon('play')}</div>` : '') + '</div>').join('');
        const here = trail[trail.length - 1];
        kids.forEach((c, k) => picture(c.thumbnail, pic => { const th = pic && trail[trail.length - 1] === here && body.children[k] && body.children[k].firstChild; if (th) { th.style.backgroundImage = cssUrl(pic); th.innerHTML = ''; } }));
        body.scrollTop = 0; HP.pop.update();
      };
      const open = c => { body.innerHTML = '';
        HP.ha.call(Object.assign({type: 'media_player/browse_media', entity_id: e}, c ? {media_content_id: c.media_content_id, media_content_type: c.media_content_type} : {}))
          .then(node => { trail.push(node); show(); }, err => { HP.toast(err.message); if (!trail.length) HP.pop.close(); else show(); }); };
      body.onclick = ev => {
        const it = ev.target.closest('.bi'); if (!it) return;
        const c = trail[trail.length - 1].children[+it.dataset.n];
        if (c.can_expand && !ev.target.closest('.bplay')) return open(c);
        if (c.can_play) { ctx.service('media_player', 'play_media', e, {media_content_id: c.media_content_id, media_content_type: c.media_content_type}); HP.pop.close(); }
      };
      back.onclick = () => { if (trail.length > 1) { trail.pop(); show(); } };
      open();
      return () => trail.map(n => n.title).filter(Boolean).join(' \u203a ');
    });
  }
  const FOLDER = '<svg viewBox="0 0 24 24"><path d="M3 5h7l2 2.5h9V19H3z"/></svg>';

  // Feature bit, service, label, the state it leads to. Home Assistant's own names for the modes.
  const ARM = [[2, 'arm_away', 'Arm away', 'armed_away'], [1, 'arm_home', 'Arm home', 'armed_home'], [4, 'arm_night', 'Arm night', 'armed_night'],
    [32, 'arm_vacation', 'Arm vacation', 'armed_vacation'], [16, 'arm_custom_bypass', 'Custom bypass', 'armed_custom_bypass'], [0, 'disarm', 'Disarm', 'disarmed']];
  /** The alarm Home Assistant already has, with a face: one button for each mode it offers. Disarming asks first;
   *  arming asks only for a code, and only where Home Assistant wants one to arm.
   *  shortcut: the PIN pad has digits only, an alarm or lock whose code has letters needs a keyboard here. */
  function alarmPop(e, ctx, name) {
    HP.pop.open(name, body => {
      const modes = ARM.filter(m => !m[0] || (st(e).attributes.supported_features & m[0])), box = part(body, 'modes');
      box.innerHTML = modes.map(m => `<div class="mb" data-r="1" data-s="${m[1]}">${m[2]}</div>`).join('');
      box.onclick = ev => {
        const b = ev.target.closest('[data-s]'), a = st(e).attributes; if (!b) return;
        const dis = b.dataset.s === 'disarm';
        guard(name, dis ? `This will disarm ${name}. Are you sure?` : null, !!a.code_format && (dis || a.code_arm_required !== false),
          code => ctx.service('alarm_control_panel', 'alarm_' + b.dataset.s, e, withCode(code)));
      };
      return () => { const s = st(e); if (!s) return 'Not found'; modes.forEach((m, k) => box.children[k].classList.toggle('go', s.state === m[3])); return U.stateLabel(e); };
    });
  }

  HP.tile('entity', {
    create(t, body, ctx, i) {
      i.p = U.card(body, t.icon || DOMAIN_ICON[(t.entity || '').split('.')[0]] || 'lightbulb');
      if (t.battery) { i.bat = document.createElement('div'); i.bat.className = 'batt'; i.bat.hidden = true; body.append(i.bat); }  // its device's battery, in the corner
    },
    update(t, body, ctx, i) {
      U.set(i.p.n, t.name || U.fname(t.entity)); U.set(i.p.l, U.stateLabel(t.entity));
      i.el.classList.toggle('on', U.active(t.entity)); i.el.classList.toggle('off', !U.avail(t.entity));
      i.el.classList.toggle('alert', !!st(t.entity) && st(t.entity).state === 'triggered');
      lit(i.el, t.entity, i.lightState);
      if (i.bat) {
        if (!i.batId && (i.batTry = (i.batTry || 0) + 1) < 4) i.batId = U.battery(t.entity);  // looked for a few times: the house's list may still be arriving
        const v = i.batId && st(i.batId) ? parseFloat(st(i.batId).state) : NaN;
        i.bat.hidden = isNaN(v);
        if (!isNaN(v)) { const text = Math.round(v) + '%'; if (i.bat.textContent !== text) i.bat.textContent = text; i.bat.classList.toggle('low', v <= 20); }
      }
    },
    tap: (t, ctx, i) => U.avail(t.entity) ? () => HP.act(t.entity, ctx, t.name, i.el) : null,
  });
  HP.tile('alarm', HP.tiles.entity);

  // ---------- showing: a value, a gauge, a chart ----------
  /** One thing's state, large: a temperature, a power reading, whether a door is open. Lit while a yes-or-no sensor says yes. */
  HP.tile('value', {
    create(t, body, ctx, i) {
      body.classList.add('val');
      body.innerHTML = `<div class="ic">${U.icon(t.icon || '')}</div><div class="tx"><div class="vv"></div><div class="l"></div></div>`;
      i.p = {v: body.querySelector('.vv'), l: body.querySelector('.l')};
    },
    update(t, body, ctx, i) {
      U.set(i.p.v, U.stateLabel(t.entity)); U.set(i.p.l, t.name || U.fname(t.entity));
      i.el.classList.toggle('on', (t.entity || '').startsWith('binary_sensor.') && U.active(t.entity)); i.el.classList.toggle('off', !U.avail(t.entity));
    },
  });

  /** A number against its range, as an arc from the lowest to the highest (0 to 100 unless the Studio says otherwise). */
  HP.tile('gauge', {
    create(t, body, ctx, i) {
      const ARC = 'M8 52a42 42 0 0 1 84 0';
      body.classList.add('gau');
      body.innerHTML = `<svg viewBox="0 0 100 58"><path class="ga" d="${ARC}"/><path class="gv" d="${ARC}"/></svg><div class="gt"><div class="vv"></div><div class="l"></div></div>`;
      i.p = {v: body.querySelector('.vv'), l: body.querySelector('.l'), arc: body.querySelector('.gv')};
      i.len = Math.PI * 42; i.p.arc.style.strokeDasharray = i.len;
    },
    update(t, body, ctx, i) {
      const s = st(t.entity), v = s ? parseFloat(s.state) : NaN, lo = parseFloat(t.min) || 0, hi = isNaN(parseFloat(t.max)) ? 100 : parseFloat(t.max);
      i.p.arc.style.strokeDashoffset = (i.len * (1 - (isNaN(v) || hi <= lo ? 0 : clamp((v - lo) / (hi - lo), 0, 1)))).toFixed(1);
      U.set(i.p.v, U.stateLabel(t.entity)); U.set(i.p.l, t.name || U.fname(t.entity)); i.el.classList.toggle('off', !U.avail(t.entity));
    },
  });

  /** What Home Assistant has kept of one thing over the last hours: [[time in ms, state]]. Up to a day it is every
   *  change; for days it is the hourly means Home Assistant keeps, where it keeps them for that thing. */
  function history(e, hours) {
    const end = new Date(), start = new Date(end - hours * 36e5), span = {start_time: start.toISOString(), end_time: end.toISOString()};
    const raw = () => HP.ha.call(Object.assign({type: 'history/history_during_period', entity_ids: [e], minimal_response: true, no_attributes: true}, span))
      .then(r => ((r || {})[e] || []).map(p => [(p.lu || p.lc) * 1000, p.s]));
    if (hours <= 24) return raw();
    return HP.ha.call(Object.assign({type: 'recorder/statistics_during_period', statistic_ids: [e], period: 'hour', types: ['mean', 'state']}, span))
      .then(r => { const a = (r || {})[e] || []; return a.length ? a.map(p => [p.start, String(p.mean != null ? p.mean : p.state)]) : raw(); }, raw);
  }
  const YES = ['on', 'open', 'opening', 'playing', 'home', 'unlocked', 'heating', 'cooling', 'cleaning', 'mowing'];
  /** The chart's line, on a box 100 wide and 40 high: a line through numbers, steps for something that is on or off. */
  function chartPath(pts, from, now) {
    const good = pts.filter(p => p[1] !== 'unavailable' && p[1] !== 'unknown' && p[1] != null);
    const numeric = good.filter(p => !isNaN(parseFloat(p[1]))).length * 2 >= good.length;
    let P = good.map(p => [Math.max(p[0], from), numeric ? parseFloat(p[1]) : YES.includes(p[1]) ? 1 : 0]).filter(p => !isNaN(p[1]) && p[0] <= now);
    if (P.length > 500) { const k = Math.ceil(P.length / 500); P = P.filter((p, n) => n % k === 0 || n === P.length - 1); }  // more points than the tile has pixels
    if (!P.length) return null;
    let lo = numeric ? Math.min(...P.map(p => p[1])) : 0, hi = numeric ? Math.max(...P.map(p => p[1])) : 1;
    if (hi === lo) { hi += 1; lo -= 1; }
    const x = v => ((v - from) / (now - from) * 100).toFixed(2), y = v => (38 - (v - lo) / (hi - lo) * 36).toFixed(2);
    let d = `M${x(P[0][0])} ${y(P[0][1])}`;
    for (let n = 1; n < P.length; n++) d += numeric ? `L${x(P[n][0])} ${y(P[n][1])}` : `H${x(P[n][0])}V${y(P[n][1])}`;
    d += 'H100';  // it has stayed there until now
    return {line: d, area: d + `V40H${x(P[0][0])}Z`, lo, hi, numeric};
  }
  /** One thing over the last hours (24 unless the Studio says otherwise). The history is read through the same
   *  connection as everything else, again every five minutes; a change in between is added the moment it happens. */
  HP.tile('chart', {
    create(t, body, ctx, i) {
      body.classList.add('cht');
      body.innerHTML = '<div class="ch"><div class="l"></div><div class="vv"></div></div><div class="cw"><svg viewBox="0 0 100 40" preserveAspectRatio="none"><path class="ca"/><path class="cl"/></svg><span class="chi"></span><span class="clo"></span></div>';
      i.p = {v: body.querySelector('.vv'), l: body.querySelector('.l'), line: body.querySelector('.cl'), area: body.querySelector('.ca'), hi: body.querySelector('.chi'), lo: body.querySelector('.clo')};
      i.pts = []; i.hours = +t.hours || 24;
      i.load = () => { if (i.busy || !HP.ha || !HP.ready || !st(t.entity)) return; i.busy = true;
        // nothing kept for the period means nothing changed in it: the value it has now, all the way across
        history(t.entity, i.hours).then(p => { i.pts = p.length || !st(t.entity) ? p : [[Date.now() - i.hours * 36e5, st(t.entity).state]]; i.got = true; i.sig = ''; }).catch(() => {}).then(() => { i.busy = false; HP.tiles.chart.update(t, body, ctx, i); }); };
      const timer = setInterval(i.load, 300000);
      return {destroy: () => clearInterval(timer)};
    },
    update(t, body, ctx, i) {
      const s = st(t.entity), now = Date.now();
      if (!i.got) i.load();
      else if (s && i.seen !== s.state) i.pts.push([now, s.state]);
      if (s) i.seen = s.state;
      U.set(i.p.v, U.stateLabel(t.entity)); U.set(i.p.l, t.name || U.fname(t.entity)); i.el.classList.toggle('off', !U.avail(t.entity));
      const sig = i.pts.length + '/' + Math.floor(now / 60000);
      if (sig === i.sig) return;  // drawn again when a point arrives, and once a minute so the line keeps moving left
      i.sig = sig;
      const c = chartPath(i.pts, now - i.hours * 36e5, now), r = v => String(Math.round(v * 10) / 10);
      i.p.line.setAttribute('d', c ? c.line : ''); i.p.area.setAttribute('d', c ? c.area : '');
      i.p.hi.textContent = c && c.numeric ? r(c.hi) : ''; i.p.lo.textContent = c && c.numeric ? r(c.lo) : '';
    },
  });

  // ---------- lists Home Assistant answers with: what is coming up, what is to do, the weather ahead ----------
  /** A service that answers: Home Assistant's reply for those entities. */
  const respond = (domain, service, ents, data) => HP.ha.call({type: 'call_service', domain, service, target: {entity_id: ents}, service_data: data || {}, return_response: true}).then(r => (r && r.response) || {});
  /** Reads a list for a tile now and then (every `mins`), and again half a minute after a failure. */
  function listed(i, mins, ask, draw) {
    i.load = () => { if (i.busy || !HP.ha || !HP.ready) return; i.busy = true;
      ask().then(r => { i.rows = r; i.fail = 0; draw(r); }, () => { i.fail = Date.now(); }).then(() => { i.busy = false; }); };
    i.due = () => { if (!i.rows && Date.now() - (i.fail || 0) > 30000) i.load(); };
    const timer = setInterval(i.load, mins * 60000);
    return {destroy: () => clearInterval(timer)};
  }
  const dayName = d => { const today = new Date(); today.setHours(0, 0, 0, 0); const n = Math.round((new Date(d).setHours(0, 0, 0, 0) - today) / 864e5); return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : new Date(d).toLocaleDateString([], {weekday: 'long'}); };
  const title = t => t.name ? `<div class="bh">${U.esc(t.name)}</div>` : '';

  /** What is on one or more calendars in the next seven days, soonest first. */
  HP.tile('calendar', {
    create(t, body, ctx, i) {
      body.classList.add('agn');
      return listed(i, 10, () => { const ents = (t.entities || []).filter(st), from = new Date();
        return respond('calendar', 'get_events', ents, {start_date_time: from.toISOString(), end_date_time: new Date(+from + 7 * 864e5).toISOString()})
          .then(r => [].concat(...ents.map(e => (r[e] || {}).events || [])).sort((a, b) => Date.parse(a.start) - Date.parse(b.start))); },
        rows => { body.innerHTML = title(t) + rows.map(ev => { const allDay = String(ev.start).length <= 10, d = allDay ? ev.start + 'T00:00' : ev.start;
          return `<div class="ag"><div class="ad">${dayName(d)}${allDay ? '' : ' ' + new Date(d).toLocaleTimeString([], {hour: 'numeric', minute: '2-digit'})}</div><div class="as">${U.esc(ev.summary || '')}</div></div>`; }).join(''); });
    },
    update(t, body, ctx, i) { i.due(); },
  });

  /** A to-do list: what is still to do. A touch on one ticks it off; the first row adds one, typed on the device's keyboard. */
  HP.tile('todo', {
    create(t, body, ctx, i) {
      body.classList.add('agn');
      body.addEventListener('click', ev => { const r = ev.target.closest('[data-u], [data-add]'); if (!r) return;
        const then = () => setTimeout(i.load, 600);
        if (r.dataset.u) ctx.service('todo', 'update_item', t.entity, {item: r.dataset.u, status: 'completed'}).then(then);
        else HP.textBox('Add', '', 'text', v => v.trim() && ctx.service('todo', 'add_item', t.entity, {item: v.trim()}).then(then)); });
      return listed(i, 10, () => respond('todo', 'get_items', [t.entity], {status: ['needs_action']}).then(r => (r[t.entity] || {}).items || []),
        rows => { body.innerHTML = title(t) + '<div class="ag tap" data-add="1"><div class="as">Add</div></div>' + rows.map(x => `<div class="ag tap" data-u="${U.esc(x.uid || x.summary)}"><div class="as">${U.esc(x.summary || '')}</div></div>`).join(''); });
    },
    update(t, body, ctx, i) { const s = st(t.entity); if (s && i.count !== s.state) { i.count = s.state; if (i.rows) i.load(); } i.due(); },
  });

  /** The weather ahead, by day or by hour: as many as fit across the tile. */
  HP.tile('forecast', {
    create(t, body, ctx, i) {
      body.classList.add('fct');
      return listed(i, 30, () => respond('weather', 'get_forecasts', [t.entity], {type: t.hourly ? 'hourly' : 'daily'}).then(r => (r[t.entity] || {}).forecast || []),
        rows => { const n = Math.max(3, Math.min(8, Math.floor(i.w / 84))), deg = v => v == null ? '' : Math.round(v) + '\u00b0';
          body.innerHTML = rows.slice(0, n).map(f => `<div class="fc"><div class="fd">${t.hourly ? new Date(f.datetime).toLocaleTimeString([], {hour: 'numeric'}) : new Date(f.datetime).toLocaleDateString([], {weekday: 'short'})}</div>`
            + `<div class="ic">${U.icon(SKY[f.condition] || 'weather-cloudy')}</div><div class="fh">${deg(f.temperature)}</div><div class="fl">${deg(f.templow)}</div></div>`).join(''); });
    },
    update(t, body, ctx, i) { i.due(); },
  });

  /** A remote control on the dashboard: a touch opens its buttons. */
  HP.tile('remote', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'television'); },
    update(t, body, ctx, i) {
      U.set(i.p.n, t.name || U.fname(t.entity)); U.set(i.p.l, U.stateLabel(t.entity));
      i.el.classList.toggle('on', U.active(t.entity)); i.el.classList.toggle('off', !U.avail(t.entity));
    },
    tap: (t, ctx) => st(t.entity) ? () => remotePop(t.entity, ctx, t.name || U.fname(t.entity), t.volume) : null,
  });

  /** The batteries of things around the house on one button, the lowest first: what needs changing is on top, and
   *  what does not fit is the least urgent. A battery that only says "low" or not (a binary sensor) counts as empty or full. */
  HP.tile('battery', {
    create(t, body) { body.classList.add('bats'); },
    update(t, body, ctx, i) {
      const rows = (t.entities || []).filter(st).map(e => {
        const s = st(e), yn = e.startsWith('binary_sensor.'), v = yn ? (s.state === 'on' ? 0 : s.state === 'off' ? 100 : NaN) : parseFloat(s.state);
        return {v, name: U.fname(e).replace(/ battery( level)?$/i, ''), text: isNaN(v) ? 'Offline' : yn ? (v ? 'OK' : 'Low') : Math.round(v) + '%'};
      }).sort((a, b) => (isNaN(a.v) ? -1 : a.v) - (isNaN(b.v) ? -1 : b.v));
      const html = (t.name ? `<div class="bh">${U.esc(t.name)}</div>` : '') + rows.map(r =>
        `<div class="bat${isNaN(r.v) || r.v <= 10 ? ' out' : r.v <= 20 ? ' low' : ''}"><div class="bn">${U.esc(r.name)}</div><div class="bv">${r.text}</div><div class="bb"><i style="width:${isNaN(r.v) ? 0 : Math.max(3, Math.min(100, r.v))}%"></i></div></div>`).join('');
      if (i.html !== html) { i.html = html; body.innerHTML = html; }
    },
  });
  /** Saves the lights of its room or floor, as they are now, as a scene. */
  HP.tile('savescene', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'star'); U.set(i.p.n, t.name || 'Save scene'); },
    tap: t => t.scope ? () => HP.saveScene(t.scope) : null,
  });  // its own entry in the Studio; the alarm's face is the popup HP.act opens

  HP.tile('action', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'star'); U.set(i.p.n, t.name || ''); U.set(i.p.l, t.label || ''); },
    update(t, body, ctx, i) { if ((t.entity || '').startsWith('scene.')) sceneLook(i.el, t.entity, i.lightState); },
    tap: (t, ctx) => () => { const [d, s] = t.service.split('.'); if (d === 'scene') HP.sceneMark(t.entity); ctx.service(d, s, t.entity, t.data); },
  });

  /** The scenes of a place in one button: it shows the scene in use, and a touch drops the list to set another.
   *  The button itself sets nothing. A scene saved later is in the list by itself. */
  HP.tile('scenes', {
    create(t, body, ctx, i) {
      body.innerHTML = `<div class="ic">${U.icon(t.icon || 'star')}</div><div class="tx"><div class="sel"><div class="n"></div><div class="arr"></div></div><div class="l"></div></div>`;
      i.p = {n: body.querySelector('.n'), l: body.querySelector('.l')};
    },
    update(t, body, ctx, i) {
      i.now = scenesIn(t.scope).find(HP.sceneActive) || null;
      U.set(i.p.n, i.now ? sceneName(i.now, t.scope) : 'Scenes'); U.set(i.p.l, t.name || '');
      sceneLook(i.el, i.now, i.lightState);
    },
    tap: (t, ctx, i) => () => HP.pop.menu(i.el, scenesIn(t.scope).map(e => [e, sceneName(e, t.scope)]), i.now, e => { HP.sceneMark(e); ctx.service('scene', 'turn_on', e); }),
  });

  HP.tile('nav', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'home'); U.set(i.p.n, t.name || ''); U.set(i.p.l, t.label || ''); },
    tap: (t, ctx) => () => t.back ? ctx.back() : t.panel ? ctx.goPanel(t.panel) : ctx.go(t.page),
  });

  HP.tile('room', {
    create(t, body, ctx, i) { i.p = U.card(body, t.icon || 'home'); },
    update(t, body, ctx, i) {
      const ls = U.inArea(t.area, 'light'), on = ls.filter(e => st(e).state === 'on').length;
      const temp = U.inArea(t.area, 'sensor').filter(e => st(e).attributes.device_class === 'temperature').map(e => parseFloat(st(e).state)).find(v => !isNaN(v));
      U.set(i.p.n, t.name || HP.S.areas[t.area] || t.area);
      U.set(i.p.l, [ls.length ? (on ? on + ' on' : 'Lights off') : '', temp == null ? '' : Math.round(temp) + '°'].filter(Boolean).join(' · '));
      i.el.classList.toggle('on', on > 0);
    },
    tap: (t, ctx) => () => ctx.go('@room', t.area),
  });

  /** A player on the dashboard, as Home Assistant shows one: the picture of what plays, its title, and back, play
   *  or pause, forward. Three places to touch: the picture opens what the player can play (or its controls, where it
   *  has no library), the words open its controls (volume, source), and each button does its own thing. */
  HP.tile('media', {
    create(t, body, ctx, i) {
      body.classList.add('mtile');
      body.innerHTML = '<div class="mart tap" data-b="art"></div><div class="mmain"><div class="mtx tap" data-b="more"><div class="n"></div><div class="l"></div></div><div class="mbtn"></div></div>';
      i.p = {art: body.firstChild, n: body.querySelector('.n'), l: body.querySelector('.l'), btn: body.querySelector('.mbtn')};
      body.addEventListener('click', ev => {
        const b = ev.target.closest('[data-b]'); if (!b || !U.avail(t.entity)) return;
        const k = b.dataset.b, name = t.name || U.fname(t.entity);
        if (k === 'art' && (attr(t.entity, 'supported_features') || 0) & 131072) return browse(t.entity, ctx, name);
        if (k === 'art' || k === 'more') return HP.act(t.entity, ctx, name);
        ctx.service('media_player', {prev: 'media_previous_track', play: 'media_play_pause', next: 'media_next_track'}[k], t.entity);
      });
    },
    update(t, body, ctx, i) {
      const s = st(t.entity), name = t.name || U.fname(t.entity);
      // the picture sits beside the words only on a tile wide enough to leave them room; otherwise it goes on top
      i.el.classList.toggle('tall', i.w < i.h * 1.8); i.el.classList.toggle('off', !U.avail(t.entity));
      if (!s) { U.set(i.p.n, name); U.set(i.p.l, U.stateLabel(t.entity)); return; }
      const a = s.attributes, f = a.supported_features || 0, playing = s.state === 'playing', pic = a.entity_picture || '', sig = f + '/' + playing;
      U.set(i.p.n, a.media_title || name); U.set(i.p.l, a.media_title ? [a.media_artist, name].filter(Boolean).join(' \u00b7 ') : U.cap(s.state));
      i.el.classList.toggle('on', playing);
      if (i.pic !== pic) { i.pic = pic; i.p.art.style.backgroundImage = ''; i.p.art.innerHTML = U.icon('play');
        picture(pic, url => { if (url && i.pic === pic) { i.p.art.style.backgroundImage = cssUrl(url); i.p.art.innerHTML = ''; } }); }
      if (i.sig !== sig) { i.sig = sig; i.p.btn.innerHTML = (f & 16 ? `<div class="tap" data-b="prev">${PREV}</div>` : '') + (f & 16385 ? `<div class="tap" data-b="play">${U.icon(playing ? 'pause' : 'play')}</div>` : '')
        + (f & 32 ? `<div class="tap" data-b="next">${NEXT}</div>` : ''); }
    },
  });

  // Still picture at once, live video takes over where the tablet can decode it. Tap opens the camera's page.
  HP.tile('camera', {
    create(t, body) {
      const s = st(t.entity);
      body.classList.add('cam');
      const img = document.createElement('img'), video = document.createElement('video'), label = document.createElement('div');
      video.muted = true; video.autoplay = true; video.playsInline = true; video.setAttribute('playsinline', '');
      label.className = 'camlabel';
      const name = t.name || (s ? U.fname(t.entity).replace(/ High resolution channel$/i, '') : t.entity);
      const status = x => { label.textContent = x ? name + ' · ' + x : name; body.classList.toggle('live', !x); };
      body.append(img, video, label);
      if (!s || s.state === 'unavailable') { status('offline'); return null; }
      const stops = [snapshots(HP.ha, s, img, body)];
      if (t.video === false || !(s.attributes.supported_features & 2)) status('stills'); else { status('connecting'); stops.push(playCamera(HP.ha, t.entity, video, status)); }
      return {destroy: () => stops.forEach(f => f())};
    },
    tap: (t, ctx) => t.page ? () => ctx.go(t.page) : null,
  });
  // A button that holds several things from the house, each on the button's own small grid. Items are either
  // placed by hand in the Studio (x, y, w, h on t.grid) or, while t.auto is not false, arranged to suit the
  // button's shape, so stretching the button in the editor reshuffles what is on it.
  const READ_ONLY = ['sensor', 'binary_sensor', 'weather', 'person', 'sun', 'device_tracker', 'camera', 'event', 'zone'];
  HP.tile('button', {
    create(t, body, ctx, i) {
      const items = (t.items || []).filter(it => it && it.entity);
      body.classList.add('multi');
      body.innerHTML = (t.name ? '<div class="bt"></div>' : '') + '<div class="its"></div>';
      if (t.name) body.firstChild.textContent = t.name;
      const box = body.lastChild, W = box.clientWidth, H = box.clientHeight, n = items.length;
      // by hand, or the arrangement whose cells come closest to a comfortable card shape for this button
      const manual = t.auto === false && t.grid && items.every(it => it.w > 0 && it.h > 0);
      let cols = 1, rows = 1, best = Infinity;
      if (manual) { cols = t.grid.cols; rows = t.grid.rows; }
      else for (let c = 1; c <= Math.max(1, n); c++) { const r = Math.ceil(n / c), miss = Math.abs(Math.log((W / c) / (H / r) / 1.5)); if (miss < best) { best = miss; cols = c; rows = r; } }
      i.cells = items.map((it, k) => {
        const el = document.createElement('div'), p = manual ? it : {x: k % cols, y: Math.floor(k / cols), w: 1, h: 1};
        const w = W * p.w / cols, h = H * p.h / rows, readOnly = READ_ONLY.includes(it.entity.split('.')[0]);
        el.className = 'it' + (w / h > 2.4 ? ' wide' : '') + (n === 1 ? ' only' : '') + (readOnly ? '' : ' tap');
        el.style.cssText = `left:${p.x / cols * 100}%;top:${p.y / rows * 100}%;width:${p.w / cols * 100}%;height:${p.h / rows * 100}%;--iu:${U.unit(w, h).toFixed(1)}px`;
        el.innerHTML = '<div class="ic"></div><div class="tx"><div class="n"></div><div class="l"></div></div>';
        if (!readOnly) el.addEventListener('click', () => { if (U.avail(it.entity)) HP.act(it.entity, ctx, it.label, el); });
        box.append(el);
        return {it, el, ic: el.firstChild, n: el.querySelector('.n'), l: el.querySelector('.l')};
      });
    },
    update(t, body, ctx, i) {
      for (const c of i.cells || []) {
        const e = c.it.entity, s = st(e), dom = e.split('.')[0];
        const name = c.it.icon || (dom === 'media_player' && s && s.state === 'playing' ? 'pause' : DOMAIN_ICON[dom] || ''), ic = U.icon(name);
        if (c.ic.innerHTML !== ic) c.ic.innerHTML = ic;
        // The label is the Studio's own name for it when one was typed; otherwise Home Assistant's friendly name.
        U.set(c.n, c.it.label || (s ? U.fname(e) : e)); U.set(c.l, U.stateLabel(e));
        c.el.classList.toggle('on', U.active(e)); c.el.classList.toggle('off', !U.avail(e));
        lit(c.el, e, i.lightState);
      }
    },
  });

  // The assistant's face on the dashboard: the orb is always there, calm while nothing happens, and it is where
  // the wake word, the listening, the thinking and the answer show (assist.js drives it). Tap to talk without the word.
  HP.tile('assistant', {
    create(t, body, ctx, i) {
      i.p = U.card(body, ''); i.el.classList.add('talking');
      U.set(i.p.n, t.name || ''); U.set(i.p.l, t.label || '');
      if (!HP.orb) return null;
      const canvas = document.createElement('canvas'), side = Math.floor(Math.min(i.w, i.h) * 0.92);  // a square that fits the button, whatever its shape
      canvas.style.width = canvas.style.height = side + 'px';
      i.p.ic.append(canvas);
      i.orb = HP.orb.create(canvas, {style: t.orb || 'ribbons'}); i.orb.start();
      return {destroy: () => { i.orb.destroy(); i.orb = null; }};
    },
    tap: t => () => HP.assist.start(t),
  });
})();
