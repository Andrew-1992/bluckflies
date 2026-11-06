import { Prisma } from '../../generated/prisma/client.js';
import type {
  Booking as BookingRow,
  Confirmation as ConfirmationRow,
  Notification as NotificationRow,
  OtpChallenge as OtpChallengeRow,
  Payment as PaymentRow,
  Session as SessionRow,
  StaffSession as StaffSessionRow,
  StaffUser as StaffUserRow,
  SupportTicket as SupportTicketRow,
  Traveller as TravellerRow,
} from '../../generated/prisma/client.js';
import type { Booking, FlightOffer, Payment, PendingConfirmation } from '../../domain/types.js';
import type { FieldCipher } from '../../lib/fieldCipher.js';
import type { RateLimitHit, RateLimitStore } from '../../lib/rateLimiter.js';
import { formatRate, parseRate } from '../../lib/fx.js';
import {
  DuplicateKeyError,
  type AgentUsageDay,
  type AgentUsageEntry,
  type AgentUsageRepository,
  type StaffRepository,
  type StaffSessionRecord,
  type StaffUserPatch,
  type StaffUserRecord,
  type BookingRepository,
  type BookingUpdate,
  type FxRateRecord,
  type FxRateRepository,
  type ConfirmationRepository,
  type ConversationRepository,
  type JobLeaseRepository,
  type OfferRepository,
  type PaymentRepository,
  type PaymentUpdate,
  type ProcessedEventRepository,
  type Repositories,
  type Session,
  type SessionRepository,
  type NotificationRecord,
  type NotificationRepository,
  type OtpChallengeRecord,
  type OtpChallengeRepository,
  type SupportTicketRecord,
  type SupportTicketRepository,
  type TicketNoteRecord,
  type TicketUpdate,
  type TravellerRecord,
  type TravellerRepository,
} from '../types.js';
import type { Db } from './client.js';
import {
  ConfirmationPayloadSchema,
  ContactSchema,
  FlightOfferSchema,
  MessagesSchema,
  PassengersSchema,
  toJsonValue,
} from './codecs.js';

const isUniqueViolation = (err: unknown): boolean => err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';

/** Name of the violated unique index, as reported by the pg driver adapter (Prisma 7). */
function violatedIndex(err: unknown): string | undefined {
  if (!(err instanceof Prisma.PrismaClientKnownRequestError)) return undefined;
  const cause: unknown = (err.meta?.['driverAdapterError'] as { cause?: unknown } | undefined)?.cause;
  if (typeof cause !== 'object' || cause === null || !('constraint' in cause)) return undefined;
  const constraint: unknown = cause.constraint;
  if (typeof constraint !== 'object' || constraint === null || !('index' in constraint)) return undefined;
  return typeof constraint.index === 'string' ? constraint.index : undefined;
}
const iso = (d: Date): string => d.toISOString();

/**
 * Connection-level failures (database down, network, pool exhausted), as
 * opposed to query errors. Codes: https://www.prisma.io/docs/orm/reference/error-reference
 */
const UNAVAILABLE_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
export function isDatabaseUnavailable(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientInitializationError) return true;
  return err instanceof Prisma.PrismaClientKnownRequestError && UNAVAILABLE_CODES.has(err.code);
}

/** AAD for field encryption: binds ciphertext to its table, row and column. */
const aad = (table: string, id: string, column: string): string => `bluckflies:${table}:${id}:${column}`;

// ------------------------------------------------------------------ sessions

function sessionToDomain(r: SessionRow): Session {
  return {
    id: r.id,
    tokenHash: r.tokenHash,
    createdAt: iso(r.createdAt),
    lastSeenAt: iso(r.lastSeenAt),
    channel: r.channel,
    ...(r.channelKey ? { channelKey: r.channelKey } : {}),
    ...(r.travellerId ? { travellerId: r.travellerId } : {}),
    ...(r.revokedAt ? { revokedAt: iso(r.revokedAt) } : {}),
  };
}

export class PrismaSessionRepository implements SessionRepository {
  constructor(private readonly db: Db) {}

  async create(s: Session): Promise<void> {
    try {
      await this.db.session.create({
        data: {
          id: s.id,
          tokenHash: s.tokenHash,
          channel: s.channel ?? 'web',
          channelKey: s.channelKey ?? null,
          travellerId: s.travellerId ?? null,
          createdAt: new Date(s.createdAt),
          lastSeenAt: new Date(s.lastSeenAt),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateKeyError(violatedIndex(err) === 'sessions_channel_key_key' ? 'channelKey' : 'tokenHash');
      throw err;
    }
  }

  async findByTokenHash(tokenHash: string): Promise<Session | undefined> {
    const r = await this.db.session.findUnique({ where: { tokenHash } });
    return r && !r.revokedAt ? sessionToDomain(r) : undefined;
  }

  async findById(id: string): Promise<Session | undefined> {
    const r = await this.db.session.findUnique({ where: { id } });
    return r ? sessionToDomain(r) : undefined;
  }

  async findByChannelKey(channelKey: string): Promise<Session | undefined> {
    const r = await this.db.session.findUnique({ where: { channelKey } });
    return r ? sessionToDomain(r) : undefined;
  }

  async setTraveller(id: string, travellerId: string): Promise<void> {
    await this.db.session.update({ where: { id }, data: { travellerId } });
  }

  async revoke(id: string, at: string): Promise<void> {
    await this.db.session.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(at) } });
  }

