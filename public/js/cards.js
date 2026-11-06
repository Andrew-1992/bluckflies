// Cards for flight offers, AI proposals and bookings, designed for travellers
// who read little: big times and prices, icons with short plain words, and a
// Listen button on every card.

import { api } from './api.js';
import { cityOf } from './airports.js';
import { dayShift, duration, el, icon, money, payLink, safePaymentUrl, wallDate, wallTime } from './dom.js';
import { hasMethod } from './payOptions.js';
import { hearButton } from './hear.js';
import { arrow, locale, t } from './i18n.js';
import { routeMap } from './routeMap.js';

/** Wired by app.js: `send(text)` posts a chat message; `bookingsChanged()` refreshes booking views. */
const actions = { send: async () => {}, choose: null, bookingsChanged: () => {} };
export function setActions(a) {
  Object.assign(actions, a);
}

/** "2 adults, 1 child (age 5)" → 3. Used to show a person icon with a number. */
export function travellerCount(passengers) {
  const counts = [...String(passengers).matchAll(/(\d+)\s+(adult|child|infant)/g)].map((m) => Number(m[1]));
  return counts.reduce((a, b) => a + b, 0) || 1;
}

const plural = (n) => (n === 1 ? '' : 's');
const stopsText = (n) => (n === 0 ? t('direct') : t('stops', { n, s: plural(n) }));

function fact(iconName, text, cls = '') {
  return el('li', { class: `fact ${cls}` }, [icon(iconName, 18), el('span', { text })]);
}

// ---------------------------------------------------------------- offers

const TAGS = {
  best_value: { key: 'tagBest', cls: 'tag ai', icon: 'sparkle' },
  cheapest: { key: 'tagCheap', cls: 'tag' },
  fastest: { key: 'tagFast', cls: 'tag' },
};

function offerSpeech(offer) {
  const first = offer.segments[0];
  const last = offer.segments[offer.segments.length - 1];
  const back = offer.return?.segments ?? [];
  const r0 = back[0];
  const rN = back[back.length - 1];
  return t('offerSay', {
    airline: offer.airline ?? first.carrier,
    from: cityOf(first.from), dep: wallTime(first.departs),
    to: cityOf(last.to), arr: wallTime(last.arrives),
    stops: stopsText(offer.stops), price: offer.price,
  }) + (dayShift(first.departs, last.arrives) > 0 ? ` ${t('arrivesNextDay')}.` : '') + (r0 && rN ? t('returnSay', { from: cityOf(r0.from), date: wallDate(r0.departs), dep: wallTime(r0.departs), to: cityOf(rN.to), arr: wallTime(rN.arrives), stops: stopsText(offer.return.stops) }) : '');
}

/**
 * Arrival time, marked "+1" when the flight lands on a later day (local time
 * at each airport): an overnight arrival must never look like a same-day one.
 */
function arrivalTime(departs, arrives) {
  const days = dayShift(departs, arrives);
  const time = el('strong', { class: 'big-time', text: wallTime(arrives) });
  if (days <= 0) return time;
  const said = days === 1 ? t('arrivesNextDay') : t('arrivesDaysLater', { n: days });
  time.append(el('sup', { class: 'plus-day', title: said, 'aria-hidden': 'true', text: `+${days}` }), el('span', { class: 'sr', text: ` (${said})` }));
  return time;
}

/** One direction of a trip: times and places, with the day and a label on round trips. */
function journeyRow(segments, label) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  const days = dayShift(first.departs, last.arrives);
  return el('div', { class: 'journey-block' }, [
    label ? el('span', { class: 'journey-label', text: `${label} · ${wallDate(first.departs)}` }) : null,
    el('div', { class: 'journey' }, [
      el('div', { class: 'end-point' }, [el('strong', { class: 'big-time', text: wallTime(first.departs) }), el('span', { text: cityOf(first.from) })]),
      el('div', { class: 'journey-line', 'aria-hidden': 'true' }, [icon('plane', 20)]),
      el('div', { class: 'end-point to' }, [arrivalTime(first.departs, last.arrives), el('span', { text: days > 0 ? `${cityOf(last.to)} · ${wallDate(last.arrives)}` : cityOf(last.to) })]),
    ]),
  ]);
}

