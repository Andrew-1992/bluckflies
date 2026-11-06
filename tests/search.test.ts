import { describe, expect, it } from 'vitest';
import { AIRPORTS, resolveAirports, resolvePlaces } from '../src/data/airports.js';
import { RoutedFlightProvider } from '../src/providers/flights/RoutedFlightProvider.js';
import type { FlightProvider } from '../src/providers/flights/FlightProvider.js';
import type { FlightSearchCriteria } from '../src/domain/types.js';
import { FlightSearchService } from '../src/services/FlightSearchService.js';
import { SandboxFlightProvider } from '../src/providers/flights/SandboxFlightProvider.js';
import { MemoryOfferRepository } from '../src/repositories/memory.js';
import { toZonedIso, zonedToUtc } from '../src/lib/time.js';
import { adult, CONTACT, FixedClock, FRIDAY, NOW, ONE_ADULT } from './helpers.js';

const svc = () =>
  new FlightSearchService(new SandboxFlightProvider(), new MemoryOfferRepository(), new FixedClock(NOW), { offerTtlMinutes: 30 }, { displayRate: async () => ({ perUsd: '4600', asOf: '2026-10-30T08:00:00.000Z' }) });

const base = { passengers: ONE_ADULT, cabin: 'economy' as const, maxStops: 1, sortBy: 'best' as const };

describe('airport resolution', () => {
  it('resolves codes, English and Arabic names', () => {
    expect(resolveAirports('jub')[0]?.iata).toBe('JUB');
    expect(resolveAirports('Wau')[0]?.iata).toBe('WUU');
    expect(resolveAirports('نيروبي')[0]?.iata).toBe('NBO');
    expect(resolveAirports('Kampala')[0]?.iata).toBe('EBB');
  });

  it.each([
    ['Kapoeta', 'HSKP'], ['Torit', 'HSTR'], ['Yambio', 'HSYA'], ['Yei', 'HSYE'], ['Bor', 'HSBR'], ['Pibor', 'HSPI'],
    ['Pachalla', 'HSPA'], ['Maridi', 'HSMD'], ['Renk', 'HSRN'], ['Bentiu', 'HSBT'], ['Kuajok', 'HJKJ'], ['Awiel', 'HSAW'],
    ['بور', 'HSBR'], ['الرنك', 'HSRN'], ['hsbr', 'HSBR'],
  ])('resolves the South Sudan town %s to exactly one airstrip (%s)', (query, code) => {
    expect(resolveAirports(query).map((a) => a.iata)).toEqual([code]);
  });

  it('routes towns without an airstrip to the nearest one, marked as by road', () => {
    expect(resolvePlaces('Lafon')).toEqual([expect.objectContaining({ airport: expect.objectContaining({ iata: 'HSTR' }), viaTown: expect.objectContaining({ name: 'Lafon' }) })]);
    expect(resolvePlaces('Rweng')[0]?.airport.iata).toBe('HSBT');
    expect(resolvePlaces('Rweng')[0]?.viaTown).toBeDefined();
    expect(resolvePlaces('Bor')[0]?.viaTown).toBeUndefined();
  });

  it('never gives two airports the same code', () => {
    expect(new Set(AIRPORTS.map((a) => a.iata)).size).toBe(AIRPORTS.length);
  });
});

describe('town airstrips', () => {
  it('sandbox serves Juba ↔ Bor directly and Bor → Nairobi via Juba', async () => {
    const direct = await svc().search('ses_1', { ...base, origin: 'Juba', destination: 'Bor', departureDate: FRIDAY });
    expect(direct.offers[0]?.segments.map((s) => s.to)).toEqual(['HSBR']);
    const onward = await svc().search('ses_1', { ...base, origin: 'بور', destination: 'Nairobi', departureDate: FRIDAY });
    expect(onward.offers[0]?.segments.map((s) => s.to)).toEqual(['JUB', 'NBO']);
  });

  it('never sends airstrip codes to an airline API and tells the agent to hand off', async () => {
    const seen: FlightSearchCriteria[] = [];
    const airline = new SandboxFlightProvider();
    const primary: FlightProvider = Object.assign(Object.create(airline) as FlightProvider, {
      name: 'airline',
      isSandbox: false,
      search: async (c: FlightSearchCriteria, at: Date) => { seen.push(c); return airline.search(c, at); },
    });
    const search = new FlightSearchService(new RoutedFlightProvider(primary), new MemoryOfferRepository(), new FixedClock(NOW), { offerTtlMinutes: 30 }, { displayRate: async () => ({ perUsd: '4600', asOf: '2026-10-30T08:00:00.000Z' }) });
    const r = await search.search('ses_1', { ...base, origin: 'Juba', destination: 'Lafon', departureDate: FRIDAY });
    expect(r.destination.code).toBe('HSTR');
    expect(r.offers).toEqual([]);
    expect(r.notice).toMatch(/handoff_to_human/);
    expect(seen).toEqual([]);
    await search.search('ses_1', { ...base, origin: 'Juba', destination: 'Nairobi', departureDate: FRIDAY });
    expect(seen.map((c) => c.destination)).toEqual(['NBO']);
  });
});