  async touch(id: string, at: string): Promise<void> {
    // Skip the write when seen within the last minute, to avoid a write per request.
    const atDate = new Date(at);
    await this.db.session.updateMany({ where: { id, lastSeenAt: { lt: new Date(atDate.getTime() - 60_000) } }, data: { lastSeenAt: atDate } });
  }

  async deleteIdleSince(before: Date): Promise<number> {
    const r = await this.db.session.deleteMany({ where: { lastSeenAt: { lt: before }, bookings: { none: {} }, tickets: { none: {} } } });
    return r.count;
  }
}

// -------------------------------------------------------------------- offers

export class PrismaOfferRepository implements OfferRepository {
  constructor(private readonly db: Db) {}

  async saveMany(sessionId: string, offers: readonly FlightOffer[]): Promise<void> {
    if (offers.length === 0) return;
    await this.db.offer.createMany({
      data: offers.map((o) => ({ id: o.id, sessionId, data: toJsonValue(o), expiresAt: new Date(o.expiresAt) })),
      skipDuplicates: true,
    });
  }

  async find(sessionId: string, offerId: string): Promise<FlightOffer | undefined> {
    const r = await this.db.offer.findFirst({ where: { id: offerId, sessionId } });
    return r ? FlightOfferSchema.parse(r.data) : undefined;
  }

  async deleteExpiredBefore(at: Date): Promise<number> {
    return (await this.db.offer.deleteMany({ where: { expiresAt: { lt: at } } })).count;
  }
}

// ------------------------------------------------------------------ bookings

