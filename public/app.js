// BluckFlies web client. Plain ES modules, no build step.
//
// Designed for travellers who read little: a picture-based home screen, a
// three-step flight finder made of big buttons, voice in English and Arabic,
// and sound that reads replies and cards aloud. Once a conversation starts,
// the screen splits into the chat and a trip panel (flights, route, bookings).
// All server and agent text is rendered with textContent (never innerHTML).

import { api, hasSession, resetSession, streamChat } from './js/api.js';
import { SOUTH_SUDAN, cityOf, countryOf, placeNote } from './js/airports.js';
import { hasMethod, hasWallets, loadPaymentOptions } from './js/payOptions.js';
import { bookingCard, confirmationCard, offerCard, resultsSummary, setActions } from './js/cards.js';
import { amountOf, el, formatted, icon, wallDate, wallTime } from './js/dom.js';
import { createGuide } from './js/guide.js';
import { hearButton, isSoundOn, sayIfSound, setSound, stopAllHearing } from './js/hear.js';
import { applyLang, arrow, getLang, hasChosenLang, onLangChange, setLang, t } from './js/i18n.js';
import { routeMap } from './js/routeMap.js';
import { canSpeak, speak } from './js/voice.js';
import { initVoice } from './js/voiceUi.js';

const $ = (id) => document.getElementById(id);
const body = document.body;
const thread = $('thread');
const composerBar = $('composer-bar');
const dock = $('dock');
const form = $('composer');
const input = $('input');
const sendBtn = $('send');
const canvas = $('canvas');
const backdrop = $('backdrop');
const canvasToggle = $('canvas-toggle');
const mobileSheet = window.matchMedia('(max-width: 1023px)');

const state = {
  busy: false,
  /** Every search from the latest turn (outbound and return for a return trip). */
  searches: [],
  /** The one shown in the trip panel. */
  search: null,
  sort: 'recommended',
  directOnly: false,
  bookings: [],
  shownConfirmations: new Set(),
  inlinePayments: new Set(),
  /** The PIN safety notice is shown once, under the first answer, not under every message. */
  pinShown: false,
};

/** Replaces each [data-icon] placeholder in the static page with its SVG. */
function fillIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach((n) => n.replaceChildren(icon(n.dataset.icon, Number(n.dataset.size) || 18)));
}

// ------------------------------------------------------------ home screen

/** The six things BluckFlies does, as big picture tiles. Violet = AI features. */
const TILES = [
  // "Find a flight" is the big button above; this tile leads to the town airstrips instead.
  { icon: 'pin', ai: false, key: 'townsTile', say: 'townsTileSay', run: () => $('towns-title').scrollIntoView({ behavior: 'smooth', block: 'start' }) },
  { icon: 'chart', ai: true, key: 'compare', say: 'compareSay', prompt: 'comparePrompt' },
  { icon: 'ticket', ai: false, key: 'hold', say: 'holdSay', prompt: 'holdPrompt' },
  { icon: 'shield', ai: false, key: 'pay', say: 'paySay', prompt: 'payPrompt' },
  { icon: 'refresh', ai: false, key: 'manage', say: 'manageSay', prompt: 'managePrompt' },
  { icon: 'help', ai: true, key: 'help', say: 'helpSay', prompt: 'helpPrompt' },
];
const POPULAR = ['NBO', 'EBB', 'ADD', 'DXB', 'WUU', 'MAK'];

function renderHome() {
  $('tiles').replaceChildren(...TILES.map((tile) => {
    const main = el('button', { type: 'button', class: 'tile-main' }, [
      el('span', { class: `tile-icon${tile.ai ? ' ai' : ''}`, 'aria-hidden': 'true' }, [icon(tile.icon, 30)]),
      el('strong', { text: t(tile.key) }),
    ]);
    main.addEventListener('click', () => (tile.run ? tile.run() : send(t(tile.prompt))));
    return el('li', { class: 'tile' }, [main, hearButton(() => t(tile.say), { label: false })]);
  }));

  $('routes').replaceChildren(...POPULAR.map((code) => {
    const b = el('button', { type: 'button', class: 'place' }, [
      el('span', { class: 'place-art', 'aria-hidden': 'true' }, [routeMap(['JUB', code], { width: 200, height: 90, compact: true })]),
      el('strong', { text: cityOf(code) }),
      el('span', { text: countryOf(code) }),
    ]);
    b.addEventListener('click', () => openGuide(code));
    return el('li', {}, [b]);
  }));

  // Every South Sudan town BluckFlies reaches: one tap opens the finder there.
  $('towns').replaceChildren(...SOUTH_SUDAN.filter((code) => code !== 'JUB').map((code) => {
    const b = el('button', { type: 'button', class: 'town' }, [
      el('span', { class: 'town-pin', 'aria-hidden': 'true' }, [icon('pin', 18)]),
      el('span', { class: 'town-text' }, [el('strong', { text: cityOf(code) }), el('small', { text: placeNote(code) })]),
    ]);
    b.addEventListener('click', () => openGuide(code));
    return el('li', {}, [b]);
  }));
}

// Step-by-step flight finder (replaces the home content while open).
const guide = createGuide({
  container: $('guide'),
  onSearch: (prompt, criteria) => { closeGuide(false); directSearch(prompt, criteria); },
  onSpeak: () => voice.open(),
  onClose: () => closeGuide(),
});

function openGuide(to = null) {
  $('home').hidden = true;
  $('guide').hidden = false;
  guide.open(to);
  $('chat').scrollTop = 0;
}

function closeGuide(restoreFocus = true) {
  if ($('guide').hidden) return;
  $('guide').hidden = true;
  $('home').hidden = false;
  if (restoreFocus) $('open-guide').focus();
}

// ------------------------------------------------------------------ thread

/** While an answer is being put together, its parts are added without scrolling (see showAnswerStart). */
let holdScroll = false;

