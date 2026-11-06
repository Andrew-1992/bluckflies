// "Listen" buttons: read a piece of the screen aloud for travellers who read little.

import { el, icon } from './dom.js';
import { t } from './i18n.js';
import { canSpeak, speak, stopSpeaking } from './voice.js';

/** Global sound preference: when on, replies and steps are read aloud automatically. */
const SOUND_KEY = 'bluckflies.sound';
let soundOn = (() => {
  try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; }
})();

export const isSoundOn = () => soundOn && canSpeak;
export function setSound(on) {
  soundOn = on;
  try { localStorage.setItem(SOUND_KEY, on ? 'on' : 'off'); } catch { /* per-device convenience */ }
  if (!on) stopAllHearing();
}

export function stopAllHearing() {
  stopSpeaking();
  document.querySelectorAll('.hear[aria-pressed="true"]').forEach((b) => b.setAttribute('aria-pressed', 'false'));
}

/** Speaks `text` if sound is on (used for step prompts and new replies). */
export function sayIfSound(text) {
  if (!isSoundOn() || !text) return Promise.resolve();
  stopAllHearing();
  return speak(text);
}

/**
 * A speaker button. `getText` is called on press so the words match the current language.
 * @param {() => string} getText
 * @param {{ label?: boolean, size?: 'sm' | 'lg' }} opts label: show the word "Listen" next to the icon
 */
export function hearButton(getText, { label = true, size = 'sm' } = {}) {
  if (!canSpeak) return null;
  const btn = el('button', { type: 'button', class: `hear ${size}`, 'aria-pressed': 'false', 'aria-label': t('listen') }, [icon('speaker', size === 'lg' ? 22 : 16), label ? el('span', { text: t('listen') }) : null]);
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // tiles under the button keep their own action
    const playing = btn.getAttribute('aria-pressed') === 'true';
    stopAllHearing();
    if (playing) return;
    btn.setAttribute('aria-pressed', 'true');
    await speak(getText());
    btn.setAttribute('aria-pressed', 'false');
  });
  return btn;
}
