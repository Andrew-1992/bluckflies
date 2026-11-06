import { createHash } from 'node:crypto';
import { parseMinorUnits } from '../lib/money.js';

/**
 * Bank statement CSV parsing for matching deposits to bookings. Banks export
 * different columns, so columns are recognised by header name: an incoming
 * amount (credit / deposit / amount), optional currency, optional reference,
 * and every other text column is searched for the booking code.
 */

export interface StatementLine {
  /** Stable id for this line (hash of its content), used to select lines to apply. */
  id: string;
  row: number;
  date?: string;
  /** Incoming amount in minor units; undefined for debits or unreadable amounts. */
  creditMinor?: number;
  currency?: string;
  /** The bank's own reference for the transaction, when the export has one. */
  bankReference?: string;
  /** All text of the line (upper case), searched for booking codes. */
  text: string;
}

export interface ParsedStatement {
  lines: StatementLine[];
  columns: { amount: string; currency?: string; reference?: string; date?: string };
}

export const MAX_STATEMENT_BYTES = 2_000_000;
const MAX_ROWS = 5000;

/** RFC 4180 CSV: quoted fields, escaped quotes, commas/newlines inside quotes, CRLF or LF. */
export function parseCsv(input: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  const text = input.replace(/^﻿/, '');
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      if (row.some((f) => f.trim() !== '')) rows.push(row);
      row = [];
      field = '';
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f.trim() !== '')) rows.push(row);
  return rows;
}

const find = (headers: string[], pattern: RegExp): number => headers.findIndex((h) => pattern.test(h));

/** "USD 1,412.50", "1412.50 CR", "$412.5" → minor units; negatives and debits → undefined. */
function creditAmount(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const s = raw.trim();
  if (/^-|\(.*\)|\bDR\b/i.test(s)) return undefined;
  return parseMinorUnits(s.replace(/[^0-9.,]/g, ''));
}

export function parseStatement(csv: string): ParsedStatement {
  if (Buffer.byteLength(csv, 'utf8') > MAX_STATEMENT_BYTES) throw new Error('The statement file is too large (2 MB at most). Export a shorter date range.');
  const rows = parseCsv(csv);
  const [header, ...body] = rows;
  if (!header || body.length === 0) throw new Error('The statement has no rows. Export it from your bank as CSV with a header row.');
  if (body.length > MAX_ROWS) throw new Error(`The statement has more than ${MAX_ROWS} rows. Export a shorter date range.`);
  const headers = header.map((h) => h.trim().toLowerCase());

  // Prefer an explicit credit / money-in column; otherwise a generic amount column.
  let amountCol = find(headers, /\b(credit|deposit|paid in|money in|cr amount)\b/);
  if (amountCol < 0) amountCol = find(headers, /\bamount\b/);
  if (amountCol < 0) throw new Error('Could not find the amount column. The header must include "Credit", "Deposit" or "Amount".');
  const debitCol = find(headers, /\b(debit|withdrawal|paid out|money out)\b/);
  const currencyCol = find(headers, /\b(currency|ccy)\b/);
  const referenceCol = find(headers, /\b(reference|ref|transaction id|txn id|trans id|receipt)\b/);
  const dateCol = find(headers, /\b(date|value date|posting date)\b/);
  const skip = new Set([amountCol, debitCol, currencyCol].filter((c) => c >= 0));

  const lines = body.map((cells, i): StatementLine => {
    const cell = (c: number) => (c >= 0 ? (cells[c] ?? '').trim() : '');
    const text = cells
      .filter((_, c) => !skip.has(c))
      .join(' ')
      .toUpperCase();
    const creditMinor = creditAmount(cell(amountCol));
    const currency = cell(currencyCol).toUpperCase() || undefined;
    const id = createHash('sha256').update(cells.join('\u0001')).digest('hex').slice(0, 16);
    return {
      id,
      row: i + 2, // 1-based, after the header row
      ...(cell(dateCol) ? { date: cell(dateCol) } : {}),
      ...(creditMinor !== undefined ? { creditMinor } : {}),
      ...(currency ? { currency } : {}),
      ...(cell(referenceCol) ? { bankReference: cell(referenceCol).slice(0, 60) } : {}),
      text,
    };
  });
  return {
    lines,
    columns: {
      amount: header[amountCol]?.trim() ?? '',
      ...(currencyCol >= 0 ? { currency: header[currencyCol]?.trim() ?? '' } : {}),
      ...(referenceCol >= 0 ? { reference: header[referenceCol]?.trim() ?? '' } : {}),
      ...(dateCol >= 0 ? { date: header[dateCol]?.trim() ?? '' } : {}),
    },
  };
}

/** True when the booking code appears as a separate word (not inside a longer code). */
export function mentionsCode(text: string, code: string): boolean {
  return new RegExp(`(^|[^A-Z0-9])${code}([^A-Z0-9]|$)`).test(text);
}