describe('time zones', () => {
  it('converts local wall time to UTC and back with the correct offset', () => {
    const utc = zonedToUtc('2026-11-06', '14:30', 'Africa/Juba');
    expect(utc.toISOString()).toBe('2026-11-06T12:30:00.000Z');
    expect(toZonedIso(utc, 'Africa/Nairobi')).toBe('2026-11-06T15:30:00+03:00');
  });
});

describe('FlightSearchService', () => {
  it('returns ranked direct offers with tags and an explicit sandbox label', async () => {
    const r = await svc().search('ses_1', { ...base, origin: 'Juba', destination: 'Nairobi', departureDate: FRIDAY });
    expect(r.offers.length).toBeGreaterThan(0);
    expect(r.notice).toMatch(/SANDBOX/);
    expect(r.offers.every((o) => o.sandbox)).toBe(true);
    const first = r.offers[0];
    expect(first?.segments[0]?.departs).toBe('2026-11-06T14:30:00+02:00');
    expect(r.offers.flatMap((o) => o.tags)).toContain('cheapest');
    expect(first?.priceIndicativeSsp).toMatch(/^≈ SSP/);
  });

  it('builds one-stop connections via Juba for domestic-to-international trips', async () => {
    // XN102 WUU→JUB departs Mon/Wed/Fri/Sun; connects to XS410 JUB→NBO.
    const r = await svc().search('ses_1', { ...base, origin: 'WUU', destination: 'NBO', departureDate: FRIDAY });
    expect(r.offers.some((o) => o.stops === 1 && o.segments.map((s) => s.flight).join('-') === 'XN102-XS410')).toBe(true);
  });

  it('respects max_stops = 0', async () => {
    const r = await svc().search('ses_1', { ...base, maxStops: 0, origin: 'WUU', destination: 'NBO', departureDate: FRIDAY });
    expect(r.offers).toHaveLength(0);
  });

  it('is deterministic for the same search', async () => {
    const a = await svc().search('ses_1', { ...base, origin: 'JUB', destination: 'DXB', departureDate: FRIDAY });
    const b = await svc().search('ses_1', { ...base, origin: 'JUB', destination: 'DXB', departureDate: FRIDAY });
    expect(a.offers.map((o) => o.price)).toEqual(b.offers.map((o) => o.price));
  });

  it('rejects past dates, unknown airports and identical endpoints', async () => {
    await expect(svc().search('s', { ...base, origin: 'JUB', destination: 'NBO', departureDate: '2026-10-01' })).rejects.toThrow(/past/);
    await expect(svc().search('s', { ...base, origin: 'Atlantis', destination: 'NBO', departureDate: FRIDAY })).rejects.toThrow(/couldn't find/);
    await expect(svc().search('s', { ...base, origin: 'JUB', destination: 'Juba', departureDate: FRIDAY })).rejects.toThrow(/different/);
  });

  it('scopes offers to the session that searched', async () => {
    const s = svc();
    const r = await s.search('ses_a', { ...base, origin: 'JUB', destination: 'NBO', departureDate: FRIDAY });
    const id = r.offers[0]?.offerId ?? '';
    await expect(s.getOffer('ses_a', id)).resolves.toBeDefined();
    await expect(s.getOffer('ses_b', id)).rejects.toThrow(/not found/);
  });
});

describe('SandboxFlightProvider across restarts', () => {
  it('tickets a hold created by another process, with stable ticket numbers', async () => {
    const iata = (code: string) => {
      const a = resolveAirports(code)[0];
      if (!a) throw new Error(code);
      return a.iata;
    };
    const before = new SandboxFlightProvider();
    const mix = { adults: 2, childAges: [], infants: 0 };
    const [offer] = await before.search({ origin: iata('JUB'), destination: iata('NBO'), departureDate: FRIDAY, passengers: mix, cabin: 'economy', maxStops: 0 }, new Date(NOW.getTime() + 1_800_000));
    if (!offer) throw new Error('no offer');
    const passengers = [adult(), adult({ givenName: 'Abuk' })];
    const { supplierReference } = await before.hold({ bookingId: 'bkg_1', offer, passengers, contact: CONTACT });
    const ctx = { bookingId: 'bkg_1', supplierReference, offer, passengers, contact: CONTACT };

    const afterRestart = new SandboxFlightProvider();
    const { ticketNumbers } = await afterRestart.issueTickets(ctx);
    expect(ticketNumbers).toHaveLength(2);
    expect(ticketNumbers.every((t) => /^999\d{10}$/.test(t))).toBe(true);
    expect((await new SandboxFlightProvider().issueTickets(ctx)).ticketNumbers).toEqual(ticketNumbers);
    await expect(afterRestart.issueTickets(ctx)).rejects.toThrow(/already issued/);
    await expect(afterRestart.issueTickets({ ...ctx, supplierReference: 'not-a-sandbox-ref' })).rejects.toThrow(/unknown/);
  });
});
