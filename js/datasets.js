// Datos precalculados (ver tools/): superficie + semáforos de OSM y rejilla de elevación.
// Se cargan una vez y se indexan por celdas para consultas instantáneas en el navegador.
import { haversine, pointSegDist } from './geo.js';

const CELL = 0.001; // ~110 m

let surfaceP = null;
let elevationP = null;

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`No se pudo cargar ${url} (HTTP ${r.status})`);
  return r.json();
}

// ---------------------------------------------------------------------------
// Superficie y semáforos
// ---------------------------------------------------------------------------
function buildSurfaceIndex(d) {
  const [south, west, north, east] = d.bbox;
  const rows = Math.ceil((north - south) / CELL) + 1;
  const cols = Math.ceil((east - west) / CELL) + 1;
  const cellOf = (lat, lon) => {
    const r = Math.floor((lat - south) / CELL), c = Math.floor((lon - west) / CELL);
    return r < 0 || c < 0 || r >= rows || c >= cols ? -1 : r * cols + c;
  };

  // Segmentos como [lat1, lon1, lat2, lon2, categoría], indexados en todas las celdas de su caja.
  const segs = [];
  const segCells = Array.from({ length: rows * cols }, () => []);
  for (const w of d.ways) {
    const cat = w[0];
    let lat = w[1], lon = w[2];
    for (let i = 3; i < w.length; i += 2) {
      const lat2 = lat + w[i], lon2 = lon + w[i + 1];
      const s = segs.push([lat / 1e5, lon / 1e5, lat2 / 1e5, lon2 / 1e5, cat]) - 1;
      const r0 = Math.floor((Math.min(lat, lat2) / 1e5 - south) / CELL), r1 = Math.floor((Math.max(lat, lat2) / 1e5 - south) / CELL);
      const c0 = Math.floor((Math.min(lon, lon2) / 1e5 - west) / CELL), c1 = Math.floor((Math.max(lon, lon2) / 1e5 - west) / CELL);
      for (let r = Math.max(0, r0); r <= Math.min(rows - 1, r1); r++) {
        for (let c = Math.max(0, c0); c <= Math.min(cols - 1, c1); c++) segCells[r * cols + c].push(s);
      }
      lat = lat2; lon = lon2;
    }
  }

  const sigCells = Array.from({ length: rows * cols }, () => []);
  for (let i = 0; i < d.signals.length; i += 2) {
    const p = [d.signals[i] / 1e5, d.signals[i + 1] / 1e5];
    const k = cellOf(p[0], p[1]);
    if (k >= 0) sigCells[k].push(p);
  }

  const neighbours = (p) => {
    const k = cellOf(p[0], p[1]);
    if (k < 0) return null;
    const r = Math.floor(k / cols), c = k % cols, out = [];
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      if (r + dr >= 0 && r + dr < rows && c + dc >= 0 && c + dc < cols) out.push((r + dr) * cols + c + dc);
    }
    return out;
  };

  // Metros de senda verde (parque/tierra) por celda: mide cuánto "parque" hay alrededor.
  const greenLen = new Float64Array(rows * cols);
  for (const g of segs) {
    if (d.cats[g[4]] === 'asfalto') continue;
    const k = cellOf((g[0] + g[2]) / 2, (g[1] + g[3]) / 2);
    if (k >= 0) greenLen[k] += haversine([g[0], g[1]], [g[2], g[3]]) * (d.cats[g[4]] === 'tierra' ? 1.3 : 1);
  }
  const density = (r, c) => {
    let sum = 0;
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const rr = r + dr, cc = c + dc;
      if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) sum += greenLen[rr * cols + cc];
    }
    return sum;
  };
  const project = (p, a, b) => {
    const k = Math.cos((p[0] * Math.PI) / 180);
    const dx = (b[1] - a[1]) * k, dy = b[0] - a[0];
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (((p[1] - a[1]) * k) * dx + (p[0] - a[0]) * dy) / len2));
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  return {
    cats: d.cats,
    bbox: d.bbox,
    // "Imán verde": dentro de `radius` m, elige la celda con más sendas de parque/tierra
    // alrededor (penalizando la distancia) y devuelve el punto de senda verde más cercano.
    greenSnap(p, radius) {
      const k0 = cellOf(p[0], p[1]);
      if (k0 < 0) return null;
      const r0 = Math.floor(k0 / cols), c0 = k0 % cols;
      const span = Math.ceil(radius / 85);
      let bestCell = -1, bestScore = -Infinity;
      for (let r = r0 - span; r <= r0 + span; r++) for (let c = c0 - span; c <= c0 + span; c++) {
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        const center = [south + (r + 0.5) * CELL, west + (c + 0.5) * CELL];
        const dist = haversine(p, center);
        if (dist > radius) continue;
        const score = density(r, c) - 2 * dist;
        if (score > bestScore) { bestScore = score; bestCell = r * cols + c; }
      }
      if (bestCell < 0 || density(Math.floor(bestCell / cols), bestCell % cols) < 150) return p; // sin parque cerca
      const target = [south + (Math.floor(bestCell / cols) + 0.5) * CELL, west + ((bestCell % cols) + 0.5) * CELL];
      let best = null, bestD = Infinity;
      for (const k of neighbours(target)) for (const s of segCells[k]) {
        const g = segs[s];
        if (d.cats[g[4]] === 'asfalto') continue;
        const q = project(target, [g[0], g[1]], [g[2], g[3]]);
        const dist = haversine(target, q);
        if (dist < bestD) { bestD = dist; best = q; }
      }
      return best ?? p;
    },
    // Categoría de la vía más cercana (< 25 m); null si el punto está fuera de la zona.
    classify(p) {
      const cells = neighbours(p);
      if (!cells) return null;
      let best = -1, bestD = 25;
      for (const k of cells) for (const s of segCells[k]) {
        const g = segs[s];
        const dist = pointSegDist(p, [g[0], g[1]], [g[2], g[3]]);
        if (dist < bestD) { bestD = dist; best = g[4]; }
      }
      return best < 0 ? 'asfalto' : d.cats[best];
    },
    // Semáforos a < `radius` m del trazado, agrupados (un cruce = varios nodos en 40 m).
    signalsAlong(samples, radius = 12) {
      const clusters = [];
      const seen = new Set();
      for (const p of samples) {
        for (const k of neighbours(p) ?? []) for (const sgn of sigCells[k]) {
          if (seen.has(sgn) || haversine(p, sgn) >= radius) continue;
          seen.add(sgn);
          if (clusters.every((cl) => haversine(cl, sgn) > 40)) clusters.push(sgn);
        }
      }
      return clusters;
    },
  };
}

export function loadSurface() {
  surfaceP ??= getJSON('data/surface.json').then(buildSurfaceIndex);
  return surfaceP;
}

// ---------------------------------------------------------------------------
// Elevación: interpolación bilineal sobre la rejilla
// ---------------------------------------------------------------------------
function buildElevation(d) {
  const at = (r, c) => d.dm[r * d.cols + c] / 10;
  return {
    elevation([lat, lon]) {
      const y = (lat - d.south) / d.step, x = (lon - d.west) / d.step;
      if (y < 0 || x < 0 || y > d.rows - 1 || x > d.cols - 1) return null;
      const r = Math.min(d.rows - 2, Math.floor(y)), c = Math.min(d.cols - 2, Math.floor(x));
      const fy = y - r, fx = x - c;
      return (at(r, c) * (1 - fx) + at(r, c + 1) * fx) * (1 - fy) + (at(r + 1, c) * (1 - fx) + at(r + 1, c + 1) * fx) * fy;
    },
  };
}

export function loadElevation() {
  elevationP ??= getJSON('data/elevation.json').then(buildElevation);
  return elevationP;
}