export function offerCard(offer) {
  const first = offer.segments[0];
  const airline = offer.airline ?? first.carrier;
  const people = travellerCount(offer.passengers);

  const choose = el('button', { class: 'btn primary big', type: 'button' }, [icon('check', 20), t('choose')]);
  choose.addEventListener('click', () => {
    const flights = offer.segments.map((s) => s.flight).join(' + ');
    const back = offer.return?.segments ?? [];
    const prompt = t('choosePrompt', {
      airline,
      flights: back.length ? `${flights}${t('chooseReturn', { flights: back.map((s) => s.flight).join(' + '), date: wallDate(back[0].departs) })}` : flights,
      from: cityOf(first.from), time: wallTime(first.departs), date: wallDate(first.departs), id: offer.offerId,
    });
    if (actions.choose) actions.choose(offer, prompt);
    else actions.send(prompt);
  });
  const ask = el('button', { class: 'btn ghost', type: 'button', text: t('askAbout') });
  ask.addEventListener('click', () => actions.send(t('askPrompt', { airline, flight: first.flight, id: offer.offerId })));

  const carriers = [...new Set([...offer.segments, ...(offer.return?.segments ?? [])].map((s) => s.carrier))];
  return el('article', { class: 'offer', 'aria-label': `${airline}, ${wallTime(first.departs)}, ${offer.price}` }, [
    offer.tags.length ? el('div', { class: 'tags' }, offer.tags.map((tag) => el('span', { class: TAGS[tag].cls }, [TAGS[tag].icon ? icon(TAGS[tag].icon, 12) : null, t(TAGS[tag].key)]))) : null,
    // Who you fly with is one of the first things travellers compare: on the card, not in the details.
    el('p', { class: 'airline' }, [icon('plane', 16), el('span', { text: carriers.length > 1 ? carriers.join(' + ') : airline })]),
    journeyRow(offer.segments, offer.return ? t('outbound') : ''),
    offer.return ? journeyRow(offer.return.segments, t('returnLeg')) : null,
    el('div', { class: 'price-row' }, [
      el('div', { class: 'price' }, [
        el('strong', {}, [money(offer.price)]),
        offer.return ? el('span', { text: t('bothWays') }) : null,
        offer.priceIndicativeSsp ? el('span', {}, [money(offer.priceIndicativeSsp)]) : null,
      ]),
      el('span', { class: 'people', 'aria-label': `${people} ${people === 1 ? t('person') : t('people')}` }, [icon('user', 18), el('b', { text: String(people) })]),
    ]),
    el('ul', { class: 'facts' }, [
      fact('plane', stopsText(offer.stops)),
      fact('clock', duration(offer.totalDurationMinutes)),
      fact(offer.refundable ? 'check' : 'close', offer.refundable ? t('refundYes') : t('refundNo')),
      offer.seatsRemaining !== undefined && offer.seatsRemaining <= 5 ? fact('users', t('seatsLeft', { n: offer.seatsRemaining }), 'warn') : null,
    ]),
    el('div', { class: 'card-actions' }, [hearButton(() => offerSpeech(offer)), choose]),
    el('details', { class: 'more' }, [
      el('summary', { text: t('details') }),
      el('ul', { class: 'detail-list' }, [
        el('li', { text: `${airline} · ${offer.segments.map((s) => `${s.flight} ${s.from}→${s.to}`).join(', ')}` }),
        offer.return ? el('li', { text: `${t('returnLeg')} · ${offer.return.segments.map((s) => `${s.flight} ${s.from}→${s.to}`).join(', ')} · ${stopsText(offer.return.stops)} · ${duration(offer.return.durationMinutes)}` }) : null,
        el('li', { text: offer.baggage }),
        el('li', { text: offer.booking === 'hold' ? t('holdLater') : t('payFirst') }),
        el('li', { text: offer.passengers }),
      ]),
      ask,
    ]),
  ]);
}

