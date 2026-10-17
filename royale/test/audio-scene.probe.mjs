// ── audio-scene.probe.mjs ───────────────────────────────────────────────────
// The one system a Node test cannot hear. Every note in this game is
// synthesised at runtime, so "is the lobby playing lobby music?" is not a
// question about source text - it is a question about which oscillators and
// noise sources the page actually schedules, and at what frequency. So this
// probe boots the real game in a real browser behind a real click (an
// AudioContext only exists inside a gesture), walks it through
// lobby -> match -> overtime -> back to the lobby, and counts what each scene
// schedules.
//
// The regression it exists for: the lobby is the only place that moves the
// audio scene *backwards*. main.js claims 'battle' on a match start and
// 'overtime' when the clock runs out, so without lobby.js claiming 'lobby' on
// the way in, the second trip through the deck screen plays the last match's
// music - drum kit, city bed and battle tempo over the one screen that should
// not sound like a match in progress. A grep cannot catch that: both files
// still contain the word setScene. Node counts can.
//
// It needs a Chromium, so it is deliberately not part of `node --test`:
//   node test/audio-scene.probe.mjs
//   VR_CHROME=/path/to/chrome node test/audio-scene.probe.mjs
// With no browser on the box it prints SKIP and exits 0, so a suite that runs
// it anyway does not fail on a machine that cannot host it.
//
// The page side of the probe is instrumented through
// Page.addScriptToEvaluateOnNewDocument, which runs before any game script, so
// no AudioContext can be created behind its back. Everything it reads is the
// audio module's own public surface (__vrScope.__audio, __match) - the dev
// test surface main.js publishes on a local origin only.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// The riff, from audio.js, restated here as the contract rather than imported:
// the probe is supposed to fail if those numbers move, not to move with them.
const ARP_BASE = 220;          // A3 pentatonic root
const KICK_HZ = 140;           // kick starts here and sweeps down to 42
const CITY_LFO_HZ = 0.11;      // the crowd bed's tremolo, battle-only

// ── the browser ────────────────────────────────────────────────────────────
function findChrome() {
  if (process.env.VR_CHROME) return existsSync(process.env.VR_CHROME) ? process.env.VR_CHROME : null;
  const tools = join(process.env.HOME ?? '/root', '.hermes', 'tools');
  const found = [];
  if (existsSync(tools)) {
    for (const dir of readdirSync(tools)) {
      if (!dir.startsWith('chromium')) continue;
      const p = join(tools, dir, 'chrome-linux64', 'chrome');
      if (existsSync(p)) found.push(p);
    }
  }
  for (const p of [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ]) if (existsSync(p)) found.push(p);
  return found[0] ?? null;
}