function reveal(node) {
  thread.append(node);
  if (!holdScroll) node.scrollIntoView({ behavior: 'smooth', block: 'end' });
  return node;
}

/** Assistant row: violet avatar and label, so AI output is always identifiable. */
function aiTurn(content, text) {
  const who = el('div', { class: 'who' }, [el('span', { text: t('who') })]);
  if (text) {
    const hear = hearButton(() => text);
    if (hear) who.append(hear);
  }
  return el('div', { class: 'turn ai' }, [
    el('span', { class: 'avatar', 'aria-hidden': 'true' }, [icon('sparkle', 18)]),
    el('div', { class: 'bubble-wrap' }, [who, content]),
  ]);
}

/** Returns the element holding the text, so callers can update it later. */
function addMessage(who, text) {
  const node = el('div', { class: `msg ${who}`, dir: 'auto' });
  if (who === 'them') {
    node.append(formatted(text));
    reveal(aiTurn(node, text));
  } else if (who === 'me') {
    node.textContent = text;
    reveal(el('div', { class: 'turn me' }, [node]));
  } else {
    node.textContent = text;
    reveal(node);
  }
  return node;
}

function typingIndicator() {
  const dots = el('div', { class: 'dots', role: 'status' }, [el('i'), el('i'), el('i'), el('span', { class: 'sr', text: t('thinking') })]);
  return reveal(aiTurn(dots));
}

/** What the assistant is doing, by tool name (sent by the server while it works). */
const STEP_KEYS = {
  find_airports: 'stepAirports',
  search_flights: 'stepSearch',
  get_offer_details: 'stepOffer',
  propose_reservation: 'stepReserve',
  get_booking: 'stepBooking',
  list_my_bookings: 'stepBooking',
  request_payment: 'stepPayment',
  get_payment_options: 'stepPayOptions',
  propose_cancellation: 'stepCancel',
  get_flight_status: 'stepStatus',
  get_travel_info: 'stepInfo',
  handoff_to_human: 'stepHandoff',
};

function stepLabel({ tool, route }) {
  if (tool === 'search_flights' && route) return t('stepSearchRoute', { from: cityOf(route.from), to: cityOf(route.to) });
  return t(STEP_KEYS[tool] ?? 'stepWorking');
}

/**
 * The answer while it is being written: dots with the current step ("Searching
 * flights Juba → Nairobi…"), then the text as it arrives. Replaced by the
 * finished, formatted answer. The draft is hidden from screen readers so they
 * announce the answer once, complete.
 */
function liveReply() {
  const label = el('span', { class: 'step-label', text: t('thinking') });
  const dots = el('div', { class: 'dots', role: 'status' }, [el('i'), el('i'), el('i'), label]);
  const draft = el('div', { class: 'msg them draft', dir: 'auto', 'aria-hidden': 'true', hidden: true });
  const turn = reveal(aiTurn(el('div', { class: 'live' }, [dots, draft])));
  const chat = $('chat');
  let text = '';
  // Follow the answer while it fits on screen; once taller, keep its first line in view.
  const follow = () => {
    const r = turn.getBoundingClientRect();
    const c = chat.getBoundingClientRect();
    if (r.height < c.height - 40 && r.bottom > c.bottom) turn.scrollIntoView({ block: 'end' });
  };
  return {
    step(l) {
      // Text written before a tool call ("Let me check…") gives way to the step itself.
      text = '';
      draft.textContent = '';
      draft.hidden = true;
      dots.hidden = false;
      label.textContent = l;
      follow();
    },
    text(delta) {
      text += delta;
      draft.textContent = text;
      draft.hidden = false;
      dots.hidden = true;
      follow();
    },
    remove() { turn.remove(); },
  };
}

function clearQuickReplies() {
  thread.querySelectorAll('.quick').forEach((q) => q.remove());
}

function quickReplies(keys) {
  clearQuickReplies();
  reveal(el('div', { class: 'quick', role: 'group' }, keys.map(([label, prompt]) => {
    const b = el('button', { type: 'button', class: 'chip', text: t(label) });
    b.addEventListener('click', () => send(t(prompt)));
    return b;
  })));
}

/** Leaves the home screen: the message box docks under the chat and the trip panel appears. */
function startConversation() {
  if (!body.classList.contains('landing')) return;
  $('hero')?.remove();
  body.classList.replace('landing', 'conversing');
  dock.append(composerBar);
  thread.prepend(newChatBar());
  updateCanvasToggle();
}

/**
 * "New chat": forgets this conversation on this device (the session token is
 * kept across visits, see api.js). Two taps, so a stray touch loses nothing.
 */
function newChatBar() {
  const b = el('button', { type: 'button', class: 'new-chat' }, [icon('refresh', 16), el('span', { text: t('newChat') })]);
  let armed = null;
  b.addEventListener('click', () => {
    if (armed) {
      clearTimeout(armed);
      activeStop?.abort();
      resetSession();
      location.assign('/');
      return;
    }
    b.querySelector('span').textContent = `${t('newChatHint')}?`;
    b.classList.add('armed');
    armed = setTimeout(() => {
      armed = null;
      b.classList.remove('armed');
      b.querySelector('span').textContent = t('newChat');
    }, 4000);
  });
  return el('div', { class: 'chat-head' }, [b]);
}

/**
 * A message that could not leave the phone: it stays on screen, marked as not
 * sent, with a "Send again" button, and goes out by itself when the connection
 * returns. Nothing the traveller typed is lost.
 */
function markUnsent(bubble, retry) {
  retryNote(`${t('netDown')} ${navigator.onLine === false ? t('netAuto') : ''}`.trim(), retry, { bubble, label: 'netRetry', whenOnline: true });
}

/**
 * A note with a retry button. With `bubble`, the traveller's message is marked
 * as not answered and replaced by the retry; with `whenOnline`, it also goes
 * out by itself when the connection returns.
 */