export class PrismaBookingRepository implements BookingRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
  ) {}

  async insert(b: Booking): Promise<void> {
    try {
      await this.db.booking.create({
        data: {
          id: b.id,
          pnr: b.pnr,
          ownerSessionId: b.ownerSessionId,
          travellerId: b.travellerId ?? null,
          status: b.status,
          offer: toJsonValue(b.offer),
          totalAmountCents: b.offer.totalPrice.amountCents,
          currency: b.offer.totalPrice.currency,
          passengersEnc: this.cipher.encrypt(JSON.stringify(b.passengers), aad('bookings', b.id, 'passengers')),
          contactEnc: this.cipher.encrypt(JSON.stringify(b.contact), aad('bookings', b.id, 'contact')),
          holdExpiresAt: new Date(b.holdExpiresAt),
          ticketNumbers: [...b.ticketNumbers],
          supplierReference: b.supplierReference,
          createdAt: new Date(b.createdAt),
          updatedAt: new Date(b.updatedAt),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateKeyError('pnr');
      throw err;
    }
  }

  async findById(id: string): Promise<Booking | undefined> {
    const r = await this.db.booking.findUnique({ where: { id } });
    return r ? this.toDomain(r) : undefined;
  }

  async findByIds(ids: readonly string[]): Promise<Booking[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.booking.findMany({ where: { id: { in: [...new Set(ids)] } } });
    return rows.map((r) => this.toDomain(r));
  }

  async findByPnr(pnr: string): Promise<Booking | undefined> {
    const r = await this.db.booking.findUnique({ where: { pnr: pnr.toUpperCase() } });
    return r ? this.toDomain(r) : undefined;
  }

  async listBySession(sessionId: string): Promise<Booking[]> {
    const rows = await this.db.booking.findMany({ where: { ownerSessionId: sessionId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => this.toDomain(r));
  }

  async listByTraveller(travellerId: string): Promise<Booking[]> {
    const rows = await this.db.booking.findMany({ where: { travellerId }, orderBy: { createdAt: 'desc' }, take: 100 });
    return rows.map((r) => this.toDomain(r));
  }

  async assignTraveller(sessionId: string, travellerId: string): Promise<number> {
    return (await this.db.booking.updateMany({ where: { ownerSessionId: sessionId, travellerId: null }, data: { travellerId } })).count;
  }

  async findRecentByStatus(statuses: readonly Booking['status'][], since: Date, limit: number): Promise<Booking[]> {
    const rows = await this.db.booking.findMany({ where: { status: { in: [...statuses] }, updatedAt: { gte: since } }, orderBy: { updatedAt: 'asc' }, take: limit });
    return rows.map((r) => this.toDomain(r));
  }

  async transition(id: string, expected: readonly Booking['status'][], update: BookingUpdate): Promise<Booking | undefined> {
    // Single UPDATE … WHERE status IN (…) RETURNING: atomic across instances.
    const [row] = await this.db.booking.updateManyAndReturn({
      where: { id, status: { in: [...expected] } },
      data: {
        status: update.status,
        updatedAt: new Date(update.updatedAt),
        ...(update.ticketNumbers ? { ticketNumbers: [...update.ticketNumbers] } : {}),
        ...(update.supplierReference ? { supplierReference: update.supplierReference } : {}),
      },
    });
    return row ? this.toDomain(row) : undefined;
  }

  async findBySupplierReference(provider: string, supplierReference: string): Promise<Booking | undefined> {
    const rows = await this.db.booking.findMany({ where: { supplierReference }, take: 5 });
    const match = rows.map((r) => this.toDomain(r)).find((b) => b.offer.provider === provider);
    return match;
  }

  async findLapsedHolds(at: Date, limit: number): Promise<Booking[]> {
    const rows = await this.db.booking.findMany({
      where: { status: { in: ['held', 'payment_pending'] }, holdExpiresAt: { lte: at } },
      orderBy: { holdExpiresAt: 'asc' },
      take: limit,
    });
    return rows.map((r) => this.toDomain(r));
  }

  async findStuckTicketing(before: Date, limit: number): Promise<Booking[]> {
    const rows = await this.db.booking.findMany({ where: { status: 'ticketing', updatedAt: { lt: before } }, orderBy: { updatedAt: 'asc' }, take: limit });
    return rows.map((r) => this.toDomain(r));
  }

  private toDomain(r: BookingRow): Booking {
    return {
      id: r.id,
      pnr: r.pnr,
      ownerSessionId: r.ownerSessionId,
      ...(r.travellerId ? { travellerId: r.travellerId } : {}),
      offer: FlightOfferSchema.parse(r.offer),
      passengers: PassengersSchema.parse(JSON.parse(this.cipher.decrypt(r.passengersEnc, aad('bookings', r.id, 'passengers')))),
      contact: ContactSchema.parse(JSON.parse(this.cipher.decrypt(r.contactEnc, aad('bookings', r.id, 'contact')))),
      status: r.status,
      holdExpiresAt: iso(r.holdExpiresAt),
      ticketNumbers: r.ticketNumbers,
      supplierReference: r.supplierReference,
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  }
}

// ------------------------------------------------------------------ payments

function paymentToDomain(r: PaymentRow): Payment {
  if (r.currency !== 'USD') throw new Error(`Payment ${r.id} has unsupported currency ${r.currency}`);
  return {
    id: r.id,
    bookingId: r.bookingId,
    method: r.method,
    provider: r.provider,
    amount: { amountCents: r.amountCents, currency: 'USD' },
    charge: { amountMinor: r.chargeAmountMinor, currency: r.chargeCurrency },
    ...(r.fxPerUsd !== null && r.fxAsOf && r.fxSource !== null && r.fxMarkupBps !== null
      ? { fx: { currency: r.chargeCurrency, perUsd: formatRate(parseRate(r.fxPerUsd.toString())), asOf: iso(r.fxAsOf), source: r.fxSource, markupBps: r.fxMarkupBps } }
      : {}),
    status: r.status,
    providerReference: r.providerReference,
    ...(r.refundReference ? { refundReference: r.refundReference } : {}),
    approvalInstructions: r.approvalInstructions,
    ...(r.checkoutUrl ? { checkoutUrl: r.checkoutUrl } : {}),
    idempotencyKey: r.idempotencyKey,
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    ...(r.paidAt ? { paidAt: iso(r.paidAt) } : {}),
    ...(r.refundedAt ? { refundedAt: iso(r.refundedAt) } : {}),
  };
}

export class PrismaPaymentRepository implements PaymentRepository {
  constructor(private readonly db: Db) {}

  async insertIfAbsent(p: Payment): Promise<{ payment: Payment; created: boolean }> {
    try {
      const row = await this.db.payment.create({
        data: {
          id: p.id,
          bookingId: p.bookingId,
          method: p.method,
          provider: p.provider,
          amountCents: p.amount.amountCents,
          currency: p.amount.currency,
          chargeAmountMinor: p.charge.amountMinor,
          chargeCurrency: p.charge.currency,
          ...(p.fx ? { fxPerUsd: p.fx.perUsd, fxAsOf: new Date(p.fx.asOf), fxSource: p.fx.source, fxMarkupBps: p.fx.markupBps } : {}),
          status: p.status,
          providerReference: p.providerReference,
          refundReference: p.refundReference ?? null,
          approvalInstructions: p.approvalInstructions,
          checkoutUrl: p.checkoutUrl ?? null,
          idempotencyKey: p.idempotencyKey,
          createdAt: new Date(p.createdAt),
          updatedAt: new Date(p.updatedAt),
        },
      });
      return { payment: paymentToDomain(row), created: true };
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const existing = await this.db.payment.findUnique({ where: { idempotencyKey: p.idempotencyKey } });
      if (existing) return { payment: paymentToDomain(existing), created: false };
      throw new DuplicateKeyError(violatedIndex(err) === 'payments_one_open_request_per_booking' ? 'openPaymentRequest' : 'providerReference');
    }
  }

  async findByProviderReference(ref: string): Promise<Payment | undefined> {
    const r = await this.db.payment.findUnique({ where: { providerReference: ref } });
    return r ? paymentToDomain(r) : undefined;
  }

  async findLatestForBooking(bookingId: string): Promise<Payment | undefined> {
    const r = await this.db.payment.findFirst({ where: { bookingId }, orderBy: { seq: 'desc' } });
    return r ? paymentToDomain(r) : undefined;
  }

  async transition(id: string, expected: readonly Payment['status'][], update: PaymentUpdate): Promise<Payment | undefined> {
    const [row] = await this.db.payment.updateManyAndReturn({
      where: { id, status: { in: [...expected] } },
      data: {
        status: update.status,
        updatedAt: new Date(update.updatedAt),
        ...(update.refundReference ? { refundReference: update.refundReference } : {}),
        ...(update.status === 'succeeded' ? { paidAt: new Date(update.updatedAt) } : {}),
        ...(update.status === 'refunded' ? { refundedAt: new Date(update.updatedAt) } : {}),
      },
    });
    return row ? paymentToDomain(row) : undefined;
  }

  async findByStatus(statuses: readonly Payment['status'][], limit: number): Promise<Payment[]> {
    const rows = await this.db.payment.findMany({ where: { status: { in: [...statuses] } }, orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: limit });
    return rows.map(paymentToDomain);
  }

  async findStale(statuses: readonly Payment['status'][], provider: string, before: Date, limit: number): Promise<Payment[]> {
    const rows = await this.db.payment.findMany({
      where: { status: { in: [...statuses] }, provider, updatedAt: { lt: before } },
      orderBy: { updatedAt: 'asc' },
      take: limit,
    });
    return rows.map(paymentToDomain);
  }

  async listActiveBetween(from: Date, to: Date, limit: number): Promise<Payment[]> {
    const rows = await this.db.payment.findMany({
      where: {
        OR: [{ createdAt: { gte: from, lt: to } }, { updatedAt: { gte: from, lt: to } }, { paidAt: { gte: from, lt: to } }, { refundedAt: { gte: from, lt: to } }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
    return rows.map(paymentToDomain);
  }

  async findRecentByMethod(method: Payment['method'], since: Date, limit: number): Promise<Payment[]> {
    const rows = await this.db.payment.findMany({ where: { method, createdAt: { gte: since } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: limit });
    return rows.map(paymentToDomain);
  }
}

// ------------------------------------------------------------- confirmations

export class PrismaConfirmationRepository implements ConfirmationRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
  ) {}

  async insert(c: PendingConfirmation): Promise<void> {
    await this.db.confirmation.create({
      data: {
        id: c.id,
        sessionId: c.sessionId,
        kind: c.kind,
        summary: c.summary,
        payloadEnc: this.cipher.encrypt(JSON.stringify(c.payload), aad('confirmations', c.id, 'payload')),
        expiresAt: new Date(c.expiresAt),
        status: c.status,
      },
    });
  }

  async find(id: string): Promise<PendingConfirmation | undefined> {
    const r = await this.db.confirmation.findUnique({ where: { id } });
    return r ? this.toDomain(r) : undefined;
  }

  async transition(id: string, expected: PendingConfirmation['status'], next: PendingConfirmation['status']): Promise<PendingConfirmation | undefined> {
    const [row] = await this.db.confirmation.updateManyAndReturn({ where: { id, status: expected }, data: { status: next } });
    return row ? this.toDomain(row) : undefined;
  }

  async listPending(sessionId: string): Promise<PendingConfirmation[]> {
    const rows = await this.db.confirmation.findMany({ where: { sessionId, status: 'pending' }, orderBy: { createdAt: 'asc' }, take: 20 });
    return rows.map((r) => this.toDomain(r));
  }

  async expireStale(at: Date): Promise<number> {
    return (await this.db.confirmation.updateMany({ where: { status: 'pending', expiresAt: { lte: at } }, data: { status: 'expired' } })).count;
  }

  private toDomain(r: ConfirmationRow): PendingConfirmation {
    return {
      id: r.id,
      sessionId: r.sessionId,
      kind: r.kind,
      summary: r.summary,
      payload: ConfirmationPayloadSchema.parse(JSON.parse(this.cipher.decrypt(r.payloadEnc, aad('confirmations', r.id, 'payload')))),
      expiresAt: iso(r.expiresAt),
      status: r.status,
    };
  }
}

// ---------------------------------------------------------------- the rest

export class PrismaProcessedEventRepository implements ProcessedEventRepository {
  constructor(private readonly db: Db) {}
  async markIfNew(eventId: string): Promise<boolean> {
    try {
      await this.db.processedEvent.create({ data: { id: eventId } });
      return true;
    } catch (err) {
      if (isUniqueViolation(err)) return false;
      throw err;
    }
  }
  async deleteOlderThan(at: Date): Promise<number> {
    return (await this.db.processedEvent.deleteMany({ where: { processedAt: { lt: at } } })).count;
  }
}

export class PrismaConversationRepository implements ConversationRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
  ) {}
  async load(sessionId: string): Promise<unknown[]> {
    const r = await this.db.conversation.findUnique({ where: { sessionId } });
    if (!r) return [];
    return MessagesSchema.parse(JSON.parse(this.cipher.decrypt(r.messagesEnc, aad('conversations', sessionId, 'messages'))));
  }
  async save(sessionId: string, messages: unknown[]): Promise<void> {
    const messagesEnc = this.cipher.encrypt(JSON.stringify(messages), aad('conversations', sessionId, 'messages'));
    await this.db.conversation.upsert({ where: { sessionId }, create: { sessionId, messagesEnc }, update: { messagesEnc } });
  }
  async deleteNotUpdatedSince(before: Date): Promise<number> {
    return (await this.db.conversation.deleteMany({ where: { updatedAt: { lt: before } } })).count;
  }
}

export class PrismaSupportTicketRepository implements SupportTicketRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
  ) {}
  private readonly toDomain = (r: SupportTicketRow): SupportTicketRecord => ({
    id: r.id,
    sessionId: r.sessionId,
    reason: r.reason,
    summary: r.summary,
    status: r.status,
    ...(r.assignee ? { assignee: r.assignee } : {}),
    ...(r.bookingId ? { bookingId: r.bookingId } : {}),
    ...(r.contactPhoneEnc ? { contactPhone: this.cipher.decrypt(r.contactPhoneEnc, aad('support_tickets', r.id, 'contact_phone')) } : {}),
    createdAt: iso(r.createdAt),
    updatedAt: iso(r.updatedAt),
    ...(r.resolvedAt ? { resolvedAt: iso(r.resolvedAt) } : {}),
  });
  async insert(t: SupportTicketRecord): Promise<void> {
    await this.db.supportTicket.create({
      data: {
        id: t.id,
        sessionId: t.sessionId,
        reason: t.reason,
        summary: t.summary,
        status: t.status,
        assignee: t.assignee ?? null,
        bookingId: t.bookingId ?? null,
        contactPhoneEnc: t.contactPhone ? this.cipher.encrypt(t.contactPhone, aad('support_tickets', t.id, 'contact_phone')) : null,
        createdAt: new Date(t.createdAt),
        updatedAt: new Date(t.updatedAt),
        resolvedAt: t.resolvedAt ? new Date(t.resolvedAt) : null,
      },
    });
  }
  async find(id: string): Promise<SupportTicketRecord | undefined> {
    const r = await this.db.supportTicket.findUnique({ where: { id } });
    return r ? this.toDomain(r) : undefined;
  }
  async list(filter: { status?: SupportTicketRecord['status']; limit: number }): Promise<SupportTicketRecord[]> {
    const rows = await this.db.supportTicket.findMany({
      where: filter.status ? { status: filter.status } : {},
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: filter.limit,
    });
    return rows.map(this.toDomain);
  }
  async update(id: string, u: TicketUpdate): Promise<SupportTicketRecord | undefined> {
    const at = new Date(u.updatedAt);
    const [row] = await this.db.supportTicket.updateManyAndReturn({
      where: { id },
      data: {
        updatedAt: at,
        ...(u.status ? { status: u.status, resolvedAt: u.status === 'resolved' ? at : null } : {}),
        ...(u.assignee !== undefined ? { assignee: u.assignee } : {}),
      },
    });
    return row ? this.toDomain(row) : undefined;
  }
  async addNote(n: TicketNoteRecord): Promise<void> {
    await this.db.ticketNote.create({ data: { id: n.id, ticketId: n.ticketId, author: n.author, body: n.body, createdAt: new Date(n.createdAt) } });
  }
  async notes(ticketId: string): Promise<TicketNoteRecord[]> {
    const rows = await this.db.ticketNote.findMany({ where: { ticketId }, orderBy: { seq: 'asc' }, take: 500 });
    return rows.map((r) => ({ id: r.id, ticketId: r.ticketId, author: r.author, body: r.body, createdAt: iso(r.createdAt) }));
  }
}

// ------------------------------------------------------------------ accounts

export class PrismaTravellerRepository implements TravellerRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
  ) {}
  private toDomain(r: TravellerRow): TravellerRecord {
    return { id: r.id, phone: this.cipher.decrypt(r.phoneEnc, aad('travellers', r.id, 'phone')), createdAt: iso(r.createdAt), lastLoginAt: iso(r.lastLoginAt) };
  }
  async upsertByPhone(input: { id: string; phoneHash: string; phone: string; at: string }): Promise<TravellerRecord> {
    const at = new Date(input.at);
    // ON CONFLICT keeps the first account for a number even if two logins race.
    const r = await this.db.traveller.upsert({
      where: { phoneHash: input.phoneHash },
      create: { id: input.id, phoneHash: input.phoneHash, phoneEnc: this.cipher.encrypt(input.phone, aad('travellers', input.id, 'phone')), createdAt: at, lastLoginAt: at },
      update: { lastLoginAt: at },
    });
    return this.toDomain(r);
  }
  async findById(id: string): Promise<TravellerRecord | undefined> {
    const r = await this.db.traveller.findUnique({ where: { id } });
    return r ? this.toDomain(r) : undefined;
  }
}

export class PrismaOtpChallengeRepository implements OtpChallengeRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
  ) {}
  private toDomain(r: OtpChallengeRow): OtpChallengeRecord {
    return {
      id: r.id,
      sessionId: r.sessionId,
      phoneHash: r.phoneHash,
      phone: this.cipher.decrypt(r.phoneEnc, aad('otp_challenges', r.id, 'phone')),
      codeHash: r.codeHash,
      attempts: r.attempts,
      expiresAt: iso(r.expiresAt),
      ...(r.consumedAt ? { consumedAt: iso(r.consumedAt) } : {}),
      createdAt: iso(r.createdAt),
    };
  }
  async insert(c: OtpChallengeRecord): Promise<void> {
    await this.db.otpChallenge.create({
      data: {
        id: c.id,
        sessionId: c.sessionId,
        phoneHash: c.phoneHash,
        phoneEnc: this.cipher.encrypt(c.phone, aad('otp_challenges', c.id, 'phone')),
        codeHash: c.codeHash,
        attempts: c.attempts,
        expiresAt: new Date(c.expiresAt),
        createdAt: new Date(c.createdAt),
      },
    });
  }
  async find(id: string): Promise<OtpChallengeRecord | undefined> {
    const r = await this.db.otpChallenge.findUnique({ where: { id } });
    return r ? this.toDomain(r) : undefined;
  }
  async countSince(phoneHash: string, since: Date): Promise<number> {
    return this.db.otpChallenge.count({ where: { phoneHash, createdAt: { gte: since } } });
  }
  async recordFailure(id: string, max: number): Promise<number | undefined> {
    // Conditional increment: concurrent guesses cannot exceed the limit.
    const [row] = await this.db.otpChallenge.updateManyAndReturn({ where: { id, consumedAt: null, attempts: { lt: max } }, data: { attempts: { increment: 1 } } });
    return row?.attempts;
  }
  async consume(id: string, at: string): Promise<boolean> {
    return (await this.db.otpChallenge.updateMany({ where: { id, consumedAt: null }, data: { consumedAt: new Date(at) } })).count === 1;
  }
  async deleteExpiredBefore(at: Date): Promise<number> {
    return (await this.db.otpChallenge.deleteMany({ where: { expiresAt: { lt: at } } })).count;
  }
}

