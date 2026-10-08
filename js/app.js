// Interfaz: controles, generación, render de resultados, alternativas e historial.
import { MAX_KM, INTENSITIES } from './config.js';
import { plan, googleMapsUrl, toGpx } from './planner.js';
import { createMap } from './map.js';
import { renderProfile } from './profile.js';

const $ = (id) => document.getElementById(id);
const HISTORY_KEY = 'rutas-noviciado:history';
const THEME_KEY = 'rutas-noviciado:theme';
const SURFACES = [
  { key: 'parque', label: 'Parque / peatonal', color: '--series-1' },
  { key: 'asfalto', label: 'Asfalto / acera', color: '--series-2' },
  { key: 'tierra', label: 'Tierra', color: '--series-3' },
];

const state = { km: 8, intensity: 'medio', candidates: [], current: null };

// ---------------------------------------------------------------------------
// Almacenamiento local (tolerante a modo privado / bloqueo)
// ---------------------------------------------------------------------------
const store = {
  get(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* sin almacenamiento */ }
  },
};

// ---------------------------------------------------------------------------
// Tema
// ---------------------------------------------------------------------------
const mapView = createMap($('map'));
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
const effectiveTheme = () => document.documentElement.dataset.theme || (systemDark.matches ? 'dark' : 'light');

function applyTheme() {
  mapView.setTheme(effectiveTheme());
  if (state.current) showCandidate(state.current, { fit: false });
}
const savedTheme = store.get(THEME_KEY, null);
if (savedTheme) document.documentElement.dataset.theme = savedTheme;
applyTheme();
systemDark.addEventListener('change', () => { if (!document.documentElement.dataset.theme) applyTheme(); });
$('theme-toggle').addEventListener('click', () => {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  store.set(THEME_KEY, next);
  applyTheme();
});

// ---------------------------------------------------------------------------
// Controles
// ---------------------------------------------------------------------------
function renderControls() {
  $('km-out').innerHTML = `<b>${state.km.toFixed(1)}</b> km`;

  $('intensity').innerHTML = Object.entries(INTENSITIES).map(([k, it]) =>
    `<button type="button" data-k="${k}" aria-pressed="${k === state.intensity}">${it.label}</button>`).join('');
  $('intensity-hint').textContent = INTENSITIES[state.intensity].hint;

}

$('km').addEventListener('input', (e) => { state.km = Number(e.target.value); renderControls(); });
$('intensity').addEventListener('click', (e) => {
  const k = e.target.closest('button')?.dataset.k;
  if (k) { state.intensity = k; renderControls(); }
});

// ---------------------------------------------------------------------------
// Generación
// ---------------------------------------------------------------------------
$('controls').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('generate');
  btn.disabled = true;
  btn.textContent = 'Calculando…';
  $('error').hidden = true;
  $('progress').hidden = false;
  try {
    const { candidates } = await plan({
      targetKm: Math.min(state.km, MAX_KM),
      intensity: state.intensity,
      onProgress: (msg, frac) => {
        $('progress-text').textContent = msg;
        $('progress-bar').style.width = `${Math.round(frac * 100)}%`;
      },
    });
    state.candidates = candidates;
    showCandidate(candidates[0]);
    saveHistory(candidates[0]);
    renderHistory();
  } catch (err) {
    $('error').textContent = err.message || 'No se pudo calcular la ruta. Inténtalo de nuevo en unos segundos.';
    console.error(err);
    $('error').hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Generar otra ruta';
    $('progress').hidden = true;
  }
});

// ---------------------------------------------------------------------------
// Resultado
// ---------------------------------------------------------------------------
const fmtMin = ([a, b]) => `${Math.round(a)}–${Math.round(b)}′`;
const fmtPace = (p) => `${Math.floor(p)}:${String(Math.round((p % 1) * 60)).padStart(2, '0')}`;

function renderSurface(c) {
  const box = $('r-surface');
  if (!c.surface) {
    box.innerHTML = '<p class="unavailable">No disponible: no se pudieron cargar los datos de superficie (data/surface.json).</p>';
    return;
  }
  const bar = SURFACES.filter((s) => c.surface[s.key] > 0)
    .map((s) => `<span style="flex:${c.surface[s.key]};background:var(${s.color})" title="${s.label}: ${c.surface[s.key].toFixed(0)} %"></span>`).join('');
  const legend = SURFACES.map((s) =>
    `<li><b><i class="swatch" style="background:var(${s.color})"></i>${c.surface[s.key].toFixed(0)} %</b>${s.label}</li>`).join('');
  box.innerHTML = `<div class="sbar" role="img" aria-label="${SURFACES.map((s) => `${s.label} ${c.surface[s.key].toFixed(0)} %`).join(', ')}">${bar}</div><ul class="slegend">${legend}</ul>`;
}

function drawProfile(c) {
  if (!c.profile.length) {
    $('r-profile').innerHTML = '<p class="unavailable">No disponible: el servicio de elevación está saturado. Vuelve a generar en un minuto.</p>';
    return;
  }
  renderProfile($('r-profile'), c.profile, {
    onHover: (i) => mapView.hover(c.samples[Math.min(c.samples.length - 1, i * (c.elevStep ?? 5))]),
    onLeave: () => mapView.hover(null),
  });
}

