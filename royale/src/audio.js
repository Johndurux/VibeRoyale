// ── audio.js ──────────────────────────────────────────────────────────────
// Everything audible is synthesised at runtime with the Web Audio API - no
// MP3/OGG/WAV to license, ship, or fail to load. That keeps the whole game on
// the one CDN script (three) and puts the sound under the same rules as the
// cast: hard edges, bright colours, nothing borrowed from a library.
//
// Two rules shaped this file.
//
// The AudioContext can only be created inside a user gesture - browsers block
// autoplay - so nothing here touches the audio graph until unlock() is called
// from a real click, and every method no-ops before that. Game code can call
// play() as if sound were guaranteed and never needs a guard of its own.
//
// Effects are throttled per cue. Ten melee hits registering in one frame
// should read as one punch, and a crowd of troops melting a tower should not
// stack a dozen thuds. Throttled cues drop the repeats; the rest play every
// time and are simply short enough to sit on top of each other.

// The music loop: a 16-step riff in A minor pentatonic, four chords a bar
// (Am - F - C - G). Everything is oscillator + noise, with a bowed noise bed
// underneath that reads as the crowd.
const BPM = 96;
const STEP_SEC = 60 / BPM / 2; // eighth notes -> 0.3175s per step
const STEPS = 16;
const CHORD_ROOTS = [110, 87.31, 130.81, 98]; // A2, F2, C3, G2 - one per bar
const PENTA = [0, 3, 5, 7, 10, 12, 15, 17, 19, 24]; // semitones above A3

// Tempo per scene, as a multiple of the base BPM. The lobby drags because
// nobody should feel hurried while picking a deck; overtime pushes because the
// clock just got shorter and the music has to say so.
const TEMPO = {
  lobby: 0.82,
  battle: 1,
  overtime: 1.15,
};

// The lobby progression is a different set of roots, not the same one played
// quietly. A major I-IV-V-I under a half-time feel and no backbeat lands as
// "menu music"; the battle loop's Am-F-C-G under a drum kit lands as "match",
// and the deck screen is the one place that should not feel like a match.
const LOBBY_ROOTS = [110, 82.41, 87.31, 130.81]; // A2, E2, F2, C3
const ARP_IDX = [0, 2, 4, 3, 5, 4, 2, 1, 0, 2, 4, 3, 6, 4, 2, 1];

// Minimum seconds between two plays of the same cue. Game events can burst.
const GAP = {
  hit: 0.055,
  towerHit: 0.075,
  enemyPlace: 0.12,
  slash: 0.05,
  thud: 0.06,
  arrow: 0.05,
  pop: 0.05,
};

