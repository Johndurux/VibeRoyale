// ── menu.js ───────────────────────────────────────────────────────────────
// The main menu: the first thing a page load shows, and the room every path
// out of a match returns through. It owns four decisions - CONTINUE (step
// into the lobby on the next uncleared stage), QUICK BATTLE (a free fight
// that banks match XP but never advances the campaign), NEW GAME (a wipe
// behind an armed two-tap confirm) and HOW TO PLAY (a short coach panel) -
// and nothing else. Deck and stage picking live in the lobby one step in, so
// the front door stays readable instead of becoming a second lobby.
//
// Every number on it comes from progression.snapshot(), the same source the
// lobby's career strip and its leaderboard tab read, so no two screens can
// disagree about what the player has done.

import { snapshot } from './progression.js';

/**
 * Build the main menu overlay.
 * @param {object} deps
 * @param {object|null} deps.audio createAudio() handle, for press cues
 * @param {() => void} deps.onContinue step into the lobby (deck + stage)
 * @param {() => void} deps.onQuick start a casual match right away
 * @param {() => void} deps.onNew wipe the career, stay on the menu
 */
export function createMenu({ audio, onContinue, onQuick, onNew }) {
  const root = document.getElementById('menu');
  if (!root) return { hide() {}, show() {} };

  const stageEl = document.getElementById('menuStage');
  const winsEl = document.getElementById('menuWins');
  const bestEl = document.getElementById('menuBest');
  const continueBtn = document.getElementById('menuContinue');
  const quickBtn = document.getElementById('menuQuick');
  const newBtn = document.getElementById('menuNew');
  const howBtn = document.getElementById('menuHow');
  const howPanel = document.getElementById('menuHowPanel');

  // NEW GAME is destructive, so it fires on the second tap of a two-tap arm
  // rather than behind a browser confirm(): the first tap repaints the button
  // red and says what a second tap will do, which asks the question in the
  // player's own language instead of a modal. Any other press disarms it.
  let armed = false;
  function disarm() {
    armed = false;
    if (newBtn) {
      newBtn.classList.remove('armed');
      newBtn.textContent = 'NEW GAME';
    }
  }

  /**
   * Paint the career facts. Runs on every show(), so coming back from a
   * match - or wiping with NEW GAME - repaints from the live record.
   */
  function paint() {
    const s = snapshot();
    if (stageEl) stageEl.textContent = s.nextStage + '/' + s.stagesTotal;
    if (winsEl) winsEl.textContent = String(s.wins);
    if (bestEl) bestEl.textContent = String(s.bestStreak);
    if (continueBtn) {
      // The label is the promise: this button lands on the next stage that
      // has not been beaten yet. A finished campaign has no next stage, so
      // the button stops promising and starts reporting.
      continueBtn.textContent = s.stage >= s.stagesTotal
        ? 'CAMPAIGN COMPLETE'
        : (s.stage === 0 ? 'START CAMPAIGN' : 'CONTINUE STAGE ' + s.nextStage);
    }
  }

  /** Disarm NEW GAME, cue the press, then run the button's own action. */
  function press(btn) {
    disarm();
    if (audio) audio.play('card');
    void btn;
  }

  if (continueBtn) {
    continueBtn.addEventListener('click', () => {
      press(continueBtn);
      if (onContinue) onContinue();
    });
  }
  if (quickBtn) {
    quickBtn.addEventListener('click', () => {
      press(quickBtn);
      if (onQuick) onQuick();
    });
  }
  if (newBtn) {
    newBtn.addEventListener('click', () => {
      if (!armed) {
        armed = true;
        newBtn.classList.add('armed');
        newBtn.textContent = 'TAP AGAIN TO RESET';
        if (audio) audio.play('deny');
        return;
      }
      disarm();
      if (onNew) onNew();
    });
  }
  if (howBtn) {
    howBtn.addEventListener('click', () => {
      press(howBtn);
      if (howPanel) howPanel.classList.toggle('on');
    });
  }

  function hide() {
    disarm();
    root.classList.remove('on');
    document.body.classList.remove('menuing');
  }
  function show() {
    root.classList.add('on');
    document.body.classList.add('menuing');
    paint();
  }

  return { hide, show };
}
