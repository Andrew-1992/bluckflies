import type { RateLimitStore } from '../lib/rateLimiter.js';
import type { Booking, FlightOffer, Payment, PendingConfirmation } from '../domain/types.js';

/**
 * Persistence boundaries, implemented in memory (development, unit tests)
 * and in PostgreSQL via Prisma (production). Every implementation must give:
 * - unique PNRs, provider references and idempotency keys;
 * - compare-and-set transitions: an update applies only if the row is still
 *   in an expected state, so concurrent webhooks, jobs and instances converge.
 */

export type SessionChannel = 'web' | 'whatsapp' | 'sms';

export interface Session {
  id: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  /** Defaults to 'web' when absent. */
  channel?: SessionChannel;
  /** WhatsApp/SMS sessions: HMAC of "<channel>:<phone>"; one session per sender. */
  channelKey?: string;
  travellerId?: string;
  revokedAt?: string;
}

export interface SessionRepository {
  /** Throws `DuplicateKeyError('tokenHash' | 'channelKey')`. */
  create(session: Session): Promise<void>;
  /** Revoked sessions are not returned. */
  findByTokenHash(tokenHash: string): Promise<Session | undefined>;
  findById(id: string): Promise<Session | undefined>;
  findByChannelKey(channelKey: string): Promise<Session | undefined>;
  setTraveller(id: string, travellerId: string): Promise<void>;
  /** Logout: the token stops working; the row stays for the records it owns. */
  revoke(id: string, at: string): Promise<void>;
  touch(id: string, at: string): Promise<void>;
  /**
   * Retention: deletes sessions not seen since `before` that own no bookings
   * and no support tickets (their offers, confirmations and transcripts go with them).
   */
  deleteIdleSince(before: Date): Promise<number>;
}

export interface OfferRepository {
  saveMany(sessionId: string, offers: readonly FlightOffer[]): Promise<void>;
  find(sessionId: string, offerId: string): Promise<FlightOffer | undefined>;
  deleteExpiredBefore(at: Date): Promise<number>;
}

/** Fields that may change after a booking is created. */
export type BookingUpdate = Pick<Booking, 'status' | 'updatedAt'> & Partial<Pick<Booking, 'ticketNumbers' | 'supplierReference'>>;

export interface BookingRepository {
  /** Throws `DuplicateKeyError` if the PNR is already taken. */
  insert(booking: Booking): Promise<void>;
  findById(id: string): Promise<Booking | undefined>;
  /** Several bookings at once (reports); missing ids are skipped. */
  findByIds(ids: readonly string[]): Promise<Booking[]>;
  findByPnr(pnr: string): Promise<Booking | undefined>;
  /** For supplier webhooks, which identify bookings by the supplier's order ID. */
  findBySupplierReference(provider: string, supplierReference: string): Promise<Booking | undefined>;
  listBySession(sessionId: string): Promise<Booking[]>;
  listByTraveller(travellerId: string): Promise<Booking[]>;
  /** After login: the session's bookings (not yet claimed) move to the account. Returns how many. */
  assignTraveller(sessionId: string, travellerId: string): Promise<number>;
  /** Bookings now in one of `statuses` that changed since `since` (notification backfill). */
  findRecentByStatus(statuses: readonly Booking['status'][], since: Date, limit: number): Promise<Booking[]>;
  /**
   * Atomically applies `update` only if the booking is currently in one of
   * `expected` states. Returns the updated booking, or undefined if the state
   * had already changed (e.g. a concurrent webhook).
   */
  transition(id: string, expected: readonly Booking['status'][], update: BookingUpdate): Promise<Booking | undefined>;
  /** Open holds (held / payment_pending) whose hold expired at or before `at`. */
  findLapsedHolds(at: Date, limit: number): Promise<Booking[]>;
  /** Bookings left in `ticketing` since before `before` (crashed mid-issuance). */
  findStuckTicketing(before: Date, limit: number): Promise<Booking[]>;
}