// -------------------------------------------------------------------- outbox

export class PrismaNotificationRepository implements NotificationRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
  ) {}
  private toDomain(r: NotificationRow): NotificationRecord {
    return {
      id: r.id,
      dedupeKey: r.dedupeKey,
      channel: r.channel,
      recipient: this.cipher.decrypt(r.recipientEnc, aad('notifications', r.id, 'recipient')),
      subject: r.subject,
      body: this.cipher.decrypt(r.bodyEnc, aad('notifications', r.id, 'body')),
      status: r.status,
      attempts: r.attempts,
      nextAttemptAt: iso(r.nextAttemptAt),
      ...(r.lastError ? { lastError: r.lastError } : {}),
      createdAt: iso(r.createdAt),
      ...(r.sentAt ? { sentAt: iso(r.sentAt) } : {}),
    };
  }
  async enqueue(n: NotificationRecord): Promise<boolean> {
    const rows = await this.db.notification.createManyAndReturn({
      data: [
        {
          id: n.id,
          dedupeKey: n.dedupeKey,
          channel: n.channel,
          recipientEnc: this.cipher.encrypt(n.recipient, aad('notifications', n.id, 'recipient')),
          subject: n.subject,
          bodyEnc: this.cipher.encrypt(n.body, aad('notifications', n.id, 'body')),
          status: n.status,
          attempts: n.attempts,
          nextAttemptAt: new Date(n.nextAttemptAt),
          createdAt: new Date(n.createdAt),
        },
      ],
      skipDuplicates: true, // ON CONFLICT DO NOTHING on dedupe_key
    });
    return rows.length === 1;
  }
  async due(now: Date, limit: number): Promise<NotificationRecord[]> {
    const rows = await this.db.notification.findMany({ where: { status: 'pending', nextAttemptAt: { lte: now } }, orderBy: { nextAttemptAt: 'asc' }, take: limit });
    return rows.map((r) => this.toDomain(r));
  }
  async markSent(id: string, at: string): Promise<void> {
    await this.db.notification.updateMany({ where: { id, status: 'pending' }, data: { status: 'sent', sentAt: new Date(at) } });
  }
  async markAttemptFailed(id: string, i: { attempts: number; nextAttemptAt: string; error: string; final: boolean }): Promise<void> {
    await this.db.notification.updateMany({
      where: { id, status: 'pending' },
      data: { attempts: i.attempts, nextAttemptAt: new Date(i.nextAttemptAt), lastError: i.error.slice(0, 500), status: i.final ? 'failed' : 'pending' },
    });
  }
  async existingKeys(keys: readonly string[]): Promise<Set<string>> {
    if (keys.length === 0) return new Set();
    const rows = await this.db.notification.findMany({ where: { dedupeKey: { in: [...keys] } }, select: { dedupeKey: true } });
    return new Set(rows.map((r) => r.dedupeKey));
  }
  async deleteFinishedBefore(at: Date): Promise<number> {
    return (await this.db.notification.deleteMany({ where: { status: { in: ['sent', 'failed'] }, createdAt: { lt: at } } })).count;
  }
}

