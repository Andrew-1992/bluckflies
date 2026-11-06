import { findAirportByCode } from '../data/airports.js';
import { allSegments, isAirstripCode, type Booking, type PaymentMethod } from '../domain/types.js';
import type { Clock } from '../lib/clock.js';
import { formatUsd } from '../lib/money.js';
import { A4, PdfDocument, wrap } from '../lib/pdf.js';
import { signLink, verifyLink } from '../lib/signedLinks.js';

/**
 * The printable e-ticket receipt and itinerary (PDF), and signed links to it.
 * Travellers in South Sudan are often asked for a printed itinerary at the
 * airport, so it is linked in the e-ticket email and on the booking.
 */

const BLUE = [36, 87, 230] as const;
const INK = [17, 24, 39] as const;
const MUTED = [100, 116, 139] as const;
const SOFT = [238, 242, 253] as const;
const RED = [185, 28, 28] as const;
const MARGIN = 40;
const RIGHT = A4.width - MARGIN;

export const ETICKET_PATH = '/e/';
const PURPOSE = 'eticket';
/** Links work for 60 days (well beyond a typical trip). */
const LINK_DAYS = 60;

const METHOD: Record<PaymentMethod, string> = {
  card: 'Bank card',
  bank_transfer: 'Bank transfer',
  cash_office: 'Cash',
  mtn_momo: 'MTN MoMo',
  zain_mgurush: 'Zain m-Gurush',
};

function place(code: string): string {
  const a = findAirportByCode(code);
  return a ? `${a.city} (${code})` : code;
}

/** "Fri 6 Nov 2026" from a local ISO time. */
function day(iso: string): string {
  return new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}

