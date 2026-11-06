import { MemoryRateLimitStore } from '../lib/rateLimiter.js';
import type { Booking, FlightOffer, Payment, PendingConfirmation } from '../domain/types.js';
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
} from './types.js';

/**
 * In-memory repositories. Each method runs without awaiting between its read
 * and its write, so Node's single thread gives the compare-and-set semantics
 * the interfaces require. Data is lost on restart: development and tests only.
 */

const clone = <T>(v: T): T => structuredClone(v);

export class MemorySessionRepository implements SessionRepository {
  private readonly byHash = new Map<string, Session>();
  private byId(id: string) {
    return [...this.byHash.values()].find((s) => s.id === id);
  }
  async create(s: Session) {
    if (this.byHash.has(s.tokenHash)) throw new DuplicateKeyError('tokenHash');
    if (s.channelKey && [...this.byHash.values()].some((r) => r.channelKey === s.channelKey)) throw new DuplicateKeyError('channelKey');
    this.byHash.set(s.tokenHash, clone(s));
  }
  async findByTokenHash(h: string) {
    const s = this.byHash.get(h);
    return s && !s.revokedAt ? clone(s) : undefined;
  }
  async findById(id: string) {
    const s = this.byId(id);
    return s ? clone(s) : undefined;
  }
  async findByChannelKey(key: string) {
    const s = [...this.byHash.values()].find((r) => r.channelKey === key);
    return s ? clone(s) : undefined;
  }
  async setTraveller(id: string, travellerId: string) {
    const s = this.byId(id);
    if (s) s.travellerId = travellerId;
  }
  async revoke(id: string, at: string) {
    const s = this.byId(id);
    if (s && !s.revokedAt) s.revokedAt = at;
  }
  async touch(id: string, at: string) {
    const s = this.byId(id);
    if (s) s.lastSeenAt = at;
  }
  /** Memory store has no cross-table view; `hasRecords` is wired by createMemoryRepositories. */
  hasRecords: (sessionId: string) => boolean = () => true;
  async deleteIdleSince(before: Date) {
    let n = 0;
    for (const [hash, s] of this.byHash) {
      if (Date.parse(s.lastSeenAt) < before.getTime() && !this.hasRecords(s.id)) {
        this.byHash.delete(hash);
        n++;
      }
    }
    return n;
  }
}

export class MemoryOfferRepository implements OfferRepository {
  private readonly offers = new Map<string, { sessionId: string; offer: FlightOffer }>();
  async saveMany(sessionId: string, offers: readonly FlightOffer[]) {
    for (const offer of offers) this.offers.set(offer.id, { sessionId, offer: clone(offer) });
  }
  async find(sessionId: string, offerId: string) {
    const row = this.offers.get(offerId);
    return row && row.sessionId === sessionId ? clone(row.offer) : undefined;
  }
  async deleteExpiredBefore(at: Date) {
    let n = 0;
    for (const [id, row] of this.offers) {
      if (Date.parse(row.offer.expiresAt) < at.getTime()) {
        this.offers.delete(id);
        n++;
      }
    }
    return n;
  }
}

