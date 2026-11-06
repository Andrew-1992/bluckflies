// DOM helpers shared by the client modules.
// All server and agent text is inserted with textContent, never innerHTML.

import { formatDay, t } from './i18n.js';

export function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'text') node.textContent = v;
    else if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) node.append(c);
  return node;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
const STROKE = { fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** Icon path data. Filled icons set `fill: true`; the rest are 24×24 strokes. */
const ICONS = {
  sparkle: { fill: true, d: ['M12 2.5l1.8 5.6 5.7 1.9-5.7 1.9L12 17.5l-1.8-5.6L4.5 10l5.7-1.9z', 'M19 15l.8 2.2 2.2.8-2.2.8L19 21l-.8-2.2-2.2-.8 2.2-.8z'] },
  plane: { d: ['M17.8 19.2 16 11l3.5-3.5C21 6 21.5 4 21 3c-1-.5-3 0-4.5 1.5L13 8 4.8 6.2c-.5-.1-.9.1-1.1.5l-.3.5c-.2.5-.1 1 .3 1.3L9 12l-2 3H4l-1 1 3 2 2 3 1-1v-3l3-2 3.5 5.3c.3.4.8.5 1.3.3l.5-.2c.4-.3.6-.7.5-1.2z'] },
  lock: { d: ['M5 11h14v10H5z', 'M8 11V7a4 4 0 0 1 8 0v4'] },
  search: { d: ['M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z', 'm20 20-3.5-3.5'] },
  chart: { d: ['M3 20h18', 'M7 16V10', 'M12 16V5', 'M17 16v-3'] },
  ticket: { d: ['M3 8V6h18v2a3 3 0 0 0 0 6v2H3v-2a3 3 0 0 0 0-6z', 'M14 6v1', 'M14 11v2', 'M14 17v-1'] },
  shield: { d: ['M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z', 'm9 12 2 2 4-4'] },
  refresh: { d: ['M3 12a9 9 0 0 1 15.5-6.2L21 8', 'M21 3v5h-5', 'M21 12a9 9 0 0 1-15.5 6.2L3 16', 'M3 21v-5h5'] },
  help: { d: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3', 'M12 17h.01'] },
  headset: { d: ['M4 14v-2a8 8 0 0 1 16 0v2', 'M4 14h3v6H5a1 1 0 0 1-1-1z', 'M20 14h-3v6h2a1 1 0 0 0 1-1z'] },
  arrow: { d: ['M5 12h14', 'M13 6l6 6-6 6'] },
  clock: { d: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M12 7v5l3 2'] },
  bag: { d: ['M6 8h12l-1 13H7z', 'M9 8V6a3 3 0 0 1 6 0v2'] },
  check: { d: ['M20 6 9 17l-5-5'] },
  close: { d: ['M6 6l12 12', 'M18 6 6 18'] },
  map: { d: ['M9 4 3 6v14l6-2 6 2 6-2V4l-6 2z', 'M9 4v14', 'M15 6v14'] },
  list: { d: ['M8 6h13', 'M8 12h13', 'M8 18h13', 'M3 6h.01', 'M3 12h.01', 'M3 18h.01'] },
  calendar: { d: ['M4 5h16v16H4z', 'M4 10h16', 'M9 3v4', 'M15 3v4'] },
  user: { d: ['M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M4 21a8 8 0 0 1 16 0'] },
  swap: { d: ['M7 4 3 8l4 4', 'M3 8h14', 'M17 20l4-4-4-4', 'M21 16H7'] },
  panel: { d: ['M3 4h18v16H3z', 'M14 4v16'] },
  mic: { d: ['M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3z', 'M19 11a7 7 0 0 1-14 0', 'M12 18v3'] },
  speaker: { d: ['M11 5 6 9H3v6h3l5 4z', 'M15.5 8.5a5 5 0 0 1 0 7', 'M18.5 5.5a9 9 0 0 1 0 13'] },
  stop: { d: ['M7 7h10v10H7z'] },
  home: { d: ['M3 11 12 4l9 7', 'M5 10v10h14V10', 'M10 20v-6h4v6'] },
  globe: { d: ['M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z', 'M3 12h18', 'M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z'] },
  mute: { d: ['M11 5 6 9H3v6h3l5 4z', 'M22 9l-6 6', 'M16 9l6 6'] },
  minus: { d: ['M5 12h14'] },
  plus: { d: ['M12 5v14', 'M5 12h14'] },
  pin: { d: ['M12 21s-7-6.2-7-12a7 7 0 0 1 14 0c0 5.8-7 12-7 12z', 'M12 11.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z'] },
  users: { d: ['M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z', 'M2 21a7 7 0 0 1 14 0', 'M16 3.5a4 4 0 0 1 0 7.5', 'M18 14a6 6 0 0 1 4 7'] },
  phone: { d: ['M7 2h10v20H7z', 'M11 18h2'] },
  card: { d: ['M2 5h20v14H2z', 'M2 10h20', 'M6 15h4'] },
  cash: { d: ['M2 6h20v12H2z', 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z', 'M6 12h.01', 'M18 12h.01'] },
  bank: { d: ['M3 21h18', 'M4 18h16', 'M6 10v8', 'M10 10v8', 'M14 10v8', 'M18 10v8', 'M12 3 3 8h18z'] },
  back: { d: ['M15 18l-6-6 6-6'] },
  next: { d: ['M9 18l6-6-6-6'] },
};

/** Decorative inline icon, hidden from assistive technology. */
export function icon(name, size = 16) {
  const spec = ICONS[name];
  const svg = document.createElementNS(SVG_NS, 'svg');
  const attrs = { width: size, height: size, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', ...(spec.fill ? { fill: 'currentColor' } : STROKE) };
  for (const [k, v] of Object.entries(attrs)) svg.setAttribute(k, String(v));
  for (const d of spec.d) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    svg.append(path);
  }
  return svg;
}

export function svgEl(tag, attrs = {}, children = []) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) node.append(c);
  return node;
}

// Only Stripe's hosted checkout is ever turned into a link: a model reply can
// never produce a clickable link to any other site.
// Hosted card pages BluckFlies uses: Stripe Checkout and DPO Pay.
const PAYMENT_HOSTS = new Set(['checkout.stripe.com', 'secure.3gdirectpay.com']);

export function safePaymentUrl(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && PAYMENT_HOSTS.has(u.hostname) ? u.href : null;
  } catch {
    return null;
  }
}

export function payLink(url, label = t('payLink')) {
  return el('a', { class: 'btn primary paylink', href: url, rel: 'noopener noreferrer' }, [icon('lock'), label]);
}

/** Minimal, safe formatting: **bold** and Stripe checkout links, built from DOM nodes. */
export function formatted(text) {
  const frag = document.createDocumentFragment();
  text.split(/(\*\*[^*]+\*\*|https:\/\/[^\s)<>"']+)/g).forEach((part) => {
    if (!part) return;
    if (part.startsWith('**') && part.endsWith('**')) return frag.append(el('strong', { text: part.slice(2, -2) }));
    if (part.startsWith('https://')) {
      const trail = part.match(/[.,;:!?]+$/)?.[0] ?? '';
      const url = safePaymentUrl(part.slice(0, part.length - trail.length));
      if (url) return frag.append(payLink(url), document.createTextNode(trail));
    }
    frag.append(document.createTextNode(part));
  });
  return frag;
}

// Times arrive as ISO strings in the airport's own zone ("2026-11-06T09:30:00+03:00"):
// show the wall-clock time and date exactly as printed on the ticket.
export const wallTime = (iso) => String(iso).slice(11, 16);

export const wallDate = (iso) => formatDay(iso);

/** Calendar days between two local wall-clock times ("…T17:20+02:00" → "…T07:30+03:00" next morning = 1). */
export function dayShift(departsIso, arrivesIso) {
  const days = (Date.parse(String(arrivesIso).slice(0, 10)) - Date.parse(String(departsIso).slice(0, 10))) / 86_400_000;
  return Number.isFinite(days) ? Math.round(days) : 0;
}

/**
 * A price or code kept whole and left-to-right inside Arabic text
 * ("USD 389.00" must never split across lines or reorder).
 */
export const money = (text) => el('bdi', { class: 'money', dir: 'ltr', text });

export function duration(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h${m ? ` ${String(m).padStart(2, '0')}m` : ''}` : `${m}m`;
}

/** "USD 1,234.50" → 1234.5 (for client-side sorting only; never for charging). */
export function amountOf(price) {
  const n = Number(String(price).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) ? n : Number.POSITIVE_INFINITY;
}