function retryNote(message, retry, { bubble = null, label = 'tryAgain', whenOnline = false } = {}) {
  const turn = bubble ? bubble.closest('.turn') ?? bubble : null;
  turn?.classList.add('unsent');
  const again = el('button', { type: 'button', class: 'btn primary sm' }, [icon('arrow', 16), t(label)]);
  const note = el('div', { class: 'msg sys unsent-note', role: 'alert' }, [el('span', { text: message }), again]);
  const resend = () => {
    if (!note.isConnected) { window.removeEventListener('online', resend); return; }
    if (state.busy) return; // another message is on its way: keep this one until it can go
    window.removeEventListener('online', resend);
    note.remove();
    turn?.remove();
    retry();
  };
  again.addEventListener('click', resend);
  if (whenOnline) window.addEventListener('online', resend);
  reveal(note);
}

/**
 * Brings the start of a long answer into view. Appending scrolls to the bottom,
 * which on a phone hides the first lines of a reply taller than the screen.
 */
function showAnswerStart(turn) {
  holdScroll = false;
  if (!turn?.isConnected) return;
  const chat = $('chat');
  const last = thread.lastElementChild ?? turn;
  // Everything fits: show it all down to the last card. Too tall: start at the answer's first line.
  const tall = last.getBoundingClientRect().bottom - turn.getBoundingClientRect().top > chat.clientHeight;
  (tall ? turn : last).scrollIntoView({ block: tall ? 'start' : 'end', behavior: 'smooth' });
}

/**
 * Sends one message to the agent.
 * @param {string} text
 * @param {{ voice?: boolean, speakReply?: boolean }} opts voice: the message was spoken
 * @returns {Promise<{ data?: any, error?: string } | null>} null when nothing was sent
 */
/**
 * The step-by-step finder searches directly (no AI needed): fast, cheap, and
 * still working when the assistant is unavailable. Choosing a flight then
 * continues with the assistant, or with a call-back request.
 */
/** While BluckFlies works on an answer, the logo flies its circle (body.working). */
function setWorking(on) {
  state.busy = on;
  body.classList.toggle('working', on);
}

/** The reply being waited for; the send button becomes Stop while it runs. */
let activeStop = null;

function setStopButton(on) {
  sendBtn.dataset.mode = on ? 'stop' : 'send';
  sendBtn.classList.toggle('stop', on);
  sendBtn.classList.toggle('flip-rtl', !on);
  sendBtn.setAttribute('aria-label', t(on ? 'stop' : 'send'));
  sendBtn.title = on ? t('stop') : '';
  sendBtn.replaceChildren(icon(on ? 'stop' : 'arrow', 22));
  sendBtn.disabled = false;
}

/** Search results in the chat: on phones the top two flights inline, then the link to all of them. */
function showResults(found) {
  state.searches = found;
  showSearch(0);
  selectTab('flights');
  if (mobileSheet.matches) {
    const top = found[0].offers.slice(0, 2);
    reveal(el('div', { class: 'inline-offers', role: 'group', 'aria-label': t('tFlights') }, top.map(offerCard)));
  }
  found.forEach((s, i) => reveal(resultsSummary(s, () => { showSearch(i); openCanvas('flights'); }, legLabel(i, found.length))));
}

async function directSearch(prompt, { legs }) {
  if (state.busy) return;
  if (!$('trips').hidden) show('chat');
  closeCanvas();
  stopAllHearing();
  setWorking(true);
  sendBtn.disabled = true;
  startConversation();
  clearQuickReplies();
  const mine = addMessage('me', prompt);
  const typing = typingIndicator();
  try {
    const results = [];
    for (const leg of legs) results.push(await api('/search', { method: 'POST', body: leg }));
    typing.remove();
    const found = results.filter((r) => r.offers?.length);
    if (!found.length) {
      const msg = t('noFlights', { from: cityOf(results[0]?.origin?.code ?? ''), to: cityOf(results[0]?.destination?.code ?? '') });
      addMessage('them', msg);
      sayIfSound(msg);
      return;
    }
    addMessage('them', t('foundFlights'));
    sayIfSound(t('foundFlights'));
    showResults(found);
  } catch (e) {
    typing.remove();
    if (e.code === 'NETWORK') markUnsent(mine, () => directSearch(prompt, { legs }));
    else addMessage('sys', e.message);
  } finally {
    setWorking(false);
    sendBtn.disabled = false;
  }
}

/** Choosing a flight: the assistant books it; if it is unavailable, staff call back. */
function chooseOffer(offer, prompt) {
  return send(prompt, { offer });
}

/** At most one open call-back form at a time. */
let callMeOpen = false;

function callMeCard(offer, message) {
  callMeOpen = true;
  const name = el('input', { type: 'text', required: '', minlength: '2', maxlength: '80', autocomplete: 'name', dir: 'auto' });
  const phone = el('input', { type: 'tel', required: '', inputmode: 'tel', autocomplete: 'tel', maxlength: '25', value: '+211 ', dir: 'ltr' });
  const status = el('p', { class: 'note', role: 'status' });
  const submit = el('button', { class: 'btn primary big', type: 'submit' }, [icon('phone', 20), t('callMeSend')]);
  const form = el('form', { class: 'call-me' }, [
    el('label', {}, [t('callMeName'), name]),
    el('label', {}, [t('callMePhone'), phone]),
    submit,
    status,
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    submit.disabled = true;
    try {
      await api('/booking-requests', { method: 'POST', body: { ...(offer ? { offerId: offer.offerId } : { message }), name: name.value, phone: phone.value, language: getLang() } });
      callMeOpen = false;
      const done = t('callMeDone', { phone: phone.value.trim() });
      form.replaceChildren(el('p', { class: 'note ok', text: done }));
      sayIfSound(done);
    } catch (err) {
      status.textContent = err.message;
      submit.disabled = false;
    }
  });
  return el('div', { class: 'card call-me-card' }, [
    el('div', { class: 'card-head' }, [el('h3', {}, [icon('headset', 22), t('callMeTitle')]), hearButton(() => t('callMeText'))]),
    el('p', { text: t('callMeText') }),
    form,
  ]);
}