export class MemoryBookingRepository implements BookingRepository {
  private readonly rows = new Map<string, Booking>();
  async insert(b: Booking) {
    if (this.rows.has(b.id)) throw new DuplicateKeyError('id');
    if ([...this.rows.values()].some((r) => r.pnr === b.pnr)) throw new DuplicateKeyError('pnr');
    this.rows.set(b.id, clone(b));
  }
  async findById(id: string) {
    const b = this.rows.get(id);
    return b ? clone(b) : undefined;
  }
  async findByIds(ids: readonly string[]) {
    return ids.map((id) => this.rows.get(id)).filter((b): b is Booking => b !== undefined).map(clone);
  }
  async findByPnr(pnr: string) {
    const b = [...this.rows.values()].find((r) => r.pnr === pnr.toUpperCase());
    return b ? clone(b) : undefined;
  }
  async findBySupplierReference(provider: string, supplierReference: string) {
    const b = [...this.rows.values()].find((r) => r.supplierReference === supplierReference && r.offer.provider === provider);
    return b ? clone(b) : undefined;
  }
  ownedBy(sessionId: string): boolean {
    return [...this.rows.values()].some((b) => b.ownerSessionId === sessionId);
  }
  async listBySession(sessionId: string) {
    return [...this.rows.values()].filter((b) => b.ownerSessionId === sessionId).map(clone);
  }
  async listByTraveller(travellerId: string) {
    return [...this.rows.values()].filter((b) => b.travellerId === travellerId).map(clone);
  }
  async assignTraveller(sessionId: string, travellerId: string) {
    let n = 0;
    for (const b of this.rows.values()) {
      if (b.ownerSessionId === sessionId && !b.travellerId) {
        b.travellerId = travellerId;
        n++;
      }
    }
    return n;
  }
  async findRecentByStatus(statuses: readonly Booking['status'][], since: Date, limit: number) {
    return [...this.rows.values()]
      .filter((b) => statuses.includes(b.status) && Date.parse(b.updatedAt) >= since.getTime())
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit)
      .map(clone);
  }
  async transition(id: string, expected: readonly Booking['status'][], update: BookingUpdate) {
    const b = this.rows.get(id);
    if (!b || !expected.includes(b.status)) return undefined;
    Object.assign(b, clone(update));
    return clone(b);
  }
  async findLapsedHolds(at: Date, limit: number) {
    return [...this.rows.values()]
      .filter((b) => (b.status === 'held' || b.status === 'payment_pending') && Date.parse(b.holdExpiresAt) <= at.getTime())
      .sort((a, b) => a.holdExpiresAt.localeCompare(b.holdExpiresAt))
      .slice(0, limit)
      .map(clone);
  }
  async findStuckTicketing(before: Date, limit: number) {
    return [...this.rows.values()]
      .filter((b) => b.status === 'ticketing' && Date.parse(b.updatedAt) < before.getTime())
      .slice(0, limit)
      .map(clone);
  }
}

export class MemoryPaymentRepository implements PaymentRepository {
  private readonly rows = new Map<string, Payment>();
  async insertIfAbsent(p: Payment) {
    const existing = [...this.rows.values()].find((r) => r.idempotencyKey === p.idempotencyKey);
    if (existing) return { payment: clone(existing), created: false };
    // Mirrors the partial unique index payments_one_open_request_per_booking.
    if (p.status === 'requested' && [...this.rows.values()].some((r) => r.bookingId === p.bookingId && r.status === 'requested')) {
      throw new DuplicateKeyError('openPaymentRequest');
    }
    if ([...this.rows.values()].some((r) => r.providerReference === p.providerReference)) throw new DuplicateKeyError('providerReference');
    this.rows.set(p.id, clone(p));
    return { payment: clone(p), created: true };
  }
  async findByProviderReference(ref: string) {
    const p = [...this.rows.values()].find((r) => r.providerReference === ref);
    return p ? clone(p) : undefined;
  }
  async findLatestForBooking(bookingId: string) {
    // Insertion order (Map iteration), the in-memory equivalent of the `seq` column.
    const last = [...this.rows.values()].filter((r) => r.bookingId === bookingId).at(-1);
    return last ? clone(last) : undefined;
  }
  async transition(id: string, expected: readonly Payment['status'][], update: PaymentUpdate) {
    const p = this.rows.get(id);
    if (!p || !expected.includes(p.status)) return undefined;
    Object.assign(p, clone(update));
    if (update.status === 'succeeded') p.paidAt = update.updatedAt;
    if (update.status === 'refunded') p.refundedAt = update.updatedAt;
    return clone(p);
  }
  async findByStatus(statuses: readonly Payment['status'][], limit: number) {
    return [...this.rows.values()]
      .filter((p) => statuses.includes(p.status))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit)
      .map(clone);
  }
  async findStale(statuses: readonly Payment['status'][], provider: string, before: Date, limit: number) {
    return [...this.rows.values()]
      .filter((p) => statuses.includes(p.status) && p.provider === provider && Date.parse(p.updatedAt) < before.getTime())
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
      .slice(0, limit)
      .map(clone);
  }
  async listActiveBetween(from: Date, to: Date, limit: number) {
    const inRange = (iso: string) => Date.parse(iso) >= from.getTime() && Date.parse(iso) < to.getTime();
    return [...this.rows.values()]
      .filter((p) => inRange(p.createdAt) || inRange(p.updatedAt) || (p.paidAt !== undefined && inRange(p.paidAt)) || (p.refundedAt !== undefined && inRange(p.refundedAt)))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map(clone);
  }
  async findRecentByMethod(method: Payment['method'], since: Date, limit: number) {
    return [...this.rows.values()]
      .filter((p) => p.method === method && Date.parse(p.createdAt) >= since.getTime())
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(clone);
  }
}

