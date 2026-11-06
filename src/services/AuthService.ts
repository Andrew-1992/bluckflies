import { createHmac, randomInt } from 'node:crypto';
import { AppError } from '../domain/errors.js';
import type { Clock } from '../lib/clock.js';
import { newId, safeEqualHex } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { keyedHash, maskPhone, normalizePhone } from '../lib/phone.js';
import { SendError, type SmsSender } from '../providers/notify/senders.js';
import type { BookingRepository, OtpChallengeRepository, SessionRepository, TravellerRepository } from '../repositories/types.js';

const CODE_TTL_MINUTES = 10;
const MAX_ATTEMPTS = 5;
/** At most this many codes per phone number per window, whatever the IP or session. */
const SENDS_PER_WINDOW = 3;
const SEND_WINDOW_MINUTES = 15;

export interface AccountView {
  /** Masked, e.g. "+211****678". */
  phone: string;
}

/**
 * Traveller accounts: log in with a phone number and a one-time code sent by
 * SMS, so bookings follow the traveller to any device.
 *
 * - Codes are 6 random digits, valid 10 minutes, single use, 5 attempts.
 * - Only an HMAC of the code is stored, bound to the challenge ID.
 * - Phone numbers are looked up by keyed hash and stored encrypted.
 * - A challenge can only be completed by the session that requested it.
 * - Responses never reveal whether a number already has an account.
 */
export class AuthService {
  constructor(
    private readonly sms: SmsSender | undefined,
    private readonly otp: OtpChallengeRepository,
    private readonly travellers: TravellerRepository,
    private readonly sessions: SessionRepository,
    private readonly bookings: BookingRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly secret: string,
  ) {}

  get enabled(): boolean {
    return Boolean(this.sms);
  }

  phoneKey(phone: string): string {
    return keyedHash(this.secret, 'phone', phone);
  }

  private codeHash(challengeId: string, code: string): string {
    return createHmac('sha256', this.secret).update(`bluckflies:otp:${challengeId}:${code}`).digest('hex');
  }

  async start(sessionId: string, rawPhone: string, language: 'en' | 'ar' = 'en'): Promise<{ challengeId: string; expiresAt: string; phone: string }> {
    if (!this.sms) throw new AppError('SERVICE_UNAVAILABLE', 'Phone login is not available right now.');
    const phone = normalizePhone(rawPhone);
    if (!phone) throw new AppError('VALIDATION_FAILED', 'Enter your phone number with the country code, for example +211 912 345 678.');
    const phoneHash = this.phoneKey(phone);
    const now = this.clock.now();
    const recent = await this.otp.countSince(phoneHash, new Date(now.getTime() - SEND_WINDOW_MINUTES * 60_000));
    if (recent >= SENDS_PER_WINDOW) throw new AppError('RATE_LIMITED', `Too many codes were sent to this number. Wait ${SEND_WINDOW_MINUTES} minutes and try again.`);

    const id = newId('otp');
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60_000).toISOString();
    await this.otp.insert({ id, sessionId, phoneHash, phone, codeHash: this.codeHash(id, code), attempts: 0, expiresAt, createdAt: now.toISOString() });
    const text =
      language === 'ar'
        ? `رمز بلك فلايز: ${code}. صالح لمدة ${CODE_TTL_MINUTES} دقائق. لا تشاركه مع أحد.`
        : `Your BluckFlies code is ${code}. It expires in ${CODE_TTL_MINUTES} minutes. Never share it.`;
    try {
      await this.sms.send(phone, text);
    } catch (err) {
      this.log.error('auth.otp_send_failed', { phone: maskPhone(phone), err: err instanceof Error ? err.message : String(err) });
      if (err instanceof SendError && !err.retryable) throw new AppError('VALIDATION_FAILED', 'We could not send a code to this number. Check the number and try again.');
      throw new AppError('UPSTREAM_UNAVAILABLE', 'We could not send the code right now. Please try again in a minute.');
    }
    this.log.info('auth.otp_sent', { phone: maskPhone(phone), challengeId: id });
    return { challengeId: id, expiresAt, phone: maskPhone(phone) };
  }

  async verify(sessionId: string, challengeId: string, rawCode: string): Promise<AccountView> {
    const code = rawCode.replace(/\D/g, '');
    const c = await this.otp.find(challengeId);
    // One message for every "this code cannot be used" case.
    const unusable = new AppError('VALIDATION_FAILED', 'This code has expired or was already used. Ask for a new code.');
    if (!c || c.sessionId !== sessionId || c.consumedAt || Date.parse(c.expiresAt) <= this.clock.now().getTime() || c.attempts >= MAX_ATTEMPTS) throw unusable;

    if (code.length !== 6 || !safeEqualHex(this.codeHash(c.id, code), c.codeHash)) {
      const attempts = await this.otp.recordFailure(c.id, MAX_ATTEMPTS);
      if (attempts === undefined || attempts >= MAX_ATTEMPTS) throw new AppError('VALIDATION_FAILED', 'Too many wrong codes. Ask for a new code.');
      throw new AppError('VALIDATION_FAILED', `That code is not right. ${MAX_ATTEMPTS - attempts} tries left.`);
    }
    if (!(await this.otp.consume(c.id, this.clock.now().toISOString()))) throw unusable;

    const traveller = await this.travellers.upsertByPhone({ id: newId('trv'), phoneHash: c.phoneHash, phone: c.phone, at: this.clock.now().toISOString() });
    await this.sessions.setTraveller(sessionId, traveller.id);
    const claimed = await this.bookings.assignTraveller(sessionId, traveller.id);
    this.log.info('auth.login', { travellerId: traveller.id, sessionId, claimedBookings: claimed });
    return { phone: maskPhone(traveller.phone) };
  }

  /** Links a WhatsApp/SMS sender (phone proven by the channel) to their account. */
  async accountForVerifiedPhone(phone: string): Promise<string> {
    const t = await this.travellers.upsertByPhone({ id: newId('trv'), phoneHash: this.phoneKey(phone), phone, at: this.clock.now().toISOString() });
    return t.id;
  }

  async me(sessionId: string): Promise<AccountView | null> {
    const session = await this.sessions.findById(sessionId);
    if (!session?.travellerId) return null;
    const t = await this.travellers.findById(session.travellerId);
    return t ? { phone: maskPhone(t.phone) } : null;
  }

  /** Ends this session (the token stops working). Bookings stay with the account. */
  async logout(sessionId: string): Promise<void> {
    await this.sessions.revoke(sessionId, this.clock.now().toISOString());
  }
}