function showCandidate(c, { fit = true } = {}) {
  state.current = c;
  const it = INTENSITIES[c.intensity];
  $('map-empty').hidden = true;
  $('result').hidden = false;

  $('r-zone').textContent = c.zoneName;
  $('r-name').textContent = c.name;
  $('r-km').textContent = `${c.km.toFixed(2)} km`;
  $('r-gain').textContent = c.gain == null ? '—' : `+${Math.round(c.gain)} m`;
  $('r-time').textContent = fmtMin(c.minutes);
  $('r-time').title = `Ritmo ${fmtPace(it.pace[0])}–${fmtPace(it.pace[1])} min/km`;
  $('r-signals').textContent = c.signals ?? '—';
  $('r-intensity').textContent = `${it.full} · ${fmtPace(it.pace[0])}–${fmtPace(it.pace[1])} min/km`;
  $('r-workout').textContent = it.workout;
  $('r-waypoints').innerHTML = c.waypoints.map((w) => `<li>${w}</li>`).join('');
  $('r-overlap').textContent = c.overlap == null ? '' : c.overlap < 3
    ? 'Sin tramos repetidos: es un bucle de verdad.'
    : `Repite ${Math.round(c.overlap)} % del recorrido (ida y vuelta por la misma calle).`;

  renderSurface(c);
  drawProfile(c);

  const url = googleMapsUrl(c);
  $('r-gmaps').href = url;
  mapView.draw(c);
  if (fit) mapView.fit(c);
  renderAlternatives();
  renderHistory();
}

$('r-gpx').addEventListener('click', () => {
  const c = state.current;
  if (!c) return;
  const blob = new Blob([toGpx(c)], { type: 'application/gpx+xml' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `noviciado-${c.id}-${c.km.toFixed(1)}km.gpx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('r-copy').addEventListener('click', async (e) => {
  try {
    await navigator.clipboard.writeText($('r-gmaps').href);
    e.target.textContent = '¡Copiado!';
  } catch {
    e.target.textContent = 'No se pudo copiar';
  }
  setTimeout(() => { e.target.textContent = 'Copiar enlace'; }, 1600);
});

// ---------------------------------------------------------------------------
// Alternativas e historial
// ---------------------------------------------------------------------------
const card = (c, attrs) => `
  <button type="button" class="card" ${attrs}>
    <span class="t">${c.name}</span><span class="k">${c.km.toFixed(2)} km</span>
    <span class="z">${c.zoneName} · ${INTENSITIES[c.intensity].label}</span>
    <span class="m">${c.gain == null ? '' : `+${Math.round(c.gain)} m`}${c.surface ? `${c.gain == null ? '' : ' · '}${Math.round(100 - c.surface.asfalto)} % parque/tierra` : ''}</span>
  </button>`;

function renderAlternatives() {
  const list = state.candidates;
  $('alternatives').hidden = list.length < 2;
  $('alt-list').innerHTML = list.map((c, i) => card(c, `data-i="${i}" aria-current="${c === state.current}"`)).join('');
}
$('alt-list').addEventListener('click', (e) => {
  const i = e.target.closest('.card')?.dataset.i;
  if (i != null) showCandidate(state.candidates[Number(i)]);
});

// Para el historial se guardan las muestras (cada 20 m), que bastan para redibujar todo.
const round5 = (p) => [Math.round(p[0] * 1e5) / 1e5, Math.round(p[1] * 1e5) / 1e5];
function serialize(c) {
  return {
    ...c,
    savedAt: Date.now(),
    coords: c.samples.map(round5),
    samples: c.samples.map(round5),
    profile: c.profile.map((p) => ({ d: Math.round(p.d * 1000) / 1000, e: Math.round(p.e * 10) / 10 })),
  };
}

function saveHistory(c) {
  const list = store.get(HISTORY_KEY, []).filter((h) => !(h.id === c.id && Math.abs(h.km - c.km) < 0.05 && h.intensity === c.intensity));
  list.unshift(serialize(c));
  store.set(HISTORY_KEY, list.slice(0, 8));
}

function renderHistory() {
  const list = store.get(HISTORY_KEY, []);
  $('history').hidden = !list.length;
  $('history-list').innerHTML = list.map((h, i) => card(h, `data-h="${i}"`)).join('');
}
$('history-list').addEventListener('click', (e) => {
  const i = e.target.closest('.card')?.dataset.h;
  if (i == null) return;
  const h = store.get(HISTORY_KEY, [])[Number(i)];
  if (!h) return;
  state.candidates = [h];
  showCandidate(h);
});
$('history-clear').addEventListener('click', () => {
  store.set(HISTORY_KEY, []);
  renderHistory();
});

// Redibuja el perfil al cambiar el ancho del panel.
new ResizeObserver(() => {
  if (state.current) drawProfile(state.current);
  mapView.invalidate();
}).observe(document.querySelector('.panel'));

renderControls();
renderHistory();
