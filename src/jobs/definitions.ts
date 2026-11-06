import type { Clock } from '../lib/clock.js';
import type { JobDefinition } from '../lib/jobs.js';
import type { Repositories } from '../repositories/types.js';
import type { BookingService } from '../services/BookingService.js';
import type { ReconciliationService } from '../services/ReconciliationService.js';
import type { NotificationService } from '../services/notifications/NotificationService.js';

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

export interface JobDeps {
  repos: Repositories;
  bookings: BookingService;
  reconciliation: ReconciliationService;
  notifications?: NotificationService;
  clock: Clock;
  retentionDays: number;
  /** Register the fast status poll (providers without trustworthy webhooks, e.g. MTN MoMo). */
  pollPayments?: boolean;
}

/**
 * Periodic work that must happen even when no traveller is active. Every job
 * is idempotent and goes through the same compare-and-set transitions as
 * request handlers and webhooks, so overlap with live traffic is safe.
 */
export function buildJobs(d: JobDeps): JobDefinition[] {
  return [
    {
      // Releases seats and voids payment links for holds nobody paid for.
      name: 'holds.sweep',
      intervalMs: MINUTE,
      run: () => d.bookings.sweepLapsedHolds(200),
    },
    ...(d.pollPayments
      ? [
          {
            // MTN MoMo callbacks are unsigned and not always delivered: ask MTN directly.
            name: 'payments.poll',
            intervalMs: 20_000,
            run: () => d.reconciliation.pollPending(15),
          },
        ]
      : []),
    {
      // Recovers from missed webhooks and crashes mid-ticketing.
      name: 'payments.reconcile',
      intervalMs: 5 * MINUTE,
      run: () => d.reconciliation.run(),
    },
    ...notificationJobs(d.notifications),
    {
      // Data minimisation: expired caches and old personal data are deleted.
      name: 'data.cleanup',
      intervalMs: 60 * MINUTE,
      run: async () => {
        const now = d.clock.now();
        const cutoff = new Date(now.getTime() - d.retentionDays * DAY);
        return {
          offersDeleted: await d.repos.offers.deleteExpiredBefore(new Date(now.getTime() - 60 * MINUTE)),
          confirmationsExpired: await d.repos.confirmations.expireStale(now),
          eventsDeleted: await d.repos.events.deleteOlderThan(cutoff),
          conversationsDeleted: await d.repos.conversations.deleteNotUpdatedSince(cutoff),
          sessionsDeleted: await d.repos.sessions.deleteIdleSince(cutoff),
          loginCodesDeleted: await d.repos.otp.deleteExpiredBefore(new Date(now.getTime() - DAY)),
          staffSessionsDeleted: await d.repos.staff.deleteSessionsExpiredBefore(new Date(now.getTime() - DAY)),
          notificationsDeleted: await d.repos.notifications.deleteFinishedBefore(cutoff),
          rateLimitWindowsDeleted: await d.repos.rateLimits.deleteExpired(now),
        };
      },
    },
  ];
}

function notificationJobs(n: NotificationService | undefined): JobDefinition[] {
  if (!n) return [];
  return [
    {
      // Delivers queued e-tickets, SMS and staff alerts, with retries.
      name: 'notifications.send',
      intervalMs: 15_000,
      run: () => n.dispatch(50),
    },
    {
      // Re-queues ticket/refund messages missed by a crash between state change and queueing.
      name: 'notifications.backfill',
      intervalMs: 10 * MINUTE,
      run: () => n.backfill(),
    },
  ];
}