/** Fields that may change after a payment is created. */
export type PaymentUpdate = Pick<Payment, 'status' | 'updatedAt'> & Partial<Pick<Payment, 'refundReference'>>;

export interface PaymentRepository {
  /**
   * Returns the existing row (created: false) when the idempotency key is already used.
   * Throws `DuplicateKeyError('openPaymentRequest')` if the booking already has a different
   * payment in `requested` (at most one open request per booking).
   */
  insertIfAbsent(payment: Payment): Promise<{ payment: Payment; created: boolean }>;
  findByProviderReference(ref: string): Promise<Payment | undefined>;
  /** Most recently *inserted* attempt (must not rely on timestamps, which can tie). */
  findLatestForBooking(bookingId: string): Promise<Payment | undefined>;
  transition(id: string, expected: readonly Payment['status'][], update: PaymentUpdate): Promise<Payment | undefined>;
  /** Payments in `statuses` for `provider` not updated since `before`, oldest first. */
  findStale(statuses: readonly Payment['status'][], provider: string, before: Date, limit: number): Promise<Payment[]>;
  /** Payments now in one of `statuses`, oldest change first (e.g. refunds owed). */
  findByStatus(statuses: readonly Payment['status'][], limit: number): Promise<Payment[]>;
  /** Payments created, changed, paid or refunded in [from, to), oldest first (finance reports). */
  listActiveBetween(from: Date, to: Date, limit: number): Promise<Payment[]>;
  /** Payments of one method created at or after `since`, newest first (bank statement matching). */
  findRecentByMethod(method: Payment['method'], since: Date, limit: number): Promise<Payment[]>;
}

export interface ConfirmationRepository {
  insert(c: PendingConfirmation): Promise<void>;
  find(id: string): Promise<PendingConfirmation | undefined>;
  transition(id: string, expected: PendingConfirmation['status'], next: PendingConfirmation['status']): Promise<PendingConfirmation | undefined>;
  listPending(sessionId: string): Promise<PendingConfirmation[]>;
  /** Marks pending confirmations past expiry as expired. */
  expireStale(at: Date): Promise<number>;
}

/** Records processed webhook event IDs so duplicates are acknowledged but not re-applied. */
export interface ProcessedEventRepository {
  markIfNew(eventId: string): Promise<boolean>;
  deleteOlderThan(at: Date): Promise<number>;
}

export interface ConversationRepository {
  load(sessionId: string): Promise<unknown[]>;
  save(sessionId: string, messages: unknown[]): Promise<void>;
  /** Retention: deletes transcripts not updated since `before`. */
  deleteNotUpdatedSince(before: Date): Promise<number>;
}

/** AI model usage, one row per conversation (session) per Juba day. */
export interface AgentUsageEntry {
  /** YYYY-MM-DD, Africa/Juba. */
  day: string;
  sessionId: string;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costMicros: number;
}

export interface AgentUsageDay {
  day: string;
  calls: number;
  conversations: number;
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
  costMicros: number;
}

export interface AgentUsageRepository {
  /** Adds one model call to the day's totals for that conversation (atomic increment). */
  add(entry: AgentUsageEntry, at: string): Promise<void>;
  /** Total spend for the day, all conversations. */
  dayCostMicros(day: string): Promise<number>;
  /** Spend of one conversation on that day. */
  sessionCostMicros(sessionId: string, day: string): Promise<number>;
  /** Per-day totals for the inclusive range of days, oldest first. */
  daily(fromDay: string, toDay: string): Promise<AgentUsageDay[]>;
}

export type TicketStatus = 'open' | 'in_progress' | 'resolved';

