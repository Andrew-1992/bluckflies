import { AppError } from '../domain/errors.js';
import type { Clock } from '../lib/clock.js';
import { hashToken, newId, newSessionToken } from '../lib/ids.js';
import type { Logger } from '../lib/logger.js';
import { DUMMY_HASH, hashPassword, needsRehash, passwordProblem, verifyPassword } from '../lib/password.js';
import { newTotpSecret, otpauthUri, verifyTotp } from '../lib/totp.js';
import { DuplicateKeyError, type StaffRepository, type StaffRole, type StaffUserRecord } from '../repositories/types.js';

/**
 * Staff accounts for the support desk and partner agents: one login per
 * person, so every confirmation and refund is attributable and access can be
 * removed for one person.
 *
 * - Passwords: scrypt (lib/password), 12+ characters.
 * - Lockout: 5 wrong passwords or codes lock the account for 15 minutes.
 * - Two-step login (TOTP): required for everyone when `require2fa` is set
 *   (production default); a session without it can only enrol.
 * - Sessions: random bearer token, stored hashed; 12 hours at most, ended
 *   after 2 hours idle, and revoked on password, role or status changes.
 */

export interface StaffPrincipal {
  kind: 'staff';
  id: string;
  name: string;
  email: string;
  role: StaffRole;
  sessionId: string;
  /** Two-step login is required but not set up yet: only enrolment is allowed. */
  needs2fa: boolean;
}

export type LoginResult =
  | { status: 'ok'; token: string; staff: StaffView }
  /** Password correct; the account has two-step login: send the 6-digit code too. */
  | { status: 'code_required' };

export interface StaffView {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  twoStepEnabled: boolean;
  disabled: boolean;
  lockedUntil?: string;
  createdAt: string;
}

const MAX_FAILURES = 5;
const LOCK_MINUTES = 15;
const SESSION_HOURS = 12;
const IDLE_MINUTES = 120;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function staffView(u: StaffUserRecord): StaffView {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    twoStepEnabled: Boolean(u.totpEnabledAt),
    disabled: Boolean(u.disabledAt),
    ...(u.lockedUntil ? { lockedUntil: u.lockedUntil } : {}),
    createdAt: u.createdAt,
  };
}

export class StaffAuthService {
  constructor(
    private readonly repo: StaffRepository,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly opts: { require2fa: boolean },
  ) {}

  // ----------------------------------------------------------------- login

