// Voice input and spoken replies using the browser's Web Speech API.
//
// Speech recognition runs in the browser's own speech service (Google in Chrome,
// Apple in Safari); the audio never reaches the BluckFlies server, only the text.
// Supported in Chrome, Edge, Safari and Samsung Internet; not in Firefox.

import { t } from './i18n.js';

const Recognition = window.SpeechRecognition ?? window.webkitSpeechRecognition;
export const canListen = Boolean(Recognition);
export const canSpeak = 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;

/**
 * Recognition locales are tried in order: not every browser offers every Arabic
 * locale, so Sudanese Arabic falls back to Egyptian (closest widely available),
 * then Saudi Arabic.
 */
export const LANGS = {
  en: { label: 'English', short: 'EN', recognize: ['en-KE', 'en-GB', 'en-US'], speak: 'en', dir: 'ltr' },
  ar: { label: 'العربية', short: 'ع', recognize: ['ar-SD', 'ar-EG', 'ar-SA'], speak: 'ar', dir: 'rtl' },
};

const ERROR_KEYS = {
  'not-allowed': 'vErr_notAllowed',
  'service-not-allowed': 'vErr_notAllowed',
  'audio-capture': 'vErr_noMic',
  network: 'vErr_network',
  'no-speech': 'vErr_noSpeech',
  'language-not-supported': 'vErr_lang',
};

/** Plain-language message for a speech recognition error code, in the interface language. */
export function voiceError(code) {
  return t(ERROR_KEYS[code] ?? 'vErr_other');
}

/**
 * Listens for one utterance.
 * @param {{ lang: keyof LANGS, onInterim?: (t: string) => void, onFinal: (t: string) => void, onError?: (code: string) => void, onEnd?: () => void }} o
 * @returns {{ stop: () => void, abort: () => void }}
 */
export function listen({ lang, onInterim, onFinal, onError, onEnd }) {
  const locales = LANGS[lang].recognize;
  let rec = null;
  let finished = false;
  let gotFinal = false;

  const start = (i) => {
    rec = new Recognition();
    rec.lang = locales[i];
    rec.interimResults = true;
    rec.continuous = false;
    rec.maxAlternatives = 1;
    rec.onresult = (e) => {
      let interim = '';
      let final = '';
      for (let r = e.resultIndex; r < e.results.length; r++) {
        const text = e.results[r][0].transcript;
        if (e.results[r].isFinal) final += text;
        else interim += text;
      }
      if (interim) onInterim?.(interim);
      if (final.trim()) {
        gotFinal = true;
        onFinal(final.trim());
      }
    };
    rec.onerror = (e) => {
      // Try the next locale for this language before giving up.
      if (e.error === 'language-not-supported' && i + 1 < locales.length) {
        rec.onend = null;
        start(i + 1);
        return;
      }
      if (e.error !== 'aborted') onError?.(gotFinal ? 'aborted' : e.error);
    };
    rec.onend = () => {
      if (finished) return;
      finished = true;
      onEnd?.();
    };
    rec.start();
  };

  start(0);
  return { stop: () => rec?.stop(), abort: () => { finished = true; rec?.abort(); onEnd?.(); } };
}

// ------------------------------------------------------------------ speaking

let voices = [];
function loadVoices() {
  voices = canSpeak ? window.speechSynthesis.getVoices() : [];
}
if (canSpeak) {
  loadVoices();
  window.speechSynthesis.addEventListener?.('voiceschanged', loadVoices);
}

/** True when the device has a voice for this language (Arabic voices are often missing). */
export function hasVoiceFor(lang) {
  loadVoices();
  return voices.some((v) => v.lang.toLowerCase().startsWith(LANGS[lang].speak));
}

const ARABIC = /[؀-ۿ]/g;
export function detectLang(text) {
  const letters = text.replace(/[^\p{L}]/gu, '').length || 1;
  return (text.match(ARABIC)?.length ?? 0) / letters > 0.3 ? 'ar' : 'en';
}

/** Turns a chat reply into text that sounds natural when read aloud. */
export function toSpeakable(text, lang) {
  return text
    .replace(/https?:\/\/\S+/g, lang === 'ar' ? 'الرابط على الشاشة' : 'the link on your screen')
    .replace(/\(offer [^)]*\)/gi, '')
    .replace(/\*\*|__|[`#>]/g, '')
    .replace(/\s*(→|->)\s*/g, lang === 'ar' ? ' إلى ' : ' to ')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Short chunks: some engines cut off long utterances after ~15 seconds. */
function chunks(text) {
  const sentences = text.match(/[^.!?؟\n]+[.!?؟]*/g) ?? [text];
  const out = [];
  let cur = '';
  for (const s of sentences.map((x) => x.trim()).filter(Boolean)) {
    if ((cur + ' ' + s).length > 180 && cur) {
      out.push(cur);
      cur = s;
    } else cur = cur ? `${cur} ${s}` : s;
  }
  if (cur) out.push(cur);
  return out;
}

let speakToken = 0;

/**
 * Reads text aloud in the language it is written in.
 * @returns {Promise<void>} resolves when speech ends or is stopped
 */
export function speak(text) {
  if (!canSpeak) return Promise.resolve();
  stopSpeaking();
  const token = ++speakToken;
  const lang = detectLang(text);
  const spoken = toSpeakable(text, lang);
  loadVoices();
  const prefix = LANGS[lang].speak;
  const voice = voices.find((v) => v.lang.toLowerCase().startsWith(prefix) && v.localService) ?? voices.find((v) => v.lang.toLowerCase().startsWith(prefix));
  const parts = chunks(spoken);
  return new Promise((resolve) => {
    let i = 0;
    const next = () => {
      if (token !== speakToken || i >= parts.length) return resolve();
      const u = new SpeechSynthesisUtterance(parts[i++]);
      u.lang = voice?.lang ?? (lang === 'ar' ? 'ar-SA' : 'en-GB');
      if (voice) u.voice = voice;
      u.rate = lang === 'ar' ? 0.95 : 1;
      u.onend = next;
      u.onerror = () => resolve();
      window.speechSynthesis.speak(u);
    };
    next();
  });
}

export function stopSpeaking() {
  speakToken++;
  if (canSpeak) window.speechSynthesis.cancel();
}

export function isSpeaking() {
  return canSpeak && window.speechSynthesis.speaking;
}
