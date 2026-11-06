/**
 * CSV for spreadsheets (RFC 4180). Cells that a spreadsheet would treat as a
 * formula (=, +, -, @, tab, carriage return) are prefixed with an apostrophe,
 * so data typed by travellers can never run as a formula in Excel or Sheets.
 * Numbers passed as numbers are written as-is.
 */

export type Cell = string | number | undefined | null;

function cell(v: Cell): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  const safe = /^[=+\-@\t\r]/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

/** A CSV document with a header row; starts with a BOM so Excel reads UTF-8 (Arabic names, "–"). */
export function toCsv(header: readonly string[], rows: readonly (readonly Cell[])[]): string {
  return `﻿${[header, ...rows].map((r) => r.map(cell).join(',')).join('\r\n')}\r\n`;
}