async function send(text, { voice: spoken = false, speakReply = spoken, offer = null } = {}) {
  if (state.busy || !text.trim()) return null;
  if (!$('trips').hidden) show('chat');
  closeCanvas(); // on phones, a choice made in the trip panel continues in the chat
  stopAllHearing();
  setWorking(true);
  startConversation();
  clearQuickReplies();
  const mine = addMessage('me', text);
  const again = () => send(text, { voice: spoken, speakReply, offer });
  const live = liveReply();
  const stopper = new AbortController();
  activeStop = stopper;
  setStopButton(true);
  try {
    let data;
    for (let attempt = 0; ; attempt++) {
      try {
        data = await streamChat({ message: text, channel: spoken ? 'voice' : 'text' }, {
          signal: stopper.signal,
          onEvent: (e) => (e.type === 'step' ? live.step(stepLabel(e)) : live.text(e.delta)),
        });
        break;
      } catch (e) {
        // Right after a Stop, the server may still be finishing a step: wait for it once.
        if (e.code !== 'CONFLICT' || attempt > 0 || stopper.signal.aborted) throw e;
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    live.remove();
    await showReply(data, { speakReply });
    return { data };
  } catch (e) {
    setStopButton(false);
    sendBtn.disabled = true;
    // INTERRUPTED: the line dropped mid-answer; the server usually finished it.
    // NETWORK while online: a reset can hide a message that did arrive.
    // Either way, look for the answer before asking again, so nothing is sent twice.
    if (e.code === 'INTERRUPTED' || (e.code === 'NETWORK' && navigator.onLine !== false)) {
      live.step(t('recovering'));
      const recovered = await recoverReply(text, e.code === 'INTERRUPTED' ? 10 : 3);
      live.remove();
      if (recovered) {
        await showReply(recovered, { speakReply });
        return { data: recovered };
      }
      if (e.code === 'NETWORK') markUnsent(mine, again);
      else retryNote(`${t('netCut')} ${t('replyFailed')}`, again, { bubble: mine, whenOnline: true });
      return { error: e.message, code: e.code };
    }
    live.remove();
    if (e.code === 'STOPPED') {
      retryNote(t('stopped'), again);
      return { error: e.message, code: e.code };
    }
    if (e.code === 'NETWORK') {
      markUnsent(mine, again);
      return { error: e.message, code: e.code };
    }
    if (e.code === 'AGENT_UNAVAILABLE') {
      addMessage('sys', e.message);
      // Assistant down: offer a call back (with the chosen flight, if any) instead of a dead end.
      if (offer || !callMeOpen) reveal(callMeCard(offer, text.slice(0, 500)));
    } else if (e.code === 'SERVER' || e.code === 'INTERNAL' || e.code === 'SERVICE_UNAVAILABLE' || e.code === 'RATE_LIMITED') {
      retryNote(e.message, again, { bubble: mine });
    } else {
      addMessage('sys', e.message);
    }
    return { error: e.message, code: e.code };
  } finally {
    activeStop = null;
    setStopButton(false);
    holdScroll = false;
    setWorking(false);
    if (!voice.isOpen()) input.focus({ preventScroll: true }); // never pull focus out of the voice dialog
  }
}

/** Shows a finished answer: text, flights, proposals to confirm, and payment steps. */
async function showReply(data, { speakReply = false } = {}) {
  if (data.stopped) {
    addMessage('sys', t('stopped'));
    return;
  }
  holdScroll = true;
  const answer = addMessage('them', data.reply).closest('.turn');
  if (!state.pinShown) {
    state.pinShown = true;
    answer.querySelector('.bubble-wrap')?.append(el('p', { class: 'pin-note' }, [icon('lock', 14), t('finePin')]));
  }
  // Read the answer aloud for spoken questions, or for everyone when sound is on.
  if (!voice.isOpen() && canSpeak) {
    if (speakReply) speak(data.reply);
    else sayIfSound(data.reply);
  }
  const found = (data.searches ?? (data.search ? [data.search] : [])).filter((s) => s.offers?.length);
  if (found.length) showResults(found);
  const fresh = (data.pendingConfirmations ?? []).filter((c) => !state.shownConfirmations.has(c.confirmationId));
  fresh.forEach((c) => {
    state.shownConfirmations.add(c.confirmationId);
    reveal(confirmationCard(c));
  });
  if (found.length && !fresh.length) quickReplies([['q1', 'q1p'], ['q2', 'q2p'], ['q3', 'q3p'], ['q4', 'q4p']]);
  await refreshBookings({ inlinePayments: true });
  showAnswerStart(answer);
}

/** Stored text of a turn the traveller stopped (server: STOPPED_TEXT). */
const STOPPED_REPLY = '(The traveller stopped this reply.)';

/**
 * After the connection dropped mid-answer: the server keeps working and saves
 * the answer, so look for it in the conversation (one try every 2 seconds).
 * Flight cards are not in the history; the panel keeps the previous ones.
 */
async function recoverReply(text, tries) {
  for (let i = 0; i < tries; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    let history;
    try {
      history = await api('/chat/history');
    } catch {
      continue; // still offline
    }
    // The traveller's last message, then the final agent line after it (earlier
    // agent lines in the same turn are notes written before a tool call).
    const msgs = history.messages;
    let askedAt = msgs.length - 1;
    while (askedAt >= 0 && msgs[askedAt].role !== 'traveller') askedAt--;
    const last = msgs.at(-1);
    if (askedAt >= 0 && msgs[askedAt].text === text && last?.role === 'agent' && msgs.length - 1 > askedAt) {
      return { reply: last.text, stopped: last.text === STOPPED_REPLY, pendingConfirmations: history.pendingConfirmations ?? [], searches: [] };
    }
  }
  return null;
}

// ------------------------------------------------------------- trip panel

const TABS = ['flights', 'route', 'bookings'];
const TAB_LABEL = { flights: 'tFlights', route: 'tRoute', bookings: 'tBookings' };

function selectTab(name) {
  for (const tab of TABS) {
    const on = tab === name;
    $(`ct-${tab}`).setAttribute('aria-selected', String(on));
    $(`ct-${tab}`).tabIndex = on ? 0 : -1;
    $(`cp-${tab}`).hidden = !on;
  }
}

function setTabLabel(name, count) {
  $(`ct-${name}`).replaceChildren(t(TAB_LABEL[name]), count ? el('span', { class: 'count', text: String(count) }) : '');
}

function emptyState(iconName, ai, key) {
  return el('div', { class: 'empty' }, [el('span', { class: `tile-icon${ai ? ' ai' : ''}`, 'aria-hidden': 'true' }, [icon(iconName, 26)]), el('p', { text: t(key) })]);
}

/** "Going" / "Coming back" when a turn searched both directions of a return trip. */
function legLabel(i, count) {
  if (count < 2) return '';
  return i === 0 ? t('going') : i === 1 ? t('comingBack') : `${i + 1}`;
}

function showSearch(i) {
  state.search = state.searches[i] ?? null;
  state.sort = 'recommended';
  state.directOnly = false;
  renderFlights();
  renderRoute();
}

function sortedOffers() {
  const offers = state.search.offers.filter((o) => !state.directOnly || o.stops === 0);
  if (state.sort === 'cheapest') offers.sort((a, b) => amountOf(a.price) - amountOf(b.price));
  if (state.sort === 'fastest') offers.sort((a, b) => a.totalDurationMinutes - b.totalDurationMinutes);
  return offers;
}

function renderFlights() {
  const panel = $('cp-flights');
  const s = state.search;
  setTabLabel('flights', s?.offers.length);
  if (!s) {
    panel.replaceChildren(emptyState('search', true, 'emptyFlights'));
    return;
  }
  const sortBtn = (key, label, ic) => {
    const b = el('button', { type: 'button', 'aria-pressed': String(state.sort === key) }, [icon(ic, 16), t(label)]);
    b.addEventListener('click', () => { state.sort = key; renderFlights(); });
    return b;
  };
  const direct = el('button', { type: 'button', 'aria-pressed': String(state.directOnly) }, [icon('plane', 16), t('sDirect')]);
  direct.addEventListener('click', () => { state.directOnly = !state.directOnly; renderFlights(); });
  const offers = sortedOffers();
  const legs = state.searches.length > 1
    ? el('div', { class: 'legs-switch', role: 'group' }, state.searches.map((leg, i) => {
        const b = el('button', { type: 'button', 'aria-pressed': String(leg === s) }, [
          el('strong', { text: legLabel(i, state.searches.length) }),
          el('span', { text: `${cityOf(leg.origin.code)} ${arrow()} ${cityOf(leg.destination.code)} · ${wallDate(leg.departureDate)}` }),
        ]);
        b.addEventListener('click', () => showSearch(i));
        return b;
      }))
    : '';
  panel.replaceChildren(
    legs,
    el('p', { class: 'panel-intro' }, [el('strong', { text: `${cityOf(s.origin.code)} ${arrow()} ${cityOf(s.destination.code)}` }), ` · ${wallDate(s.departureDate)}`]),
    el('div', { class: 'sortbar', role: 'group' }, [sortBtn('recommended', 'sBest', 'sparkle'), sortBtn('cheapest', 'sCheap', 'card'), sortBtn('fastest', 'sFast', 'clock'), direct]),
    ...(offers.length ? offers.map(offerCard) : [emptyState('search', true, 'noDirect')]),
    s.notice ? el('p', { class: 'panel-intro', text: s.notice }) : '',
  );
  updateCanvasToggle();
}

function renderRoute() {
  const panel = $('cp-route');
  setTabLabel('route');
  const s = state.search;
  const pick = s ? s.offers.find((o) => o.tags.includes('best_value')) ?? s.offers[0] : null;
  const latest = state.bookings[0];
  // Outbound then, for a round trip, the flights back (the map draws the way there; the list shows both).
  const segments = pick
    ? [...pick.segments, ...(pick.return?.segments ?? [])]
    : latest ? [...latest.segments, ...(latest.returnSegments ?? [])] : null;
  const outboundCount = (pick ?? latest)?.segments.length ?? 0;
  if (!segments?.length) {
    panel.replaceChildren(emptyState('map', false, 'emptyRoute'));
    return;
  }
  const outbound = segments.slice(0, outboundCount);
  const map = routeMap([outbound[0].from, ...outbound.map((x) => x.to)], { width: 400, height: 260 });
  panel.replaceChildren(
    el('p', { class: 'panel-intro', text: pick ? t('routeOf') : t('routeFor', { pnr: latest.pnr }) }),
    map ? el('div', { class: 'route-big' }, [map]) : '',
    el('ol', { class: 'timeline' }, segments.map((x, i) => el('li', {}, [
      el('div', {}, [
        i === outboundCount && outboundCount < segments.length ? el('span', { class: 'journey-label', text: t('returnLeg') }) : null,
        el('strong', { text: `${wallTime(x.departs)} ${cityOf(x.from)} ${arrow()} ${wallTime(x.arrives)} ${cityOf(x.to)}` }),
        el('span', { text: `${x.flight} · ${x.carrier} · ${wallDate(x.departs)}` }),
      ]),
    ]))),
  );
}

function renderBookingsPanel() {
  setTabLabel('bookings', state.bookings.length);
  $('cp-bookings').replaceChildren(...(state.bookings.length ? state.bookings.map((b) => bookingCard(b)) : [emptyState('ticket', false, 'emptyBookings')]));
}

async function refreshBookings({ inlinePayments = false } = {}) {
  try {
    const { bookings } = await api('/bookings');
    state.bookings = bookings;
  } catch {
    return; // the chat already reports connection problems
  }
  renderBookingsPanel();
  if (!state.search) renderRoute();
  if (inlinePayments) {
    // Surface payment-pending bookings in the chat so the pay step is reachable.
    state.bookings.filter((b) => b.status === 'payment_pending' && !state.inlinePayments.has(b.pnr)).forEach((b) => {
      state.inlinePayments.add(b.pnr);
      reveal(bookingCard(b));
    });
  }
  if (!$('trips').hidden) renderTrips();
  updateCanvasToggle();
}

function updateCanvasToggle() {
  const flights = state.search?.offers.length ?? 0;
  const bookings = state.bookings.length;
  const visible = body.classList.contains('conversing') && (flights > 0 || bookings > 0);
  canvasToggle.hidden = !visible;
  if (!visible) return;
  const parts = [flights ? `${t('tFlights')} ${flights}` : '', bookings ? `${t('tBookings')} ${bookings}` : ''].filter(Boolean);
  canvasToggle.replaceChildren(icon('list', 18), `${t('panel')} · ${parts.join(' · ')}`);
}

let lastFocus = null;
function openCanvas(tab = 'flights') {
  selectTab(tab);
  if (!mobileSheet.matches) {
    $(`ct-${tab}`).focus();
    return;
  }
  lastFocus = document.activeElement;
  canvas.classList.add('open');
  backdrop.hidden = false;
  canvasToggle.setAttribute('aria-expanded', 'true');
  $('canvas-title').focus();
}

function closeCanvas() {
  if (!canvas.classList.contains('open')) return;
  canvas.classList.remove('open');
  backdrop.hidden = true;
  canvasToggle.setAttribute('aria-expanded', 'false');
  lastFocus?.focus?.();
}

// ------------------------------------------------------------------ views

async function renderTrips() {
  const list = $('trip-list');
  try {
    const [{ bookings }, me] = await Promise.all([api('/bookings'), api('/me')]);
    state.bookings = bookings;
    renderAccount(me);
    if (bookings.length) {
      list.replaceChildren(...bookings.map((b) => bookingCard(b, { map: true })));
      return;
    }
    const find = el('button', { class: 'btn primary huge', type: 'button' }, [icon('plane', 22), t('findFlight')]);
    find.addEventListener('click', () => { show('chat'); if (body.classList.contains('landing')) openGuide(); });
    list.replaceChildren(el('div', { class: 'empty' }, [el('span', { class: 'tile-icon', 'aria-hidden': 'true' }, [icon('ticket', 26)]), el('p', { text: t('noTickets') }), find]));
  } catch (e) {
    list.replaceChildren(el('p', { class: 'msg sys', text: e.message }));
  }
}

// ------------------------------------------------------------ phone login

/** Login card on My tickets: phone number → SMS code, so tickets follow the traveller. */
function renderAccount(me) {
  const box = $('account');
  if (!me.phoneLogin) {
    box.replaceChildren();
    return;
  }
  if (me.account) {
    const out = el('button', { type: 'button', class: 'btn ghost', text: t('logout') });
    out.addEventListener('click', async () => {
      await api('/auth/logout', { method: 'POST' }).catch(() => {});
      resetSession();
      location.reload();
    });
    box.replaceChildren(el('div', { class: 'account-row' }, [icon('user', 22), el('strong', { text: t('loggedInAs', { phone: me.account.phone }) }), out]));
    return;
  }
  const status = el('p', { class: 'note', role: 'status' });
  const phone = el('input', { id: 'login-phone', type: 'tel', inputmode: 'tel', autocomplete: 'tel', placeholder: '+211 9xx xxx xxx', dir: 'ltr' });
  const sendBtn2 = el('button', { type: 'submit', class: 'btn primary big' }, [icon('phone', 20), t('sendCode')]);
  const phoneForm = el('form', { class: 'login-row' }, [el('label', { for: 'login-phone', text: t('phoneLabel') }), phone, sendBtn2]);
  const code = el('input', { id: 'login-code', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: '6', pattern: '[0-9]*', dir: 'ltr' });
  const codeForm = el('form', { class: 'login-row', hidden: true }, [el('label', { for: 'login-code', text: t('codeLabel') }), code, el('button', { type: 'submit', class: 'btn primary big' }, [icon('check', 20), t('login')])]);
  let challengeId = '';
  phoneForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    status.textContent = t('wait');
    try {
      const r = await api('/auth/otp/start', { method: 'POST', body: { phone: phone.value, language: getLang() } });
      challengeId = r.challengeId;
      status.textContent = `${t('codeSent', { phone: r.phone })} ${t('loginNote')}`;
      codeForm.hidden = false;
      code.focus();
    } catch (err) {
      status.textContent = err.message;
    }
  });
  codeForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await api('/auth/otp/verify', { method: 'POST', body: { challengeId, code: code.value } });
      sayIfSound(t('welcomeBack'));
      renderTrips();
      refreshBookings();
    } catch (err) {
      status.textContent = err.message;
    }
  });
  box.replaceChildren(el('div', { class: 'card login' }, [
    el('div', { class: 'card-head' }, [el('h3', { text: t('loginTitle') }), hearButton(() => `${t('loginTitle')}. ${t('loginText')}`)]),
    el('p', { text: t('loginText') }),
    phoneForm,
    codeForm,
    status,
  ]));
}