/** Compact in-chat summary pointing to the full list in the trip panel. */
export function resultsSummary(search, onOpen, label = '') {
  const cheapest = search.offers.find((o) => o.tags.includes('cheapest')) ?? search.offers[0];
  const open = el('button', { class: 'btn primary', type: 'button' }, [icon('list', 18), t('seeFlights')]);
  open.addEventListener('click', onOpen);
  const map = routeMap([search.origin.code, search.destination.code], { width: 120, height: 64, compact: true });
  return el('div', { class: 'results-chip' }, [
    map ? el('div', { class: 'results-map', 'aria-hidden': 'true' }, [map]) : null,
    el('div', { class: 'results-text' }, [
      el('strong', { text: `${label ? `${label} · ` : ''}${t('flightsFound', { n: search.offers.length, s: plural(search.offers.length) })} · ${cityOf(search.origin.code)} ${search.returnDate ? '⇄' : arrow()} ${cityOf(search.destination.code)}` }),
      el('span', {}, [`${wallDate(search.departureDate)}${search.returnDate ? ` – ${wallDate(search.returnDate)}` : ''}`, ...(cheapest ? [' · ', money(cheapest.price)] : [])]),
    ]),
    open,
  ]);
}

// ---------------------------------------------------------------- proposals

export function confirmationCard(c) {
  const isBooking = c.kind === 'create_reservation';
  const title = isBooking ? t('confirmBook') : t('confirmCancel');
  const status = el('p', { class: 'note', role: 'status' });
  const yes = el('button', { class: 'btn primary big yes', type: 'button' }, [icon('check', 22), t('yes')]);
  const no = el('button', { class: 'btn ghost big no', type: 'button' }, [icon('close', 22), t('no')]);
  const card = el('div', { class: 'card proposal', role: 'group', 'aria-label': title }, [
    el('span', { class: 'ai-badge' }, [icon('sparkle', 12), t('suggested')]),
    el('div', { class: 'card-head' }, [el('h3', { class: 'question', text: title }), hearButton(() => `${title} ${c.summary} ${t('nothingYet')}`)]),
    el('p', { class: 'summary', text: c.summary, dir: 'auto' }),
    el('p', { class: 'fine-print', text: t('nothingYet') }),
    el('div', { class: 'yes-no' }, [yes, no]),
    status,
  ]);

  yes.addEventListener('click', async () => {
    yes.disabled = no.disabled = true;
    status.textContent = t('wait');
    try {
      const { booking } = await api(`/confirmations/${c.confirmationId}/confirm`, { method: 'POST' });
      status.textContent = '';
      card.replaceWith(bookingCard(booking));
      actions.bookingsChanged();
      await actions.send(booking.status === 'held' ? t('confirmedFollow', { pnr: booking.pnr }) : t('cancelledFollow', { pnr: booking.pnr }));
    } catch (e) {
      status.textContent = e.message;
      yes.disabled = no.disabled = false;
    }
  });
  no.addEventListener('click', async () => {
    yes.disabled = no.disabled = true;
    await api(`/confirmations/${c.confirmationId}/decline`, { method: 'POST' }).catch(() => {});
    status.textContent = t('declined');
  });
  return card;
}

// ---------------------------------------------------------------- bookings

const STATUS_ICON = {
  held: 'clock', payment_pending: 'clock', ticketing: 'ticket', ticketed: 'check',
  expired: 'close', cancelled: 'close', refund_pending: 'refresh', refunded: 'check',
};

function bookingSpeech(b) {
  const first = b.segments[0];
  const last = b.segments[b.segments.length - 1];
  return t('bookingSay', {
    code: b.pnr.split('').join(' '),
    from: first ? cityOf(first.from) : '', to: last ? cityOf(last.to) : '',
    date: first ? wallDate(first.departs) : '', time: first ? wallTime(first.departs) : '',
    status: t(`st_${b.status}`),
  }) + (b.returnSegments?.[0] ? t('bookingReturnSay', { date: wallDate(b.returnSegments[0].departs), time: wallTime(b.returnSegments[0].departs) }) : '');
}

function bookingJourney(segments, label) {
  const first = segments[0];
  const last = segments[segments.length - 1];
  return el('div', { class: 'journey-block' }, [
    label ? el('span', { class: 'journey-label', text: label }) : null,
    el('div', { class: 'journey boxed' }, [
      el('div', { class: 'end-point' }, [el('strong', { class: 'big-time', text: wallTime(first.departs) }), el('span', { text: cityOf(first.from) }), el('span', { class: 'date', text: wallDate(first.departs) })]),
      el('div', { class: 'journey-line', 'aria-hidden': 'true' }, [icon('plane', 20)]),
      el('div', { class: 'end-point to' }, [arrivalTime(first.departs, last.arrives), el('span', { text: cityOf(last.to) }), el('span', { class: 'date', text: wallDate(last.arrives) })]),
    ]),
  ]);
}

