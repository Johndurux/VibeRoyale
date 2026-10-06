// Proves the three lobby additions behave, by driving createLobby() against a
// hand-built DOM and a real localStorage. Neither existing suite touches
// lobby.js - it is DOM code - so without this file the padlock, the NEW! badge
// and the deck save are unverified code that only ever runs in a browser.

import { createLobby } from '../src/lobby.js';
import * as progression from '../src/progression.js';

let passed = 0;
let failed = 0;
function ok(name, cond) {
  if (cond) { passed++; console.log('  ok   ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}

// A DOM small enough to read, big enough for the lobby. Only the handful of
// members it actually touches are implemented; anything unrecognised hands
// back a throwaway node so querySelector() never has to return null.
function el(tag) {
  const n = {
    tagName: tag,
    // classList mutations have to be reflected in className, because the lobby
    // sets the two separately: className for the initial build, classList.add
    // for .on / .fixed / .fresh / .locked afterwards. A fake that only tracked
    // one of them would silently mis-report which card is selected.
    className: '',
    style: { setProperty() {}, _w: undefined },
    // `innerHTML = ''` is how the lobby clears a panel between passes, so
    // setting innerHTML has to empty the child list the way a browser would.
    // Without this the grid accumulated every card from every previous render
    // and the tests were clicking nodes from stale passes.
    _children: [],
    listeners: {},
    disabled: false,
    textContent: '',
    title: '',
    // Assigning innerHTML replaces the node's contents. A plain property would
    // leave old children in place, and the lobby clears a panel by setting
    // innerHTML to the empty string before each pass.
    _innerHTML: '',
    classList: {
      _s: new Set(),
      // _sync takes ONE class name. The original passed the whole `c` array
      // through, which stringified to the right thing on add() but made
      // remove() delete an array from a set of strings - className silently
      // kept the removed class. The MENU-button test asserts on className
      // after a hide(), which is what finally exposed that.
      add(...c) { c.forEach((x) => { this._s.add(x); n._sync(x, true); }); },
      remove(...c) { c.forEach((x) => { this._s.delete(x); n._sync(x, false); }); },
      toggle(c, on) {
        if (on === undefined) on = !this._s.has(c);
        on ? this._s.add(c) : this._s.delete(c);
        n._sync(c, on);
      },
      contains(c) { return this._s.has(c); },
    },
    get children() { return this._children; },
    appendChild(k) { this._children.push(k); },
    addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
    click() { for (const f of this.listeners.click || []) f(); },
    // 'canvas' is matched by tag name as well as class, because the lobby
    // writes <canvas> into its own innerHTML and then fetches it back. A
    // stubbed node is returned with a real 2D context so renderFaces() can
    // actually run instead of being bypassed.
    querySelector(sel) {
      if (sel === 'canvas') {
        const c = stub();
        c.tagName = 'canvas';
 return c;
      }
      return this._find(sel.slice(1)) || stub();
    },
    _find(cls) {
      for (const c of this.children) {
        if (typeof c.className === 'string' && c.className.split(/\s+/).includes(cls)) return c;
        const hit = c._find && c._find(cls);
        if (hit) return hit;
      }
      return null;
    },
  };
  // The career bar is the one place the lobby writes a style property.
  Object.defineProperty(n.style, 'width', {
    get() { return this._w; },
    set(v) { this._w = v; },
  });
  n._sync = (cls, on) => {
    const set = new Set(String(n.className).split(/\s+/).filter(Boolean));
    on ? set.add(cls) : set.delete(cls);
    n.className = [...set].join(' ');
  };
  Object.defineProperty(n, 'innerHTML', {
    get() { return n._innerHTML; },
    set(v) { n._innerHTML = v; if (v === '') n._children.length = 0; },
  });
  return n;
}
function stub() {
  const n = el('span');
  n.getContext = () => ctx2d();
  return n;
}

// The 2D context renderFaces() draws into. Every path call is recorded rather
// than rasterised, so the spell sigils can be asserted on (which shapes ran)
// without a canvas. Anything that genuinely needs pixels still has to be
// checked in a browser by a person.
function ctx2d() {
  const c = {
    drawn: 0,
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    lineCap: '',
    clearRect() { c.drawn++; },
    drawImage() { c.drawn++; },
    beginPath() { c.paths = (c.paths || 0) + 1; },
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    fill() { c.filled = (c.filled || 0) + 1; },
    stroke() { c.stroked = (c.stroked || 0) + 1; },
    fillRect() { c.filled = (c.filled || 0) + 1; },
    save() {},
    restore() {},
    translate() {},
    scale() {},
  };
  return c;
}

const nodes = {};
for (const id of ['lobby', 'lobbyPick', 'lobbyDeck', 'lobbyDiff', 'lobbyStart', 'lobbySound',
  'lobbyCount', 'lobbyCountNum', 'lvLevelNum', 'lvBarFill', 'lvXpNum', 'lvRecord',
  'lvStreak', 'lvStreakNum', 'lvTier',
  'lobbyMenu', 'lobbyBoard', 'ltabStage', 'ltabDeck', 'ltabBoard',
  'paneStage', 'paneDeck', 'paneBoard']) {
  nodes[id] = el('div');
  nodes[id].id = id;
}
globalThis.document = {
  getElementById: (id) => nodes[id] || null,
  createElement: (t) => el(t),
  createElementNS: (_ns, t) => el(t),
  body: el('body'),
};
// Every canvas, whether created directly or found with querySelector('canvas'),
// hands out a recording 2D context. lobby.js builds the canvas itself as part
// of its innerHTML, so the querySelector path matters as much as createElement.
const realCreate = globalThis.document.createElement;
globalThis.document.createElement = (t) => {
  const n = realCreate(t);
  n.getContext = () => ctx2d();
  return n;
};

// renderFaces() spins up a WebGL context per panel. There is no canvas here, so
// the ctx it is handed is a plain object. This suite is about deck state, not
// portrait pixels.
globalThis.localStorage = (() => {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
    clear: () => m.clear(),
  };
})();

const silent = { play() {}, unlock() {}, setMuted() {}, setMusic() {}, muted: false };
const mk = (opts = {}) => createLobby({ audio: silent, onStart: () => {}, ...opts });
const cards = () => nodes.lobbyPick.children;
const isLocked = (c) => c.className.includes('locked');

console.log('\nlobby: locked cards are shown but not selectable');
{
  localStorage.clear();
  progression.reset();
  const l = mk();
  ok('the grid renders the whole roster, not just unlocked cards', cards().length > 5);
  ok('some cards are locked at level 1', cards().some(isLocked));
  ok('every locked card is disabled', cards().filter(isLocked).every((c) => c.disabled === true));
  ok('no unlocked card is disabled', cards().filter((c) => !isLocked(c)).every((c) => c.disabled !== true));
  ok('the default deck holds exactly four', l.deck.length === 4);
  ok('the default deck holds no locked card', l.deck.every((id) => progression.isUnlocked(id)));
}

console.log('\nlobby: a locked card cannot enter the deck');
{
  localStorage.clear();
  progression.reset();
  const l = mk();
  const before = JSON.stringify(l.deck);
  cards().find(isLocked).click();
  ok('clicking a locked card leaves the deck unchanged', JSON.stringify(l.deck) === before);
  ok('the deck still holds nothing locked', l.deck.every((id) => progression.isUnlocked(id)));
}

console.log('\nlobby: the padlock names the stage that opens the card');
{
  localStorage.clear();
  progression.reset();
  const l = mk();
  const lockedCards = cards().filter(isLocked);
  ok('the padlock markup carries a STAGE label',
    lockedCards.every((c) => /STAGE \d+/.test(c.innerHTML)));
  // The printed stage must be the one progression says, not a hardcoded guess.
  // Gate 1 is legitimate: clearing stage 1 grants TUX, so a fresh career's
  // locked cards read STAGE 1 and up.
  const printed = lockedCards.map((c) => /STAGE (\d+)/.exec(c.innerHTML)).filter(Boolean).map((m) => +m[1]);
  ok('the printed stage is a real campaign stage for every locked card', printed.length > 0 && printed.every((n) => n >= 1 && n <= 15));
}

console.log('\nlobby: the career strip reads real progression state');
{
  localStorage.clear();
  progression.reset();
  const l = mk();
  ok('level starts at 1', nodes.lvLevelNum.textContent === '1');
  ok('the xp bar starts at zero width', nodes.lvBarFill.style.width === '0.0%');
  ok('the record starts 0W / 0L', nodes.lvRecord.textContent === '0W · 0L');
  ok('an unlit streak shows no tier', nodes.lvTier.textContent === '');

  // Bank a win, then return to the lobby the way main.js does.
  progression.recordMatch({ won: true, difficulty: 'normal', towersDestroyed: 2, damageDealt: 900 });
  l.show();
  const s = progression.snapshot();
  ok('the level advanced after a win', nodes.lvLevelNum.textContent === String(s.level));
  ok('the streak count follows the win', nodes.lvStreakNum.textContent === String(s.streak));
  ok('the bar reflects real progress',
    nodes.lvBarFill.style.width === (s.levelProgress * 100).toFixed(1) + '%');
  ok('show() repainted the grid, not just the strip', cards().length > 0);

  // One win is a streak of 1, and the thresholds are 3 and 5, so the flame has
  // to stay cold here. Bank up to the threshold and the same strip has to light
  // up without anything else being re-rendered.
  ok('one win is below the hot threshold, so the flame stays cold',
    nodes.lvTier.textContent === '' && !nodes.lvStreak.classList.contains('hot'));
  while (progression.snapshot().tier === '') {
    progression.recordMatch({ won: true, difficulty: 'normal' });
  }
  l.show();
  ok('reaching the threshold lights the flame', nodes.lvStreak.classList.contains('hot'));
  ok('and labels it', /^(HOT|ON FIRE)$/.test(nodes.lvTier.textContent));
  ok('the label matches the tier progression reports',
    nodes.lvTier.textContent === (progression.snapshot().tier === 'onfire' ? 'ON FIRE' : 'HOT'));
}

console.log('\nlobby: the deck survives a reload');
{
  localStorage.clear();
  progression.reset();
  const first = mk();
  const target = cards().find((c) => !isLocked(c) && !c.className.includes('on'));
  ok('found an unlocked card outside the default deck', !!target);
  target.click();
  const chosen = first.deck.slice();
  ok('the deck is still exactly four after the swap', chosen.length === 4);
  ok('something was written to storage', !!localStorage.getItem('viberoyale.deck'));
  const second = mk();
  ok('the reloaded deck is the saved one', JSON.stringify(second.deck) === JSON.stringify(chosen));
}

console.log('\nlobby: a save cannot smuggle a locked card back in');
{
  localStorage.clear();
  progression.reset();
  const lockedId = ['armor', 'mist', 'pip', 'honey', 'goggles', 'captain']
    .find((id) => !progression.isUnlocked(id));
  ok('found a card that is locked at level 1', !!lockedId);
  if (lockedId) {
    localStorage.setItem('viberoyale.deck', JSON.stringify([lockedId, lockedId, 'nope', 7]));
    const l = mk();
    ok('the locked id is not restored', !l.deck.includes(lockedId));
    ok('duplicates are collapsed', new Set(l.deck).size === l.deck.length);
    ok('the deck is still exactly four', l.deck.length === 4);
    ok('every restored card is unlocked', l.deck.every((id) => progression.isUnlocked(id)));
  }
}

console.log('\nlobby: a corrupt save falls back instead of throwing');
{
  localStorage.clear();
  progression.reset();
  localStorage.setItem('viberoyale.deck', '{not json');
  let threw = false;
  let l = null;
  try { l = mk(); } catch (e) { threw = true; }
  ok('a malformed save does not throw', !threw);
  ok('it falls back to a full deck', !!l && l.deck.length === 4);
  localStorage.setItem('viberoyale.deck', '["armor"]');
  threw = false;
  try { l = mk(); } catch (e) { threw = true; }
  ok('a one-card save does not throw', !threw);
  ok('and is topped back up to four', !!l && l.deck.length === 4);
}

console.log('\nlobby: a save that cannot be written still plays');
{
  localStorage.clear();
  progression.reset();
  const real = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => { throw new Error('storage blocked'); },
    setItem: () => { throw new Error('quota exceeded'); },
    removeItem: () => {},
    clear: () => {},
  };
  let threw = false;
  let l = null;
  try {
    l = mk();
    l && cards().find((c) => !isLocked(c) && !c.className.includes('on')).click();
  } catch (e) { threw = true; }
  ok('a hostile storage does not take the lobby down', !threw);
  ok('the deck is still playable', !!l && l.deck.length === 4);
  globalThis.localStorage = real;
}

console.log('\nlobby: tabs swap panes and the board reads the career');
{
  localStorage.clear();
  progression.reset();
  mk();
  // The board is built from snapshot(), so bank a match before opening it.
  progression.recordMatch({ won: true, difficulty: 'normal', towersDestroyed: 1, damageDealt: 500 });
  nodes.ltabBoard.click();
  ok('the board tab lights up', nodes.ltabBoard.className.includes('on'));
  ok('the board pane shows', nodes.paneBoard.className.includes('on'));
  ok('the stage pane hides', !nodes.paneStage.className.includes('on'));
  ok('the board rendered its rows', nodes.lobbyBoard.children.length >= 6);
  ok('the first row is the cleared-stage row',
    nodes.lobbyBoard.children[0].children[0].textContent === 'STAGE CLEARED');
  ok('the stage row reports the real campaign position',
    nodes.lobbyBoard.children[0].children[1].textContent ===
      progression.snapshot().stage + ' / ' + progression.snapshot().stagesTotal);
  nodes.ltabDeck.click();
  ok('the deck tab takes over',
    nodes.ltabDeck.className.includes('on') && nodes.paneDeck.className.includes('on'));
  ok('the board pane yields', !nodes.paneBoard.className.includes('on'));

  // Two lobbies share these nodes; only the second carries an onMenu, so the
  // first mk() cannot have answered this click by accident.
  let menued = 0;
  const l2 = mk({ onMenu: () => { menued++; } });
  l2.show();
  ok('show() puts the lobby up', nodes.lobby.className.includes('on'));
  nodes.lobbyMenu.click();
  ok('the MENU button hands control back to the menu', menued === 1);
  ok('the MENU click hid the lobby', !nodes.lobby.className.includes('on'));
}

console.log('\nlobby: show() re-reads the deck, so a NEW GAME wipe lands');
{
  localStorage.clear();
  progression.reset();
  const l = mk();
  const target = cards().find((c) => !isLocked(c) && !c.className.includes('on'));
  target.click();
  const custom = JSON.stringify(l.deck);
  ok('the swapped-in deck was saved', !!localStorage.getItem('viberoyale.deck'));
  // The menu's NEW GAME does exactly this: the save disappears under the
  // live lobby, and the next show() has to rebuild from nothing.
  localStorage.removeItem('viberoyale.deck');
  l.show();
  ok('show() rebuilt a different hand after the wipe', JSON.stringify(l.deck) !== custom);
  ok('the rebuilt hand is four unlocked cards',
    l.deck.length === 4 && l.deck.every((id) => progression.isUnlocked(id)));
}

console.log('\nPASS - ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);