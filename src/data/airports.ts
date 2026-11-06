import type { Airport, IataCode, NearbyTown } from '../domain/types.js';

const iata = (code: string): IataCode => code as IataCode;

const AIRSTRIP_NOTE =
  'Airstrip without scheduled airline service: flights are domestic charter or humanitarian services arranged by a BluckFlies agent, and they often change with the weather and the rainy season.';

/** A South Sudan airstrip identified by its 4-letter ICAO code (it has no IATA code). */
function airstrip(a: { icao: string; name: string; city: string; state: string; aliases: readonly string[]; nearbyTowns?: readonly NearbyTown[] }): Airport {
  return {
    iata: iata(a.icao),
    name: a.name,
    city: a.city,
    country: 'South Sudan',
    countryCode: 'SS',
    timeZone: 'Africa/Juba',
    isDomestic: true,
    aliases: a.aliases,
    notes: `${a.state}. ${AIRSTRIP_NOTE}`,
    ...(a.nearbyTowns ? { nearbyTowns: a.nearbyTowns } : {}),
  };
}

/**
 * Reference airport data. Domestic coverage starts with airports that have
 * well-established IATA codes; extend this list (or load it from the database)
 * as more domestic routes are supplied by real providers.
 */
export const AIRPORTS: readonly Airport[] = [
  {
    iata: iata('JUB'),
    name: 'Juba International Airport',
    city: 'Juba',
    country: 'South Sudan',
    countryCode: 'SS',
    timeZone: 'Africa/Juba',
    isDomestic: true,
    aliases: ['juba', 'جوبا', 'juba international'],
    notes: 'Main international gateway to South Sudan. Arrive at least 3 hours before international departures.',
  },
  {
    iata: iata('WUU'),
    name: 'Wau Airport',
    city: 'Wau',
    country: 'South Sudan',
    countryCode: 'SS',
    timeZone: 'Africa/Juba',
    isDomestic: true,
    aliases: ['wau', 'واو'],
  },
  {
    iata: iata('MAK'),
    name: 'Malakal Airport',
    city: 'Malakal',
    country: 'South Sudan',
    countryCode: 'SS',
    timeZone: 'Africa/Juba',
    isDomestic: true,
    aliases: ['malakal', 'ملكال'],
  },
  {
    iata: iata('RBX'),
    name: 'Rumbek Airport',
    city: 'Rumbek',
    country: 'South Sudan',
    countryCode: 'SS',
    timeZone: 'Africa/Juba',
    isDomestic: true,
    aliases: ['rumbek', 'رمبيك'],
  },
  // Airstrips (ICAO codes: Wikipedia "List of airports in South Sudan"; Kuajok: OurAirports HJKJ).
  airstrip({ icao: 'HSKP', name: 'Kapoeta Airport', city: 'Kapoeta', state: 'Eastern Equatoria', aliases: ['kapoeta', 'كبويتا'] }),
  airstrip({
    icao: 'HSTR', name: 'Torit Airport', city: 'Torit', state: 'Eastern Equatoria', aliases: ['torit', 'توريت'],
    nearbyTowns: [{ name: 'Lafon', nameAr: 'لافون', aliases: ['lafon', 'lafone', 'لافون'] }],
  }),
  airstrip({ icao: 'HSYA', name: 'Yambio Airport', city: 'Yambio', state: 'Western Equatoria', aliases: ['yambio', 'يامبيو'] }),
  airstrip({ icao: 'HSYE', name: 'Yei Airport', city: 'Yei', state: 'Central Equatoria', aliases: ['yei', 'ياي'] }),
  airstrip({ icao: 'HSBR', name: 'Bor Airport', city: 'Bor', state: 'Jonglei', aliases: ['bor', 'بور'] }),
  airstrip({ icao: 'HSPI', name: 'Pibor Airport', city: 'Pibor', state: 'Greater Pibor Administrative Area', aliases: ['pibor', 'بيبور'] }),
  airstrip({ icao: 'HSPA', name: 'Pochalla Airport', city: 'Pochalla', state: 'Greater Pibor Administrative Area', aliases: ['pochalla', 'pachalla', 'pochala', 'بوشالا'] }),
  airstrip({ icao: 'HSMD', name: 'Maridi Airport', city: 'Maridi', state: 'Western Equatoria', aliases: ['maridi', 'مريدي'] }),
  airstrip({ icao: 'HSRN', name: 'Renk Airport', city: 'Renk', state: 'Upper Nile', aliases: ['renk', 'الرنك', 'رنك'] }),
  airstrip({
    icao: 'HSBT', name: 'Bentiu Airport', city: 'Bentiu', state: 'Unity', aliases: ['bentiu', 'بانتيو', 'بنتيو'],
    nearbyTowns: [{ name: 'Ruweng (Panrieng)', nameAr: 'رووينق', aliases: ['rweng', 'ruweng', 'panrieng', 'pariang', 'رووينق', 'روينق', 'فاريانق'] }],
  }),
  airstrip({ icao: 'HJKJ', name: 'Kuajok Airstrip', city: 'Kuajok', state: 'Warrap', aliases: ['kuajok', 'kuacjok', 'kwajok', 'كواجوك'] }),
  airstrip({ icao: 'HSAW', name: 'Aweil Airport', city: 'Aweil', state: 'Northern Bahr el Ghazal', aliases: ['aweil', 'awiel', 'أويل', 'اويل'] }),
  {
    iata: iata('NBO'),
    name: 'Jomo Kenyatta International Airport',
    city: 'Nairobi',
    country: 'Kenya',
    countryCode: 'KE',
    timeZone: 'Africa/Nairobi',
    isDomestic: false,
    aliases: ['nairobi', 'نيروبي'],
  },
  {
    iata: iata('EBB'),
    name: 'Entebbe International Airport',
    city: 'Entebbe (Kampala)',
    country: 'Uganda',
    countryCode: 'UG',
    timeZone: 'Africa/Kampala',
    isDomestic: false,
    aliases: ['entebbe', 'kampala', 'كمبالا', 'عنتيبي'],
  },
  {
    iata: iata('ADD'),
    name: 'Addis Ababa Bole International Airport',
    city: 'Addis Ababa',
    country: 'Ethiopia',
    countryCode: 'ET',
    timeZone: 'Africa/Addis_Ababa',
    isDomestic: false,
    aliases: ['addis', 'addis ababa', 'أديس أبابا'],
  },
  {
    iata: iata('KGL'),
    name: 'Kigali International Airport',
    city: 'Kigali',
    country: 'Rwanda',
    countryCode: 'RW',
    timeZone: 'Africa/Kigali',
    isDomestic: false,
    aliases: ['kigali', 'كيغالي'],
  },
  {
    iata: iata('CAI'),
    name: 'Cairo International Airport',
    city: 'Cairo',
    country: 'Egypt',
    countryCode: 'EG',
    timeZone: 'Africa/Cairo',
    isDomestic: false,
    aliases: ['cairo', 'القاهرة'],
  },
  {
    iata: iata('DXB'),
    name: 'Dubai International Airport',
    city: 'Dubai',
    country: 'United Arab Emirates',
    countryCode: 'AE',
    timeZone: 'Asia/Dubai',
    isDomestic: false,
    aliases: ['dubai', 'دبي'],
  },
  {
    iata: iata('IST'),
    name: 'Istanbul Airport',
    city: 'Istanbul',
    country: 'Türkiye',
    countryCode: 'TR',
    timeZone: 'Europe/Istanbul',
    isDomestic: false,
    aliases: ['istanbul', 'إسطنبول'],
  },
];

