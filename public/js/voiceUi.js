// Voice controls: the microphone in the message box (one spoken message) and
// the hands-free voice conversation (listen → answer aloud → listen again).

import { getLang, setLang, t } from './i18n.js';
import { stopAllHearing } from './hear.js';
import { canListen, canSpeak, detectLang, hasVoiceFor, listen, speak, stopSpeaking, voiceError } from './voice.js';

const $ = (id) => document.getElementById(id);

/**
 * @param {{ send: (text: string, o?: { voice?: boolean, speakReply?: boolean }) => Promise<{ data?: any, error?: string } | null>,
 *           isBusy: () => boolean, showFlights: () => void, input: HTMLTextAreaElement, fitInput: () => void }} deps
 */
export function initVoice({ send, isBusy, showFlights, input, fitInput }) {
  const micBtn = $('mic');
  const hint = $('voice-hint');
  const overlay = $('voice');
  const orb = $('orb');

  if (!canListen) {
    // No speech recognition (e.g. Firefox): hide every voice entry point; typing still works.
    document.querySelectorAll('[data-voice]').forEach((n) => { n.hidden = true; });
    return { open: () => {}, isOpen: () => false, close: () => {}, onLang: () => {} };
  }

  // ---------------------------------------------------- push-to-talk (message box)
  let micListener = null;
  function setMic(on) {
    micBtn.setAttribute('aria-pressed', String(on));
    micBtn.setAttribute('aria-label', on ? t('orbListening') : t('tapSpeak'));
    if (on) hint.textContent = t('listening');
  }
  micBtn.addEventListener('click', () => {
    if (micListener) { micListener.stop(); return; }
    if (isBusy()) return;
    stopAllHearing();
    setMic(true);
    micListener = listen({
      lang: getLang(),
      onInterim: (text) => { input.value = text; fitInput(); },
      onFinal: (text) => {
        input.value = '';
        fitInput();
        hint.textContent = '';
        send(text, { voice: true });
      },
      onError: (code) => { if (code !== 'aborted') hint.textContent = voiceError(code); },
      onEnd: () => {
        micListener = null;
        setMic(false);
        if (hint.textContent === t('listening')) hint.textContent = '';
      },
    });
  });

  // ---------------------------------------------------- hands-free conversation
  const conv = { open: false, listener: null, misses: 0, heard: '', error: null, restart: false, returnFocus: null };
  const ORB_LABEL = { idle: 'orbIdle', listening: 'orbListening', thinking: 'orbThinking', speaking: 'orbSpeaking' };
  const STAGE_TEXT = { idle: 'tapMic', listening: 'listening', thinking: 'thinking', speaking: 'speaking' };

  function setStage(stage, message) {
    orb.dataset.state = stage;
    orb.setAttribute('aria-label', t(ORB_LABEL[stage]));
    $('voice-status').textContent = message ?? t(STAGE_TEXT[stage]);
  }

  function open() {
    micListener?.abort();
    stopAllHearing();
    conv.returnFocus = document.activeElement;
    conv.open = true;
    conv.misses = 0;
    overlay.hidden = false;
    $('voice-heard').textContent = '';
    $('voice-reply').textContent = '';
    $('voice-note').hidden = true;
    $('voice-results').hidden = true;
    syncLangButtons();
    orb.focus();
    listenTurn();
  }

  function close() {
    if (!conv.open) return;
    conv.open = false;
    conv.listener?.abort();
    conv.listener = null;
    stopSpeaking();
    overlay.hidden = true;
    conv.returnFocus?.focus?.();
  }

  /** True when the browser says the microphone is blocked for this site (no prompt will appear). */
  async function micBlocked() {
    try {
      return (await navigator.permissions?.query({ name: 'microphone' }))?.state === 'denied';
    } catch {
      return false; // not supported (Safari, Firefox): the recognition error says it instead
    }
  }

  async function listenTurn() {
    if (!conv.open) return;
    // Never show "Listening…" when nothing can be heard.
    if (await micBlocked()) { setStage('idle', voiceError('not-allowed')); return; }
    if (!conv.open) return;
    setStage('listening');
    $('voice-heard').textContent = '';
    conv.heard = '';
    conv.error = null;
    conv.listener = listen({
      lang: getLang(),
      onInterim: (text) => { $('voice-heard').textContent = text; },
      onFinal: (text) => { conv.heard = text; $('voice-heard').textContent = text; },
      onError: (code) => { conv.error = code; },
      onEnd: () => {
        conv.listener = null;
        if (!conv.open) return;
        if (conv.restart) { conv.restart = false; listenTurn(); return; }
        if (conv.heard) { conv.misses = 0; respond(conv.heard); return; }
        if (conv.error && conv.error !== 'no-speech' && conv.error !== 'aborted') { setStage('idle', voiceError(conv.error)); return; }
        // Silence: try once more, then wait for a tap rather than listening forever.
        conv.misses += 1;
        if (conv.misses >= 2) setStage('idle', t('paused'));
        else listenTurn();
      },
    });
  }

  async function respond(text) {
    setStage('thinking');
    const result = await send(text, { voice: true, speakReply: false });
    if (!conv.open) return;
    if (!result) { setStage('idle'); return; }
    if (result.error) { setStage('idle', result.error); return; }
    if (result.data.stopped) { setStage('idle', t('stopped')); return; }
    const reply = result.data.reply;
    $('voice-reply').textContent = reply;
    $('voice-results').hidden = !result.data.search?.offers?.length;
    const lang = detectLang(reply);
    const note = $('voice-note');
    note.hidden = canSpeak && hasVoiceFor(lang);
    if (!note.hidden) note.textContent = canSpeak && lang === 'ar' ? t('noArabicVoice') : t('noVoice');
    setStage('speaking');
    await speak(reply);
    if (conv.open) listenTurn();
  }

  function syncLangButtons() {
    overlay.querySelectorAll('[data-lang]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.lang === getLang())));
  }

  /** Called by app.js after the interface language changes. */
  function onLang() {
    syncLangButtons();
    micBtn.setAttribute('aria-label', t('tapSpeak'));
    if (!conv.open) return;
    if (conv.listener) {
      conv.restart = true; // listen again in the new language
      conv.listener.abort();
    } else setStage(orb.dataset.state ?? 'idle');
  }

  orb.addEventListener('click', () => {
    const stage = orb.dataset.state;
    if (stage === 'listening') conv.listener?.stop();
    else if (stage === 'speaking') stopSpeaking(); // speak() resolves and listening resumes
    else if (stage === 'idle') { conv.misses = 0; listenTurn(); }
  });
  $('voice-close').addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelectorAll('[data-lang]').forEach((b) => b.addEventListener('click', () => setLang(b.dataset.lang)));
  $('voice-results').addEventListener('click', () => { close(); showFlights(); });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key !== 'Tab') return; // keep keyboard focus inside the dialog
    const items = [...overlay.querySelectorAll('button:not([hidden])')];
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  });
  document.querySelectorAll('[data-voice-open]').forEach((b) => b.addEventListener('click', open));

  return { open, close, isOpen: () => conv.open, onLang };
}