const hm = (mins: number) => `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;

export class ETicketService {
  constructor(
    private readonly secret: string,
    private readonly siteUrl: string,
    private readonly clock: Clock,
  ) {}

  /** Signed download link for a booking's e-ticket. */
  link(bookingId: string): string {
    const expires = new Date(this.clock.now().getTime() + LINK_DAYS * 86_400_000);
    return `${this.siteUrl}${ETICKET_PATH}${signLink(this.secret, PURPOSE, bookingId, expires)}`;
  }

  /** The booking id behind a link token, if the token is genuine and current. */
  bookingIdFor(token: string): string | undefined {
    return verifyLink(this.secret, PURPOSE, token, this.clock.now());
  }

  render(b: Booking, method?: PaymentMethod): Buffer {
    const doc = new PdfDocument({ title: `BluckFlies e-ticket ${b.pnr}`, author: 'BluckFlies' });
    const demo = b.offer.provider.startsWith('sandbox');
    let y = 0;

    // Header band
    doc.rect(0, 0, A4.width, 96, BLUE);
    doc.text(MARGIN, 44, 'BluckFlies', { size: 26, bold: true, color: [255, 255, 255] });
    doc.text(MARGIN, 66, 'E-ticket receipt and itinerary', { size: 12, color: [224, 231, 255] });
    doc.textRight(RIGHT, 38, 'BOOKING CODE', { size: 9, color: [224, 231, 255] });
    doc.textRight(RIGHT, 66, b.pnr, { size: 26, bold: true, color: [255, 255, 255] });
    y = 124;

    if (demo) {
      doc.rect(MARGIN, y - 16, RIGHT - MARGIN, 26, [254, 226, 226]);
      doc.text(MARGIN + 10, y + 2, 'DEMO BOOKING - NOT A VALID TICKET. Generated test data, not an airline reservation.', { size: 10, bold: true, color: RED });
      y += 28;
    }

    const status = b.status === 'ticketed' ? 'Ticketed' : b.status.replace('_', ' ');
    doc.text(MARGIN, y, `Status: ${status}`, { size: 10, bold: true, color: b.status === 'ticketed' ? [21, 128, 61] : RED });
    if (b.supplierReference) doc.textRight(RIGHT, y, `Airline reference: ${b.supplierReference}`, { size: 10, color: MUTED });
    y += 14;
    doc.text(MARGIN, y, `Issued ${day(this.clock.now().toISOString())} by BluckFlies, ${this.siteUrl.replace(/^https?:\/\//, '')}`, { size: 9, color: MUTED });
    y += 26;

    // Travellers
    y = this.heading(doc, y, 'Travellers');
    doc.text(MARGIN, y, 'NAME (as on passport / ID)', { size: 8, bold: true, color: MUTED });
    doc.text(330, y, 'TYPE', { size: 8, bold: true, color: MUTED });
    doc.text(410, y, 'E-TICKET NUMBER', { size: 8, bold: true, color: MUTED });
    y += 16;
    b.passengers.forEach((p, i) => {
      doc.text(MARGIN, y, `${p.familyName.toUpperCase()} / ${p.givenName.toUpperCase()}`, { size: 11, bold: true });
      doc.text(330, y, p.type, { size: 10 });
      doc.text(410, y, b.ticketNumbers[i] ?? 'Not yet issued', { size: 11, bold: Boolean(b.ticketNumbers[i]), color: b.ticketNumbers[i] ? INK : MUTED });
      y += 18;
    });
    y += 10;

    // Flights
    y = this.heading(doc, y, b.offer.returnSegments?.length ? 'Flights (round trip)' : 'Flights');
    const legs = [
      ...b.offer.segments.map((s, i) => ({ s, label: b.offer.returnSegments?.length && i === 0 ? 'OUTBOUND' : '' })),
      ...(b.offer.returnSegments ?? []).map((s, i) => ({ s, label: i === 0 ? 'RETURN' : '' })),
    ];
    for (const { s, label } of legs) {
      if (label) {
        doc.text(MARGIN, y, label, { size: 8, bold: true, color: MUTED });
        y += 16;
      }
      if (y > A4.height - 170) {
        doc.addPage();
        y = 50;
      }
      doc.rect(MARGIN, y - 12, RIGHT - MARGIN, 66, SOFT);
      doc.text(MARGIN + 10, y + 4, day(s.departureTime), { size: 11, bold: true, color: BLUE });
      doc.textRight(RIGHT - 10, y + 4, `${s.flightNumber}  ${s.carrierName}${s.aircraft ? `  ·  ${s.aircraft}` : ''}`, { size: 9, color: MUTED });
      doc.text(MARGIN + 10, y + 24, `${s.departureTime.slice(11, 16)}  Depart ${place(s.origin)}`, { size: 11, bold: true });
      doc.text(MARGIN + 10, y + 42, `${s.arrivalTime.slice(11, 16)}  Arrive ${place(s.destination)}${s.arrivalTime.slice(0, 10) !== s.departureTime.slice(0, 10) ? `  (${day(s.arrivalTime)})` : ''}`, { size: 11, bold: true });
      doc.textRight(RIGHT - 10, y + 42, `Flight time ${hm(s.durationMinutes)}`, { size: 9, color: MUTED });
      y += 76;
    }
    doc.text(MARGIN, y, 'All times are local to each airport.', { size: 9, color: MUTED });
    y += 24;

    // Baggage, fare, payment
    y = this.heading(doc, y, 'Baggage and fare');
    const bag = b.offer.baggage;
    const lines = [
      `Cabin bag: ${bag.cabinPieces} piece${bag.cabinPieces === 1 ? '' : 's'}${bag.cabinKg ? ` up to ${bag.cabinKg} kg` : ''}.  Checked bags: ${bag.checkedPieces === 0 ? 'none included' : `${bag.checkedPieces} x ${bag.checkedKgPerPiece ? `${bag.checkedKgPerPiece} kg` : 'standard'}`}.`,
      `Fare: ${b.offer.cabin.replace('_', ' ')}. ${b.offer.fareRules.refundable ? 'Refundable' : 'Not refundable'}${b.offer.fareRules.refundPenaltyCents ? ` (fee ${formatUsd({ amountCents: b.offer.fareRules.refundPenaltyCents, currency: 'USD' })})` : ''}. ${b.offer.fareRules.changeable ? 'Changes allowed' : 'No changes'}${b.offer.fareRules.changePenaltyCents ? ` (fee ${formatUsd({ amountCents: b.offer.fareRules.changePenaltyCents, currency: 'USD' })} plus any fare difference)` : ''}.`,
      `Total paid: ${formatUsd(b.offer.totalPrice)}${method ? ` by ${METHOD[method]}` : ''}.`,
    ];
    for (const l of lines) {
      for (const w of wrap(l, RIGHT - MARGIN, 10)) {
        doc.text(MARGIN, y, w, { size: 10 });
        y += 14;
      }
    }
    y += 12;

    // At the airport
    const intl = allSegments(b.offer).some((s) => !findAirportByCode(s.origin)?.isDomestic || !findAirportByCode(s.destination)?.isDomestic);
    const airstrip = allSegments(b.offer).some((s) => isAirstripCode(s.origin) || isAirstripCode(s.destination));
    y = this.heading(doc, y, 'At the airport');
    const advice = [
      `Arrive ${intl ? '3 hours' : '90 minutes'} before departure. Check-in usually closes ${intl ? '60' : '45'} minutes before departure.`,
      `Bring the ${intl ? 'passport (valid at least 6 months), visa and yellow fever certificate where required' : 'passport or national ID'} used for this booking. Names must match exactly.`,
      'Show this receipt (printed or on your phone) with your booking code and e-ticket numbers.',
      ...(airstrip ? ['Town airstrip flights can change with weather and the rainy season: confirm the day before with BluckFlies.'] : []),
      'Changes, cancellations or help: contact BluckFlies with your booking code.',
    ];
    for (const a of advice) {
      const wrapped = wrap(a, RIGHT - MARGIN - 14, 10);
      wrapped.forEach((w, i) => {
        if (i === 0) doc.text(MARGIN, y, '•', { size: 10, bold: true, color: BLUE });
        doc.text(MARGIN + 14, y, w, { size: 10 });
        y += 14;
      });
    }

    doc.line(MARGIN, A4.height - 46, RIGHT, A4.height - 46);
    doc.text(MARGIN, A4.height - 30, `BluckFlies - Your journey. Powered by intelligence.  ${this.siteUrl.replace(/^https?:\/\//, '')}`, { size: 8, color: MUTED });
    doc.textRight(RIGHT, A4.height - 30, `Booking ${b.pnr}`, { size: 8, color: MUTED });
    return doc.toBuffer();
  }

  private heading(doc: PdfDocument, y: number, title: string): number {
    doc.text(MARGIN, y, title.toUpperCase(), { size: 10, bold: true, color: BLUE });
    doc.line(MARGIN, y + 6, RIGHT, y + 6, [214, 224, 251]);
    return y + 24;
  }
}
