import { findAirportByCode } from '../data/airports.js';
import { AppError } from '../domain/errors.js';

export type TravelTopic = 'entry_requirements' | 'baggage' | 'airport' | 'payments' | 'check_in';

const DISCLAIMER = 'Requirements change. Confirm with the airline, the relevant embassy or official government sources before travelling.';

/**
 * Curated, deliberately conservative guidance. It points travellers to
 * authoritative sources rather than asserting rules that may have changed.
 */
const GUIDANCE: Record<Exclude<TravelTopic, 'airport'>, string[]> = {
  entry_requirements: [
    'Most foreign nationals need a visa to enter South Sudan. Apply through official South Sudan government channels or the nearest South Sudan embassy; avoid unofficial visa agents.',
    'A yellow fever vaccination certificate is commonly requested on arrival in South Sudan and by neighbouring countries. Carry the original certificate.',
    'Passports should usually be valid for at least 6 months beyond your travel dates and have blank pages.',
    'Transit through Nairobi, Entebbe, Addis Ababa, Kigali, Cairo, Dubai or Istanbul may need its own transit visa depending on your nationality.',
    'Domestic flights within South Sudan require a valid national ID or passport.',
  ],
  baggage: [
    'Allowances depend on the fare; each BluckFlies offer lists cabin and checked baggage.',
    'Small domestic aircraft (e.g. Cessna Caravan) have strict weight limits; excess baggage may be refused or travel on a later flight.',
    'Power banks and lithium batteries must go in cabin baggage, never checked baggage.',
  ],
  payments: [
    'BluckFlies accepts Visa and Mastercard bank cards, including cards from South Sudanese banks such as KCB, Equity Bank, Stanbic, Cooperative Bank and Ivory Bank when the bank has enabled them for online payments. You can also pay by bank transfer or cash deposit at a bank branch in USD, using your booking code as the reference. Where available, MTN MoMo and Zain m-Gurush are charged in South Sudanese pounds at a rate locked when the request is sent. Fares are priced in USD.',
    'Card payments open on a secure payment page (secure.3gdirectpay.com for DPO Pay, or checkout.stripe.com). Check the address before entering card details.',
    'If your card is declined, ask your bank to enable it for online and international payments, try a USD card, or pay by bank transfer.',
    'You approve every payment on your own phone or the secure card page. BluckFlies will never ask for your PIN, password or card number in chat.',
    'Your ticket is issued only after the payment provider confirms the payment.',
  ],
  check_in: [
    'Arrive at Juba International Airport at least 3 hours before international flights and 2 hours before domestic flights.',
    'Online check-in availability depends on the airline. Bring printed or digital tickets and your travel documents.',
  ],
};

export interface SupportTicket {
  ticketId: string;
  reason: string;
  summary: string;
  createdAt: string;
}

export class TravelInfoService {
  info(topic: TravelTopic, airportCode?: string): { topic: TravelTopic; points: string[]; disclaimer: string } {
    if (topic === 'airport') {
      if (!airportCode) throw new AppError('VALIDATION_FAILED', 'Please specify which airport.');
      const a = findAirportByCode(airportCode);
      if (!a) throw new AppError('NOT_FOUND', `Unknown airport code ${airportCode}.`);
      const points = [`${a.name} (${a.iata}) serves ${a.city}, ${a.country}.`, `Local time zone: ${a.timeZone}.`];
      if (a.notes) points.push(a.notes);
      return { topic, points, disclaimer: DISCLAIMER };
    }
    return { topic, points: GUIDANCE[topic], disclaimer: DISCLAIMER };
  }
}