export class PrismaJobLeaseRepository implements JobLeaseRepository {
  constructor(private readonly db: Db) {}
  async tryAcquire(name: string, owner: string, until: Date, now: Date): Promise<boolean> {
    // Atomic take-or-renew: succeeds if the lease is free, expired, or already ours.
    const rows = await this.db.$queryRaw<Array<{ name: string }>>`
      INSERT INTO job_leases (name, owner, lease_until) VALUES (${name}, ${owner}, ${until})
      ON CONFLICT (name) DO UPDATE SET owner = EXCLUDED.owner, lease_until = EXCLUDED.lease_until
      WHERE job_leases.lease_until < ${now} OR job_leases.owner = EXCLUDED.owner
      RETURNING name`;
    return rows.length === 1;
  }
  async release(name: string, owner: string): Promise<void> {
    await this.db.jobLease.deleteMany({ where: { name, owner } });
  }
}

export class PrismaFxRateRepository implements FxRateRepository {
  constructor(private readonly db: Db) {}
  private toRecord = (r: { currency: string; perUsd: { toString(): string }; asOf: Date; source: string }): FxRateRecord => ({
    currency: r.currency,
    perUsd: formatRate(parseRate(r.perUsd.toString())),
    asOf: iso(r.asOf),
    source: r.source,
  });
  async insert(rate: FxRateRecord): Promise<void> {
    await this.db.fxRate.create({ data: { currency: rate.currency, perUsd: rate.perUsd, asOf: new Date(rate.asOf), source: rate.source } });
  }
  async latest(currency: string): Promise<FxRateRecord | undefined> {
    const r = await this.db.fxRate.findFirst({ where: { currency }, orderBy: [{ asOf: 'desc' }, { id: 'desc' }] });
    return r ? this.toRecord(r) : undefined;
  }
  async history(currency: string, limit: number): Promise<FxRateRecord[]> {
    const rows = await this.db.fxRate.findMany({ where: { currency }, orderBy: [{ asOf: 'desc' }, { id: 'desc' }], take: limit });
    return rows.map(this.toRecord);
  }
}

