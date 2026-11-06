// Display data for the airports BluckFlies serves (mirrors src/data/airports.ts).
// Coordinates are used only to draw route sketches; they are approximate.

import { getLang, t } from './i18n.js';

export const AIRPORTS = {
  JUB: { city: 'Juba', ar: 'جوبا', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 4.87, lon: 31.6, domestic: true },
  WUU: { city: 'Wau', ar: 'واو', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 7.73, lon: 27.98, domestic: true },
  MAK: { city: 'Malakal', ar: 'ملكال', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 9.56, lon: 31.65, domestic: true },
  RBX: { city: 'Rumbek', ar: 'رمبيك', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 6.83, lon: 29.67, domestic: true },
  // Town airstrips (4-letter ICAO codes; they have no IATA code).
  HSKP: { city: 'Kapoeta', ar: 'كبويتا', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 4.77, lon: 33.59, domestic: true, airstrip: true },
  HSTR: { city: 'Torit', ar: 'توريت', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 4.41, lon: 32.57, domestic: true, airstrip: true },
  HSYA: { city: 'Yambio', ar: 'يامبيو', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 4.57, lon: 28.4, domestic: true, airstrip: true },
  HSYE: { city: 'Yei', ar: 'ياي', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 4.09, lon: 30.68, domestic: true, airstrip: true },
  HSBR: { city: 'Bor', ar: 'بور', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 6.21, lon: 31.56, domestic: true, airstrip: true },
  HSPI: { city: 'Pibor', ar: 'بيبور', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 6.8, lon: 33.13, domestic: true, airstrip: true },
  HSPA: { city: 'Pochalla', ar: 'بوشالا', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 7.18, lon: 34.1, domestic: true, airstrip: true },
  HSMD: { city: 'Maridi', ar: 'مريدي', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 4.92, lon: 29.47, domestic: true, airstrip: true },
  HSRN: { city: 'Renk', ar: 'الرنك', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 11.75, lon: 32.8, domestic: true, airstrip: true },
  HSBT: { city: 'Bentiu', ar: 'بانتيو', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 9.23, lon: 29.8, domestic: true, airstrip: true },
  HJKJ: { city: 'Kuajok', ar: 'كواجوك', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 8.3, lon: 27.98, domestic: true, airstrip: true },
  HSAW: { city: 'Aweil', ar: 'أويل', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 8.77, lon: 27.4, domestic: true, airstrip: true },
  // Towns without an airstrip: travellers fly to `via`, then continue by road.
  LAFON: { city: 'Lafon', ar: 'لافون', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 5.05, lon: 32.47, domestic: true, via: 'HSTR' },
  RUWENG: { city: 'Ruweng', ar: 'رووينق', country: 'South Sudan', countryAr: 'جنوب السودان', lat: 9.91, lon: 29.98, domestic: true, via: 'HSBT' },
  NBO: { city: 'Nairobi', ar: 'نيروبي', country: 'Kenya', countryAr: 'كينيا', lat: -1.32, lon: 36.93 },
  EBB: { city: 'Entebbe', ar: 'عنتيبي', country: 'Uganda', countryAr: 'أوغندا', lat: 0.04, lon: 32.44 },
  ADD: { city: 'Addis Ababa', ar: 'أديس أبابا', country: 'Ethiopia', countryAr: 'إثيوبيا', lat: 8.98, lon: 38.8 },
  KGL: { city: 'Kigali', ar: 'كيغالي', country: 'Rwanda', countryAr: 'رواندا', lat: -1.97, lon: 30.14 },
  CAI: { city: 'Cairo', ar: 'القاهرة', country: 'Egypt', countryAr: 'مصر', lat: 30.12, lon: 31.41 },
  DXB: { city: 'Dubai', ar: 'دبي', country: 'UAE', countryAr: 'الإمارات', lat: 25.25, lon: 55.36 },
  IST: { city: 'Istanbul', ar: 'إسطنبول', country: 'Türkiye', countryAr: 'تركيا', lat: 41.26, lon: 28.74 },
};

/** City name in the interface language; unknown codes are shown as-is. */
export function cityOf(code) {
  const a = AIRPORTS[code];
  if (!a) return code;
  return getLang() === 'ar' ? a.ar : a.city;
}

export function countryOf(code) {
  const a = AIRPORTS[code];
  if (!a) return '';
  return getLang() === 'ar' ? a.countryAr : a.country;
}

/** Codes of places in South Sudan, airports and towns, in display order. */
export const SOUTH_SUDAN = Object.keys(AIRPORTS).filter((c) => AIRPORTS[c].domestic);

/** Second line under a place name: the country, or how a town without an airstrip is reached. */
export function placeNote(code) {
  const a = AIRPORTS[code];
  if (!a) return '';
  if (a.via) return t('viaRoad', { city: cityOf(a.via) });
  return countryOf(code);
}