  async login(rawEmail: string, password: string, code: string | undefined, ip: string | undefined): Promise<LoginResult> {
    const email = rawEmail.trim().toLowerCase();
    const user = await this.repo.findByEmail(email);
    const now = this.clock.now();
    // Same work and the same answer whether or not the account exists.
    const passwordOk = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    const fail = (): never => {
      throw new AppError('UNAUTHENTICATED', 'Email or password is incorrect, or the account is locked or disabled.');
    };
    if (!user || user.disabledAt) return fail();
    if (user.lockedUntil && Date.parse(user.lockedUntil) > now.getTime()) {
      this.log.warn('staff.login_locked', { staffId: user.id, ip });
      return fail();
    }
    if (!passwordOk) {
      await this.recordFailure(user, ip);
      return fail();
    }
    if (user.totpEnabledAt && user.totpSecret) {
      if (!code) return { status: 'code_required' };
      const step = verifyTotp(user.totpSecret, code.trim(), now);
      if (step === undefined || !(await this.repo.useTotpStep(user.id, step))) {
        await this.recordFailure(user, ip);
        throw new AppError('UNAUTHENTICATED', 'The 6-digit code is wrong or was already used. Wait for a new code and try again.');
      }
    }
    await this.repo.update(user.id, {
      failedLogins: 0,
      lockedUntil: null,
      ...(needsRehash(user.passwordHash) ? { passwordHash: await hashPassword(password) } : {}),
      updatedAt: now.toISOString(),
    });
    const token = newSessionToken();
    await this.repo.insertSession({
      id: newId('sss'),
      staffId: user.id,
      tokenHash: hashToken(token),
      createdAt: now.toISOString(),
      lastSeenAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + SESSION_HOURS * 3_600_000).toISOString(),
    });
    this.log.info('staff.login', { staffId: user.id, role: user.role, ip });
    return { status: 'ok', token, staff: staffView(user) };
  }

  private async recordFailure(user: StaffUserRecord, ip: string | undefined): Promise<void> {
    const failures = user.failedLogins + 1;
    const lock = failures >= MAX_FAILURES;
    await this.repo.update(user.id, {
      failedLogins: lock ? 0 : failures,
      ...(lock ? { lockedUntil: new Date(this.clock.now().getTime() + LOCK_MINUTES * 60_000).toISOString() } : {}),
      updatedAt: this.clock.now().toISOString(),
    });
    this.log.warn(lock ? 'staff.locked' : 'staff.login_failed', { staffId: user.id, ip });
  }

  /** Resolves a bearer token to the signed-in staff member, or undefined. */
  async authenticate(token: string): Promise<StaffPrincipal | undefined> {
    if (!token || token.length > 200) return undefined;
    const session = await this.repo.findSession(hashToken(token));
    if (!session) return undefined;
    const now = this.clock.now();
    const idleFor = now.getTime() - Date.parse(session.lastSeenAt);
    if (Date.parse(session.expiresAt) <= now.getTime() || idleFor > IDLE_MINUTES * 60_000) {
      await this.repo.revokeSession(session.id, now.toISOString());
      return undefined;
    }
    const user = await this.repo.findById(session.staffId);
    if (!user || user.disabledAt) return undefined;
    // Write at most once a minute per session.
    if (idleFor > 60_000) await this.repo.touchSession(session.id, now.toISOString());
    return {
      kind: 'staff',
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      sessionId: session.id,
      needs2fa: this.opts.require2fa && !user.totpEnabledAt,
    };
  }

  async logout(p: StaffPrincipal): Promise<void> {
    await this.repo.revokeSession(p.sessionId, this.clock.now().toISOString());
  }

  async me(p: StaffPrincipal): Promise<StaffView & { needs2fa: boolean }> {
    const u = await this.mustFind(p.id);
    return { ...staffView(u), needs2fa: p.needs2fa };
  }

  async changePassword(p: StaffPrincipal, current: string, next: string): Promise<void> {
    const u = await this.mustFind(p.id);
    if (!(await verifyPassword(current, u.passwordHash))) throw new AppError('UNAUTHENTICATED', 'Your current password is incorrect.');
    this.checkPassword(next, u);
    const now = this.clock.now().toISOString();
    await this.repo.update(u.id, { passwordHash: await hashPassword(next), updatedAt: now });
    // Sign out everywhere else; this session stays.
    await this.repo.revokeAllSessions(u.id, now, p.sessionId);
    this.log.info('staff.password_changed', { staffId: u.id });
  }

  // ------------------------------------------------------ two-step login

  /** Starts (or restarts) enrolment: a new secret to add to an authenticator app. */
  async start2fa(p: StaffPrincipal): Promise<{ secret: string; uri: string }> {
    const u = await this.mustFind(p.id);
    if (u.totpEnabledAt) throw new AppError('INVALID_STATE', 'Two-step login is already on. Ask an admin to reset it if you lost your phone.');
    const secret = newTotpSecret();
    await this.repo.update(u.id, { totpSecret: secret, updatedAt: this.clock.now().toISOString() });
    return { secret, uri: otpauthUri(secret, u.email) };
  }

  /** Finishes enrolment once the app shows a correct code. */
  async confirm2fa(p: StaffPrincipal, code: string): Promise<void> {
    const u = await this.mustFind(p.id);
    if (u.totpEnabledAt) return;
    if (!u.totpSecret) throw new AppError('INVALID_STATE', 'Start two-step login setup first.');
    const step = verifyTotp(u.totpSecret, code.trim(), this.clock.now());
    if (step === undefined || !(await this.repo.useTotpStep(u.id, step))) throw new AppError('VALIDATION_FAILED', 'That code is not right. Check the time on your phone and try the newest code.');
    const now = this.clock.now().toISOString();
    await this.repo.update(u.id, { totpEnabledAt: now, updatedAt: now });
    await this.repo.revokeAllSessions(u.id, now, p.sessionId);
    this.log.info('staff.2fa_enabled', { staffId: u.id });
  }

  // ------------------------------------------------------- administration

  async list(): Promise<StaffView[]> {
    return (await this.repo.list()).map(staffView);
  }

  async create(by: string, input: { email: string; name: string; role: StaffRole; password: string }): Promise<StaffView> {
    const email = input.email.trim().toLowerCase();
    if (!EMAIL.test(email)) throw new AppError('VALIDATION_FAILED', 'Enter a valid email address.');
    const now = this.clock.now().toISOString();
    const record: StaffUserRecord = {
      id: newId('stf'),
      email,
      name: input.name.trim(),
      role: input.role,
      passwordHash: '',
      failedLogins: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.checkPassword(input.password, record);
    record.passwordHash = await hashPassword(input.password);
    try {
      await this.repo.insert(record);
    } catch (err) {
      if (err instanceof DuplicateKeyError) throw new AppError('CONFLICT', 'A staff account with this email already exists.');
      throw err;
    }
    this.log.info('staff.created', { staffId: record.id, role: record.role, by });
    return staffView(record);
  }

  /**
   * Changes another account. Any change that affects access (role, disabling,
   * password reset, 2FA reset) signs that person out everywhere.
   */
  async update(
    actor: { id?: string; name: string },
    id: string,
    change: { name?: string; role?: StaffRole; disabled?: boolean; password?: string; reset2fa?: boolean; unlock?: boolean },
  ): Promise<StaffView> {
    const u = await this.mustFind(id);
    if (actor.id === id && (change.disabled || (change.role && change.role !== 'admin'))) {
      throw new AppError('VALIDATION_FAILED', 'You cannot disable yourself or remove your own admin role.');
    }
    if ((change.disabled || (change.role && change.role !== 'admin')) && u.role === 'admin' && !u.disabledAt) {
      const admins = (await this.repo.list()).filter((x) => x.role === 'admin' && !x.disabledAt);
      if (admins.length <= 1) throw new AppError('VALIDATION_FAILED', 'Keep at least one active admin.');
    }
    const now = this.clock.now().toISOString();
    if (change.password !== undefined) this.checkPassword(change.password, u);
    const updated = await this.repo.update(id, {
      ...(change.name !== undefined ? { name: change.name.trim() } : {}),
      ...(change.role !== undefined ? { role: change.role } : {}),
      ...(change.disabled !== undefined ? { disabledAt: change.disabled ? now : null } : {}),
      ...(change.password !== undefined ? { passwordHash: await hashPassword(change.password) } : {}),
      ...(change.reset2fa ? { totpSecret: null, totpEnabledAt: null } : {}),
      ...(change.unlock ? { lockedUntil: null, failedLogins: 0 } : {}),
      updatedAt: now,
    });
    if (!updated) throw new AppError('NOT_FOUND', 'No such staff account.');
    if (change.role !== undefined || change.disabled || change.password !== undefined || change.reset2fa) {
      await this.repo.revokeAllSessions(id, now);
    }
    this.log.info('staff.updated', { staffId: id, by: actor.name, fields: Object.keys(change) });
    return staffView(updated);
  }

  async cleanupSessions(): Promise<number> {
    return this.repo.deleteSessionsExpiredBefore(new Date(this.clock.now().getTime() - 86_400_000));
  }

  private checkPassword(password: string, u: Pick<StaffUserRecord, 'email' | 'name'>): void {
    const problem = passwordProblem(password, u);
    if (problem) throw new AppError('VALIDATION_FAILED', problem);
  }

  private async mustFind(id: string): Promise<StaffUserRecord> {
    const u = await this.repo.findById(id);
    if (!u) throw new AppError('NOT_FOUND', 'No such staff account.');
    return u;
  }
}