// ------------------------------------------------------------------ staff

export class PrismaStaffRepository implements StaffRepository {
  constructor(
    private readonly db: Db,
    private readonly cipher: FieldCipher,
  ) {}
  private toDomain(r: StaffUserRow): StaffUserRecord {
    return {
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      passwordHash: r.passwordHash,
      ...(r.totpSecretEnc ? { totpSecret: this.cipher.decrypt(r.totpSecretEnc, aad('staff_users', r.id, 'totp_secret')) } : {}),
      ...(r.totpEnabledAt ? { totpEnabledAt: iso(r.totpEnabledAt) } : {}),
      ...(r.totpLastStep !== null ? { totpLastStep: Number(r.totpLastStep) } : {}),
      failedLogins: r.failedLogins,
      ...(r.lockedUntil ? { lockedUntil: iso(r.lockedUntil) } : {}),
      ...(r.disabledAt ? { disabledAt: iso(r.disabledAt) } : {}),
      createdAt: iso(r.createdAt),
      updatedAt: iso(r.updatedAt),
    };
  }
  private sessionToDomain(r: StaffSessionRow): StaffSessionRecord {
    return {
      id: r.id,
      staffId: r.staffId,
      tokenHash: r.tokenHash,
      createdAt: iso(r.createdAt),
      lastSeenAt: iso(r.lastSeenAt),
      expiresAt: iso(r.expiresAt),
      ...(r.revokedAt ? { revokedAt: iso(r.revokedAt) } : {}),
    };
  }
  async insert(u: StaffUserRecord): Promise<void> {
    try {
      await this.db.staffUser.create({
        data: {
          id: u.id,
          email: u.email,
          name: u.name,
          role: u.role,
          passwordHash: u.passwordHash,
          ...(u.totpSecret ? { totpSecretEnc: this.cipher.encrypt(u.totpSecret, aad('staff_users', u.id, 'totp_secret')) } : {}),
          failedLogins: u.failedLogins,
          createdAt: new Date(u.createdAt),
          updatedAt: new Date(u.updatedAt),
        },
      });
    } catch (err) {
      if (isUniqueViolation(err)) throw new DuplicateKeyError('email');
      throw err;
    }
  }
  async findById(id: string) {
    const r = await this.db.staffUser.findUnique({ where: { id } });
    return r ? this.toDomain(r) : undefined;
  }
  async findByEmail(email: string) {
    const r = await this.db.staffUser.findUnique({ where: { email } });
    return r ? this.toDomain(r) : undefined;
  }
  async list() {
    return (await this.db.staffUser.findMany({ orderBy: { name: 'asc' } })).map((r) => this.toDomain(r));
  }
  async count() {
    return this.db.staffUser.count();
  }
  async update(id: string, p: StaffUserPatch) {
    const date = (v: string | null): Date | null => (v === null ? null : new Date(v));
    try {
      const r = await this.db.staffUser.update({
        where: { id },
        data: {
          ...(p.name !== undefined ? { name: p.name } : {}),
          ...(p.role !== undefined ? { role: p.role } : {}),
          ...(p.passwordHash !== undefined ? { passwordHash: p.passwordHash } : {}),
          ...(p.failedLogins !== undefined ? { failedLogins: p.failedLogins } : {}),
          ...(p.totpLastStep !== undefined ? { totpLastStep: BigInt(p.totpLastStep) } : {}),
          ...(p.totpSecret !== undefined ? { totpSecretEnc: p.totpSecret === null ? null : this.cipher.encrypt(p.totpSecret, aad('staff_users', id, 'totp_secret')) } : {}),
          ...(p.totpEnabledAt !== undefined ? { totpEnabledAt: date(p.totpEnabledAt) } : {}),
          ...(p.lockedUntil !== undefined ? { lockedUntil: date(p.lockedUntil) } : {}),
          ...(p.disabledAt !== undefined ? { disabledAt: date(p.disabledAt) } : {}),
          updatedAt: new Date(p.updatedAt),
        },
      });
      return this.toDomain(r);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2025') return undefined;
      throw err;
    }
  }
  async useTotpStep(id: string, step: number): Promise<boolean> {
    // Compare-and-set: only a newer step than the last accepted one is recorded.
    const { count } = await this.db.staffUser.updateMany({
      where: { id, OR: [{ totpLastStep: null }, { totpLastStep: { lt: BigInt(step) } }] },
      data: { totpLastStep: BigInt(step) },
    });
    return count === 1;
  }
  async insertSession(s: StaffSessionRecord): Promise<void> {
    await this.db.staffSession.create({
      data: { id: s.id, staffId: s.staffId, tokenHash: s.tokenHash, createdAt: new Date(s.createdAt), lastSeenAt: new Date(s.lastSeenAt), expiresAt: new Date(s.expiresAt) },
    });
  }
  async findSession(tokenHash: string) {
    const r = await this.db.staffSession.findFirst({ where: { tokenHash, revokedAt: null } });
    return r ? this.sessionToDomain(r) : undefined;
  }
  async touchSession(id: string, at: string) {
    await this.db.staffSession.updateMany({ where: { id }, data: { lastSeenAt: new Date(at) } });
  }
  async revokeSession(id: string, at: string) {
    await this.db.staffSession.updateMany({ where: { id, revokedAt: null }, data: { revokedAt: new Date(at) } });
  }
  async revokeAllSessions(staffId: string, at: string, keepSessionId?: string) {
    const { count } = await this.db.staffSession.updateMany({
      where: { staffId, revokedAt: null, ...(keepSessionId ? { id: { not: keepSessionId } } : {}) },
      data: { revokedAt: new Date(at) },
    });
    return count;
  }
  async deleteSessionsExpiredBefore(cutoff: Date) {
    const { count } = await this.db.staffSession.deleteMany({ where: { expiresAt: { lt: cutoff } } });
    return count;
  }
}