const BY_CODE = new Map(AIRPORTS.map((a) => [a.iata as string, a]));

export function findAirportByCode(code: string): Airport | undefined {
  return BY_CODE.get(code.trim().toUpperCase());
}

export interface PlaceMatch {
  airport: Airport;
  /** Set when the query named a town without an airstrip that is reached from `airport` by road. */
  viaTown?: NearbyTown;
}

const norm = (v: string): string => v.trim().toLowerCase();

/**
 * Resolves free text ("juba", "Bor", "JUB", "HSBR", "نيروبي", "Lafon") to
 * airports. Exact names win over partial ones, so "Bor" does not also match
 * "Pibor". Returns every match so the caller can ask the traveller to choose.
 */
export function resolvePlaces(query: string): PlaceMatch[] {
  const q = norm(query);
  if (q.length === 0) return [];
  const byCode = findAirportByCode(q);
  if (byCode) return [{ airport: byCode }];

  const exact: PlaceMatch[] = [];
  for (const airport of AIRPORTS) {
    if (norm(airport.city) === q || norm(airport.name) === q || airport.aliases.some((a) => norm(a) === q)) exact.push({ airport });
    for (const town of airport.nearbyTowns ?? []) {
      if (norm(town.name) === q || town.aliases.some((a) => norm(a) === q)) exact.push({ airport, viaTown: town });
    }
  }
  if (exact.length > 0) return exact;

  return AIRPORTS.filter(
    (a) => a.city.toLowerCase().includes(q) || a.name.toLowerCase().includes(q) || a.aliases.some((alias) => alias.includes(q)),
  ).map((airport) => ({ airport }));
}

/** Airports for free text; see `resolvePlaces` for whether a town was reached by road. */
export function resolveAirports(query: string): Airport[] {
  return [...new Set(resolvePlaces(query).map((m) => m.airport))];
}
