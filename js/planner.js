// Planificador de bucles aleatorios: cada ruta sale y vuelve a Noviciado pasando por
// 3 puntos colocados al azar en un círculo, atraídos hacia parques, y escalados para
// quedar justo por debajo de la distancia pedida (nunca por encima de 10 km).
import { MAX_KM, ORIGIN, LANDMARKS, INTENSITIES } from './config.js';
import { haversine, resample } from './geo.js';
import { routeFoot, elevations } from './api.js';
import { loadSurface, loadElevation } from './datasets.js';

const SAMPLE_M = 20;         // resolución de la telemetría
const ELEV_EVERY = 5;        // elevación cada 5 muestras (100 m ≈ resolución del DEM)
const CANDIDATES = 4;        // bucles distintos por generación (uno por cuadrante)
const DETOUR = 1.3;          // ruta real a pie ≈ 1,3 × perímetro geométrico (calles, rodeos)

const O = [ORIGIN.lat, ORIGIN.lon];
const COMPASS = ['norte', 'noreste', 'este', 'sureste', 'sur', 'suroeste', 'oeste', 'noroeste'];

// Generador pseudoaleatorio con semilla (mulberry32): la misma semilla da la misma ruta.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Desplaza `p` en km (este, norte).
const offset = ([lat, lon], eastKm, northKm) => [
  lat + northKm / 110.574,
  lon + eastKm / (111.32 * Math.cos((lat * Math.PI) / 180)),
];

// ---------------------------------------------------------------------------
// Forma del bucle: círculo que pasa por Noviciado, con centro en la dirección `bearing`.
// Los 3 puntos de paso se reparten por el círculo con algo de ruido (ángulo y radio),
// así cada bucle es distinto. La forma es fija; solo cambia la escala `r` (km).
// ---------------------------------------------------------------------------
function makeShape(bearing, rand) {
  return {
    bearing,
    jitter: [0, 1, 2].map(() => (rand() - 0.5) * 0.6),       // ±17° por punto
    stretch: [0, 1, 2].map(() => 0.85 + rand() * 0.3),       // ±15 % de radio
  };
}

function rawWaypoints(shape, r) {
  const center = offset(O, r * Math.sin(shape.bearing), r * Math.cos(shape.bearing));
  const back = shape.bearing + Math.PI; // Noviciado está en este ángulo visto desde el centro
  return [1, 2, 3].map((j, i) => {
    const a = back + (j * Math.PI) / 2 + shape.jitter[i];
    const rr = r * shape.stretch[i];
    return offset(center, rr * Math.sin(a), rr * Math.cos(a));
  });
}

// ---------------------------------------------------------------------------
// Calibración: la distancia crece casi proporcionalmente con la escala r, así que
// se estima con r ∝ distancia y se afina con secante (3-5 llamadas al router).
// ---------------------------------------------------------------------------
async function calibrate(shape, targetKm, prefs, idx) {
  const limit = Math.min(targetKm, MAX_KM);
  const aim = limit - 0.05;                       // apunta 50 m por debajo del límite

  const make = async (r) => {
    const snapRadius = Math.max(150, Math.min(600, r * 1000 * 0.4));
    const wps = rawWaypoints(shape, r).map((p) => idx.greenSnap(p, snapRadius) ?? p);
    const route = await routeFoot([O, ...wps, O], prefs);
    return { r, wps, route, km: route.distance / 1000 };
  };

  let r = targetKm / (2 * Math.PI * DETOUR);
  let lo = null, hi = null, best = null;
  for (let i = 0; i < 5; i++) {
    const c = await make(r);
    if (c.km <= limit) {
      if (!best || c.km > best.km) best = c;
      if (!lo || c.r > lo.r) lo = c;
      if (limit - c.km < 0.15) break;
    } else if (!hi || c.r < hi.r) {
      hi = c;
    }
    // Siguiente escala: secante si hay cota por ambos lados; si no, proporcional.
    const ref = lo ?? hi;
    r = lo && hi
      ? lo.r + ((aim - lo.km) * (hi.r - lo.r)) / (hi.km - lo.km)
      : ref.r * (aim / ref.km);
    if (lo && hi && (r <= lo.r || r >= hi.r)) r = (lo.r + hi.r) / 2;
  }
  if (!best || best.km < targetKm * 0.9) return null;
  return best;
}

// ---------------------------------------------------------------------------
// Telemetría
// ---------------------------------------------------------------------------
function smooth(values, win = 5) {
  const h = Math.floor(win / 2);
  return values.map((_, i) => {
    const s = values.slice(Math.max(0, i - h), i + h + 1);
    return s.reduce((a, b) => a + b, 0) / s.length;
  });
}

