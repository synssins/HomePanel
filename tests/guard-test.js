// Popup and question test: light controls, lock and door questions, the code pad, the alarm panel, the remote,
// a room's page with its groups, and saving a scene.
//   node tests/guard-test.js
// The page under test is the real engine in headless Chrome, served a panel by a Daedalus Workshop (WORKSHOP,
// default http://127.0.0.1:8723; a test copy, not the one the house uses). Nothing in the house is touched: every
// entity on the test panel is made up (its name holds "fake_"), its state is written into the page by the test, and
// the page's service call is replaced by a recorder before the first press (so is its request to save a scene). The test refuses to press otherwise.
'use strict';
const {spawn} = require('child_process'), fs = require('fs'), os = require('os'), path = require('path');
const B = process.env.WORKSHOP || 'http://127.0.0.1:8723', DEV = 'guardtest', W = 960, H = 540, port = 9395;
const CHROME = process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const api = async (method, p, body) => { const r = await fetch(B + '/admin/api/' + p, {method, headers: {'Content-Type': 'application/json'}, body: body && JSON.stringify(body)}); if (!r.ok) throw new Error(method + ' ' + p + ': ' + r.status); return r.json(); };
const TILES = [['lock.fake_plain', 'Fake Lock', 1, 1], ['lock.fake_code', 'Fake Code Lock', 27, 1], ['cover.fake_garage', 'Fake Garage', 53, 1],
  ['alarm_control_panel.fake_alarm', 'Fake Alarm', 1, 19], ['light.fake_full', 'Fake Light', 53, 19], ['light.fake_onoff', 'Fake Switch Light', 1, 37]];
const design = guard => Object.assign({format: 1, name: 'Guard test', grid: {cols: 64, rows: 48}, start: 'home', rooms: {}, theme: {background: {color: '#1a2038'}, tile: {fill: 'rgba(255,255,255,.16)', radius: 22, gap: 5}},
  pages: [{id: 'home', name: 'Home', tiles: TILES.map(([entity, name, x, y]) => ({type: entity.startsWith('alarm') ? 'alarm' : 'entity', x, y, w: 10, h: 10, entity, name, battery: entity === 'lock.fake_plain' || undefined, style: entity === 'light.fake_full' ? {lightState: true} : {}}))
    .concat([{type: 'battery', x: 27, y: 19, w: 12, h: 14, entities: ['sensor.fake_bat_full', 'sensor.fake_bat_low', 'binary_sensor.fake_bat_yn']},
      {type: 'value', x: 14, y: 37, w: 10, h: 10, entity: 'sensor.fake_temp'}, {type: 'gauge', x: 27, y: 37, w: 10, h: 10, entity: 'sensor.fake_temp', min: '10', max: '30'},
      {type: 'chart', x: 40, y: 19, w: 12, h: 14, entity: 'sensor.fake_temp', name: 'Fake chart'}, {type: 'value', x: 40, y: 37, w: 10, h: 10, entity: 'binary_sensor.fake_door'},
      {type: 'calendar', x: 14, y: 1, w: 10, h: 10, entities: ['calendar.fake_cal']}, {type: 'todo', x: 40, y: 1, w: 10, h: 10, entity: 'todo.fake_list'}, {type: 'forecast', x: 14, y: 19, w: 12, h: 10, entity: 'weather.fake_sky'}, {type: 'media', x: 53, y: 31, w: 10, h: 16, entity: 'media_player.fake_hifi'}])}]}, guard === false ? {guard: false} : {});
const STATES = {
  'lock.fake_plain': ['locked', {}], 'lock.fake_code': ['locked', {code_format: '^\\d{4}$'}], 'cover.fake_garage': ['closed', {device_class: 'garage'}],
  'alarm_control_panel.fake_alarm': ['disarmed', {supported_features: 3, code_arm_required: false, code_format: null}],
  'light.fake_full': ['on', {supported_color_modes: ['color_temp', 'xy'], color_mode: 'color_temp', brightness: 102, color_temp_kelvin: 3000, min_color_temp_kelvin: 2000, max_color_temp_kelvin: 6500,
    hs_color: [28, 60], rgb_color: [255, 180, 107], effect_list: ['Candle', 'Colorloop', 'none'], effect: null}],
  'light.fake_onoff': ['off', {supported_color_modes: ['onoff']}]};
const FAKE = `window.DaedalusNative = {post(t) { const m = JSON.parse(t), out = {id: m.id, cmd: m.cmd};
  if (m.cmd === 'ping') { out.config = {server: '${B}'}; out.device = {id: '${DEV}', model: 'Test TV', name: 'Guard test', width: ${W}, height: ${H}, scale: 2}; } else out.error = 'none';
  setTimeout(() => window.nativeReply && window.nativeReply(out), 5); }}; window.__err = []; window.addEventListener('error', e => window.__err.push(e.message));`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guardtest-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--hide-scrollbars',
  '--allow-file-access-from-files', '--user-data-dir=' + dir, '--remote-debugging-port=' + port, `--window-size=${W},${H}`, 'about:blank'], {stdio: 'ignore'});
let id = null, failed = 0;
const done = async code => { try { await api('DELETE', 'tablets/' + DEV); } catch (e) {} try { if (id) await api('DELETE', 'designs/' + id); } catch (e) {} chrome.kill(); process.exit(code); };