export function createAudio() {
  let ctx = null;            // the context, created on first gesture
  let master = null;         // everything runs through this, mute sits here
  let sfxBus = null;         // one-shot effects
  let musicBus = null;       // the step-sequenced riff
  let bedBus = null;         // the persistent crowd bed
  let noiseBuf = null;       // one-second white noise, shared by every burst
  let city = null;           // the live crowd source, when music is on
  let cityLfo = null;
  let muted = false;
  let musicOn = false;
  let scene = 'lobby';        // 'lobby' | 'battle' | 'overtime'
  let tempo = TEMPO.lobby;
  let timer = null;          // the music lookahead timer
  let nextStep = 0;          // ctx time of the next scheduled step
  let stepN = 0;
  const lastByCue = new Map();

  // Restore a preference kept locally, so muting once stays muted next boot.
  try {
    muted = localStorage.getItem('viberoyale.muted') === '1';
  } catch (e) {
    muted = false;
  }

  /**
   * Create the audio graph. Safe to call any number of times; also resumes a
   * suspended context (some browsers suspend after a long idle).
   */
  function unlock() {
    if (ctx) {
      if (ctx.state === 'suspended') ctx.resume();
      return;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    try {
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.7;
      master.connect(ctx.destination);
      sfxBus = ctx.createGain();
      sfxBus.gain.value = 1;
      sfxBus.connect(master);
      musicBus = ctx.createGain();
      musicBus.gain.value = 0.75;
      musicBus.connect(master);
      bedBus = ctx.createGain();
      bedBus.gain.value = 0.05;
      bedBus.connect(master);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuf.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    } catch (e) {
      // No audio path: play() no-ops below. The game must never care.
      ctx = null;
    }
  }

  // -- one-shot voices --------------------------------------------------------
  function env(t0, dur, peak) {
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(peak, t0 + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    g.connect(sfxBus);
    return g;
  }

  function osc(type, f0, f1, t0, dur, peak) {
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(Math.max(1, f0), t0);
    if (f1 && f1 !== f0) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t0 + dur);
    const g = env(t0, dur, peak);
    o.connect(g);
    o.start(t0);
    o.stop(t0 + dur + 0.03);
  }

  function burst(t0, dur, peak, filterType, freq) {
    const src = ctx.createBufferSource();
    src.buffer = noiseBuf;
    src.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = filterType;
    flt.frequency.value = freq;
    const g = env(t0, dur, peak);
    src.connect(flt);
    flt.connect(g);
    src.start(t0);
    src.stop(t0 + dur + 0.04);
  }

  /**
   * Play a named cue. Nothing happens before unlock() and nothing is allowed
   * to throw, so the whole game can call this freely.
   * @param {string} name one of the cue keys below
   */
  function play(name) {
    if (!ctx || muted) return;
    // No "must be running" guard here on purpose. resume() is async, so the
    // first cue of a session (a card pick, the countdown) would land in the
    // sliver between the gesture and the context coming up, and a silent
    // first tap makes the whole audio system read as broken. Web Audio
    // replays events scheduled while suspended as soon as it resumes, so
    // scheduling through that sliver is exactly what gets the player their
    // first sound.
    const gap = GAP[name] || 0;
    const last = lastByCue.get(name) || -Infinity;
    if (ctx.currentTime - last < gap) return;
    lastByCue.set(name, ctx.currentTime);

    const now = ctx.currentTime;
    try {
      switch (name) {
        // Card armed: a bright two-note tick on the top side.
        case 'card':
          osc('square', 880, 1320, now, 0.07, 0.1);
          break;
        // A troop lands: body thump plus a crisp attack of air.
        case 'place':
          osc('sine', 210, 58, now, 0.22, 0.5);
          burst(now, 0.08, 0.35, 'lowpass', 700);
          break;
        // Elixir too thin / illegal spot / field full: a flat refusal buzz.
        case 'deny':
          osc('sawtooth', 118, 62, now, 0.17, 0.16);
          break;
        // Spawn chirp riding on deployment.
        case 'spawn':
          osc('triangle', 320, 640, now, 0.15, 0.14);
          break;
        // The rival's deployment: duller, further away, unmistakably theirs.
        case 'enemyPlace':
          osc('sine', 150, 48, now, 0.24, 0.42);
          osc('triangle', 220, 110, now, 0.18, 0.12);
          break;
        // Melee/shot hit: a click and a low knock, throttled by GAP.hit.
        case 'hit':
          burst(now, 0.09, 0.28, 'highpass', 500);
          osc('sine', 190, 70, now, 0.09, 0.35);
          break;
        // Melee blade slash / swish
        case 'slash':
          burst(now, 0.07, 0.3, 'bandpass', 2200);
          osc('sawtooth', 680, 220, now, 0.08, 0.18);
          break;
        // Heavy blunt impact / hammer
        case 'thud':
        case 'blunt':
          osc('sine', 150, 48, now, 0.14, 0.5);
          burst(now, 0.09, 0.32, 'lowpass', 650);
          break;
        // Arrow release / twang
        case 'arrow':
          osc('triangle', 640, 280, now, 0.07, 0.22);
          burst(now, 0.05, 0.18, 'highpass', 1400);
          break;
        // A tower takes damage: heavier, longer knock than a troop hit.
        case 'towerHit':
          burst(now, 0.16, 0.4, 'lowpass', 520);
          osc('sine', 118, 40, now, 0.2, 0.55);
          break;
        // Tower destroyed: the big one.
        case 'ko':
          osc('sine', 92, 28, now, 0.5, 0.6);
          burst(now, 0.42, 0.5, 'lowpass', 400);
          osc('triangle', 46, 22, now, 0.4, 0.28);
          break;
        // The king is under direct fire: a low, long gong.
        case 'king':
          osc('sine', 65, 54, now, 0.9, 0.6);
          osc('sine', 98, 84, now, 0.8, 0.28);
          break;
        // Countdown tick.
        case 'tick':
          osc('square', 840, 840, now, 0.09, 0.12);
          break;
        // GO: a rising two-note squawk.
        case 'go':
          osc('square', 880, 880, now, 0.09, 0.15);
          osc('square', 1180, 1180, now + 0.12, 0.14, 0.15);
          break;
        // Overtime: a descending minor line (A5 G5 F5 E5 D5) over a rising
        // noise swell, so the pitch falls while the tension climbs. The
        // detune on the long tail is what stops it sounding like a jingle.
        case 'overtime': {
          const seq = [880, 783.99, 698.46, 659.25, 587.33];
          seq.forEach((f, i) => {
            osc('triangle', f, f, now + i * 0.1, 0.26, 0.17);
            osc('square', f / 2, f / 2, now + i * 0.1, 0.2, 0.05);
          });
          // A held fifth that slides sharp, under the fall. Without it the
          // arpeggio alone is too polite to signal that something changed.
          osc('sawtooth', 220, 233, now + 0.5, 1.1, 0.09);
          burst(now + 0.5, 1.0, 0.11, 'bandpass', 1400);
          break;
        }
        // Victory: a rising major arpeggio (C5 E5 G5 C6), all finals.
        case 'victory': {
          const seq = [523.25, 659.25, 783.99, 1046.5];
          seq.forEach((f, i) => osc('triangle', f, f, now + i * 0.11, 0.24, 0.2));
          break;
        }
        // Defeat: a falling minor phrase, slower, sadder.
        case 'defeat': {
          const seq = [392, 311.13, 261.63, 196];
          seq.forEach((f, i) => osc('triangle', f, f * 0.99, now + i * 0.17, 0.32, 0.16));
          break;
        }
        // Light troop defeat pop / poof
        case 'pop':
          osc('sine', 520, 180, now, 0.07, 0.26);
          burst(now, 0.05, 0.14, 'highpass', 950);
          break;
        default:
          break;
      }
    } catch (e) {
      // A single bad cue must never take the game down with it.
    }
  }

  // -- the music bed ----------------------------------------------------------
  function startCity() {
    if (!ctx || city) return;
    city = ctx.createBufferSource();
    city.buffer = noiseBuf;
    city.loop = true;
    const flt = ctx.createBiquadFilter();
    flt.type = 'bandpass';
    flt.frequency.value = 620;
    flt.Q.value = 0.4;
    cityLfo = ctx.createOscillator();
    cityLfo.frequency.value = 0.11;
    const lfoGain = ctx.createGain();
    lfoGain.gain.value = 0.02;
    cityLfo.connect(lfoGain);
    lfoGain.connect(bedBus.gain);
    city.connect(flt);
    flt.connect(bedBus);
    city.start();
    cityLfo.start();
  }

  function stopCity() {
    if (city) { try { city.stop(); } catch (e) {} city = null; }
    if (cityLfo) { try { cityLfo.stop(); } catch (e) {} cityLfo = null; }
  }

  /**
   * Seconds per step for the current scene.
   *
   * Derived rather than stored, and read fresh by the scheduler on every step,
   * so a tempo change takes effect at the next step boundary and never
   * rewrites the already-scheduled future.
   * @returns {number}
   */
  function stepSec() {
    return STEP_SEC / tempo;
  }

  function kick(t, v) {
    osc('sine', 140, 42, t, 0.16, v);
    burst(t, 0.04, v * 0.25, 'lowpass', 300);
  }
  function hat(t, v) {
    burst(t, 0.035, v, 'highpass', 6000);
  }
  function bassNote(t, f, v) {
    osc('sine', f, f, t, 0.28, v);
  }
  function arpNote(t, f, v) {
    osc('triangle', f, f, t, 0.2, v);
  }

  function scheduleStep(n, t) {
    const inLobby = scene === 'lobby';
    const bar = Math.floor(n / 4);

    // No drums in the lobby. A backbeat under the deck screen reads as "match
    // in progress" and pulls the player past the one screen that still needs
    // them, so the kit is a battle-only voice rather than a quiet one.
    if (!inLobby) {
      if (n % 4 === 0) kick(t, 0.45);
      if (n % 2 === 1) hat(t, n % 4 === 1 ? 0.14 : 0.08);
    }

    const roots = inLobby ? LOBBY_ROOTS : CHORD_ROOTS;
    if (n % 4 === 0) bassNote(t, roots[bar], inLobby ? 0.16 : 0.22);
    if (n % 4 === 2) bassNote(t, roots[bar] * 1.5, inLobby ? 0.10 : 0.15);

    // Overtime lifts the arp a perfect fifth. Same sixteen notes, so the riff
    // is still recognisably the one that has been playing all match, but a
    // fifth up it stops sounding like background and starts sounding like a
    // warning. Changing the notes here would make it a different song.
    const lift = scene === 'overtime' ? 1.5 : 1;
    arpNote(t, 220 * lift * Math.pow(2, PENTA[ARP_IDX[n]] / 12), inLobby ? 0.06 : 0.09);
  }

  function tick() {
    if (!ctx || !musicOn) return;
    while (nextStep < ctx.currentTime + 0.12) {
      scheduleStep(stepN, nextStep);
      nextStep += stepSec();
      stepN = (stepN + 1) % STEPS;
    }
  }

  /**
   * Choose which music is playing. Null-safe before unlock().
   *
   * The city bed is battle-only. A crowd in the lobby implies a match that has
   * already started, and the bed is the single most expensive thing in this
   * file - it is a permanent looping noise source.
   *
   * Unknown names fall back to battle rather than throwing: this is called
   * from main.js on a state change, and a typo here should not take the match
   * down with it.
   *
   * @param {'lobby'|'battle'|'overtime'} name
   */
  function setScene(name) {
    if (!TEMPO[name]) return;
    const wasMusic = musicOn;
    scene = name;
    tempo = TEMPO[name];
    if (!ctx) return;
    if (name === 'lobby') {
      stopCity();
    } else {
      startCity();
    }
    if (wasMusic && !timer) {
      nextStep = ctx.currentTime + 0.05;
      timer = setInterval(tick, 40);
    }
  }

  /** Turn the music and the crowd bed on or off. Null-safe before unlock(). */
  function setMusic(on) {
    musicOn = !!on;
    if (!ctx) return;
    if (on) {
      // Follows the current scene, so turning music on while in the lobby
      // plays lobby tempo and turning it on in overtime plays the fast one.
      if (scene === 'lobby') stopCity(); else startCity();
      if (!timer) {
        nextStep = ctx.currentTime + 0.05;
        timer = setInterval(tick, 40);
      }
    } else {
      if (timer) { clearInterval(timer); timer = null; }
      stopCity();
    }
  }

  /** Mute everything. Persisted so one bad session is not every session. */
  function setMuted(on) {
    muted = !!on;
    if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : 0.7, ctx.currentTime, 0.02);
    try {
      localStorage.setItem('viberoyale.muted', muted ? '1' : '0');
    } catch (e) {}
  }

  return {
    unlock,
    play,
    setScene,
    setMusic,
    setMuted,
    get ready() { return !!ctx; },
    get muted() { return muted; },
    get scene() { return scene; },
  };
}