export function bookingCard(b, { map = false } = {}) {
  const first = b.segments[0];
  const last = b.segments[b.segments.length - 1];
  const card = el('div', { class: `card booking is-${b.status}`, role: 'group', 'aria-label': `${t('code')} ${b.pnr}` }, [
    el('div', { class: `status-banner ${b.status}` }, [icon(STATUS_ICON[b.status] ?? 'ticket', 22), el('strong', { text: t(`st_${b.status}`) })]),
    el('div', { class: 'card-head' }, [
      el('div', {}, [el('span', { class: 'eyebrow-text', text: t('code') }), el('h3', { class: 'pnr', text: b.pnr })]),
      hearButton(() => bookingSpeech(b)),
    ]),
  ]);

  if (first && last) {
    const sketch = map ? routeMap([first.from, ...b.segments.map((s) => s.to)], { width: 400, height: 150, compact: true }) : null;
    if (sketch) card.append(el('div', { class: 'booking-map', 'aria-hidden': 'true' }, [sketch]));
    const back = b.returnSegments ?? [];
    card.append(bookingJourney(b.segments, back.length ? t('outbound') : ''));
    if (back.length) card.append(bookingJourney(back, t('returnLeg')));
  }

  const meta = [
    ['users', t('travellers'), b.passengers.map((p) => p.name).join(', ')],
    ['card', t('total'), money(b.total)],
    ...(b.holdExpiresAt && (b.status === 'held' || b.status === 'payment_pending') ? [['clock', t('payBefore'), new Date(b.holdExpiresAt).toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })]] : []),
    ...(b.ticketNumbers.length ? [['ticket', t('ticketNos'), b.ticketNumbers.join(', ')]] : []),
  ];
  card.append(el('dl', { class: 'meta' }, meta.map(([ic, k, v]) => el('div', {}, [el('dt', {}, [icon(ic, 16), k]), typeof v === 'string' ? el('dd', { text: v, dir: 'auto' }) : el('dd', {}, [v])]))));

  // Printable e-ticket: same-origin path from the signed link (works however the site is reached).
  if (b.status === 'ticketed' && b.eticketUrl) {
    let path = null;
    try { const u = new URL(b.eticketUrl, location.href); if (u.pathname.startsWith('/e/')) path = u.pathname; } catch { /* ignore */ }
    if (path) {
      card.append(el('div', { class: 'pay' }, [
        el('a', { class: 'btn primary big', href: path, target: '_blank', rel: 'noopener' }, [icon('ticket', 20), t('printTicket')]),
        el('p', { class: 'note', text: t('printTicketNote') }),
      ]));
    }
  }

  if (b.status === 'payment_pending' && b.payment?.status === 'requested') {
    const url = b.payment.checkoutUrl ? safePaymentUrl(b.payment.checkoutUrl) : null;
    const pay = el('div', { class: 'pay' });
    if (url) pay.append(payLink(url), el('p', { class: 'note', text: t('cardBanks') }));
    else if (b.payment.bankTransfer) pay.append(bankDetails(b));
    else if (b.payment.cashOffices) pay.append(cashDetails(b));
    else if (b.payment.provider === 'sandbox') pay.append(sandboxPayControls(b));
    else pay.append(el('p', { class: 'note', text: b.payment.instructions, dir: 'auto' }));
    card.append(pay);
  } else if (b.status === 'held') {
    const choice = (method, cls, ic, label, prompt) => {
      const btn = el('button', { class: `btn ${cls} big`, type: 'button' }, [icon(ic, 20), t(label)]);
      btn.addEventListener('click', () => actions.send(t(prompt, { pnr: b.pnr })));
      return hasMethod(method) ? btn : null;
    };
    const buttons = [
      choice('card', 'primary', 'card', 'payCard', 'payCardPrompt'),
      choice('bank_transfer', 'ghost', 'bank', 'payBank', 'payBankPrompt'),
      choice('cash_office', 'ghost', 'cash', 'payCash', 'payCashPrompt'),
      choice('mtn_momo', 'ghost', 'phone', 'payMomo', 'payMomoPrompt'),
    ].filter(Boolean);
    card.append(el('div', { class: 'pay pay-choices' }, buttons));
    if (hasMethod('card')) card.append(el('p', { class: 'note pay-banks', text: t('cardBanks') }));
  }
  return card;
}