export class MemoryConfirmationRepository implements ConfirmationRepository {
  private readonly rows = new Map<string, PendingConfirmation>();
  async insert(c: PendingConfirmation) {
    this.rows.set(c.id, clone(c));
  }
  async find(id: string) {
    const c = this.rows.get(id);
    return c ? clone(c) : undefined;
  }
  async transition(id: string, expected: PendingConfirmation['status'], next: PendingConfirmation['status']) {
    const c = this.rows.get(id);
    if (!c || c.status !== expected) return undefined;
    c.status = next;
    return clone(c);
  }
  async listPending(sessionId: string) {
    return [...this.rows.values()].filter((c) => c.sessionId === sessionId && c.status === 'pending').map(clone);
  }
  async expireStale(at: Date) {
    let n = 0;
    for (const c of this.rows.values()) {
      if (c.status === 'pending' && Date.parse(c.expiresAt) <= at.getTime()) {
        c.status = 'expired';
        n++;
      }
    }
    return n;
  }
}

export class MemoryProcessedEventRepository implements ProcessedEventRepository {
  private readonly seen = new Map<string, number>();
  async markIfNew(eventId: string) {
    if (this.seen.has(eventId)) return false;
    this.seen.set(eventId, Date.now());
    return true;
  }
  async deleteOlderThan(at: Date) {
    let n = 0;
    for (const [id, t] of this.seen) {
      if (t < at.getTime()) {
        this.seen.delete(id);
        n++;
      }
    }
    return n;
  }
}

