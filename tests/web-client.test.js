// Pure helpers of the web client (public/js), run in Node. Browser behaviour is
// checked with Playwright; these pin down the date logic every card relies on.
import { describe, expect, it } from 'vitest';
import { dayShift } from '../public/js/dom.js';

describe('arrival day marker', () => {
  it('counts calendar days between local departure and arrival times', () => {
    expect(dayShift('2026-11-20T14:30:00+02:00', '2026-11-20T17:25:00+03:00')).toBe(0);
    // Juba 17:20 → Nairobi 07:30 the next morning
    expect(dayShift('2026-11-20T17:20:00+02:00', '2026-11-21T07:30:00+03:00')).toBe(1);
    // Two nights (long connection)
    expect(dayShift('2026-11-20T23:50:00+02:00', '2026-11-22T06:10:00+04:00')).toBe(2);
  });

  it('uses each airport\'s own date, not UTC: a late arrival east of Juba is still the same local day', () => {
    // 23:40 in Dubai (+04:00) is 19:40 UTC: same local day as a 14:00 departure from Juba
    expect(dayShift('2026-11-20T14:00:00+02:00', '2026-11-20T23:40:00+04:00')).toBe(0);
    // 00:30 local in Dubai is the next local day even though it is still the 20th in UTC
    expect(dayShift('2026-11-20T18:00:00+02:00', '2026-11-21T00:30:00+04:00')).toBe(1);
  });

  it('is 0 for anything it cannot read, rather than a wrong marker', () => {
    expect(dayShift('', '2026-11-21T07:30:00+03:00')).toBe(0);
    expect(dayShift(undefined, undefined)).toBe(0);
  });
});
