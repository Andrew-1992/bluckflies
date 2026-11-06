import { transcriptOf, type TranscriptLine } from '../agent/transcript.js';
import { AppError } from '../domain/errors.js';
import type { Booking } from '../domain/types.js';
import type { Clock } from '../lib/clock.js';
import { newId } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { formatUsd } from '../lib/money.js';
import type {
  BookingRepository,
  ConversationRepository,
  SessionRepository,
  SupportTicketRecord,
  SupportTicketRepository,
  TicketNoteRecord,
  TicketStatus,
  TravellerRepository,
} from '../repositories/types.js';
import type { NotificationService } from './notifications/NotificationService.js';

export interface SupportTicket {
  ticketId: string;
  reason: string;
  summary: string;
  createdAt: string;
}

/** What staff see for a ticket: enough to call the traveller and act on the booking. */
export interface TicketDetail {
  ticket: SupportTicketRecord;
  booking?: {
    pnr: string;
    status: Booking['status'];
    route: string;
    departs?: string;
    total: string;
    ticketNumbers: readonly string[];
    passengers: string[];
    contact: { phone: string; email: string; language?: string };
  };
  /** Phone of the traveller's account (if logged in) or WhatsApp/SMS sender. */
  travellerPhone?: string;
  channel: string;
  notes: TicketNoteRecord[];
  transcript: TranscriptLine[];
}

/**
 * Escalations to people: "talk to a person", change requests, airline
 * schedule changes and refunds that need manual action. Every ticket alerts
 * the support team, and staff work it from the support desk.
 */
export class SupportService {
  constructor(
    private readonly tickets: SupportTicketRepository,
    private readonly bookings: BookingRepository,
    private readonly sessions: SessionRepository,
    private readonly travellers: TravellerRepository,
    private readonly conversations: ConversationRepository,
    private readonly notifications: NotificationService | undefined,
    private readonly clock: Clock,
    private readonly log: Logger,
  ) {}

  async open(sessionId: string, reason: string, summary: string, opts: { bookingId?: string | undefined; contactPhone?: string } = {}): Promise<SupportTicket> {
    const now = this.clock.now().toISOString();
    const record: SupportTicketRecord = {
      id: newId('sup'),
      sessionId,
      reason,
      summary,
      status: 'open',
      ...(opts.bookingId ? { bookingId: opts.bookingId } : {}),
      ...(opts.contactPhone ? { contactPhone: opts.contactPhone } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.tickets.insert(record);
    this.log.info('support.ticket_opened', { ticketId: record.id, sessionId, reason });
    const booking = opts.bookingId ? await this.bookings.findById(opts.bookingId) : undefined;
    const phone = opts.contactPhone ?? booking?.contact.phone ?? (await this.travellerPhone(sessionId));
    // Alerting must never break the traveller's request.
    await this.notifications
      ?.onSupportTicket(record, { ...(booking ? { pnr: booking.pnr } : {}), ...(phone ? { phone } : {}) })
      .catch((err: unknown) => this.log.error('support.alert_failed', { ticketId: record.id, err: String(err) }));
    return { ticketId: record.id, reason, summary, createdAt: now };
  }

  list(status: TicketStatus | undefined, limit = 100): Promise<SupportTicketRecord[]> {
    return this.tickets.list({ ...(status ? { status } : {}), limit });
  }

  async detail(id: string): Promise<TicketDetail> {
    const ticket = await this.tickets.find(id);
    if (!ticket) throw new AppError('NOT_FOUND', 'No such ticket.');
    const [booking, session, notes, messages] = await Promise.all([
      ticket.bookingId ? this.bookings.findById(ticket.bookingId) : undefined,
      this.sessions.findById(ticket.sessionId),
      this.tickets.notes(id),
      this.conversations.load(ticket.sessionId),
    ]);
    const travellerPhone = ticket.contactPhone ?? (await this.travellerPhone(ticket.sessionId));
    const first = booking?.offer.segments[0];
    return {
      ticket,
      ...(booking
        ? {
            booking: {
              pnr: booking.pnr,
              status: booking.status,
              route: `${booking.offer.segments.map((s) => `${s.flightNumber} ${s.origin}-${s.destination}`).join(', ')}${
                booking.offer.returnSegments?.length ? `; return ${booking.offer.returnSegments.map((s) => `${s.flightNumber} ${s.origin}-${s.destination} ${s.departureTime.slice(0, 10)}`).join(', ')}` : ''
              }`,
              ...(first ? { departs: first.departureTime } : {}),
              total: formatUsd(booking.offer.totalPrice),
              ticketNumbers: booking.ticketNumbers,
              passengers: booking.passengers.map((p) => `${p.givenName} ${p.familyName} (${p.type})`),
              contact: { phone: booking.contact.phone, email: booking.contact.email, ...(booking.contact.language ? { language: booking.contact.language } : {}) },
            },
          }
        : {}),
      ...(travellerPhone ? { travellerPhone } : {}),
      channel: session?.channel ?? 'web',
      notes,
      transcript: transcriptOf(messages),
    };
  }

  async update(id: string, change: { status?: TicketStatus; assignee?: string | null }, author: string): Promise<SupportTicketRecord> {
    const now = this.clock.now().toISOString();
    const updated = await this.tickets.update(id, { ...change, updatedAt: now });
    if (!updated) throw new AppError('NOT_FOUND', 'No such ticket.');
    const parts = [
      change.status ? `status → ${change.status}` : '',
      change.assignee !== undefined ? `assignee → ${change.assignee ?? 'nobody'}` : '',
    ].filter(Boolean);
    if (parts.length) await this.addNote(id, author, parts.join(', '));
    this.log.info('support.ticket_updated', { ticketId: id, author, ...change });
    return updated;
  }

  async addNote(ticketId: string, author: string, body: string): Promise<TicketNoteRecord> {
    const ticket = await this.tickets.find(ticketId);
    if (!ticket) throw new AppError('NOT_FOUND', 'No such ticket.');
    const note: TicketNoteRecord = { id: newId('note'), ticketId, author, body, createdAt: this.clock.now().toISOString() };
    await this.tickets.addNote(note);
    await this.tickets.update(ticketId, { updatedAt: note.createdAt });
    return note;
  }

  /** Sends a text message to the traveller (booking contact phone, else their account or sender phone). */
  async messageTraveller(ticketId: string, author: string, text: string): Promise<TicketNoteRecord> {
    if (!this.notifications?.canDeliver('sms')) throw new AppError('INVALID_STATE', 'SMS is not configured, so travellers cannot be messaged from the desk. Call them instead.');
    const detail = await this.detail(ticketId);
    const phone = detail.booking?.contact.phone ?? detail.travellerPhone;
    if (!phone) throw new AppError('INVALID_STATE', 'This ticket has no phone number to message.');
    const note = await this.addNote(ticketId, author, `SMS to traveller: ${text}`);
    await this.notifications.staffMessage(ticketId, note.id, phone, text);
    return note;
  }

  private async travellerPhone(sessionId: string): Promise<string | undefined> {
    const session = await this.sessions.findById(sessionId);
    if (!session?.travellerId) return undefined;
    return (await this.travellers.findById(session.travellerId))?.phone;
  }
}
