/**
 * A minimal PDF 1.4 writer for simple documents (the e-ticket receipt): text in
 * the standard Helvetica fonts, filled rectangles and lines, on A4 pages. No
 * dependencies and nothing to install. Text uses WinAnsi encoding, so it covers
 * Latin letters (passenger names must be Latin for airlines anyway); other
 * characters are replaced. Coordinates are in points from the top-left.
 */

export const A4 = { width: 595.28, height: 841.89 } as const;

type Rgb = readonly [number, number, number];
export interface TextStyle {
  size?: number;
  bold?: boolean;
  color?: Rgb;
}

// Helvetica glyph widths (1/1000 em) for ASCII 32–126, from the standard AFM metrics.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
const HELV_BOLD = [278,333,474,556,556,889,722,238,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,333,333,584,584,584,611,975,722,722,722,722,667,611,778,722,278,556,722,611,833,722,778,667,778,722,667,611,722,667,944,667,667,611,333,278,333,584,556,333,556,611,556,611,556,333,611,611,278,278,556,278,889,611,611,611,611,389,556,333,611,556,778,556,556,500,389,280,389,584];

/** Unicode characters WinAnsi places in 0x80–0x9F. */
const WIN_ANSI_EXTRA: Record<string, number> = { '€': 0x80, '‚': 0x82, '„': 0x84, '…': 0x85, '•': 0x95, '–': 0x96, '—': 0x97, '‘': 0x91, '’': 0x92, '“': 0x93, '”': 0x94, '™': 0x99 };

function toWinAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s.replaceAll('→', '-').replaceAll('✓', '')) {
    const extra = WIN_ANSI_EXTRA[ch];
    const code = ch.codePointAt(0) ?? 63;
    if (extra !== undefined) out.push(extra);
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out.push(code);
    else out.push(63); // "?"
  }
  return out;
}

function escapeText(bytes: number[]): string {
  return bytes
    .map((b) => (b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b < 0x20 || b > 0x7e ? `\\${b.toString(8).padStart(3, '0')}` : String.fromCharCode(b)))
    .join('');
}

export function textWidth(s: string, size: number, bold = false): number {
  const table = bold ? HELV_BOLD : HELV;
  return toWinAnsi(s).reduce((w, b) => w + (b >= 32 && b <= 126 ? (table[b - 32] ?? 556) : 556), 0) * (size / 1000);
}

/** Splits text into lines no wider than `width`. */
export function wrap(s: string, width: number, size: number, bold = false): string[] {
  const lines: string[] = [];
  for (const para of s.split('\n')) {
    let line = '';
    for (const word of para.split(/\s+/).filter(Boolean)) {
      const next = line ? `${line} ${word}` : word;
      if (textWidth(next, size, bold) <= width || !line) line = next;
      else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

const n = (v: number) => (Math.round(v * 100) / 100).toString();
const rgb = (c: Rgb) => c.map((x) => n(x / 255)).join(' ');

export class PdfDocument {
  private readonly pages: string[][] = [];
  private ops: string[] = [];

  constructor(private readonly meta: { title: string; author: string }) {
    this.addPage();
  }

  addPage(): void {
    this.ops = [];
    this.pages.push(this.ops);
  }

  text(x: number, y: number, s: string, style: TextStyle = {}): void {
    const size = style.size ?? 10;
    this.ops.push(`BT /${style.bold ? 'F2' : 'F1'} ${n(size)} Tf ${rgb(style.color ?? [17, 24, 39])} rg ${n(x)} ${n(A4.height - y)} Td (${escapeText(toWinAnsi(s))}) Tj ET`);
  }

  /** Right-aligned text ending at x. */
  textRight(x: number, y: number, s: string, style: TextStyle = {}): void {
    this.text(x - textWidth(s, style.size ?? 10, style.bold), y, s, style);
  }

  rect(x: number, y: number, w: number, h: number, fill: Rgb): void {
    this.ops.push(`${rgb(fill)} rg ${n(x)} ${n(A4.height - y - h)} ${n(w)} ${n(h)} re f`);
  }

  line(x1: number, y1: number, x2: number, y2: number, color: Rgb = [226, 232, 240], width = 1): void {
    this.ops.push(`${rgb(color)} RG ${n(width)} w ${n(x1)} ${n(A4.height - y1)} m ${n(x2)} ${n(A4.height - y2)} l S`);
  }

  toBuffer(): Buffer {
    const objects: string[] = [];
    const add = (body: string) => objects.push(body); // object number = index + 1
    add('<< /Type /Catalog /Pages 2 0 R >>');
    add(''); // pages tree, filled below
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    const pageRefs: number[] = [];
    for (const ops of this.pages) {
      const content = ops.join('\n');
      add(`<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`);
      const contentRef = objects.length;
      add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(A4.width)} ${n(A4.height)}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentRef} 0 R >>`);
      pageRefs.push(objects.length);
    }
    objects[1] = `<< /Type /Pages /Kids [${pageRefs.map((r) => `${r} 0 R`).join(' ')}] /Count ${pageRefs.length} >>`;
    const info = `<< /Title (${escapeText(toWinAnsi(this.meta.title))}) /Author (${escapeText(toWinAnsi(this.meta.author))}) /Producer (BluckFlies) >>`;
    add(info);
    const infoRef = objects.length;

    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets: number[] = [];
    objects.forEach((body, i) => {
      offsets.push(Buffer.byteLength(out, 'latin1'));
      out += `${i + 1} 0 obj\n${body}\nendobj\n`;
    });
    const xref = Buffer.byteLength(out, 'latin1');
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info ${infoRef} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(out, 'latin1');
  }
}