// D+ / D- con histéresis de 2 m: sin esto el ruido del DEM infla el desnivel.
function gainLoss(elev, threshold = 2) {
  let gain = 0, loss = 0, ref = elev[0];
  for (const e of elev.slice(1)) {
    if (e - ref >= threshold) { gain += e - ref; ref = e; }
    else if (ref - e >= threshold) { loss += ref - e; ref = e; }
  }
  return { gain, loss };
}

async function addElevation(c) {
  const elevPts = c.samples.filter((_, i) => i % ELEV_EVERY === 0);
  let raw;
  try {
    const grid = await loadElevation();         // rejilla local precalculada (instantáneo)
    raw = elevPts.map((p) => grid.elevation(p));
    if (raw.some((e) => e == null)) throw new Error('fuera de la rejilla');
  } catch {
    raw = await elevations(elevPts);            // plan B: API de Open-Meteo
  }
  const elev = smooth(raw, 3);
  const { gain, loss } = gainLoss(elev);
  c.gain = gain;
  c.loss = loss;
  c.elevStep = ELEV_EVERY;
  c.profile = elev.map((e, i) => ({ d: Math.min(c.km, (i * SAMPLE_M * ELEV_EVERY) / 1000), e }));
}

function addSurface(c, idx) {
  const counts = { asfalto: 0, parque: 0, tierra: 0 };
  c.cats = c.samples.map((p) => {
    const cat = idx.classify(p) ?? 'asfalto';
    counts[cat]++;
    return cat;
  });
  const total = c.samples.length || 1;
  c.surface = Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, (100 * v) / total]));
  c.signalPoints = idx.signalsAlong(c.samples);
  c.signals = c.signalPoints.length;
}

// % del recorrido que repite calle ya pisada (> 400 m antes): a nadie le gusta ir y volver por el mismo sitio.
function overlapPct(samples) {
  const cell = (p) => `${Math.round(p[0] * 2000)},${Math.round(p[1] * 2000)}`; // celdas de ~55 m
  const seen = new Map();
  let repeated = 0;
  samples.forEach((p, i) => {
    const [a, b] = cell(p).split(',').map(Number);
    let hit = false;
    for (let da = -1; da <= 1 && !hit; da++) for (let db = -1; db <= 1 && !hit; db++) {
      for (const j of seen.get(`${a + da},${b + db}`) ?? []) {
        if (i - j > 400 / SAMPLE_M && haversine(p, samples[j]) < 20) { hit = true; break; }
      }
    }
    if (hit) repeated++;
    const k = cell(p);
    if (!seen.has(k)) seen.set(k, []);
    seen.get(k).push(i);
  });
  return (100 * repeated) / samples.length;
}

// Lugares conocidos a < 120 m del trazado, en el orden en que se pasa por ellos.
function landmarksAlong(samples) {
  const hits = [];
  for (const lm of LANDMARKS) {
    const p = [lm.lat, lm.lon];
    let bestI = -1, bestD = 120;
    samples.forEach((s, i) => {
      const d = haversine(s, p);
      if (d < bestD) { bestD = d; bestI = i; }
    });
    if (bestI >= 0) hits.push({ ...lm, at: p, i: bestI });
  }
  // Madrid Río tiene muchos puentes seguidos: se agrupan para no saturar la lista.
  return hits.sort((a, b) => a.i - b.i).filter((h, k, arr) => !(k > 0 && h.name.startsWith('Puente') && arr[k - 1].name.startsWith('Puente')));
}

function routeName(c) {
  const green = c.landmarks.filter((l) => l.green && !l.name.startsWith('Puente'));
  const river = c.landmarks.some((l) => l.name.startsWith('Puente'));
  const names = [...new Set([...green.map((l) => l.name), ...(river ? ['Madrid Río'] : [])])];
  const pick = (names.length ? names : c.landmarks.map((l) => l.name)).slice(0, 3);
  if (!pick.length) return `Bucle hacia el ${c.direction}`;
  return `Por ${pick.length > 1 ? `${pick.slice(0, -1).join(', ')} y ${pick.at(-1)}` : pick[0]}`;
}

function score(c, targetKm, it) {
  const gpk = c.gain == null ? (it.gainPerKm[0] + it.gainPerKm[1]) / 2 : c.gain / c.km; // sin datos: neutro
  const [lo, hi] = it.gainPerKm;
  const gainDev = Math.max(0, lo - gpk) + Math.max(0, gpk - hi);
  const asphalt = c.surface ? c.surface.asfalto : 45;
  return Math.abs(targetKm - c.km) * 10 + gainDev * it.wGain + (c.signals ?? 8) * it.wSignals
    + asphalt * it.wAsphalt + c.overlap * 0.5;
}