/** Where to pay a bank transfer or branch deposit: big, labelled, with the booking code as reference. */
function bankDetails(b) {
  const a = b.payment.bankTransfer;
  const amount = b.payment.amount;
  const rows = [
    ['bankAmount', amount],
    ['bankName', a.branch ? `${a.bankName} (${a.branch})` : a.bankName],
    ['bankAccountName', a.accountName],
    ['bankAccountNo', a.accountNumber],
    ...(a.swift ? [['bankSwift', a.swift]] : []),
    ['bankRef', b.pnr],
  ];
  const say = () => t('bankSay', { amount, bank: a.bankName, name: a.accountName, number: a.accountNumber.split('').join(' '), pnr: b.pnr.split('').join(' ') });
  return el('div', { class: 'bank-box' }, [
    el('div', { class: 'bank-head' }, [el('strong', {}, [icon('bank', 20), t('bankTitle')]), hearButton(say)]),
    ...(b.payment.provider === 'bank_transfer_demo' ? [el('p', { class: 'note warn', text: t('bankDemo') })] : []),
    el('dl', { class: 'bank-rows' }, rows.map(([k, v]) => el('div', { class: k === 'bankRef' ? 'is-ref' : '' }, [el('dt', { text: t(k) }), el('dd', { text: v, dir: 'ltr' })]))),
    el('p', { class: 'note', text: t('bankKeep') }),
  ]);
}

/** Where to pay cash: each office with address and hours, and the booking code in large print. */
function cashDetails(b) {
  const amount = b.payment.amount;
  const offices = b.payment.cashOffices.map((o) =>
    el('li', { class: 'office' }, [
      el('div', {}, [el('strong', { text: o.name }), el('span', { text: o.address }), el('span', { class: 'hours' }, [icon('clock', 14), o.hours])]),
      hearButton(() => t('cashSay', { amount, office: o.name, address: o.address, hours: o.hours, pnr: b.pnr.split('').join(' ') }), { label: false }),
    ]),
  );
  return el('div', { class: 'bank-box cash-box' }, [
    el('div', { class: 'bank-head' }, [el('strong', {}, [icon('cash', 20), t('cashTitle')]), el('strong', { class: 'cash-amount', text: amount, dir: 'ltr' })]),
    ...(b.payment.provider === 'cash_office_demo' ? [el('p', { class: 'note warn', text: t('cashDemo') })] : []),
    el('ul', { class: 'offices' }, offices),
    el('div', { class: 'bank-rows' }, [el('div', { class: 'is-ref' }, [el('dt', { text: t('cashCode') }), el('dd', { text: b.pnr, dir: 'ltr' })])]),
    el('p', { class: 'note', text: t('cashKeep') }),
  ]);
}

// Sandbox-only: stands in for approving the prompt on the traveller's phone.
function sandboxPayControls(b) {
  const note = el('p', { class: 'note', text: t('demoPay') });
  const ok = el('button', { class: 'btn primary big', type: 'button' }, [icon('check', 20), t('approve')]);
  const fail = el('button', { class: 'btn ghost big', type: 'button' }, [icon('close', 20), t('decline')]);
  const wrap = el('div', {}, [note, el('div', { class: 'yes-no' }, [ok, fail])]);
  const act = (outcome) => async () => {
    ok.disabled = fail.disabled = true;
    try {
      const { booking } = await api(`/sandbox/bookings/${b.pnr}/payment`, { method: 'POST', body: { outcome } });
      wrap.closest('.card')?.replaceWith(bookingCard(booking));
      actions.bookingsChanged();
    } catch (e) {
      note.textContent = e.message;
      ok.disabled = fail.disabled = false;
    }
  };
  ok.addEventListener('click', act('succeeded'));
  fail.addEventListener('click', act('failed'));
  return wrap;
}