export interface SupportTicketRecord {
  id: string;
  sessionId: string;
  reason: string;
  summary: string;
  status: TicketStatus;
  assignee?: string;
  bookingId?: string;
  /** Phone the traveller asked to be called on (encrypted at rest). */
  contactPhone?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface TicketNoteRecord {
  id: string;
  ticketId: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface TicketUpdate {
  status?: TicketStatus;
  /** null clears the assignee. */
  assignee?: string | null;
  updatedAt: string;
}

export interface SupportTicketRepository {
  insert(t: SupportTicketRecord): Promise<void>;
  find(id: string): Promise<SupportTicketRecord | undefined>;
  /** Newest first. */
  list(filter: { status?: TicketStatus; limit: number }): Promise<SupportTicketRecord[]>;
  /** Sets resolvedAt when moving to resolved and clears it otherwise. */
  update(id: string, update: TicketUpdate): Promise<SupportTicketRecord | undefined>;
  addNote(note: TicketNoteRecord): Promise<void>;
  /** Oldest first. */
  notes(ticketId: string): Promise<TicketNoteRecord[]>;
}

// ------------------------------------------------------------- accounts

export interface TravellerRecord {
  id: string;
  /** E.164 phone number (stored encrypted). */
  phone: string;
  createdAt: string;
  lastLoginAt: string;
}

export interface TravellerRepository {
  /** Returns the account for this phone, creating it if needed, and records the login time. */
  upsertByPhone(input: { id: string; phoneHash: string; phone: string; at: string }): Promise<TravellerRecord>;
  findById(id: string): Promise<TravellerRecord | undefined>;
}

export interface OtpChallengeRecord {
  id: string;
  sessionId: string;
  phoneHash: string;
  phone: string;
  codeHash: string;
  attempts: number;
  expiresAt: string;
  consumedAt?: string;
  createdAt: string;
}

export interface OtpChallengeRepository {
  insert(c: OtpChallengeRecord): Promise<void>;
  find(id: string): Promise<OtpChallengeRecord | undefined>;
  /** Challenges created for this phone at or after `since` (rate limiting). */
  countSince(phoneHash: string, since: Date): Promise<number>;
  /**
   * Counts a wrong code. Applies only while unconsumed and under `max`;
   * returns the new attempt count, or undefined if the challenge is no longer usable.
   */
  recordFailure(id: string, max: number): Promise<number | undefined>;
  /** Marks the challenge used; false if it was already consumed (single use). */
  consume(id: string, at: string): Promise<boolean>;
  deleteExpiredBefore(at: Date): Promise<number>;
}

// ------------------------------------------------------------- outbox

export type NotificationChannel = 'email' | 'sms' | 'whatsapp';
export type NotificationStatus = 'pending' | 'sent' | 'failed';

export interface NotificationRecord {
  id: string;
  /** Same key = same message; it is queued at most once. */
  dedupeKey: string;
  channel: NotificationChannel;
  /** Email address or E.164 phone number (stored encrypted). */
  recipient: string;
  subject: string;
  /** Stored encrypted (may contain ticket numbers and names). */
  body: string;
  status: NotificationStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
  sentAt?: string;
}

export interface NotificationRepository {
  /** False when a message with this dedupe key already exists. */
  enqueue(n: NotificationRecord): Promise<boolean>;
  /** Pending messages due at `now`, oldest first. */
  due(now: Date, limit: number): Promise<NotificationRecord[]>;
  markSent(id: string, at: string): Promise<void>;
  /** Records a failed attempt; `final` marks the message failed instead of rescheduling. */
  markAttemptFailed(id: string, input: { attempts: number; nextAttemptAt: string; error: string; final: boolean }): Promise<void>;
  /** Which of these dedupe keys already exist. */
  existingKeys(keys: readonly string[]): Promise<Set<string>>;
  /** Retention: deletes sent/failed messages created before `at`. */
  deleteFinishedBefore(at: Date): Promise<number>;
}

export interface FxRateRecord {
  currency: string;
  /** Units of `currency` per USD, exact decimal string. */
  perUsd: string;
  asOf: string;
  source: string;
}

export interface FxRateRepository {
  insert(rate: FxRateRecord): Promise<void>;
  /** Newest by `asOf`, or undefined if none has been entered. */
  latest(currency: string): Promise<FxRateRecord | undefined>;
  history(currency: string, limit: number): Promise<FxRateRecord[]>;
}

/** Cross-instance mutual exclusion for background jobs. */
export interface JobLeaseRepository {
  /** Takes or renews the lease if it is free, expired, or already ours. */
  tryAcquire(name: string, owner: string, until: Date, now: Date): Promise<boolean>;
  release(name: string, owner: string): Promise<void>;
}

export type StaffRole = 'admin' | 'agent' | 'partner';

export interface StaffUserRecord {
  id: string;
  /** Lower-cased. */
  email: string;
  name: string;
  role: StaffRole;
  passwordHash: string;
  /** Base32 TOTP secret (encrypted at rest). Present once enrolment has started. */
  totpSecret?: string;
  totpEnabledAt?: string;
  totpLastStep?: number;
  failedLogins: number;
  lockedUntil?: string;
  disabledAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type StaffUserPatch = Partial<Pick<StaffUserRecord, 'name' | 'role' | 'passwordHash' | 'failedLogins' | 'totpLastStep'>> & {
  totpSecret?: string | null;
  totpEnabledAt?: string | null;
  lockedUntil?: string | null;
  disabledAt?: string | null;
  updatedAt: string;
};

export interface StaffSessionRecord {
  id: string;
  staffId: string;
  tokenHash: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  revokedAt?: string;
}

export interface StaffRepository {
  /** Throws DuplicateKeyError('email') when the email is taken. */
  insert(u: StaffUserRecord): Promise<void>;
  findById(id: string): Promise<StaffUserRecord | undefined>;
  findByEmail(email: string): Promise<StaffUserRecord | undefined>;
  list(): Promise<StaffUserRecord[]>;
  count(): Promise<number>;
  update(id: string, patch: StaffUserPatch): Promise<StaffUserRecord | undefined>;
  /**
   * Records a TOTP step only if it is newer than the last one (compare-and-set),
   * so the same code cannot be used twice. Returns false on replay.
   */
  useTotpStep(id: string, step: number): Promise<boolean>;
  insertSession(s: StaffSessionRecord): Promise<void>;
  /** Active (not revoked) session by token hash. */
  findSession(tokenHash: string): Promise<StaffSessionRecord | undefined>;
  touchSession(id: string, at: string): Promise<void>;
  revokeSession(id: string, at: string): Promise<void>;
  /** Signs a staff member out everywhere (password change, role change, disable). Optionally keeps one session. */
  revokeAllSessions(staffId: string, at: string, keepSessionId?: string): Promise<number>;
  deleteSessionsExpiredBefore(cutoff: Date): Promise<number>;
}

export interface Repositories {
  sessions: SessionRepository;
  offers: OfferRepository;
  bookings: BookingRepository;
  payments: PaymentRepository;
  confirmations: ConfirmationRepository;
  events: ProcessedEventRepository;
  conversations: ConversationRepository;
  tickets: SupportTicketRepository;
  travellers: TravellerRepository;
  otp: OtpChallengeRepository;
  notifications: NotificationRepository;
  leases: JobLeaseRepository;
  fx: FxRateRepository;
  staff: StaffRepository;
  agentUsage: AgentUsageRepository;
  /** Shared rate-limit counters (all servers). */
  rateLimits: RateLimitStore;
  /** Readiness probe; resolves if the store is reachable and migrated. */
  ping(): Promise<void>;
  /** True if `err` means the store is temporarily unreachable (maps to HTTP 503). */
  isUnavailable(err: unknown): boolean;
  close(): Promise<void>;
}

export class DuplicateKeyError extends Error {
  constructor(readonly field: string) {
    super(`Duplicate value for ${field}`);
    this.name = 'DuplicateKeyError';
  }
}