// Ejecuta tareas asíncronas con un máximo de `limit` a la vez.
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------
export async function plan({ targetKm, intensity, seed = Date.now(), onProgress = () => {} }) {
  if (!(targetKm > 0 && targetKm <= MAX_KM)) throw new Error(`La distancia debe estar entre 0 y ${MAX_KM} km`);
  const it = INTENSITIES[intensity];
  const prefs = { use_hills: it.useHills };
  const rand = rng(seed);
  onProgress('Cargando mapa de superficies…', 0.02);
  const idx = await loadSurface();

  // Un bucle por cuadrante, con una orientación inicial aleatoria: alternativas variadas.
  const base = rand() * 2 * Math.PI;
  const shapes = Array.from({ length: CANDIDATES }, (_, i) => makeShape(base + (i * Math.PI * 2) / CANDIDATES, rand));

  let done = 0;
  const results = await pool(shapes, 2, async (shape) => {
    try {
      return { shape, best: await calibrate(shape, targetKm, prefs, idx) };
    } catch (e) {
      console.warn('Bucle descartado', e);
      return null;
    } finally {
      done++;
      onProgress(`Trazando bucles aleatorios (${done}/${shapes.length})`, 0.05 + (done / shapes.length) * 0.85);
    }
  });

  const fits = [];
  onProgress('Analizando desnivel y superficie…', 0.92);
  for (const res of results) {
    if (!res?.best) continue;
    const { shape, best } = res;
    const deg = ((shape.bearing * 180) / Math.PI + 360) % 360;
    const c = {
      id: `${seed}-${Math.round(deg)}`,
      seed,
      km: best.km,
      coords: best.route.coords,
      urlPoints: best.wps,
      direction: COMPASS[Math.round(deg / 45) % 8],
      intensity,
    };
    c.samples = resample(c.coords, SAMPLE_M);
    try { await addElevation(c); } catch { c.gain = null; c.profile = []; }
    try { addSurface(c, idx); } catch { c.surface = null; }
    c.overlap = overlapPct(c.samples);
    c.landmarks = landmarksAlong(c.samples);
    c.name = routeName(c);
    c.zoneName = `Bucle hacia el ${c.direction}`;
    c.anchorPoints = c.landmarks.map((l) => ({ name: l.name, at: l.at }));
    c.waypoints = [ORIGIN.name, ...c.landmarks.map((l) => l.name), ORIGIN.name];
    c.minutes = [c.km * it.pace[0], c.km * it.pace[1]];
    c.score = score(c, targetKm, it);
    if (c.km > MAX_KM) throw new Error('Límite de 10 km violado'); // garantía final
    fits.push(c);
  }
  if (!fits.length) throw new Error('No se pudo trazar un bucle con esa distancia. Vuelve a intentarlo.');
  fits.sort((a, b) => a.score - b.score);
  onProgress('Listo', 1);
  return { candidates: fits };
}

// URL universal de Google Maps (abre la app en móvil, modo a pie). Usa los mismos 3 puntos
// de paso que el generador (el máximo que admite la app móvil), así la forma coincide.
export function googleMapsUrl(c) {
  const fmt = ([a, b]) => `${a.toFixed(6)},${b.toFixed(6)}`;
  const params = new URLSearchParams({
    api: '1',
    origin: fmt(O),
    destination: fmt(O),
    travelmode: 'walking',
    waypoints: c.urlPoints.slice(0, 3).map(fmt).join('|'),
  });
  return 'https://www.google.com/maps/dir/?' + params.toString().replace(/%2C/g, ',').replace(/%7C/g, '|');
}

export function toGpx(c) {
  const esc = (s) => s.replace(/[<>&]/g, (ch) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' })[ch]);
  const pts = c.samples.map((p, i) => {
    const e = c.profile.length ? c.profile[Math.min(c.profile.length - 1, Math.round(i / ELEV_EVERY))].e : null;
    return `      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${e != null ? `<ele>${e.toFixed(1)}</ele>` : ''}</trkpt>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Rutas Noviciado" xmlns="http://www.topografix.com/GPX/1/1">
  <trk><name>${esc(c.name)} · ${c.km.toFixed(2)} km</name><trkseg>
${pts}
  </trkseg></trk>
</gpx>
`;
}
