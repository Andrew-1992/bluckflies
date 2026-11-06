/**
 * Minimal client for the DPO Pay (Network International) XML API v6:
 * POST {baseUrl}/API/v6/ with an <API3G> document. Responses are flat XML;
 * only the known top-level fields are read.
 *
 * Reference: https://docs.dpopay.com/dpo-pay-by-network/reference/create-token
 * and the verifyToken / refundToken pages of the DPO Public API.
 */

export interface DpoClientOptions {
  baseUrl: string;
  companyToken: string;
  timeoutMs: number;
  fetchImpl?: typeof fetch;
}

export class DpoApiError extends Error {
  constructor(
    /** DPO 3-digit result code, or "network_error" / "http_<status>" / "invalid_response". */
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'DpoApiError';
  }
}

export type DpoFields = Record<string, string>;

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'" };

export function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch] ?? ch);
}

/** Reads the leaf elements of a flat DPO response into a map (first occurrence wins). */
export function parseFlatXml(xml: string): DpoFields {
  const out: DpoFields = {};
  for (const m of xml.matchAll(/<([A-Za-z][A-Za-z0-9]*)>([^<]*)<\/\1>/g)) {
    const [, tag, raw] = m;
    if (tag && raw !== undefined && !(tag in out)) out[tag] = raw.replace(/&(amp|lt|gt|quot|apos);/g, (e) => ENTITIES[e] ?? e).trim();
  }
  return out;
}

/** Builds child elements from a list (keeps order; skips undefined values). */
function elements(fields: ReadonlyArray<readonly [string, string | undefined]>): string {
  return fields
    .filter((f): f is readonly [string, string] => f[1] !== undefined)
    .map(([k, v]) => `<${k}>${xmlEscape(v)}</${k}>`)
    .join('');
}

export class DpoClient {
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: DpoClientOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Hosted payment page for a transaction token. */
  paymentPageUrl(transToken: string): string {
    return `${this.opts.baseUrl}/payv2.php?ID=${encodeURIComponent(transToken)}`;
  }

  /**
   * Sends one API request. `body` is the XML inside <API3G> after the company
   * token and request name. Returns the parsed response fields; the caller
   * interprets `Result`.
   */
  async request(name: string, body: string): Promise<DpoFields> {
    const xml = `<?xml version="1.0" encoding="utf-8"?><API3G><CompanyToken>${xmlEscape(this.opts.companyToken)}</CompanyToken><Request>${name}</Request>${body}</API3G>`;
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.opts.baseUrl}/API/v6/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/xml; charset=utf-8', Accept: 'application/xml' },
        body: xml,
        signal: AbortSignal.timeout(this.opts.timeoutMs),
      });
    } catch (err) {
      throw new DpoApiError('network_error', `DPO ${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await res.text();
    if (!res.ok) throw new DpoApiError(`http_${res.status}`, `DPO ${name}: HTTP ${res.status}`);
    const fields = parseFlatXml(text);
    if (!fields['Result']) throw new DpoApiError('invalid_response', `DPO ${name}: response has no Result`);
    return fields;
  }

  static fields = elements;
}
