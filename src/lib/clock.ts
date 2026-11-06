/** Injectable clock so expiry logic is deterministic in tests. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export const addMinutes = (d: Date, minutes: number): Date => new Date(d.getTime() + minutes * 60_000);

export const isPast = (iso: string, clock: Clock): boolean => new Date(iso).getTime() <= clock.now().getTime();