export class PrismaAgentUsageRepository implements AgentUsageRepository {
  constructor(private readonly db: Db) {}
  /** One statement, so concurrent turns on several servers add up without lost updates. */
  async add(e: AgentUsageEntry, at: string): Promise<void> {
    await this.db.$executeRaw`
      INSERT INTO agent_usage (day, session_id, calls, input_tokens, output_tokens, cache_write_tokens, cache_read_tokens, cost_micros, updated_at)
      VALUES (${e.day}::date, ${e.sessionId}, 1, ${e.inputTokens}, ${e.outputTokens}, ${e.cacheWriteTokens}, ${e.cacheReadTokens}, ${e.costMicros}, ${new Date(at)})
      ON CONFLICT (day, session_id) DO UPDATE SET
        calls = agent_usage.calls + 1,
        input_tokens = agent_usage.input_tokens + EXCLUDED.input_tokens,
        output_tokens = agent_usage.output_tokens + EXCLUDED.output_tokens,
        cache_write_tokens = agent_usage.cache_write_tokens + EXCLUDED.cache_write_tokens,
        cache_read_tokens = agent_usage.cache_read_tokens + EXCLUDED.cache_read_tokens,
        cost_micros = agent_usage.cost_micros + EXCLUDED.cost_micros,
        updated_at = EXCLUDED.updated_at`;
  }
  async dayCostMicros(day: string): Promise<number> {
    const r = await this.db.agentUsage.aggregate({ where: { day: new Date(`${day}T00:00:00Z`) }, _sum: { costMicros: true } });
    return Number(r._sum.costMicros ?? 0n);
  }
  async sessionCostMicros(sessionId: string, day: string): Promise<number> {
    const r = await this.db.agentUsage.findUnique({ where: { day_sessionId: { day: new Date(`${day}T00:00:00Z`), sessionId } }, select: { costMicros: true } });
    return Number(r?.costMicros ?? 0n);
  }
  async daily(fromDay: string, toDay: string): Promise<AgentUsageDay[]> {
    const rows = await this.db.agentUsage.groupBy({
      by: ['day'],
      where: { day: { gte: new Date(`${fromDay}T00:00:00Z`), lte: new Date(`${toDay}T00:00:00Z`) } },
      _sum: { calls: true, inputTokens: true, outputTokens: true, cacheWriteTokens: true, cacheReadTokens: true, costMicros: true },
      _count: { sessionId: true },
      orderBy: { day: 'asc' },
    });
    return rows.map((r) => ({
      day: r.day.toISOString().slice(0, 10),
      calls: r._sum.calls ?? 0,
      conversations: r._count.sessionId,
      inputTokens: Number(r._sum.inputTokens ?? 0n),
      outputTokens: Number(r._sum.outputTokens ?? 0n),
      cacheWriteTokens: Number(r._sum.cacheWriteTokens ?? 0n),
      cacheReadTokens: Number(r._sum.cacheReadTokens ?? 0n),
      costMicros: Number(r._sum.costMicros ?? 0n),
    }));
  }
}

