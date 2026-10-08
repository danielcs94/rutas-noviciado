// Acceso a servicios cartográficos abiertos (sin API key):
//   · Valhalla "pedestrian" (FOSSGIS) -> enrutado a pie (motor principal; admite preferencias
//                                        de cuestas, paseos peatonales y caminos de tierra)
//   · OSRM perfil "foot" (FOSSGIS)    -> enrutado a pie, plan B si Valhalla falla
//   · Open-Meteo Elevation          -> altitud, solo como plan B si falta data/elevation.json
// La superficie y los semáforos van precalculados en data/surface.json (tools/build_surface.py).
import { decodePolyline, encodePolyline } from './geo.js';

const VALHALLA_URL = 'https://valhalla1.openstreetmap.de/route';
const OSRM_URL = 'https://routing.openstreetmap.de/routed-foot/route/v1/driving/';
const ELEVATION_URL = 'https://api.open-meteo.com/v1/elevation';

const RETRY_STATUS = new Set([429, 500, 502, 503, 504]);
const memo = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AbortSignal.timeout no existe antes de iOS 16: equivalente con AbortController.
function timeoutSignal(ms) {
  if (typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  const c = new AbortController();
  setTimeout(() => c.abort(), ms);
  return c.signal;
}

// Cola por host: los servidores públicos penalizan ráfagas de peticiones.
const lastCall = new Map();
async function throttle(url, minGap) {
  const host = new URL(url).host;
  const wait = (lastCall.get(host) ?? 0) + minGap - Date.now();
  lastCall.set(host, Date.now() + Math.max(0, wait));
  if (wait > 0) await sleep(wait);
}

async function fetchJSON(url, opts = {}, { retries = 4, base = 900, gap = 150 } = {}) {
  const key = url + '|' + (opts.body ?? '');
  if (memo.has(key)) return memo.get(key);
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try {
      await throttle(url, gap);
      // Timeout de 15 s: un servidor caído no debe dejar la app colgada.
      const r = await fetch(url, { ...opts, signal: timeoutSignal(15000) });
      if (r.ok) {
        const json = await r.json();
        memo.set(key, json);
        return json;
      }
      lastErr = new Error(`HTTP ${r.status} en ${new URL(url).host}`);
      if (!RETRY_STATUS.has(r.status)) break;
      const retryAfter = Number(r.headers.get('Retry-After'));
      if (retryAfter > 0) { await sleep(retryAfter * 1000); continue; }
    } catch (e) {
      lastErr = e;
    }
    await sleep(base * 2 ** i);
  }
  throw lastErr;
}

// Caché persistente de rutas: son deterministas, así que la misma petición nunca se repite
// entre sesiones (los servidores públicos de FOSSGIS limitan con HTTP 429).
const ROUTE_CACHE_KEY = 'rutas-noviciado:routes:v2';
const ROUTE_CACHE_MAX = 300;
const routeCache = (() => {
  try { return new Map(JSON.parse(localStorage.getItem(ROUTE_CACHE_KEY)) ?? []); } catch { return new Map(); }
})();
let saveTimer = null;
function persistRouteCache() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const entries = [...routeCache].slice(-ROUTE_CACHE_MAX);  // descarta las más antiguas
    try { localStorage.setItem(ROUTE_CACHE_KEY, JSON.stringify(entries)); } catch { /* cuota llena o bloqueado */ }
  }, 500);
}

// Preferencias de corredor sobre el perfil peatonal de Valhalla:
//   walkway_factor < 1 -> prefiere paseos y sendas peatonales frente a aceras de calle
//   use_tracks         -> preferencia por caminos de tierra (0-1)
//   use_hills          -> 0 evita cuestas, 1 las busca (lo fija la intensidad)
const RUNNER_COSTING = { walkway_factor: 0.8, use_tracks: 0.7, use_living_streets: 0.6, step_penalty: 15 };

const VALHALLA_MAX_LOCATIONS = 10; // límite del servidor público

async function valhallaChunk(points, prefs) {
  const req = {
    locations: points.map(([lat, lon]) => ({ lat, lon })),
    costing: 'pedestrian',
    costing_options: { pedestrian: { ...RUNNER_COSTING, ...prefs } },
    directions_type: 'none',
  };
  // GET con JSON compacto: evita la petición CORS de preflight (y Valhalla no decodifica '+' como espacio).
  const j = await fetchJSON(`${VALHALLA_URL}?json=${encodeURIComponent(JSON.stringify(req))}`, {}, { gap: 350, base: 1500 });
  if (!j.trip) throw new Error(`Valhalla: ${j.error ?? 'sin ruta'}`);
  const coords = [];
  for (const leg of j.trip.legs) coords.push(...decodePolyline(leg.shape, 6).slice(coords.length ? 1 : 0));
  return { distance: j.trip.summary.length * 1000, duration: j.trip.summary.time, coords };
}

// Cada tramo entre puntos consecutivos se calcula por separado, así que una lista larga
// se trocea en bloques de 10 que comparten el punto frontera y se concatenan sin cambiar nada.
async function valhalla(points, prefs) {
  const total = { distance: 0, duration: 0, coords: [] };
  for (let i = 0; i < points.length - 1; i += VALHALLA_MAX_LOCATIONS - 1) {
    const part = await valhallaChunk(points.slice(i, i + VALHALLA_MAX_LOCATIONS), prefs);
    total.distance += part.distance;
    total.duration += part.duration;
    total.coords.push(...part.coords.slice(total.coords.length ? 1 : 0));
  }
  return total;
}

async function osrm(points) {
  const path = points.map(([lat, lon]) => `${lon.toFixed(5)},${lat.toFixed(5)}`).join(';');
  const j = await fetchJSON(`${OSRM_URL}${path}?overview=full&geometries=polyline`, {}, { retries: 1, gap: 350, base: 1500 });
  if (j.code !== 'Ok' || !j.routes?.length) throw new Error(`OSRM: ${j.code}`);
  return { distance: j.routes[0].distance, duration: j.routes[0].duration, coords: decodePolyline(j.routes[0].geometry) };
}

// Ruta a pie que pasa por `points` en orden. `prefs` = opciones de Valhalla (p. ej. use_hills).
export async function routeFoot(points, prefs = {}) {
  const pts = points
    .map(([lat, lon]) => [Number(lat.toFixed(5)), Number(lon.toFixed(5))])
    .filter((p, i, a) => i === 0 || p[0] !== a[i - 1][0] || p[1] !== a[i - 1][1]); // sin duplicados seguidos
  const key = JSON.stringify([pts, prefs]);
  const hit = routeCache.get(key);
  if (hit) return { distance: hit.distance, duration: hit.duration, coords: decodePolyline(hit.geometry) };

  let r;
  try {
    r = await valhalla(pts, prefs);
  } catch (e) {
    console.warn('Valhalla no disponible, uso OSRM', e);
    r = await osrm(pts);
  }
  routeCache.set(key, { distance: r.distance, duration: r.duration, geometry: encodePolyline(r.coords) });
  persistRouteCache();
  return r;
}

export async function elevations(samples) {
  const out = [];
  for (let i = 0; i < samples.length; i += 100) { // límite de 100 coordenadas por petición
    const chunk = samples.slice(i, i + 100);
    const lat = chunk.map((p) => p[0].toFixed(5)).join(',');
    const lon = chunk.map((p) => p[1].toFixed(5)).join(',');
    const j = await fetchJSON(`${ELEVATION_URL}?latitude=${lat}&longitude=${lon}`, {}, { gap: 1200, base: 2000 });
    out.push(...j.elevation);
  }
  return out;
}
