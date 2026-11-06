import { findAirportByCode } from '../../data/airports.js';
import type { Booking } from '../../domain/types.js';
import { formatUsd } from '../../lib/money.js';

/**
 * Messages to travellers, in English or Arabic (the booking's contact language).
 * Plain text on purpose: it renders on every phone and email client, and
 * SMS stays short (Arabic SMS uses 70-character segments).
 */

export type Lang = 'en' | 'ar';
export type BookingEventKind = 'held' | 'ticketed' | 'refunded';

const city = (code: string, lang: Lang) => {
  const a = findAirportByCode(code);
  if (!a) return code;
  const arabic = a.aliases.find((x) => /[؀-ۿ]/.test(x));
  return lang === 'ar' && arabic ? arabic : a.city;
};

/** "Fri 6 Nov 2026, 09:30" in the airport's local time, exactly as on the ticket. */
function when(iso: string, lang: Lang): string {
  const d = new Date(`${iso.slice(0, 10)}T12:00:00Z`);
  const day = d.toLocaleDateString(lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${day}, ${iso.slice(11, 16)}`;
}

function flightLines(segments: Booking['offer']['segments'], lang: Lang): string {
  return segments
    .map((s) =>
      lang === 'ar'
        ? `✈ ${s.flightNumber} (${s.carrierName}): ${city(s.origin, lang)} ${when(s.departureTime, lang)} ← ${city(s.destination, lang)} ${when(s.arrivalTime, lang)}`
        : `✈ ${s.flightNumber} (${s.carrierName}): ${city(s.origin, lang)} ${when(s.departureTime, lang)} → ${city(s.destination, lang)} ${when(s.arrivalTime, lang)}`,
    )
    .join('\n');
}

function itinerary(b: Booking, lang: Lang): string {
  const back = b.offer.returnSegments ?? [];
  if (back.length === 0) return flightLines(b.offer.segments, lang);
  return lang === 'ar'
    ? `الذهاب:\n${flightLines(b.offer.segments, lang)}\nالعودة:\n${flightLines(back, lang)}`
    : `Outbound:\n${flightLines(b.offer.segments, lang)}\nReturn:\n${flightLines(back, lang)}`;
}

/** "Juba → Nairobi", or "Juba ⇄ Nairobi" for a round trip. */
function routeOf(b: Booking, lang: Lang): string {
  const first = b.offer.segments[0];
  const last = b.offer.segments.at(-1);
  if (!first || !last) return '';
  const arrow = b.offer.returnSegments?.length ? '⇄' : lang === 'ar' ? '←' : '→';
  return `${city(first.origin, lang)} ${arrow} ${city(last.destination, lang)}`;
}

/** Departure time(s) for short messages: "Fri 6 Nov 2026, 09:30", plus the return for a round trip. */
function departures(b: Booking, lang: Lang): string {
  const out = b.offer.segments[0];
  const back = b.offer.returnSegments?.[0];
  if (!out) return '';
  return back ? `${when(out.departureTime, lang)}; ${lang === 'ar' ? 'العودة' : 'return'} ${when(back.departureTime, lang)}` : when(out.departureTime, lang);
}

const names = (b: Booking) => b.passengers.map((p) => `${p.givenName} ${p.familyName}`).join(', ');

export interface Rendered {
  subject: string;
  email: string;
  sms: string;
  /**
   * Values for the approved WhatsApp template of this event, in order ({{1}}, {{2}}, …):
   * held: booking code, route, total, pay before · ticketed: booking code, route and
   * departure, ticket numbers, e-ticket link · refunded: booking code.
   */
  whatsappParams: string[];
}

type RenderOpts = { lang: Lang; siteUrl: string; holdExpiresLocal?: string; eticketUrl?: string };

export function renderBookingEvent(kind: BookingEventKind, b: Booking, opts: RenderOpts): Rendered {
  const route = routeOf(b, opts.lang);
  const leaves = departures(b, opts.lang);
  const payBy = new Date(b.holdExpiresAt).toLocaleString(opts.lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Juba' });
  const whatsappParams =
    kind === 'held'
      ? [b.pnr, route, formatUsd(b.offer.totalPrice), payBy]
      : kind === 'ticketed'
        ? [b.pnr, `${route}${leaves ? `, ${leaves}` : ''}`, b.ticketNumbers.join(', '), opts.eticketUrl ?? opts.siteUrl]
        : [b.pnr];
  return { ...renderText(kind, b, opts), whatsappParams };
}

function renderText(kind: BookingEventKind, b: Booking, opts: RenderOpts): Omit<Rendered, 'whatsappParams'> {
  const { lang, siteUrl } = opts;
  const route = routeOf(b, lang);
  const leaves = departures(b, lang);
  const total = formatUsd(b.offer.totalPrice);
  const tickets = b.ticketNumbers.join(', ');
  const payBy = new Date(b.holdExpiresAt).toLocaleString(lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Africa/Juba' });

  if (lang === 'ar') {
    switch (kind) {
      case 'held':
        return {
          subject: `بلك فلايز: تم حجز مقاعدك ${b.pnr}`,
          email: `مرحباً،\n\nتم حجز مقاعدك ولم يتم الدفع بعد.\n\nرمز الحجز: ${b.pnr}\nالمسافرون: ${names(b)}\n${itinerary(b, lang)}\nالمجموع: ${total}\n\nادفع قبل ${payBy} (بتوقيت جوبا) وإلا سيتم إلغاء الحجز.\nللدفع افتح ${siteUrl} أو اسأل بلك فلايز.\n\nلن نطلب منك أبداً رقمك السري أو رقم بطاقتك.\n\nبلك فلايز`,
          sms: `بلك فلايز: تم حجز ${b.pnr} ${route}. ادفع ${total} قبل ${payBy}.`,
        };
      case 'ticketed':
        return {
          subject: `بلك فلايز: تذكرتك جاهزة ${b.pnr}`,
          email: `مرحباً،\n\nتم الدفع وتذكرتك جاهزة.\n\nرمز الحجز: ${b.pnr}\nأرقام التذاكر: ${tickets}\nالمسافرون: ${names(b)}\n${itinerary(b, lang)}\nالمجموع المدفوع: ${total}\n\nفي المطار: أحضر جواز السفر أو بطاقة الهوية المستخدمة في الحجز، وأظهر هذه الرسالة عند تسجيل الوصول. الأوقات بالتوقيت المحلي لكل مطار.${opts.eticketUrl ? `\n\nالتذكرة للطباعة (PDF): ${opts.eticketUrl}` : ''}\n\nبلك فلايز`,
          sms: `بلك فلايز: التذكرة جاهزة. ${b.pnr} ${route}. ${leaves}. التذاكر: ${tickets}`,
        };
      case 'refunded':
        return {
          subject: `بلك فلايز: تمت إعادة المبلغ ${b.pnr}`,
          email: `مرحباً،\n\nتمت إعادة المبلغ الخاص بالحجز ${b.pnr} إلى وسيلة الدفع الأصلية. قد يستغرق ظهوره بضعة أيام حسب البنك أو مزود المحفظة.\n\nبلك فلايز`,
          sms: `بلك فلايز: تمت إعادة المبلغ للحجز ${b.pnr} إلى وسيلة الدفع الأصلية.`,
        };
    }
  }
  switch (kind) {
    case 'held':
      return {
        subject: `BluckFlies: seats held, booking ${b.pnr}`,
        email: `Hello,\n\nYour seats are held. You have not paid yet.\n\nBooking code: ${b.pnr}\nTravellers: ${names(b)}\n${itinerary(b, lang)}\nTotal: ${total}\n\nPay before ${payBy} (Juba time) or the hold is released.\nTo pay, open ${siteUrl} or ask BluckFlies.\n\nWe will never ask for your PIN or card number.\n\nBluckFlies`,
        sms: `BluckFlies: seats held, ${b.pnr} ${route}. Pay ${total} before ${payBy}.`,
      };
    case 'ticketed':
      return {
        subject: `BluckFlies: your ticket is ready, booking ${b.pnr}`,
        email: `Hello,\n\nPayment received. Your ticket is issued.\n\nBooking code: ${b.pnr}\nTicket numbers: ${tickets}\nTravellers: ${names(b)}\n${itinerary(b, lang)}\nTotal paid: ${total}\n\nAt the airport: bring the passport or ID used for this booking and show this message at check-in. Times are local to each airport.${opts.eticketUrl ? `\n\nPrintable e-ticket (PDF): ${opts.eticketUrl}` : ''}\n\nBluckFlies`,
        sms: `BluckFlies: ticket ready. ${b.pnr} ${route}, ${leaves}. Tickets: ${tickets}`,
      };
    case 'refunded':
      return {
        subject: `BluckFlies: refund completed, booking ${b.pnr}`,
        email: `Hello,\n\nThe refund for booking ${b.pnr} has been sent to your original payment method. Depending on your bank or wallet, it can take a few days to appear.\n\nBluckFlies`,
        sms: `BluckFlies: refund for ${b.pnr} sent to your original payment method.`,
      };
  }
}