export class MemoryConversationRepository implements ConversationRepository {
  private readonly rows = new Map<string, { messages: unknown[]; updatedAt: number }>();
  async load(sessionId: string) {
    return clone(this.rows.get(sessionId)?.messages ?? []);
  }
  async save(sessionId: string, messages: unknown[]) {
    this.rows.set(sessionId, { messages: clone(messages), updatedAt: Date.now() });
  }
  async deleteNotUpdatedSince(before: Date) {
    let n = 0;
    for (const [id, row] of this.rows) {
      if (row.updatedAt < before.getTime()) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

export class MemorySupportTicketRepository implements SupportTicketRepository {
  readonly rows: SupportTicketRecord[] = [];
  private readonly noteRows: TicketNoteRecord[] = [];
  async insert(t: SupportTicketRecord) {
    this.rows.push(clone(t));
  }
  async find(id: string) {
    const t = this.rows.find((r) => r.id === id);
    return t ? clone(t) : undefined;
  }
  async list(filter: { status?: SupportTicketRecord['status']; limit: number }) {
    return this.rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => !filter.status || r.status === filter.status)
      .sort((a, b) => b.r.createdAt.localeCompare(a.r.createdAt) || b.i - a.i)
      .slice(0, filter.limit)
      .map(({ r }) => clone(r));
  }
  async update(id: string, u: TicketUpdate) {
    const t = this.rows.find((r) => r.id === id);
    if (!t) return undefined;
    if (u.status) {
      t.status = u.status;
      if (u.status === 'resolved') t.resolvedAt = u.updatedAt;
      else delete t.resolvedAt;
    }
    if (u.assignee === null) delete t.assignee;
    else if (u.assignee !== undefined) t.assignee = u.assignee;
    t.updatedAt = u.updatedAt;
    return clone(t);
  }
  async addNote(note: TicketNoteRecord) {
    if (!this.rows.some((r) => r.id === note.ticketId)) throw new Error(`No ticket ${note.ticketId}`);
    this.noteRows.push(clone(note));
  }
  async notes(ticketId: string) {
    return this.noteRows.filter((n) => n.ticketId === ticketId).map(clone);
  }
}

export class MemoryTravellerRepository implements TravellerRepository {
  private readonly rows = new Map<string, { phoneHash: string; t: TravellerRecord }>();
  async upsertByPhone(input: { id: string; phoneHash: string; phone: string; at: string }) {
    const existing = [...this.rows.values()].find((r) => r.phoneHash === input.phoneHash);
    if (existing) {
      existing.t.lastLoginAt = input.at;
      return clone(existing.t);
    }
    const t: TravellerRecord = { id: input.id, phone: input.phone, createdAt: input.at, lastLoginAt: input.at };
    this.rows.set(input.id, { phoneHash: input.phoneHash, t });
    return clone(t);
  }
  async findById(id: string) {
    const r = this.rows.get(id);
    return r ? clone(r.t) : undefined;
  }
}

export class MemoryOtpChallengeRepository implements OtpChallengeRepository {
  private readonly rows = new Map<string, OtpChallengeRecord>();
  async insert(c: OtpChallengeRecord) {
    this.rows.set(c.id, clone(c));
  }
  async find(id: string) {
    const c = this.rows.get(id);
    return c ? clone(c) : undefined;
  }
  async countSince(phoneHash: string, since: Date) {
    return [...this.rows.values()].filter((c) => c.phoneHash === phoneHash && Date.parse(c.createdAt) >= since.getTime()).length;
  }
  async recordFailure(id: string, max: number) {
    const c = this.rows.get(id);
    if (!c || c.consumedAt || c.attempts >= max) return undefined;
    c.attempts += 1;
    return c.attempts;
  }
  async consume(id: string, at: string) {
    const c = this.rows.get(id);
    if (!c || c.consumedAt) return false;
    c.consumedAt = at;
    return true;
  }
  async deleteExpiredBefore(at: Date) {
    let n = 0;
    for (const [id, c] of this.rows) {
      if (Date.parse(c.expiresAt) < at.getTime()) {
        this.rows.delete(id);
        n++;
      }
    }
    return n;
  }
}

export class MemoryNotificationRepository implements NotificationRepository {
  readonly rows: NotificationRecord[] = [];
  async enqueue(n: NotificationRecord) {
    if (this.rows.some((r) => r.dedupeKey === n.dedupeKey)) return false;
    this.rows.push(clone(n));
    return true;
  }
  async due(now: Date, limit: number) {
    return this.rows
      .filter((r) => r.status === 'pending' && Date.parse(r.nextAttemptAt) <= now.getTime())
      .slice(0, limit)
      .map(clone);
  }
  async markSent(id: string, at: string) {
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, { status: 'sent', sentAt: at });
  }
  async markAttemptFailed(id: string, i: { attempts: number; nextAttemptAt: string; error: string; final: boolean }) {
    const r = this.rows.find((x) => x.id === id);
    if (r) Object.assign(r, { attempts: i.attempts, nextAttemptAt: i.nextAttemptAt, lastError: i.error, status: i.final ? 'failed' : 'pending' });
  }
  async existingKeys(keys: readonly string[]) {
    return new Set(this.rows.filter((r) => keys.includes(r.dedupeKey)).map((r) => r.dedupeKey));
  }
  async deleteFinishedBefore(at: Date) {
    const before = this.rows.length;
    for (let i = this.rows.length - 1; i >= 0; i--) {
      const r = this.rows[i];
      if (r && r.status !== 'pending' && Date.parse(r.createdAt) < at.getTime()) this.rows.splice(i, 1);
    }
    return before - this.rows.length;
  }
}

export class MemoryJobLeaseRepository implements JobLeaseRepository {
  private readonly leases = new Map<string, { owner: string; until: number }>();
  async tryAcquire(name: string, owner: string, until: Date, now: Date) {
    const l = this.leases.get(name);
    if (l && l.owner !== owner && l.until > now.getTime()) return false;
    this.leases.set(name, { owner, until: until.getTime() });
    return true;
  }
  async release(name: string, owner: string) {
    if (this.leases.get(name)?.owner === owner) this.leases.delete(name);
  }
}

export class MemoryFxRateRepository implements FxRateRepository {
  private readonly rows: FxRateRecord[] = [];
  async insert(rate: FxRateRecord) {
    this.rows.push(clone(rate));
  }
  private sorted(currency: string) {
    // Newest asOf first; for equal asOf, the most recently inserted wins.
    return this.rows
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.currency === currency)
      .sort((a, b) => b.r.asOf.localeCompare(a.r.asOf) || b.i - a.i)
      .map(({ r }) => clone(r));
  }
  async latest(currency: string) {
    return this.sorted(currency)[0];
  }
  async history(currency: string, limit: number) {
    return this.sorted(currency).slice(0, limit);
  }
}

