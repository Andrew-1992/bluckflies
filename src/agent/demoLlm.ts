import { AIRPORTS } from '../data/airports.js';
import type { Airport } from '../domain/types.js';
import type { Clock } from '../lib/clock.js';
import type { AgentBlock, AgentMessage, LlmClient, LlmRequest, LlmResponse } from './llm.js';

/**
 * A stand-in for the AI model, for testing the whole chat (streaming, steps,
 * Stop, flight cards, "talk to a person") before an Anthropic key exists.
 *
 * It is NOT an AI: it recognises two places and a date in a message, runs the
 * real search_flights tool, and summarises the result; "person"/"agent"
 * requests go to the support desk through handoff_to_human. Everything else
 * gets a short explanation. Every reply says it is the demo assistant.
 *
 * Only allowed outside production (AGENT_DEMO=true; config refuses it in
 * production) and only when no ANTHROPIC_API_KEY is set.
 */

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const ARABIC = /[؀-ۿ]/;
const PERSON = /\b(person|human|agent|someone|call me|staff)\b|موظف|شخص|اتصل/i;

const DEMO_TAG = { en: '(Demo assistant, not AI.) ', ar: '(مساعد تجريبي، ليس ذكاءً اصطناعياً.) ' } as const;

const TEXT = {
  en: {
    help: 'I can search flights in this test. Try: "Juba to Nairobi on 20 November", or "Juba to Entebbe tomorrow". You can also ask to talk to a person. Booking through the chat needs the real AI assistant; use the Choose button and the call-back form for now.',
    found: (n: number, from: string, to: string, date: string, cheapest: string) =>
      `I found ${n} flight${n === 1 ? '' : 's'} from ${from} to ${to} on ${date}. The cheapest is ${cheapest}. Tap a flight to see the details.`,
    none: (from: string, to: string, date: string) => `I found no flights from ${from} to ${to} on ${date}. Try another day, or ask to talk to a person.`,
    failed: (msg: string) => `I could not search that: ${msg}`,
    handoff: 'I have passed your request to the BluckFlies team. Someone will contact you.',
    handoffFailed: (msg: string) => `I could not reach the team: ${msg}`,
    lookFlights: 'Let me look for flights.',
    passing: 'Let me pass you to our team.',
  },
  ar: {
    help: 'يمكنني البحث عن رحلات في هذه التجربة. جرّب: "من جوبا إلى نيروبي يوم 20 نوفمبر" أو "من جوبا إلى عنتيبي غداً". ويمكنك أن تطلب التحدث مع موظف. الحجز عبر المحادثة يحتاج المساعد الذكي الحقيقي؛ استخدم زر الاختيار ونموذج طلب الاتصال الآن.',
    found: (n: number, from: string, to: string, date: string, cheapest: string) =>
      `وجدت ${n} رحلات من ${from} إلى ${to} يوم ${date}. الأرخص ${cheapest}. اضغط على رحلة لرؤية التفاصيل.`,
    none: (from: string, to: string, date: string) => `لم أجد رحلات من ${from} إلى ${to} يوم ${date}. جرّب يوماً آخر، أو اطلب التحدث مع موظف.`,
    failed: (msg: string) => `لم أتمكن من البحث: ${msg}`,
    handoff: 'حوّلت طلبك إلى فريق بلك فلايز. سيتواصل معك أحد الموظفين.',
    handoffFailed: (msg: string) => `لم أتمكن من الوصول إلى الفريق: ${msg}`,
    lookFlights: 'دعني أبحث عن رحلات.',
    passing: 'سأحوّلك إلى فريقنا.',
  },
} as const;

type Lang = keyof typeof TEXT;

const norm = (s: string): string => s.trim().toLowerCase();

/** Every name an airport answers to: code, city, airport name and aliases (English and Arabic). */
const NAMES: Array<{ name: string; airport: Airport }> = AIRPORTS.flatMap((a) =>
  [a.iata, a.city, a.name, ...a.aliases].map((n) => ({ name: norm(n), airport: a })),
);

/** Places named in the text, in the order they appear (whole words only, so "to" never matches "Toronto"). */
export function placesIn(text: string): Airport[] {
  const words = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const found: Array<{ at: number; airport: Airport }> = [];
  for (let i = 0; i < words.length; i++) {
    for (const size of [3, 2, 1]) {
      const phrase = words.slice(i, i + size).join(' ');
      // Arabic place names often carry a prefix: "إلى نيروبي" is two words, "لنيروبي" is one.
      const hit = NAMES.find((n) => n.name === phrase) ?? (size === 1 ? NAMES.find((n) => /[؀-ۿ]/.test(n.name) && phrase.length > n.name.length && phrase.endsWith(n.name)) : undefined);
      if (hit) {
        if (!found.some((f) => f.airport === hit.airport)) found.push({ at: i, airport: hit.airport });
        i += size - 1;
        break;
      }
    }
  }
  return found.sort((a, b) => a.at - b.at).map((f) => f.airport);
}

/** "2026-11-20", "20 November", "November 20", "today", "tomorrow" (also Arabic); otherwise a week from today. */
export function dateIn(text: string, today: Date): string {
  const iso = text.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const day = (offset: number) => new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + offset)).toISOString().slice(0, 10);
  if (/\btomorrow\b|غد/i.test(text)) return day(1);
  if (/\btoday\b|اليوم/i.test(text)) return day(0);
  const lower = text.toLowerCase();
  for (let m = 0; m < 12; m++) {
    const name = MONTHS[m] ?? '';
    const re = new RegExp(`(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(?:${name}|${name.slice(0, 3)})\\b|\\b(?:${name}|${name.slice(0, 3)})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`);
    const hit = lower.match(re);
    const d = Number(hit?.[1] ?? hit?.[2]);
    if (hit && d >= 1 && d <= 31) {
      let year = today.getUTCFullYear();
      if (Date.UTC(year, m, d) < Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) year += 1;
      return new Date(Date.UTC(year, m, d)).toISOString().slice(0, 10);
    }
  }
  return day(7);
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); }, { once: true });
  });