(async () => {
  let tab; for (let i = 0; i < 40 && !tab; i++) { await sleep(250); try { tab = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find(t => t.type === 'page'); } catch (e) {} }
  const ws = new WebSocket(tab.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let n = 0; const wait4 = {};
  ws.onmessage = ev => { const m = JSON.parse(ev.data); if (wait4[m.id]) wait4[m.id](m.result); };
  const send = (method, params = {}) => new Promise(r => { wait4[++n] = r; ws.send(JSON.stringify({id: n, method, params})); });
  const ev = async x => { const r = await send('Runtime.evaluate', {expression: x, returnByValue: true, awaitPromise: true}); if (r.exceptionDetails) throw new Error('page: ' + (r.exceptionDetails.exception || {}).description); return (r.result || {}).value; };
  const js = async x => JSON.parse(await ev(`JSON.stringify(${x})`));

  id = (await api('POST', 'designs', {name: 'Guard test', design: design()})).id;
  await send('Emulation.setDeviceMetricsOverride', {width: W, height: H, deviceScaleFactor: 1, mobile: false});
  await send('Page.enable'); await send('Page.addScriptToEvaluateOnNewDocument', {source: FAKE});
  await send('Page.navigate', {url: 'file:///' + path.resolve(__dirname, '../web/index.html').replace(/\\/g, '/')});
  await sleep(5000);
  await api('POST', 'tablets/' + DEV + '/approve'); await api('PATCH', 'tablets/' + DEV, {design: id});
  await sleep(8000);

  // The house is taken out of it: service calls go to a list, and the made-up things get their states.
  const set = (e, state, attrs) => ev(`(() => { const s = HP.S.states[${JSON.stringify(e)}]; HP.S.states[${JSON.stringify(e)}] = {entity_id: ${JSON.stringify(e)}, state: ${JSON.stringify(state)}, attributes: Object.assign({friendly_name: 'x'}, s ? s.attributes : {}, ${JSON.stringify(attrs || {})})}; update(); })()`);
  await ev(`window.__calls = []; HP.ctx.service = (d, s, e, data) => { __calls.push([d, s, e, data || {}]); return Promise.resolve(); }; HP.ready = true`);
  for (const e in STATES) await set(e, STATES[e][0], STATES[e][1]);
  const safe = async () => { const s = await js(`{name: HP.design && HP.design.name, stub: /__calls/.test(String(HP.ctx.service)), ents: (HP.design.pages || []).flatMap(p => p.tiles).flatMap(t => [t.entity].concat(t.entities || [])).filter(Boolean)}`);
    if (s.name !== 'Guard test' || !s.stub || s.ents.length !== TILES.length + 11 || s.ents.some(e => !/\.fake_/.test(e))) throw new Error('not the test panel, nothing pressed: ' + JSON.stringify(s)); };
  await safe();

  const calls = () => js('__calls.splice(0)');
  const mid = sel => js(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2), Math.round(r.width), Math.round(r.height)]; })()`);
  const at = async (x, y) => { await safe(); for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', {type, x, y, button: 'left', clickCount: 1}); await sleep(450); };
  const tap = async sel => { const p = await mid(sel); if (!p) throw new Error('nothing to press: ' + sel); await at(p[0], p[1]); };
  const tile = k => `#grid .tile:nth-child(${k + 1})`;
  const key = async k => { for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', {type, key: k, code: k, windowsVirtualKeyCode: {ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Enter: 13, Escape: 27}[k]}); await sleep(200); };
  const q = () => ev(`(document.querySelector('#modal.open .q') || {}).textContent || ''`);
  const popOpen = () => ev(`!!HP.pop.cur`);
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const ok = (name, pass, got) => { if (!pass) failed++; console.log((pass ? 'ok   ' : 'FAIL ') + name + (pass ? '' : '  ' + JSON.stringify(got))); };

  // ---- locks and doors
  await tap(tile(0)); let text = await q();
  await tap('#modal [data-m=no]'); let c = await calls();
  ok('lock without a code: asks, No does nothing', text === 'This will unlock Fake Lock. Are you sure?' && !c.length, {text, c});
  await tap(tile(0)); await tap('#modal [data-m=yes]'); c = await calls();
  ok('lock without a code: Yes unlocks', same(c, [['lock', 'unlock', 'lock.fake_plain', {}]]), c);
  await set('lock.fake_plain', 'unlocked'); await tap(tile(0)); text = await q(); c = await calls();
  ok('unlocked, no code: locks without a question', !text && same(c, [['lock', 'lock', 'lock.fake_plain', {}]]), {text, c});
  await set('lock.fake_plain', 'locked');

  await tap(tile(1)); const pad = await ev(`!!document.querySelector('#modal.open .keys')`);
  await tap('#modal [data-m=yes]'); const stays = await ev(`document.getElementById('modal').className === 'open'`);
  for (const k of [1, 2, 9, 'del', 3, 4]) await tap(`#modal [data-k="${k}"]`);
  const dots = await ev(`document.querySelector('.pin').textContent.length`);
  await tap('#modal [data-m=yes]'); c = await calls();
  ok('lock with a code: code pad, empty code stays, code goes to Home Assistant', pad && stays && dots === 4 && same(c, [['lock', 'unlock', 'lock.fake_code', {code: '1234'}]]), {pad, stays, dots, c});

  await tap(tile(2)); text = await q(); await tap('#modal [data-m=yes]'); c = await calls();
  ok('garage door: asks, Yes opens', text === 'This will open Fake Garage. Are you sure?' && same(c, [['cover', 'open_cover', 'cover.fake_garage', {}]]), {text, c});

  // ---- alarm panel
  await tap(tile(3)); const modes = await js(`[...document.querySelectorAll('#pop .modes .mb')].map(b => b.textContent)`);
  await tap('#pop [data-s=arm_away]'); c = await calls();
  ok('alarm: its modes, arming needs no question', same(modes, ['Arm away', 'Arm home', 'Disarm']) && same(c, [['alarm_control_panel', 'alarm_arm_away', 'alarm_control_panel.fake_alarm', {}]]), {modes, c});
  await set('alarm_control_panel.fake_alarm', 'armed_away');
  const lit = await js(`{mode: (document.querySelector('#pop .modes .go') || {}).textContent, line: document.querySelector('#pop .ps').textContent, tile: document.querySelector(${JSON.stringify(tile(3))}).classList.contains('on')}`);
  await tap('#pop [data-s=disarm]'); text = await q(); await tap('#modal [data-m=yes]'); c = await calls();
  ok('alarm: shows its mode, disarming asks', lit.mode === 'Arm away' && lit.line === 'Armed away' && lit.tile && text === 'This will disarm Fake Alarm. Are you sure?' && same(c, [['alarm_control_panel', 'alarm_disarm', 'alarm_control_panel.fake_alarm', {}]]), {lit, text, c});
  await set('alarm_control_panel.fake_alarm', 'disarmed', {code_format: 'number', code_arm_required: true});
  await tap('#pop [data-s=arm_home]'); await tap('#modal [data-k="9"]'); await tap('#modal [data-m=yes]'); c = await calls();
  ok('alarm with a code: arming asks for it', same(c, [['alarm_control_panel', 'alarm_arm_home', 'alarm_control_panel.fake_alarm', {code: '9'}]]), c);
  await tap('#pop .px'); ok('popup: X closes it', !(await popOpen()));

  // ---- light
  const fill = await ev(`document.querySelector(${JSON.stringify(tile(4))}).style.getPropertyValue('--fill-on')`);
  ok('light status on the button: its colour at its level', /rgba\(255,180,107,0\.46\)/.test(fill), fill);
  await tap(tile(4));
  const has = await js(`{bri: !!document.querySelector('#pop .bri'), ct: !!document.querySelector('#pop .ct'), wheel: !!document.querySelector('#pop .wheel'), fx: !!document.querySelector('#pop .dd'),
    line: document.querySelector('#pop .ps').textContent, ctMark: !document.querySelector('#pop .ct .mark').hidden, wheelMark: !document.querySelector('#pop .wheel .mark').hidden}`);
  ok('light: level, white, colour and effects, left to right; the mark is on the white it is using', has.bri && has.ct && has.wheel && has.fx && has.line === '40% \u00b7 3000K' && has.ctMark && !has.wheelMark, has);
  let p = await mid('#pop .bri'); await at(p[0], p[1] - p[3] * 0.25); c = await calls();  // three quarters of the way up
  ok('light: the level bar sets the level', c.length >= 1 && c.every(x => x[1] === 'turn_on') && Math.abs(c[c.length - 1][3].brightness_pct - 75) <= 2, c);
  p = await mid('#pop .ct'); await at(p[0], p[1] + p[3] * 0.5 - 2); c = await calls();
  ok('light: the white bar sets warm at the bottom', c.length >= 1 && c[c.length - 1][3].color_temp_kelvin <= 2100, c);
  p = await mid('#pop .wheel'); await at(p[0] + p[2] * 0.25, p[1]); c = await calls(); const hs = (c[c.length - 1] || [0, 0, 0, {}])[3].hs_color || [];
  const marks = await js(`{ct: !document.querySelector('#pop .ct .mark').hidden, wheel: !document.querySelector('#pop .wheel .mark').hidden}`);
  ok('light: the wheel sets the colour, and the mark moves to it', Math.abs(hs[0] - 90) <= 3 && Math.abs(hs[1] - 50) <= 4 && !marks.ct && marks.wheel, {c, marks});
  await tap('#pop .dd'); const opts = await js(`[...document.querySelectorAll('#pop .dd.open .ddl div')].map(b => b.textContent)`);
  await tap('#pop .ddl div'); c = await calls();
  ok('light: its effects in a list', same(opts, ['Candle', 'Colorloop', 'none']) && same(c, [['light', 'turn_on', 'light.fake_full', {effect: 'Candle'}]]), {opts, c});
  await set('light.fake_full', 'on', {effect: 'Candle'}); const shown = await ev(`document.querySelector('#pop .ddv').textContent`);
  p = await mid('#pop .ct'); await at(p[0], p[1]); c = await calls(); const sent = (c[c.length - 1] || [0, 0, 0, {}])[3];
  ok('light: shows the running effect, and a new white ends it with a short fade', shown === 'Candle' && sent.effect === 'none' && sent.transition === 0.3 && sent.color_temp_kelvin > 4000, {shown, sent});
  await set('light.fake_full', 'on', {effect: null});
  await tap('#pop .ph .rb'); c = await calls();
  ok('light: the power button', same(c, [['light', 'toggle', 'light.fake_full', {}]]), c);

  // ---- the remote: on to the level bar, OK takes hold, Up is brighter, Back lets go, Back again closes
  await sleep(2200); await ev('update()');  // the bar gives up the finger's value for the light's own: 40%
  for (let i = 0; i < 6; i++) await key('ArrowLeft');
  await key('Enter'); await key('ArrowUp'); c = await calls();
  await key('Escape'); const still = await popOpen(); await key('Escape'); const closed = !(await popOpen());
  ok('remote: holds the level bar, steps it, Back lets go and then closes', same(c, [['light', 'turn_on', 'light.fake_full', {brightness_pct: 45, transition: 0.3}]]) && still && closed, {c, still, closed});

  // ---- layers: a touch outside the popup closes it and reaches no button under it
  await tap(tile(4)); await tap(tile(0)); text = await q(); c = await calls();
  ok('popup: a touch outside closes it and goes no further', !(await popOpen()) && !text && !c.length, {text, c});
  await set('light.fake_full', 'off'); const off = await ev(`document.querySelector(${JSON.stringify(tile(4))}).style.getPropertyValue('--fill-on')`);
  await tap(tile(5)); c = await calls();
  ok('light that only switches: no popup; a light that is off wears its design', !(await popOpen()) && same(c, [['light', 'toggle', 'light.fake_onoff', {}]]) && !off, {c, off});

  // ---- a choice kept on the light's own device (a WLED preset) is a list of its own
  await ev(`HP.S.reg['light.fake_full'] = {area: 'elsewhere', dev: 'fake_dev', skip: false}; HP.S.reg['select.fake_preset'] = {area: 'elsewhere', dev: 'fake_dev', skip: false}`);
  await set('select.fake_preset', 'Movie', {options: ['Movie', 'Party']}); await set('light.fake_full', 'on');
  await tap(tile(4)); const preset = await ev(`document.querySelector('#pop .pr .dd:last-child .ddv').textContent`);
  await tap('#pop .pr .dd:last-child'); await tap('#pop .pr .dd:last-child .ddl div:last-child'); c = await calls();
  ok('light: a choice on its device is a list', preset === 'Movie' && same(c, [['select', 'select_option', 'select.fake_preset', {option: 'Party'}]]), {preset, c});
  await tap('#pop .px');

  // ---- a room's page: its widest group is "All lights", a group inside that is one button, and its bulbs get none
  await ev(`HP.S.areas.fake_room = 'Fake Room'; for (const e of ['light.fake_a', 'light.fake_b', 'light.fake_c', 'scene.fake_one']) HP.S.reg[e] = {area: 'fake_room', dev: null, skip: false}`);
  for (const [e, n] of [['light.fake_a', 'Fake Room Fan One'], ['light.fake_b', 'Fake Room Fan Two'], ['light.fake_c', 'Fake Room Lamp']]) await set(e, 'on', {friendly_name: n, supported_color_modes: ['brightness'], brightness: 255});
  await set('light.fake_fan', 'on', {friendly_name: 'Fake Room Fan', supported_color_modes: ['brightness'], brightness: 255, entity_id: ['light.fake_a', 'light.fake_b']});
  await set('light.fake_room_all', 'on', {friendly_name: 'Fake Room Lights', supported_color_modes: ['brightness'], entity_id: ['light.fake_fan', 'light.fake_c', 'light.fake_missing']});
  await set('scene.fake_one', '2026-01-01T00:00:00', {friendly_name: 'Fake Room Evening', id: 'x1'});
  await ev(`HP.ctx.go('@room', 'fake_room')`); await sleep(500);
  const names = await js(`[...document.querySelectorAll('#grid .tile .n')].map(n => n.textContent)`);
  const byName = async name => tile(await ev(`[...document.querySelectorAll('#grid .tile')].findIndex(t => (t.querySelector('.n') || {}).textContent === ${JSON.stringify(name)})`));
  await tap(await byName('Fan')); const chips = await js(`[...document.querySelectorAll('#pop .pmem .mb')].map(b => b.textContent)`);
  await tap('#pop .pmem .mb'); const one = await ev(`document.querySelector('#pop .pn div').textContent`);
  await tap('#pop .ph .rb'); const backTo = await ev(`document.querySelector('#pop .pn div').textContent + '/' + document.querySelectorAll('#pop .pmem .mb').length`);
  ok('room: all lights, one button for a fixture, its bulbs in its popup with a way back to it', same(names, ['Back', 'All lights', 'Fan', 'Lamp', 'Scenes', 'Save scene']) && same(chips, ['One', 'Two']) && one === 'Fake Room Fan One' && backTo === 'Fan/2', {names, chips, one, backTo});
  await tap('#pop .px'); await calls();

  // ---- save scene: a new one needs a name; one that exists is replaced after a question. The request is caught, not sent.
  await ev(`window.__sent = []; const realFetch = window.fetch; window.fetch = (u, o) => /\\/api\\/scene$/.test(String(u)) ? (__sent.push(JSON.parse(o.body)), Promise.resolve(new Response('{}')))
    : /\\/api\\/scenes$/.test(String(u)) ? Promise.resolve(new Response(JSON.stringify(HP.scenes))) : realFetch(u, o)`);  // a save makes the page read the scenes again: it gets back what it has
  await tap(await byName('Save scene')); const rep = await js(`[...document.querySelectorAll('#modal .slist .mb')].map(b => b.textContent)`);
  await tap('#modal [data-m=yes]'); const needsName = await ev(`document.getElementById('modal').className === 'open'`);
  await ev(`document.querySelector('#modal .tin').value = ' Evening two '`); await tap('#modal [data-m=yes]');
  await tap(await byName('Save scene')); await tap('#modal [data-m=rep]'); text = await q(); await tap('#modal [data-m=yes]'); await sleep(200);
  const asked = await js('__sent');
  ok('save scene: a name for a new one, a question before replacing one', same(rep, ['Fake Room Evening']) && needsName && text === 'This will replace Fake Room Evening. Are you sure?'
    && same(asked, [{scope: 'area:fake_room', name: 'Evening two'}, {scope: 'area:fake_room', replace: 'scene.fake_one'}]), {rep, needsName, text, asked});

  // ---- the room's scenes in one button: the list drops from it, a choice sets the scene, and the button is lit
  //      while the lights are as the scene sets them: in the scene's colours where the button design asks for that
  await ev(`HP.scenes = {'scene.fake_one': [{e: 'light.fake_a', on: true, bri: 255, mode: 'hs', k: null, hs: [0, 100], rgb: [255, 0, 0]}, {e: 'light.fake_b', on: true, bri: 128, mode: 'hs', k: null, hs: [240, 100], rgb: [0, 0, 255]}, {e: 'light.fake_c', on: false, bri: null, mode: null, k: null, hs: null, rgb: null}]}; HP.theme.tile.lightState = true; show()`);
  await sleep(500); const scenesTile = await byName('Scenes');
  const idle = await js(`{on: document.querySelector(${JSON.stringify(scenesTile)}).classList.contains('on'), arrow: !!document.querySelector(${JSON.stringify(scenesTile)} + ' .arr')}`);
  await tap(scenesTile); const menu = await js(`[...document.querySelectorAll('#pop.menu .mlist div')].map(d => d.textContent)`);
  await tap('#pop .mlist div'); c = await calls();
  const picked = await js(`{name: document.querySelector(${JSON.stringify(scenesTile)} + ' .n').textContent, on: document.querySelector(${JSON.stringify(scenesTile)}).classList.contains('on'), menu: !!HP.pop.cur}`);
  ok('scenes: the list drops from the button, a choice sets the scene and shows at once', !idle.on && idle.arrow && same(menu, ['Evening']) && same(c, [['scene', 'turn_on', 'scene.fake_one', {}]]) && picked.name === 'Evening' && picked.on && !picked.menu, {idle, menu, c, picked});
  // the lights arrive where the scene puts them (a little off, as real lights answer), and the head start is over
  await set('light.fake_a', 'on', {brightness: 252, color_mode: 'hs', hs_color: [2, 97]}); await set('light.fake_b', 'on', {brightness: 131, color_mode: 'hs', hs_color: [238, 100]}); await set('light.fake_c', 'off');
  await ev('HP.sceneSet = null; update()');
  const held = await js(`{name: document.querySelector(${JSON.stringify(scenesTile)} + ' .n').textContent, fill: document.querySelector(${JSON.stringify(scenesTile)}).style.getPropertyValue('--fill-on')}`);
  await set('light.fake_b', 'on', {brightness: 30});
  const left = await js(`{name: document.querySelector(${JSON.stringify(scenesTile)} + ' .n').textContent, on: document.querySelector(${JSON.stringify(scenesTile)}).classList.contains('on'), fill: document.querySelector(${JSON.stringify(scenesTile)}).style.getPropertyValue('--fill-on')}`);
  ok('scenes: lit in the scene\'s colours while the lights match, and no longer once one light is changed',
    held.name === 'Evening' && /^linear-gradient\(90deg, rgba\(255,0,0,1\.00\), rgba\(0,0,255,0\.55\)\)$/.test(held.fill) && left.name === 'Scenes' && !left.on && !left.fill, {held, left});
  await ev(`HP.theme.tile.lightState = false; HP.ctx.back()`); await sleep(500);

  // ---- batteries: several on one button with the lowest on top, and a device's own in the corner of its button
  await ev(`HP.S.reg['lock.fake_plain'] = {area: 'elsewhere', dev: 'fake_lockdev', skip: false}; HP.S.reg['sensor.fake_bat_low'] = {area: 'elsewhere', dev: 'fake_lockdev', skip: true}`);
  await set('sensor.fake_bat_full', '91', {friendly_name: 'Fake Window battery', device_class: 'battery'}); await set('sensor.fake_bat_low', '14.6', {friendly_name: 'Fake Door Battery level', device_class: 'battery'});
  await set('binary_sensor.fake_bat_yn', 'off', {friendly_name: 'Fake Remote battery', device_class: 'battery'});
  await ev('show()'); await sleep(400);
  const bats = await js(`[...document.querySelectorAll('#grid .bats .bat')].map(r => [r.querySelector('.bn').textContent, r.querySelector('.bv').textContent, r.className.replace('bat', '').trim()])`);
  const badge = await js(`(() => { const b = document.querySelector(${JSON.stringify(tile(0))} + ' .batt'); return b ? [b.textContent, b.hidden, b.classList.contains('low')] : null; })()`);
  ok('batteries: lowest first on their button, and a device\'s own on its button', same(bats, [['Fake Door', '15%', 'low'], ['Fake Window', '91%', ''], ['Fake Remote', 'OK', '']]) && same(badge, ['15%', false, true]), {bats, badge});

  // ---- showing: a value in its own words, a gauge against its range, a chart of what Home Assistant kept (made up here)
  await ev(`(() => { const real = HP.ha.call.bind(HP.ha), t = Date.now() / 1000; HP.ha.call = m => m.type === 'history/history_during_period' && /fake_/.test(m.entity_ids[0])
    ? Promise.resolve({[m.entity_ids[0]]: [{s: '20', lu: t - 7200}, {s: 'unavailable', lu: t - 5400}, {s: '24', lu: t - 3600}, {s: '21', lu: t - 60}]}) : real(m); })()`);
  await set('sensor.fake_temp', '21', {friendly_name: 'Fake Temperature', unit_of_measurement: '°C', device_class: 'temperature'});
  await set('binary_sensor.fake_door', 'on', {friendly_name: 'Fake Door', device_class: 'door'});
  await sleep(600);
  const seen5 = await js(`(() => { const of = type => HP.live.filter(i => i.t.type === type), v = of('value'), g = of('gauge')[0], c = of('chart')[0];
    return {value: v[0].p.v.textContent, door: v[1].p.v.textContent, doorLit: v[1].el.classList.contains('on'), gauge: +(parseFloat(g.p.arc.style.strokeDashoffset) / g.len).toFixed(2),
      line: c.p.line.getAttribute('d'), hi: c.p.hi.textContent, lo: c.p.lo.textContent, head: c.p.l.textContent + ' ' + c.p.v.textContent}; })()`);
  ok('showing: a value, a door in its own words, a gauge against its range, a chart with its highest and lowest',
    seen5.value === '21°C' && seen5.door === 'Open' && seen5.doorLit && seen5.gauge === 0.45 && /^M[\d.]+ [\d.]+L[\d.]+ [\d.]+L[\d.]+ [\d.]+H100$/.test(seen5.line || '') && seen5.hi === '24' && seen5.lo === '20' && seen5.head === 'Fake chart 21°C', seen5);

  // ---- a thermostat, a blind, a fan and a player open the same popup with what each of them has
  const lastCall = async () => { const all = await calls(); return all[all.length - 1] || null; };
  await set('climate.fake_heat', 'heat', {friendly_name: 'Fake Thermostat', temperature: 20, current_temperature: 19.5, min_temp: 10, max_temp: 30, target_temp_step: 0.5, hvac_modes: ['off', 'heat', 'cool'], fan_modes: ['auto', 'low'], fan_mode: 'auto'});
  await ev(`HP.act('climate.fake_heat', HP.ctx)`); await sleep(300);
  const heatLine = await ev(`document.querySelector('#pop .ps').textContent`); await calls();
  p = await mid('#pop .vbar'); await at(p[0], p[1] - p[3] * 0.25); const heatSet = await lastCall();
  await tap('#pop .dd'); const heatModes = await js(`[...document.querySelectorAll('#pop .dd.open .ddl div')].map(d => d.textContent)`); await tap('#pop .dd.open .ddl div:last-child'); const heatMode = await lastCall();
  await tap('#pop .px');
  ok('thermostat: its target is sent when the finger lets go, and its modes are a list', heatLine === 'Heat \u00b7 Now 19.5\u00b0 \u00b7 Set 20\u00b0' && same(heatSet, ['climate', 'set_temperature', 'climate.fake_heat', {temperature: 25}])
    && same(heatModes, ['Off', 'Heat', 'Cool']) && same(heatMode, ['climate', 'set_hvac_mode', 'climate.fake_heat', {hvac_mode: 'cool'}]), {heatLine, heatSet, heatModes, heatMode});

  await set('cover.fake_blind', 'open', {friendly_name: 'Fake Blind', device_class: 'blind', supported_features: 15, current_position: 40});
  await ev(`HP.act('cover.fake_blind', HP.ctx)`); await sleep(300);
  const blindBtns = await js(`[...document.querySelectorAll('#pop .modes .mb')].map(b => b.textContent)`); await calls();
  await tap('#pop [data-s=stop_cover]'); const blindStop = await lastCall();
  p = await mid('#pop .vbar'); await at(p[0], p[1]); const blindSet = await lastCall(); await tap('#pop .px');
  await set('cover.fake_awning', 'closed', {friendly_name: 'Fake Awning', device_class: 'awning', supported_features: 3}); await ev(`HP.act('cover.fake_awning', HP.ctx)`); const awning = await lastCall();
  ok('blind: open, stop, close and how far; a cover that only opens and closes does that', same(blindBtns, ['Open', 'Stop', 'Close']) && same(blindStop, ['cover', 'stop_cover', 'cover.fake_blind', {}])
    && same(blindSet, ['cover', 'set_cover_position', 'cover.fake_blind', {position: 50}]) && same(awning, ['cover', 'open_cover', 'cover.fake_awning', {}]) && !(await popOpen()), {blindBtns, blindStop, blindSet, awning});

  await set('fan.fake_fan', 'on', {friendly_name: 'Fake Fan', supported_features: 11, percentage: 33, percentage_step: 33.33, preset_modes: ['auto', 'sleep'], oscillating: false});
  await ev(`HP.act('fan.fake_fan', HP.ctx)`); await sleep(300); await calls();
  await tap('#pop .pr > .mb'); const fanOsc = await lastCall(); await tap('#pop .ph .rb'); const fanPower = await lastCall(); await tap('#pop .px');
  ok('fan: its speed bar, oscillation and power', same(fanOsc, ['fan', 'oscillate', 'fan.fake_fan', {oscillating: true}]) && same(fanPower, ['fan', 'toggle', 'fan.fake_fan', {}]), {fanOsc, fanPower});

  await set('media_player.fake_tv', 'playing', {friendly_name: 'Fake Player', supported_features: 4 | 8 | 16 | 32 | 1 | 16384 | 2048 | 128 | 256, volume_level: 0.3, is_volume_muted: false, source_list: ['TV', 'Radio'], source: 'TV', media_title: 'Song', media_artist: 'Band'});
  await ev(`HP.act('media_player.fake_tv', HP.ctx)`); await sleep(300);
  const tvLine = await ev(`document.querySelector('#pop .ps').textContent`); await calls();
  await tap('#pop [data-b=next]'); const tvNext = await lastCall(); await tap('#pop [data-b=mute]'); const tvMute = await lastCall();
  await tap('#pop .dd'); await tap('#pop .dd.open .ddl div:last-child'); const tvSrc = await lastCall();
  p = await mid('#pop .vbar'); await at(p[0], p[1]); const tvVol = await lastCall(); await tap('#pop .px');
  ok('player: what it plays, next, mute, source and volume', tvLine === 'Song \u00b7 Band' && same(tvNext, ['media_player', 'media_next_track', 'media_player.fake_tv', {}]) && same(tvMute, ['media_player', 'volume_mute', 'media_player.fake_tv', {is_volume_muted: true}])
    && same(tvSrc, ['media_player', 'select_source', 'media_player.fake_tv', {source: 'Radio'}]) && same(tvVol, ['media_player', 'volume_set', 'media_player.fake_tv', {volume_level: 0.5}]), {tvLine, tvNext, tvMute, tvSrc, tvVol});

  // ---- things set by a value, a choice or a few actions
  await set('input_number.fake_n', '4', {friendly_name: 'Fake Number', min: 0, max: 10, step: 0.5, unit_of_measurement: 'h'});
  await ev(`HP.act('input_number.fake_n', HP.ctx)`); await sleep(300); await calls(); p = await mid('#pop .vbar'); await at(p[0], p[1] - p[3] * 0.25); const numSet = await lastCall(); await tap('#pop .px');
  await set('input_select.fake_s', 'Low', {friendly_name: 'Fake Choice', options: ['Low', 'High']});
  await ev(`HP.act('input_select.fake_s', HP.ctx, null, document.querySelector(${JSON.stringify(tile(0))}))`); await sleep(300); await tap('#pop .mlist div:last-child'); const selSet = await lastCall();
  await set('input_text.fake_t', 'old', {friendly_name: 'Fake Text'});
  await ev(`HP.act('input_text.fake_t', HP.ctx)`); await sleep(200); const textWas = await ev(`document.querySelector('#modal .tin').value`);
  await ev(`document.querySelector('#modal .tin').value = 'new words'`); await tap('#modal [data-m=yes]'); const textSet = await lastCall();
  await set('vacuum.fake_v', 'docked', {friendly_name: 'Fake Vacuum', supported_features: 8192 | 4 | 16});
  await ev(`HP.act('vacuum.fake_v', HP.ctx)`); await sleep(300); const vacBtns = await js(`[...document.querySelectorAll('#pop .modes .mb')].map(b => b.textContent)`);
  await tap('#pop [data-s=return_to_base]'); const vacDock = await lastCall(); await tap('#pop .px');
  ok('a number is a bar, a choice a list from its button, a text is typed, a vacuum has its actions',
    same(numSet, ['input_number', 'set_value', 'input_number.fake_n', {value: 7.5}]) && same(selSet, ['input_select', 'select_option', 'input_select.fake_s', {option: 'High'}])
    && textWas === 'old' && same(textSet, ['input_text', 'set_value', 'input_text.fake_t', {value: 'new words'}]) && same(vacBtns, ['Start', 'Pause', 'Dock']) && same(vacDock, ['vacuum', 'return_to_base', 'vacuum.fake_v', {}]),
    {numSet, selSet, textWas, textSet, vacBtns, vacDock});

  await set('siren.fake_siren', 'off', {friendly_name: 'Fake Siren'}); await ev(`HP.act('siren.fake_siren', HP.ctx)`); const sirenQ = await q(); await tap('#modal [data-m=no]'); const sirenNo = await calls();
  await set('update.fake_up', 'on', {friendly_name: 'Fake Firmware'}); await ev(`HP.act('update.fake_up', HP.ctx)`); const upQ = await q(); await tap('#modal [data-m=yes]'); const upYes = await lastCall();
  ok('a siren and an update ask first', sirenQ === 'This will sound Fake Siren. Are you sure?' && !sirenNo.length && upQ === 'This will install the update for Fake Firmware. Are you sure?' && same(upYes, ['update', 'install', 'update.fake_up', {}]), {sirenQ, sirenNo, upQ, upYes});

  // ---- lists Home Assistant answers with (the answers are made up here): a calendar, a to-do list, the weather ahead
  await ev(`(() => { const real = HP.ha.call.bind(HP.ha), at = (days, h) => { const d = new Date(); d.setDate(d.getDate() + days); d.setHours(h, 0, 0, 0); return d; }, day = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    HP.ha.call = m => m.type !== 'call_service' || !m.return_response ? real(m) : Promise.resolve({response: m.service === 'get_events' ? {'calendar.fake_cal': {events: [{start: at(1, 15).toISOString(), summary: 'Dentist'}, {start: day(at(0, 0)), summary: 'Bin day'}]}}
      : m.service === 'get_items' ? {'todo.fake_list': {items: [{summary: 'Milk', uid: 'u1', status: 'needs_action'}]}}
      : {'weather.fake_sky': {forecast: [0, 1, 2].map(n => ({datetime: at(n, 12).toISOString(), condition: n ? 'rainy' : 'sunny', temperature: 20 + n, templow: 10 + n}))}}}); })()`);
  await set('calendar.fake_cal', 'off', {friendly_name: 'Fake Calendar'}); await set('todo.fake_list', '1', {friendly_name: 'Fake List'}); await set('weather.fake_sky', 'sunny', {friendly_name: 'Fake Sky', temperature: 20});
  await ev(`HP.live.filter(i => i.load && ['calendar', 'todo', 'forecast'].includes(i.t.type)).forEach(i => { i.fail = 0; i.busy = false; i.load(); })`); await sleep(700);
  const lists = await js(`{cal: [...document.querySelectorAll('#grid .t-calendar .ag')].map(r => r.querySelector('.ad').textContent.split(' ')[0] + ': ' + r.querySelector('.as').textContent),
    todo: [...document.querySelectorAll('#grid .t-todo .ag')].map(r => r.textContent), fc: [...document.querySelectorAll('#grid .t-forecast .fc')].map(c => c.querySelector('.fh').textContent + '/' + c.querySelector('.fl').textContent)}`);
  await calls(); await tap('#grid .t-todo [data-u]'); const ticked = await lastCall();
  ok('lists: a calendar soonest first, a to-do list that ticks off, the weather ahead', same(lists.cal, ['Today: Bin day', 'Tomorrow: Dentist']) && same(lists.todo, ['Add', 'Milk']) && same(lists.fc, ['20\u00b0/10\u00b0', '21\u00b0/11\u00b0', '22\u00b0/12\u00b0'])
    && same(ticked, ['todo', 'update_item', 'todo.fake_list', {item: 'u1', status: 'completed'}]), {lists, ticked});

  // ---- a remote control: buttons in its integration's words, volume to the player on the same device, a remote of an unknown kind
  await ev(`HP.S.reg['remote.fake_tv'] = {area: 'elsewhere', dev: 'fake_tvdev', plat: 'androidtv_remote', skip: false}; HP.S.reg['media_player.fake_tvmp'] = {area: 'elsewhere', dev: 'fake_tvdev', plat: 'androidtv_remote', skip: false};
    HP.S.reg['remote.fake_sam'] = {area: 'elsewhere', dev: 'fake_samdev', plat: 'samsungtv', skip: false}; HP.S.reg['remote.fake_odd'] = {area: 'elsewhere', dev: 'fake_odddev', plat: 'some_other', skip: false}`);
  await set('remote.fake_tv', 'on', {friendly_name: 'Fake TV', activity_list: ['Films', 'Music'], current_activity: 'Films'});
  await set('media_player.fake_tvmp', 'on', {friendly_name: 'Fake TV player', supported_features: 4 | 8 | 1024 | 2048, is_volume_muted: false, source_list: ['HDMI 1', 'HDMI 2'], source: 'HDMI 1'});
  await ev(`HP.act('remote.fake_tv', HP.ctx)`); await sleep(300); await calls();
  const rc = [];
  for (const b of ['up', 'ok', 'home', 'volup', 'mute', 'chdown']) { await tap(`#pop [data-b=${b}]`); rc.push(await calls()); }
  await tap('#pop .ph .rb'); rc.push(await calls());
  await tap('#pop .rlists .dd'); await tap('#pop .rlists .dd.open .ddl div:last-child'); rc.push(await calls());
  const rcLine = await ev(`document.querySelector('#pop .ps').textContent`); await tap('#pop .px');
  const just = (d, s, e2, data) => [[d, s, e2, data]];
  ok('remote: each button is one press in its integration\'s words; volume and source go to the player on its device',
    same(rc, [just('remote', 'send_command', 'remote.fake_tv', {command: 'DPAD_UP'}), just('remote', 'send_command', 'remote.fake_tv', {command: 'DPAD_CENTER'}), just('remote', 'send_command', 'remote.fake_tv', {command: 'HOME'}),
      just('media_player', 'volume_up', 'media_player.fake_tvmp', {}), just('media_player', 'volume_mute', 'media_player.fake_tvmp', {is_volume_muted: true}), just('remote', 'send_command', 'remote.fake_tv', {command: 'CHANNEL_DOWN'}),
      just('remote', 'toggle', 'remote.fake_tv', {}), just('media_player', 'select_source', 'media_player.fake_tvmp', {source: 'HDMI 2'})]) && rcLine === 'On \u00b7 HDMI 1', {rc, rcLine});
  await set('remote.fake_sam', 'on', {friendly_name: 'Fake Other TV'}); await ev(`HP.act('remote.fake_sam', HP.ctx)`); await sleep(300); await calls();
  await tap('#pop [data-b=volup]'); const samVol = await calls(); await tap('#pop .rlists .mb'); const samSrc = await calls(); await tap('#pop .px');
  await set('remote.fake_odd', 'off', {friendly_name: 'Fake Odd Remote'}); await ev(`HP.act('remote.fake_odd', HP.ctx)`); await sleep(300);
  const odd = await js(`{buttons: document.querySelectorAll('#pop [data-b]').length, power: !!document.querySelector('#pop .ph .rb')}`); await tap('#pop .px');
  ok('remote: without a player its own volume word is sent; a remote of an unknown kind has power only', same(samVol, just('remote', 'send_command', 'remote.fake_sam', {command: 'KEY_VOLUP'}))
    && same(samSrc, just('remote', 'send_command', 'remote.fake_sam', {command: 'KEY_SOURCE'})) && odd.buttons === 0 && odd.power, {samVol, samSrc, odd});

  // ---- a player's tile: its picture, what plays, its buttons; the picture opens what it can play (the library is made up here)
  await ev(`(() => { const real = HP.ha.call.bind(HP.ha); HP.ha.call = m => m.type === 'media_player/search_media' ? (window.__asked = m, Promise.resolve({result: [{title: 'Found Song', can_expand: false, can_play: true, media_content_id: 'f1', media_content_type: 'music', thumbnail: null}]}))
    : m.type !== 'media_player/browse_media' ? real(m) : Promise.resolve(m.media_content_id === 'albums'
    ? {title: 'Albums', children: [{title: 'Night Drive', can_expand: true, can_play: true, media_content_id: 'al1', media_content_type: 'album', thumbnail: '/api/media_player_proxy/x.jpg'}]}
    : {title: 'Media', can_search: true, media_content_id: 'root', media_content_type: 'library', children: [{title: 'Albums', can_expand: true, can_play: false, media_content_id: 'albums', media_content_type: 'albums', thumbnail: null}, {title: 'Radio One', can_expand: false, can_play: true, media_content_id: 'r1', media_content_type: 'music', thumbnail: null}]}); })()`);
  await set('media_player.fake_hifi', 'playing', {friendly_name: 'Fake Hifi', supported_features: 1 | 16 | 32 | 4 | 16384 | 131072, media_title: 'Night Drive', media_artist: 'The Made Ups', entity_picture: '/api/media_player_proxy/now.jpg', volume_level: 0.4});
  await sleep(700);  // the picture's link is signed by Home Assistant first
  const mt = await js(`(() => { const el = document.querySelector('#grid .t-media'); return {title: el.querySelector('.n').textContent, line: el.querySelector('.l').textContent, lit: el.classList.contains('on'),
    art: /\\/api\\/media_player_proxy\\/now\\.jpg/.test(el.querySelector('.mart').style.backgroundImage), btns: [...el.querySelectorAll('.mbtn [data-b]')].map(b => b.dataset.b)}; })()`);
  await calls(); await tap('#grid .t-media [data-b=next]'); const mNext = await calls(); await tap('#grid .t-media [data-b=play]'); const mPlay = await calls();
  await tap('#grid .t-media .mart'); await sleep(300);
  const b1 = await js(`{items: [...document.querySelectorAll('#pop .bi .bnm')].map(n => n.textContent), back: !document.querySelector('#pop .ph .rb').hidden}`);
  const s1 = await ev(`!document.querySelector('#pop .bsearch').hidden`);
  await tap('#pop .bi'); await sleep(700);
  const s2 = await ev(`!document.querySelector('#pop .bsearch').hidden`);
  const b2 = await js(`{items: [...document.querySelectorAll('#pop .bi .bnm')].map(n => n.textContent), trail: document.querySelector('#pop .ps').textContent, play: !!document.querySelector('#pop .bplay'), pic: /x\\.jpg/.test(document.querySelector('#pop .bth').style.backgroundImage)}`);
  await tap('#pop .ph .rb'); await sleep(200); const b3 = await js(`[...document.querySelectorAll('#pop .bi .bnm')].map(n => n.textContent)`);
  await ev(`document.querySelector('#pop .bsearch .tin').value = 'found'`); await tap('#pop .bsearch .mb'); await sleep(300);
  const s3 = await js(`{items: [...document.querySelectorAll('#pop .bi .bnm')].map(n => n.textContent), trail: document.querySelector('#pop .ps').textContent, field: !document.querySelector('#pop .bsearch').hidden, asked: [window.__asked.search_query, window.__asked.media_content_id]}`);
  await tap('#pop .ph .rb'); await sleep(200);
  await calls(); await tap('#pop .bi:last-child'); const bPlay = await calls(); const bClosed = !(await popOpen());
  await tap('#grid .t-media .mtx'); await sleep(200); const mMore = await js(`{open: !!HP.pop.cur, vol: !!document.querySelector('#pop .vbar')}`); await tap('#pop .px');
  ok('player: picture, title and buttons on its tile; the picture opens its library, with search only where Home Assistant offers it; the words open its controls',
    mt.title === 'Night Drive' && mt.line === 'The Made Ups \u00b7 Fake Hifi' && mt.lit && mt.art && same(mt.btns, ['prev', 'play', 'next'])
    && same(mNext, [['media_player', 'media_next_track', 'media_player.fake_hifi', {}]]) && same(mPlay, [['media_player', 'media_play_pause', 'media_player.fake_hifi', {}]])
    && same(b1, {items: ['Albums', 'Radio One'], back: false}) && same(b2, {items: ['Night Drive'], trail: 'Media \u203a Albums', play: true, pic: true}) && same(b3, ['Albums', 'Radio One']) && s1 && !s2 && same(s3, {items: ['Found Song'], trail: 'Media \u203a found', field: false, asked: ['found', 'root']})
    && same(bPlay, [['media_player', 'play_media', 'media_player.fake_hifi', {media_content_id: 'r1', media_content_type: 'music'}]]) && bClosed && mMore.open && mMore.vol, {mt, mNext, mPlay, b1, b2, b3, s1, s2, s3, bPlay, bClosed, mMore});

  // ---- the panel's switch: no questions
  await api('PUT', 'designs/' + id, {name: 'Guard test', design: design(false)}); await sleep(6000);
  await tap(tile(0)); text = await q(); c = await calls();
  ok('lock confirmation off for the panel: unlocks at once', !text && same(c, [['lock', 'unlock', 'lock.fake_plain', {}]]), {text, c});

  const err = await js('__err');
  ok('no script errors', !err.length, err);
  console.log(failed ? failed + ' failed' : 'all passed');
  ws.close(); await done(failed ? 1 : 0);
})().catch(async e => { console.error(String(e.message || e)); await done(1); });