export class MemoryStaffRepository implements StaffRepository {
  private readonly users = new Map<string, StaffUserRecord>();
  private readonly sessions = new Map<string, StaffSessionRecord>();
  async insert(u: StaffUserRecord) {
    if ([...this.users.values()].some((x) => x.email === u.email)) throw new DuplicateKeyError('email');
    this.users.set(u.id, clone(u));
  }
  async findById(id: string) {
    const u = this.users.get(id);
    return u ? clone(u) : undefined;
  }
  async findByEmail(email: string) {
    const u = [...this.users.values()].find((x) => x.email === email);
    return u ? clone(u) : undefined;
  }
  async list() {
    return [...this.users.values()].sort((a, b) => a.name.localeCompare(b.name)).map(clone);
  }
  async count() {
    return this.users.size;
  }
  async update(id: string, patch: StaffUserPatch) {
    const u = this.users.get(id);
    if (!u) return undefined;
    const next: StaffUserRecord = { ...u };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete (next as unknown as Record<string, unknown>)[k];
      else if (v !== undefined) (next as unknown as Record<string, unknown>)[k] = v;
    }
    this.users.set(id, next);
    return clone(next);
  }
  async useTotpStep(id: string, step: number) {
    const u = this.users.get(id);
    if (!u || (u.totpLastStep !== undefined && u.totpLastStep >= step)) return false;
    u.totpLastStep = step;
    return true;
  }
  async insertSession(s: StaffSessionRecord) {
    this.sessions.set(s.id, clone(s));
  }
  async findSession(tokenHash: string) {
    const s = [...this.sessions.values()].find((x) => x.tokenHash === tokenHash && !x.revokedAt);
    return s ? clone(s) : undefined;
  }
  async touchSession(id: string, at: string) {
    const s = this.sessions.get(id);
    if (s) s.lastSeenAt = at;
  }
  async revokeSession(id: string, at: string) {
    const s = this.sessions.get(id);
    if (s && !s.revokedAt) s.revokedAt = at;
  }
  async revokeAllSessions(staffId: string, at: string, keepSessionId?: string) {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (s.staffId === staffId && !s.revokedAt && s.id !== keepSessionId) {
        s.revokedAt = at;
        n++;
      }
    }
    return n;
  }
  async deleteSessionsExpiredBefore(cutoff: Date) {
    let n = 0;
    for (const [id, s] of this.sessions) {
      if (Date.parse(s.expiresAt) < cutoff.getTime()) {
        this.sessions.delete(id);
        n++;
      }
    }
    return n;
  }
}