// ------------------------------------------------------- restore after refresh

/** Brings back the conversation after a page refresh or a return to the tab. */
async function restoreConversation() {
  let history;
  try {
    history = await api('/chat/history');
  } catch {
    return;
  }
  if (!history.messages.length) return;
  startConversation();
  state.pinShown = true; // seen in an earlier visit
  for (const m of history.messages) {
    if (m.role === 'agent' && m.text === STOPPED_REPLY) addMessage('sys', t('stopped'));
    else addMessage(m.role === 'traveller' ? 'me' : 'them', m.text);
  }
  for (const c of history.pendingConfirmations ?? []) {
    if (state.shownConfirmations.has(c.confirmationId)) continue;
    state.shownConfirmations.add(c.confirmationId);
    reveal(confirmationCard(c));
  }
}

function show(view) {
  const isChat = view === 'chat';
  $('workspace').hidden = !isChat;
  $('trips').hidden = isChat;
  for (const [id, on] of [['tab-chat', isChat], ['bn-home', isChat], ['tab-trips', !isChat], ['bn-tickets', !isChat]]) $(id).setAttribute('aria-pressed', String(on));
  closeCanvas();
  if (!isChat) {
    $('trip-list').replaceChildren(el('p', { class: 'note', text: t('loading') }));
    renderTrips();
  }
}