/**
 * Fixed windows in one statement: the first hit (or the first after the window
 * ended) starts a new window at 1; later hits increment. Concurrent requests on
 * different servers serialise on the row, so none is lost.
 */
export class PrismaRateLimitStore implements RateLimitStore {
  constructor(private readonly db: Db) {}
  async hit(keyHash: string, windowMs: number, now: Date): Promise<RateLimitHit> {
    const resetAt = new Date(now.getTime() + windowMs);
    const rows = await this.db.$queryRaw<Array<{ count: number; reset_at: Date }>>`
      INSERT INTO rate_limits (key_hash, count, reset_at) VALUES (${keyHash}, 1, ${resetAt})
      ON CONFLICT (key_hash) DO UPDATE SET
        count = CASE WHEN rate_limits.reset_at <= ${now} THEN 1 ELSE rate_limits.count + 1 END,
        reset_at = CASE WHEN rate_limits.reset_at <= ${now} THEN EXCLUDED.reset_at ELSE rate_limits.reset_at END
      RETURNING count, reset_at`;
    const r = rows[0];
    if (!r) throw new Error('rate_limits upsert returned no row');
    return { count: r.count, resetAt: r.reset_at };
  }
  async deleteExpired(before: Date): Promise<number> {
    return (await this.db.rateLimit.deleteMany({ where: { resetAt: { lte: before } } })).count;
  }
}

export function createPrismaRepositories(db: Db, cipher: FieldCipher): Repositories {
  return {
    sessions: new PrismaSessionRepository(db),
    offers: new PrismaOfferRepository(db),
    bookings: new PrismaBookingRepository(db, cipher),
    payments: new PrismaPaymentRepository(db),
    confirmations: new PrismaConfirmationRepository(db, cipher),
    events: new PrismaProcessedEventRepository(db),
    conversations: new PrismaConversationRepository(db, cipher),
    tickets: new PrismaSupportTicketRepository(db, cipher),
    travellers: new PrismaTravellerRepository(db, cipher),
    otp: new PrismaOtpChallengeRepository(db, cipher),
    notifications: new PrismaNotificationRepository(db, cipher),
    agentUsage: new PrismaAgentUsageRepository(db),
    rateLimits: new PrismaRateLimitStore(db),
    leases: new PrismaJobLeaseRepository(db),
    fx: new PrismaFxRateRepository(db),
    staff: new PrismaStaffRepository(db, cipher),
    // Reads a real table, so an unmigrated database fails readiness too.
    ping: async () => {
      await db.$queryRaw`SELECT 1 FROM job_leases LIMIT 1`;
    },
    isUnavailable: isDatabaseUnavailable,
    close: () => db.$disconnect(),
  };
}