export class MemoryAgentUsageRepository implements AgentUsageRepository {
  private readonly rows = new Map<string, AgentUsageEntry & { calls: number }>();
  async add(e: AgentUsageEntry): Promise<void> {
    const key = `${e.day}|${e.sessionId}`;
    const r = this.rows.get(key) ?? { day: e.day, sessionId: e.sessionId, calls: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costMicros: 0 };
    this.rows.set(key, {
      ...r,
      calls: r.calls + 1,
      inputTokens: r.inputTokens + e.inputTokens,
      outputTokens: r.outputTokens + e.outputTokens,
      cacheWriteTokens: r.cacheWriteTokens + e.cacheWriteTokens,
      cacheReadTokens: r.cacheReadTokens + e.cacheReadTokens,
      costMicros: r.costMicros + e.costMicros,
    });
  }
  async dayCostMicros(day: string): Promise<number> {
    return [...this.rows.values()].filter((r) => r.day === day).reduce((a, r) => a + r.costMicros, 0);
  }
  async sessionCostMicros(sessionId: string, day: string): Promise<number> {
    return this.rows.get(`${day}|${sessionId}`)?.costMicros ?? 0;
  }
  async daily(fromDay: string, toDay: string): Promise<AgentUsageDay[]> {
    const days = new Map<string, AgentUsageDay>();
    for (const r of this.rows.values()) {
      if (r.day < fromDay || r.day > toDay) continue;
      const d = days.get(r.day) ?? { day: r.day, calls: 0, conversations: 0, inputTokens: 0, outputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, costMicros: 0 };
      days.set(r.day, {
        day: r.day,
        calls: d.calls + r.calls,
        conversations: d.conversations + 1,
        inputTokens: d.inputTokens + r.inputTokens,
        outputTokens: d.outputTokens + r.outputTokens,
        cacheWriteTokens: d.cacheWriteTokens + r.cacheWriteTokens,
        cacheReadTokens: d.cacheReadTokens + r.cacheReadTokens,
        costMicros: d.costMicros + r.costMicros,
      });
    }
    return [...days.values()].sort((a, b) => a.day.localeCompare(b.day));
  }
}

export function createMemoryRepositories(): Repositories {
  const sessions = new MemorySessionRepository();
  const bookings = new MemoryBookingRepository();
  const tickets = new MemorySupportTicketRepository();
  // Mirrors the database's ON DELETE RESTRICT: never purge a session that owns records.
  sessions.hasRecords = (id) => bookings.ownedBy(id) || tickets.rows.some((t) => t.sessionId === id);
  return {
    sessions,
    offers: new MemoryOfferRepository(),
    bookings,
    payments: new MemoryPaymentRepository(),
    confirmations: new MemoryConfirmationRepository(),
    events: new MemoryProcessedEventRepository(),
    conversations: new MemoryConversationRepository(),
    tickets,
    travellers: new MemoryTravellerRepository(),
    otp: new MemoryOtpChallengeRepository(),
    notifications: new MemoryNotificationRepository(),
    leases: new MemoryJobLeaseRepository(),
    fx: new MemoryFxRateRepository(),
    staff: new MemoryStaffRepository(),
    agentUsage: new MemoryAgentUsageRepository(),
    rateLimits: new MemoryRateLimitStore(),
    ping: async () => undefined,
    isUnavailable: () => false,
    close: async () => undefined,
  };
}