export class DemoLlmClient implements LlmClient {
  /** Pause between streamed pieces; 0 in tests. */
  constructor(private readonly clock: Clock, private readonly pieceDelayMs = 40) {}

  async createMessage(req: LlmRequest): Promise<LlmResponse> {
    const last = req.messages.at(-1);
    const question = lastTravellerText(req.messages);
    const lang: Lang = ARABIC.test(question) ? 'ar' : 'en';
    const t = TEXT[lang];

    // After a tool ran: describe its result.
    if (last?.role === 'user' && Array.isArray(last.content)) {
      const result = last.content.find((b): b is Extract<AgentBlock, { type: 'tool_result' }> => b.type === 'tool_result');
      const call = toolCallFor(req.messages, result?.tool_use_id);
      if (result && call) return this.say(req, lang, describe(call.name, result, lang));
    }

    if (PERSON.test(question)) {
      return this.useTool(req, t.passing, 'handoff_to_human', {
        reason: 'traveller_request',
        summary: `Traveller asked for a person (demo assistant). They wrote: "${question.slice(0, 500)}"`,
      });
    }

    const places = placesIn(question);
    const juba = AIRPORTS.find((a) => a.iata === 'JUB');
    const [from, to] = places.length >= 2 ? places : places.length === 1 && juba && places[0] !== juba ? [juba, places[0]] : [];
    if (from && to) {
      return this.useTool(req, t.lookFlights, 'search_flights', {
        origin: from.iata,
        destination: to.iata,
        departure_date: dateIn(question, this.clock.now()),
      });
    }
    return this.say(req, lang, t.help);
  }

  private async useTool(req: LlmRequest, note: string, name: string, input: Record<string, unknown>): Promise<LlmResponse> {
    await this.stream(req, note);
    return {
      content: [{ type: 'text', text: note }, { type: 'tool_use', id: `demo_${name}_${this.clock.now().getTime()}`, name, input }],
      stopReason: 'tool_use',
    };
  }

  private async say(req: LlmRequest, lang: Lang, text: string): Promise<LlmResponse> {
    const full = DEMO_TAG[lang] + text;
    await this.stream(req, full);
    return { content: [{ type: 'text', text: full }], stopReason: 'end_turn' };
  }

  /** Writes the text in small pieces like a real model; Stop (the signal) ends it. */
  private async stream(req: LlmRequest, text: string): Promise<void> {
    if (!req.onText) return;
    for (const piece of text.match(/\S+\s*/g) ?? [text]) {
      if (this.pieceDelayMs > 0) await sleep(this.pieceDelayMs, req.signal);
      else if (req.signal?.aborted) throw new Error('aborted');
      req.onText(piece);
    }
  }
}

/** "Nairobi" (or its Arabic name when the traveller writes Arabic), from an airport code. */
function cityName(code: string, lang: Lang): string {
  const airport = AIRPORTS.find((a) => a.iata === code);
  if (!airport) return code;
  return lang === 'ar' ? (airport.aliases.find((n) => ARABIC.test(n)) ?? airport.city) : airport.city;
}

/** "Friday 20 November" / "الجمعة 20 نوفمبر" from 2026-11-20. */
function readableDate(iso: string, lang: Lang): string {
  const d = new Date(`${iso}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(lang === 'ar' ? 'ar-u-nu-latn' : 'en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
}

function lastTravellerText(messages: AgentMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m?.role === 'user' && typeof m.content === 'string') return m.content;
  }
  return '';
}

function toolCallFor(messages: AgentMessage[], id: string | undefined): Extract<AgentBlock, { type: 'tool_use' }> | undefined {
  if (!id) return undefined;
  for (const m of messages) {
    if (m.role !== 'assistant' || typeof m.content === 'string') continue;
    const call = m.content.find((b): b is Extract<AgentBlock, { type: 'tool_use' }> => b.type === 'tool_use' && b.id === id);
    if (call) return call;
  }
  return undefined;
}

function describe(tool: string, result: Extract<AgentBlock, { type: 'tool_result' }>, lang: Lang): string {
  const t = TEXT[lang];
  let data: unknown;
  try {
    data = JSON.parse(result.content);
  } catch {
    data = {};
  }
  const message = (data as { message?: unknown }).message;
  if (result.is_error) return tool === 'handoff_to_human' ? t.handoffFailed(String(message ?? '')) : t.failed(String(message ?? ''));
  if (tool === 'handoff_to_human') return t.handoff;
  const s = data as { origin?: { code?: string }; destination?: { code?: string }; departureDate?: string; offers?: Array<{ price?: string; airline?: string; tags?: string[] }> };
  const from = cityName(s.origin?.code ?? '', lang);
  const to = cityName(s.destination?.code ?? '', lang);
  const date = readableDate(s.departureDate ?? '', lang);
  const offers = s.offers ?? [];
  if (offers.length === 0) return t.none(from, to, date);
  const cheapest = offers.find((o) => o.tags?.includes('cheapest')) ?? offers[0];
  return t.found(offers.length, from, to, date, `${cheapest?.price ?? ''}${cheapest?.airline ? ` (${cheapest.airline})` : ''}`);
}