/** Returning from Stripe Checkout: the webhook may land a few seconds after the redirect. */
async function handlePaymentReturn() {
  const params = new URLSearchParams(location.search);
  const outcome = params.get('payment');
  const ref = params.get('ref');
  if (!outcome || !ref || !/^[A-Z2-9]{6}$/.test(ref)) return;
  history.replaceState(null, '', location.pathname);
  startConversation();
  if (outcome === 'cancelled') {
    addMessage('sys', t('payCancelled', { ref }));
    return;
  }
  if (outcome === 'failed') {
    addMessage('sys', t('payFailed', { ref }));
    sayIfSound(t('payFailed', { ref }));
    refreshBookings();
    return;
  }
  const note = addMessage('sys', t('payChecking', { ref }));
  for (let i = 0; i < 15; i++) {
    try {
      const { booking } = await api(`/bookings/${ref}`);
      if (booking.status === 'ticketed') {
        note.textContent = t('payDone');
        sayIfSound(t('payDone'));
        reveal(bookingCard(booking));
        refreshBookings();
        return;
      }
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  note.textContent = t('payLate', { ref });
}

// ------------------------------------------------------------ language & sound

function renderSound() {
  const on = isSoundOn();
  const btn = $('sound');
  btn.hidden = !canSpeak;
  btn.setAttribute('aria-pressed', String(on));
  // Icon-only button: the words are its accessible name and tooltip.
  btn.setAttribute('aria-label', t(on ? 'soundOn' : 'soundOff'));
  btn.title = t(on ? 'soundOn' : 'soundOff');
  btn.replaceChildren(icon(on ? 'speaker' : 'mute', 20));
}

// ------------------------------------------------------------------ footer

/** In the footer the company name is set in capitals, like the navbar wordmark. */
const brandCaps = (text) => text.replaceAll('BluckFlies', 'BLUCKFLIES');

/** Footer for the home page and My tickets. Every link is an action in the app (no dead pages). */
function renderFooters() {
  const link = (key, run) => {
    const b = el('button', { type: 'button', class: 'foot-link', text: t(key) });
    b.addEventListener('click', run);
    return el('li', {}, [b]);
  };
  const col = (key, children) => el('div', { class: 'foot-col' }, [el('h3', { text: t(key) }), ...children]);
  // The home screen (finder, popular places) exists until the conversation starts; after that, the message box is the way in.
  const onHome = () => body.classList.contains('landing');
  const findFlight = () => { show('chat'); if (onHome()) openGuide(); else input.focus(); };
  const popular = () => { show('chat'); if (onHome()) { closeGuide(false); $('routes').scrollIntoView({ behavior: 'smooth', block: 'start' }); } else input.focus(); };
  const payWay = (ic, label) => el('li', {}, [el('span', { class: 'pay-ico', 'aria-hidden': 'true' }, [icon(ic, 16)]), label]);

  document.querySelectorAll('.footer-slot').forEach((slot) => {
    const scroller = slot.closest('.scroll, .trips-view');
    const toTop = el('button', { type: 'button', class: 'to-top', 'aria-label': t('footTop'), title: t('footTop') }, [icon('arrow', 18)]);
    toTop.addEventListener('click', () => scroller?.scrollTo({ top: 0, behavior: 'smooth' }));
    const langs = el('div', { class: 'lang-chips', role: 'group', 'aria-label': t('footLangs') }, [['en', 'English'], ['ar', 'العربية']].map(([l, name]) => {
      const b = el('button', { type: 'button', class: 'lang-chip', lang: l, 'aria-pressed': String(getLang() === l), text: name });
      b.addEventListener('click', () => setLang(l));
      return b;
    }));
    const brand = slot.ownerDocument.querySelector('.topbar .brand')?.cloneNode(true);
    if (brand) { brand.removeAttribute('href'); brand.setAttribute('aria-hidden', 'true'); }
    slot.replaceChildren(el('footer', { class: 'site-footer' }, [
      el('div', { class: 'foot-grid' }, [
        el('div', { class: 'foot-brand' }, [brand ?? '', el('p', { text: brandCaps(t('footAbout')) }), langs]),
        col('footBook', [el('ul', {}, [link('findFlight', findFlight), link('footPopular', popular), link('navTickets', () => show('trips'))])]),
        col('footHelp', [el('ul', {}, [
          link('talkPerson', () => send(t('talkPersonPrompt'))),
          link('footDocs', () => send(t('helpPrompt'))),
          link('footBaggage', () => send(t('footBaggagePrompt'))),
          link('footPayHow', () => send(t('payPrompt'))),
        ])]),
        col('footPay', [
          el('ul', { class: 'pay-list' }, [
            hasMethod('card') ? payWay('card', 'Visa · Mastercard') : null,
            hasMethod('card') && hasWallets() ? payWay('phone', 'Apple Pay · Google Pay') : null,
            hasMethod('bank_transfer') ? payWay('bank', t('payBankChip')) : null,
            hasMethod('cash_office') ? payWay('cash', t('payCashChip')) : null,
            hasMethod('mtn_momo') ? payWay('phone', 'MTN MoMo') : null,
          ].filter(Boolean)),
          el('p', { class: 'foot-note', text: t('footCurrency') }),
        ]),
      ]),
      el('p', { class: 'foot-safe' }, [icon('lock', 18), brandCaps(t('finePin'))]),
      el('div', { class: 'foot-bottom' }, [
        el('span', { class: 'foot-copy', text: brandCaps(t('footCopy', { year: new Date().getFullYear() })) }),
        el('nav', { class: 'foot-legal', 'aria-label': t('footLegal') }, [
          el('a', { href: '/terms', text: t('footTerms') }),
          el('a', { href: '/privacy', text: t('footPrivacy') }),
          el('a', { href: '/refunds', text: t('footRefunds') }),
        ]),
        toTop,
      ]),
    ]));
  });
}

/** Soft shadow under the navbar once the page has scrolled. */
function watchScroll() {
  const bar = $('topbar');
  const update = (e) => bar.classList.toggle('scrolled', (e.target.scrollTop ?? 0) > 4);
  for (const id of ['chat', 'trips']) $(id).addEventListener('scroll', update, { passive: true });
}

function showLangPicker() {
  const picker = $('lang-picker');
  const options = [
    { lang: 'en', name: 'English', say: 'English' },
    { lang: 'ar', name: 'العربية', say: 'العربية' },
  ];
  $('lp-options').replaceChildren(...options.map((o) => {
    const pick = el('button', { type: 'button', class: 'lp-btn', lang: o.lang }, [el('span', { text: o.name })]);
    pick.addEventListener('click', () => {
      setLang(o.lang);
      setSound(true);
      picker.hidden = true;
      renderSound();
      sayIfSound(t('welcome'));
      $('open-guide').focus();
    });
    return el('div', { class: 'lp-option' }, [pick, hearButton(() => o.say, { label: false, size: 'lg' })]);
  }));
  picker.hidden = false;
  picker.querySelector('.lp-btn')?.focus();
}

onLangChange(() => {
  renderHome();
  renderFooters();
  if (!$('guide').hidden) guide.refresh();
  renderFlights();
  renderRoute();
  renderBookingsPanel();
  updateCanvasToggle();
  renderSound();
  if (!$('trips').hidden) renderTrips();
  voice.onLang();
});

// ------------------------------------------------------------------ wiring

/** Arrow-key navigation for a tab list (WAI-ARIA tabs pattern). */
function arrowKeys(listEl, onSelect) {
  listEl.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const tabs = [...listEl.querySelectorAll('[role="tab"]')];
    const i = tabs.indexOf(document.activeElement);
    if (i < 0) return;
    const forward = (e.key === 'ArrowRight') !== (getLang() === 'ar'); // arrows follow reading direction
    const next = tabs[(i + (forward ? 1 : tabs.length - 1)) % tabs.length];
    next.focus();
    onSelect(next);
  });
}

