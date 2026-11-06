// Schematic route sketch: airports placed by coordinates, legs drawn as arcs.
// No map tiles or external assets (the page's CSP allows none).

import { AIRPORTS, cityOf } from './airports.js';
import { svgEl } from './dom.js';

let uid = 0;
const BLUE = '#2457e6';
const INK = '#111c3f';
const MUTED = '#4f5b80';
const PLANE = 'M11 0 L-5 -1.7 L-8 -7 L-10.5 -7 L-8.6 -1.4 L-12 -1 L-13.4 -3.6 L-15 -3.6 L-14.2 0 L-15 3.6 L-13.4 3.6 L-12 1 L-8.6 1.4 L-10.5 7 L-8 7 L-5 1.7 Z';

/**
 * @param {string[]} codes airports in order of travel (origin, connections, destination)
 * @param {{ width?: number, height?: number, compact?: boolean }} opts
 * @returns {SVGSVGElement | null} null when an airport has no known position
 */
export function routeMap(codes, { width = 400, height = 220, compact = false } = {}) {
  const stops = codes.filter((c, i) => c !== codes[i - 1]);
  const points = stops.map((c) => AIRPORTS[c]);
  if (stops.length < 2 || points.some((p) => !p)) return null;

  // Equirectangular projection, corrected for latitude, then fitted into the box.
  const meanLat = points.reduce((s, p) => s + p.lat, 0) / points.length;
  const k = Math.cos((meanLat * Math.PI) / 180);
  const raw = points.map((p) => ({ x: p.lon * k, y: -p.lat }));
  const span = (axis) => {
    const vals = raw.map((r) => r[axis]);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const size = Math.max(max - min, compact ? 5 : 4); // keep short domestic hops from filling the whole box
    const mid = (min + max) / 2;
    return { min: mid - size / 2, size };
  };
  const sx = span('x');
  const sy = span('y');
  const pad = compact ? 0.22 : 0.18;
  const scale = Math.min((width * (1 - 2 * pad)) / sx.size, (height * (1 - 2 * pad)) / sy.size);
  const ox = (width - sx.size * scale) / 2;
  const oy = (height - sy.size * scale) / 2;
  const pts = raw.map((r) => ({ x: ox + (r.x - sx.min) * scale, y: oy + (r.y - sy.min) * scale }));

  const id = `rm${++uid}`;
  const svg = svgEl('svg', { viewBox: `0 0 ${width} ${height}`, width: '100%', direction: 'ltr', role: 'img', 'aria-label': `Route: ${stops.map(cityOf).join(' to ')}`, class: 'route-map' });
  svg.append(
    svgEl('defs', {}, [
      svgEl('pattern', { id: `${id}-dots`, width: 14, height: 14, patternUnits: 'userSpaceOnUse' }, [svgEl('circle', { cx: 1.5, cy: 1.5, r: 1.1, fill: '#cbd5f0' })]),
    ]),
    svgEl('rect', { width, height, fill: `url(#${id}-dots)`, opacity: 0.7 }),
  );

  // Each leg is a gentle arc bowing upwards, like a great-circle line on a flat map.
  pts.slice(1).forEach((b, i) => {
    const a = pts[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    let nx = -dy / len;
    let ny = dx / len;
    if (ny > 0) { nx = -nx; ny = -ny; }
    const bend = len * 0.22;
    const c = { x: (a.x + b.x) / 2 + nx * bend, y: (a.y + b.y) / 2 + ny * bend };
    const d = `M${a.x.toFixed(1)} ${a.y.toFixed(1)} Q${c.x.toFixed(1)} ${c.y.toFixed(1)} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`;
    svg.append(
      svgEl('path', { d, fill: 'none', stroke: '#dbe4fc', 'stroke-width': compact ? 5 : 7, 'stroke-linecap': 'round' }),
      svgEl('path', { d, fill: 'none', stroke: BLUE, 'stroke-width': compact ? 1.8 : 2.2, 'stroke-dasharray': '1 0', 'stroke-linecap': 'round' }),
    );
    if (i === 0) {
      // Plane at the arc's midpoint, pointing along it (tangent at t=.5 is parallel to a→b).
      const mx = 0.25 * a.x + 0.5 * c.x + 0.25 * b.x;
      const my = 0.25 * a.y + 0.5 * c.y + 0.25 * b.y;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      const s = compact ? 0.75 : 1;
      svg.append(
        svgEl('circle', { cx: mx, cy: my, r: 13 * s, fill: '#ffffff', stroke: '#dbe4fc' }),
        svgEl('path', { d: PLANE, fill: BLUE, transform: `translate(${mx.toFixed(1)} ${my.toFixed(1)}) rotate(${angle.toFixed(1)}) scale(${0.62 * s})` }),
      );
    }
  });

  pts.forEach((p, i) => {
    const end = i === 0 || i === pts.length - 1;
    svg.append(svgEl('circle', { cx: p.x, cy: p.y, r: end ? 6 : 4.5, fill: end ? BLUE : '#ffffff', stroke: end ? '#ffffff' : BLUE, 'stroke-width': end ? 3 : 2 }));

    // Put each label on the side facing away from the route, so it never sits on the line.
    const prev = pts[i - 1];
    const next = pts[i + 1];
    let vx = (prev ? p.x - prev.x : 0) + (next ? p.x - next.x : 0);
    let vy = (prev ? p.y - prev.y : 0) + (next ? p.y - next.y : 0);
    if (prev && next) {
      // A connecting airport: label perpendicular to its legs, on the upper side.
      vx = -(next.y - prev.y);
      vy = next.x - prev.x;
      if (vy > 0) { vx = -vx; vy = -vy; }
      if (vx === 0 && vy === 0) vy = -1;
    }
    const len = Math.hypot(vx, vy) || 1;
    vx /= len; vy /= len;
    const gap = compact ? 12 : 14;
    const anchor = vx > 0.35 ? 'start' : vx < -0.35 ? 'end' : 'middle';
    const lx = p.x + vx * gap;
    const ly = p.y + vy * gap + (vy > 0.35 ? 9 : vy < -0.35 ? -2 : 4);
    // Keep every label inside the drawing: small sketches otherwise cut "JUB" and "NBO" in half.
    const size = compact ? 11 : 13;
    const half = anchor === 'middle' ? 14 : 0;
    const x = Math.min(width - 2 - (anchor === 'start' ? 28 : half), Math.max(2 + (anchor === 'end' ? 28 : half), lx));
    const y = Math.min(height - 3, Math.max(size, ly));
    const label = svgEl('text', { x: x.toFixed(1), y: y.toFixed(1), 'text-anchor': anchor, 'font-size': size, 'font-weight': 700, fill: INK });
    // Airline codes (JUB) are familiar; airstrip codes (HSBR) are not, so those show the town name.
    const familiarCode = /^[A-Z]{3}$/.test(stops[i]);
    label.textContent = familiarCode ? stops[i] : cityOf(stops[i]);
    svg.append(label);
    if (!compact && familiarCode) {
      const city = svgEl('text', { x: x.toFixed(1), y: Math.min(height - 3, Math.max(11, y + (vy < -0.35 ? -15 : 14))).toFixed(1), 'text-anchor': anchor, 'font-size': 11, fill: MUTED });
      city.textContent = cityOf(stops[i]);
      svg.append(city);
    }
  });
  return svg;
}