// ── tiny CDP client (no dependencies: Node has fetch and WebSocket) ────────
class Session {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.waiting = new Map();
    this.sessionId = null;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      const slot = this.waiting.get(msg.id);
      if (!slot) return;
      this.waiting.delete(msg.id);
      if (msg.error) slot.rej(new Error(msg.error.message));
      else slot.res(msg.result);
    };
  }

  static async open(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error(`cannot open ${url}`));
    });
    return new Session(ws);
  }

  send(method, params = {}) {
    const id = ++this.seq;
    const msg = { id, method, params };
    if (this.sessionId) msg.sessionId = this.sessionId;
    this.ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => {
      this.waiting.set(id, { res, rej });
      setTimeout(() => {
        if (this.waiting.delete(id)) rej(new Error(`${method} timed out`));
      }, 20000).unref?.();
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      throw new Error(`page threw: ${d}`);
    }
    return r.result.value;
  }

  /** Trusted input, so the page sees a real gesture and not a scripted click. */
  async click(x, y) {
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
  }

  async clickSelector(sel) {
    const box = await this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, w: r.width, h: r.height };
    })()`);
    if (!box) throw new Error(`no ${sel} on the page`);
    if (box.w < 2 || box.h < 2) return false;                 // laid out but not really shown
    await this.click(Math.round(box.x), Math.round(box.y));
    return true;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((res) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); });
});
async function waitFor(fn, ms = 15000, step = 200) {
  const end = Date.now() + ms;
  for (;;) {
    try { if (await fn()) return true; } catch (e) { /* keep waiting */ }
    if (Date.now() > end) return false;
    await sleep(step);
  }
}

// ── page instrumentation ───────────────────────────────────────────────────
const INSTRUMENT = `(() => {
  const rec = window.__aud = { osc: [], oscs: 0, bufs: 0, bufStops: 0, bedStops: 0, ctxs: 0, err: null };
  window.__audReset = () => { rec.osc.length = 0; rec.oscs = 0; rec.bufs = 0; rec.bufStops = 0; };
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { rec.err = 'no AudioContext'; return; }
    const proto = AC.prototype;
    const cOsc = proto.createOscillator, cBuf = proto.createBufferSource, cGain = proto.createGain;
    // The graph is recorded, not just the node count: "the fader works" is a
    // claim about where a gain sits in the signal path, and the one way to get it
    // wrong here is to write the fader onto the very gain the bed's tremolo is
    // already modulating - which leaves the crowd humming at "volume 0".
    rec.nodes = {}; rec.edges = []; rec.seq = 0; rec.paramOwner = new WeakMap();
    const tag = (node, kind) => {
      const id = ++rec.seq;
      rec.nodes[id] = { kind, n: node };
      try { node.__audId = id; } catch (e) { /* frozen node, id is best effort */ }
      return node;
    };
    proto.createOscillator = function () {
      const o = tag(cOsc.call(this), 'osc');
      const entry = { type: o.type, f: null, f1: null };
      rec.osc.push(entry); rec.oscs++;
      Object.defineProperty(o, 'type', { configurable: true, get: () => entry.type, set: (v) => { entry.type = v; } });
      const f = o.frequency, sv = f.setValueAtTime.bind(f);
      f.setValueAtTime = (v, t) => { if (entry.f === null) entry.f = v; return sv(v, t); };
      const er = f.exponentialRampToValueAtTime.bind(f);
      f.exponentialRampToValueAtTime = (v, t) => { entry.f1 = v; return er(v, t); };
      // The crowd bed writes its tremolo through the plain value setter rather
      // than the scheduled path, so a probe that only watched setValueAtTime
      // would report a bed that plays in every scene as one that never exists.
      const vd = Object.getOwnPropertyDescriptor(AudioParam.prototype, 'value');
      Object.defineProperty(f, 'value', {
        configurable: true,
        get: () => vd.get.call(f),
        set: (v) => { if (entry.f === null) entry.f = v; vd.set.call(f, v); },
      });
      const osp = o.stop.bind(o);
      o.stop = (...a) => {
        entry.stopped = true;
        if (typeof entry.f === 'number' && entry.f < 1) rec.bedStops++;   // the bed's own tremolo, torn down
        return osp(...a);
      };
      return o;
    };
    proto.createBufferSource = function () {
      const src = tag(cBuf.call(this), 'buf');
      rec.bufs++;
      const st = src.start.bind(src), sp = src.stop.bind(src);
      src.start = (...a) => st(...a);
      src.stop = (...a) => { rec.bufStops++; return sp(...a); };
      return src;
    };
    proto.createGain = function () {
      const g = tag(cGain.call(this), 'gain');
      rec.paramOwner.set(g.gain, g.__audId);
      return g;
    };
    // Gain values are only trustworthy while the renderer is pulling the graph;
    // a long silent stretch in a headless profile leaves the automation frozen
    // at whatever it started at. What the fader *does* is schedule a ramp, so
    // that is what gets recorded - with the node it landed on.
    if (!rec.automation) rec.automation = [];
    const sta = AudioParam.prototype.setTargetAtTime;
    AudioParam.prototype.setTargetAtTime = function (v, t, c) {
      if (rec.automation.length < 500) rec.automation.push({ owner: rec.paramOwner.get(this) ?? null, value: v });
      return sta.call(this, v, t, c);
    };
    const AN = window.AudioNode && window.AudioNode.prototype;
    if (AN) {
      const c = AN.connect;
      AN.connect = function (dst, ...rest) {
        try {
          const from = this.__audId ?? null;
          if (dst === this.context.destination) rec.edges.push({ from, to: 'out', param: false });
          else if (window.AudioParam && dst instanceof window.AudioParam) rec.edges.push({ from, to: rec.paramOwner.get(dst) ?? null, param: true });
          else rec.edges.push({ from, to: dst.__audId ?? null, param: false });
        } catch (e) { rec.err = String(e); }
        return c.call(this, dst, ...rest);
      };
    }
    window.AudioContext = new Proxy(AC, { construct: (t, a) => { rec.ctxs++; return new t(...a); } });
  } catch (e) { rec.err = String(e); }
})();`;

// One read of the page: the raw counters, plus the scene fingerprints the
// assertions are written against.
const READ = `(() => {
  const r = window.__aud;
  const scope = window.__vrScope;
  if (!r || !scope) return { missing: !r ? '__aud' : '__vrScope' };
  const tris = r.osc.filter((o) => o.type === 'triangle' && typeof o.f === 'number').map((o) => o.f);
  // The crowd bed is the only sub-1 Hz oscillator in the file, so it is the
  // one voice whose existence can be read straight off the node list: created
  // means the bed was started, still-live means nobody has stopped it.
  const beds = r.osc.filter((o) => typeof o.f === 'number' && o.f < 1);
  const kicks = r.osc.filter((o) => typeof o.f === 'number' && Math.abs(o.f - ${KICK_HZ}) < 0.01).length;
  return {
    ctxs: r.ctxs, oscs: r.oscs, bufs: r.bufs, bufStops: r.bufStops, err: r.err,
    tris: tris.length, minTri: tris.length ? Math.min(...tris) : null,
    kicks, subsCreated: beds.length, subsLive: beds.filter((o) => !o.stopped).length, bedStops: r.bedStops,
    scene: scope.__audio.scene, ready: !!scope.__audio.ready, muted: !!scope.__audio.muted,
    volume: { ...scope.__audio.volume },
    graph: {
      nodes: Object.keys(r.nodes || {}).map((id) => ({ id: +id, kind: r.nodes[id].kind, gain: r.nodes[id].kind === 'gain' ? r.nodes[id].n.gain.value : null })),
      edges: (r.edges || []).map((e) => ({ from: e.from, to: e.to, param: e.param })),
    },
    ls: [localStorage.getItem('viberoyale.vol.music'), localStorage.getItem('viberoyale.vol.sfx')].join('/'),
    automation: (r.automation || []).slice(-30),
    ctxState: (() => {
      const first = Object.values(r.nodes || {})[0];
      if (!first) return null;
      return first.n.context.state + '@' + first.n.context.currentTime.toFixed(2);
    })(),
    phase: scope.__match ? scope.__match.phase : null,
    settled: !!scope.__settled,
    menuOn: !!document.getElementById('menu')?.classList.contains('on'),
    lobbyOn: !!document.getElementById('lobby')?.classList.contains('on'),
  };
})()`;

// Total gain from one node down to the speakers. This is the only honest way to
// answer "did the fader reach the bed": the bed's own gain node is being pushed
// around by an LFO, so its live value says nothing about what comes out.
function downstreamGain(graph, startId) {
  const adj = new Map();
  for (const e of graph.edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    adj.get(e.from).push(e.to);
  }
  const path = [];
  const seen = new Set();
  let cur = startId;
  while (cur != null && !seen.has(cur)) {
    seen.add(cur);
    path.push(cur);
    const next = adj.get(cur) || [];
    if (next.includes('out')) { path.push('out'); break; }
    cur = next.find((n) => n != null && !seen.has(n)) ?? null;
  }
  if (path[path.length - 1] !== 'out') return null;
  let gain = 1;
  const steps = [];
  for (const id of path) {
    if (id === 'out') break;
    const n = graph.nodes.find((x) => x.id === id);
    if (!n) return null;
    if (typeof n.gain === 'number') { gain *= n.gain; steps.push({ id, gain: n.gain }); }
  }
  return { gain, path, steps };
}

// The gain an LFO is modulating is the one the fader must *not* be written on.
function modulatedPath(graph) {
  for (const e of graph.edges) {
    if (!e.param || e.to == null) continue;
    const d = downstreamGain(graph, e.to);
    if (d) return d;
  }
  return null;
}

async function measure(s, ms) {
  await s.eval('window.__audReset()');
  await sleep(ms);
  return s.eval(READ);
}

// ── run ────────────────────────────────────────────────────────────────────
const results = [];
function check(name, ok, info = '') {
  results.push({ name, ok: !!ok, info });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${info ? `  [${info}]` : ''}`);
}