function fitInput() {
  input.style.height = 'auto';
  input.style.height = `${input.scrollHeight}px`;
}

fillIcons();
applyLang();
renderHome();
renderFooters();
watchScroll();
renderFlights();
renderRoute();
renderBookingsPanel();
$('hero-slot').append(composerBar); // the message box starts on the home screen

const voice = initVoice({ send, isBusy: () => state.busy, showFlights: () => openCanvas('flights'), input, fitInput });
setActions({ send, choose: chooseOffer, bookingsChanged: () => refreshBookings() });
renderSound();

$('tab-chat').addEventListener('click', () => show('chat'));
$('bn-home').addEventListener('click', () => { show('chat'); closeGuide(false); });
$('tab-trips').addEventListener('click', () => show('trips'));
$('bn-tickets').addEventListener('click', () => show('trips'));
for (const id of ['human', 'bn-help']) $(id).addEventListener('click', () => send(t('talkPersonPrompt')));
$('open-guide').addEventListener('click', () => openGuide());
$('sound').addEventListener('click', () => { setSound(!isSoundOn()); renderSound(); });
$('lang-switch').addEventListener('click', () => setLang(getLang() === 'en' ? 'ar' : 'en'));

for (const tab of TABS) $(`ct-${tab}`).addEventListener('click', () => selectTab(tab));
arrowKeys(document.querySelector('.canvas-tabs'), (tab) => selectTab(tab.id.slice(3)));
canvasToggle.addEventListener('click', () => openCanvas(state.search ? 'flights' : 'bookings'));
$('canvas-close').addEventListener('click', closeCanvas);
backdrop.addEventListener('click', closeCanvas);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (voice.isOpen()) voice.close();
  else if (canvas.classList.contains('open')) closeCanvas();
  else closeGuide();
});
mobileSheet.addEventListener('change', () => { if (!mobileSheet.matches) closeCanvas(); });

form.addEventListener('submit', (e) => {
  e.preventDefault();
  // While a reply is coming, the button is Stop and the typed text waits in the box.
  if (state.busy) {
    if (e.submitter === sendBtn && sendBtn.dataset.mode === 'stop') activeStop?.abort();
    return;
  }
  const text = input.value;
  input.value = '';
  fitInput();
  send(text);
});
input.addEventListener('input', fitInput);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    if (!state.busy) form.requestSubmit(); // Enter never stops a reply; only the Stop button does
  }
});
// Phones: the bottom menu steps aside while typing, leaving room for the keyboard and the chat.
// The menu returns a moment after the box loses focus: returning at once would shift
// the layout under a finger tapping Send or Stop, and the tap would miss.
input.addEventListener('focus', () => body.classList.add('typing'));
input.addEventListener('blur', () => setTimeout(() => {
  if (document.activeElement !== input) body.classList.remove('typing');
}, 300));

if (!hasChosenLang()) showLangPicker();
// Payment buttons and footer show only the ways to pay that are switched on.
const paymentOptions = loadPaymentOptions().then(renderFooters);
if (hasSession()) {
  // A returning tab: restore its conversation and bookings.
  paymentOptions.then(restoreConversation).then(() => refreshBookings({ inlinePayments: true }));
}
paymentOptions.then(handlePaymentReturn);