const chrome = findChrome();
if (!chrome) {
  console.log('SKIP  no Chromium found - set VR_CHROME=/path/to/chrome to run the audio probe');
  process.exit(0);
}

const httpPort = await freePort();
const cdpPort = await freePort();
const profile = mkdtempSync(join(tmpdir(), 'vr-audio-probe-'));
const server = spawn(process.execPath, ['serve.mjs'], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(httpPort) },
  stdio: 'ignore',
});
const browser = spawn(chrome, [
  '--headless=new',
  `--remote-debugging-port=${cdpPort}`,
  `--user-data-dir=${profile}`,
  '--no-sandbox',
  '--no-first-run',
  '--no-default-browser-check',
  // Without these three a headless page has its timers throttled to 1 Hz, the
  // music scheduler falls behind the clock, and an empty window would look
  // like sane silence instead of a measurement problem.
  '--disable-background-timer-throttling',
  '--disable-renderer-backgrounding',
  '--disable-backgrounding-occluded-windows',
  '--window-size=900,700',
  'about:blank',
], { stdio: 'ignore' });

const cleanup = () => {
  try { browser.kill('SIGKILL'); } catch (e) { /* already gone */ }
  try { server.kill('SIGKILL'); } catch (e) { /* already gone */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch (e) { /* best effort */ }
};
process.on('exit', cleanup);

let session = null;
try {
  const served = await waitFor(async () => (await fetch(`http://127.0.0.1:${httpPort}/index.html`)).ok, 10000);
  if (!served) throw new Error('serve.mjs never answered');
  const up = await waitFor(async () => (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).ok, 20000);
  if (!up) throw new Error('chrome never opened its devtools port');
  const { webSocketDebuggerUrl } = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();

  session = await Session.open(webSocketDebuggerUrl);
  const { targetId } = await session.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await session.send('Target.attachToTarget', { targetId, flatten: true });
  session.sessionId = sessionId;
  await session.send('Page.enable');
  await session.send('Runtime.enable');
  await session.send('Page.addScriptToEvaluateOnNewDocument', { source: INSTRUMENT });
  await session.send('Page.navigate', { url: `http://localhost:${httpPort}/` });

  const booted = await waitFor(async () => await session.eval('document.readyState === "complete" && !!window.__vrScope'), 20000);
  check('the dev test surface is up on a local origin', booted);
  const boot = await session.eval(READ);
  check('no AudioContext is created before a gesture', boot.ctxs === 0, `ctxs=${boot.ctxs}`);
  check('the game boots on the front door, not inside a match', boot.menuOn && !boot.lobbyOn && boot.scene === 'lobby', `menu=${boot.menuOn} lobby=${boot.lobbyOn} scene=${boot.scene}`);

  // A fresh profile has a fresh save, so the first-run panel is over the menu.
  // Dismiss it by hand: it is a modal, and a modal would swallow the real
  // clicks this probe needs later.
  const told = await session.eval('!!document.getElementById("tutorial")?.classList.contains("on")');
  if (told) {
    await session.clickSelector('#tutOk');
    await sleep(300);
  }

  // The one gesture the whole session needs. Everything audible is behind it.
  // With no panel to dismiss it is aimed at the corner of the screen, where no
  // button can be hiding under it.
  if (!told) await session.click(20, 20);
  await waitFor(async () => await session.eval('!!window.__vrScope.__audio.ready'), 5000);
  const unlocked = await session.eval(READ);
  check('a real click creates exactly one AudioContext', unlocked.ctxs === 1 && unlocked.ready, `ctxs=${unlocked.ctxs} ready=${unlocked.ready}`);
  check('the instrumentation is in front of the audio module', unlocked.err === null, unlocked.err ?? '');

  // ── the lobby's own music ────────────────────────────────────────────────
  const intoLobby = await session.clickSelector('#menuContinue');
  check('the front door offers the deck screen', intoLobby);
  const arrived = await waitFor(async () => (await session.eval(READ)).lobbyOn, 5000);
  const inLobby = await session.eval(READ);
  check('walking into the deck screen claims the lobby scene', arrived && inLobby.scene === 'lobby', `scene=${inLobby.scene}`);

  // Music only starts with a match, so the deck screen is normally silent on a
  // first boot. Forcing it on here is what makes the scene measurable without
  // playing a match first - and scene is precisely the thing that regressed.
  await session.eval('window.__vrScope.__audio.setMusic(true)');
  const lobby = await measure(session, 9000);
  check('lobby music is audible when the lobby asks for music', lobby.tris >= 1, `triangles=${lobby.tris}`);
  check('the lobby schedules no drum kit', lobby.bufs === 0 && lobby.kicks === 0, `bursts=${lobby.bufs} kicks=${lobby.kicks}`);
  check('the crowd bed is silent in the lobby', lobby.subsCreated === 0, `bedStarted=${lobby.subsCreated}`);

  // ── a real match start, through the countdown, with real clicks ──────────
  await session.eval('window.__audReset()');   // cumulative from here covers the transition itself
  const clicked = await session.clickSelector('#lobbyStart');
  check('the deck screen offers a start button', clicked);
  const inBattle = await waitFor(async () => (await session.eval(READ)).scene === 'battle', 12000);
  check('the countdown hands the scene to the battle', inBattle);
  const atStart = await session.eval(READ);
  check('entering the match starts the crowd bed', atStart.subsLive >= 1, `bedLive=${atStart.subsLive}`);

  const battle = await measure(session, 9000);
  check('the battle schedules its drum kit', battle.bufs >= 1 && battle.kicks >= 1, `bursts=${battle.bufs} kicks=${battle.kicks}`);
  check('the battle keeps playing the riff', battle.tris >= 1, `triangles=${battle.tris}`);
  check('the battle arp sits on the 220 Hz root', battle.minTri !== null && battle.minTri >= ARP_BASE - 0.5, `minTri=${battle.minTri}`);

  // ── overtime: stepping the referee, not waiting four minutes ─────────────
  const toOt = await session.eval(`(() => {
    const m = window.__vrScope.__match;
    for (let i = 0; i < 400 && m.phase === 'reg'; i++) m.update(1);
    return m.phase;
  })()`);
  check('the referee can be stepped into overtime', toOt === 'ot', `phase=${toOt}`);
  const otScene = await waitFor(async () => (await session.eval(READ)).scene === 'overtime', 3000);
  check('overtime claims its own audio scene', otScene);
  const ot = await measure(session, 9000);
  check('the overtime arp is a fifth up', ot.tris >= 1 && ot.minTri >= ARP_BASE * 1.5 - 0.5, `triangles=${ot.tris} minTri=${ot.minTri}`);
  check('overtime keeps the drum kit', ot.bufs >= 1, `bursts=${ot.bufs}`);
  check('overtime leaves the crowd bed running', ot.bedStops === 0, `bedStops=${ot.bedStops}`);

  // ── the way back: settle, then hand control to the lobby ────────────────
  const done = await session.eval(`(() => {
    const m = window.__vrScope.__match;
    for (let i = 0; i < 400 && !window.__vrScope.__settled; i++) m.update(1);
    return { phase: m.phase, settled: window.__vrScope.__settled };
  })()`);
  check('the match settles once, by itself', done.settled && done.phase === 'done', `phase=${done.phase}`);
  await sleep(500);
  const beforeBack = await session.eval(READ);

  const back = await session.clickSelector('#btnChangeDeck');
  if (!back) await session.eval('document.getElementById("btnChangeDeck").click()');   // panel not painted: same handler
  const homed = await waitFor(async () => (await session.eval(READ)).scene === 'lobby', 4000);
  const afterBack = await session.eval(READ);
  check('the lobby takes the audio scene back on the way in', homed, `scene=${afterBack.scene}`);
  check('the crowd bed is torn down, not just relabelled', afterBack.bedStops >= 1, `bedStops=${beforeBack.bedStops}->${afterBack.bedStops}`);

  const homed2 = await measure(session, 4000);
  check('the second visit to the deck screen is not the last match', homed2.scene === 'lobby' && homed2.subsCreated === 0, `scene=${homed2.scene} bedStarted=${homed2.subsCreated}`);

  // ── the two faders ───────────────────────────────────────────────────────
  // The graph is cumulative for the whole run, so by now it holds the real
  // deck-to-speakers wiring built at unlock. Every claim below is read off that
  // wiring or off the live gain values in it, not off the fader's own number.
  const setFader = (id, v) => session.eval(`(() => {
    const el = document.getElementById('${id}');
    if (!el) return null;
    el.value = '${v}';
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return el.value;
  })()`);

  check('the deck screen carries a music fader and an effects fader',
    await session.eval('!!document.getElementById("volMusic") && !!document.getElementById("volSfx")'));

  await setFader('volMusic', 0);
  await setFader('volSfx', 40);
  await sleep(400);
  const faded = await session.eval(READ);
  check('a drag reaches the audio module, not just the input',
    faded.volume.music === 0 && Math.abs(faded.volume.sfx - 0.4) < 1e-9,
    `music=${faded.volume.music} sfx=${faded.volume.sfx}`);
  check('the level is kept for the next boot', faded.ls === '0/0.4', `stored=${faded.ls}`);

  const silent = modulatedPath(faded.graph);
  check('the modulated gain feeds a fader of its own', !!silent && silent.path.length >= 3,
    silent ? `path=${silent.path.join('>')}` : 'no LFO-modulated gain reaches the speakers');

  // The fader's whole job is to schedule the bed's own gain to the chosen level
  // and leave the one the tremolo rides alone. That is read off the automation
  // log rather than off gain.value: a long silent stretch leaves a headless
  // Chrome holding the value a param started at.
  const bedVolId = silent ? silent.path[1] : null;   // the step after the modulated gain
  const bedTremId = silent ? silent.path[0] : null;  // the gain the tremolo writes to
  const onBed = (r) => r.automation.filter((a) => a.owner === bedVolId).map((a) => a.value);
  check('music at zero silences the bed at its own volume node',
    !!bedVolId && onBed(faded).includes(0),
    bedVolId ? `node ${bedVolId} <- ${JSON.stringify(onBed(faded))}` : 'no bed volume node in the path');
  check('the tremolo gain is never used as a volume knob',
    !!bedTremId && !faded.automation.some((a) => a.owner === bedTremId),
    bedTremId ? `node ${bedTremId} <- ${JSON.stringify(faded.automation.filter((a) => a.owner === bedTremId))}` : '');
  check('the effects fader writes the effects bus',
    faded.automation.some((a) => Math.abs(a.value - 0.4) < 1e-9),
    `recent ramps=${JSON.stringify(faded.automation.slice(-4))}`);

  await setFader('volMusic', 60);
  await sleep(400);
  const louder = await session.eval(READ);
  check('turning it back up re-writes that same node',
    !!bedVolId && onBed(louder).slice(-1)[0] === 0.6,
    `node ${bedVolId} <- ${JSON.stringify(onBed(louder).slice(-3))}`);

  // A reload settles the last question: does the slider show what was chosen,
  // or whatever its markup defaulted to?
  await session.send('Page.navigate', { url: `http://localhost:${httpPort}/` });
  const again = await waitFor(async () => await session.eval('document.readyState === "complete" && !!window.__vrScope'), 20000);
  const shown = again ? await session.eval('(() => { const m = document.getElementById("volMusic"), s = document.getElementById("volSfx"); return (!m || !s) ? null : m.value + "/" + s.value; })()') : null;
  check('the faders come back showing the stored level', shown === '60/40', `sliders=${shown}`);

  // ...and the same levels had better be what the mixer actually runs at. A page
  // that was just reloaded has a young audio clock, so gain.value is honest
  // again here where the long session above was not. Three gains feed the
  // speakers on a fresh boot: the effects bus, the music bus at three quarters
  // of the fader, and the crowd bed at the fader itself.
  await session.click(20, 20);
  let live = null;
  const levels = (buses) => buses.length === 3
    && Math.abs(buses[0] - 0.4) < 0.02 && Math.abs(buses[1] - 0.45) < 0.02 && Math.abs(buses[2] - 0.6) < 0.02;
  for (let i = 0; i < 24; i++) {
    const r = await session.eval(READ);
    if (r.ctxState && r.ctxState.startsWith('running')) {
      const out = r.graph.edges.filter((e) => e.to === 'out').map((e) => e.from)[0];
      const buses = r.graph.nodes
        .filter((n) => n.kind === 'gain' && r.graph.edges.some((e) => e.from === n.id && e.to === out))
        .map((n) => n.gain).sort((a, b) => a - b);
      live = { state: r.ctxState, buses };
      if (levels(buses)) break;
    }
    await sleep(150);
  }
  check('a fresh boot runs every gain that feeds the speakers at the slider levels',
    !!live && levels(live.buses),
    live ? `gains-to-master=${JSON.stringify(live.buses)} (${live.state})` : 'the audio graph never came up in time');
} catch (e) {
  check('the probe ran to the end', false, String(e && e.message ? e.message : e));
} finally {
  try { session?.ws.close(); } catch (e) { /* nothing to close */ }
  cleanup();
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} audio scene checks passed`);
process.exit(failed.length ? 1 : 0);
