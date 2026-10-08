// Mapa Leaflet: teselas CARTO (claro/oscuro), trazado coloreado por superficie,
// marcadores de origen, anclas, giro, kilómetros y semáforos.
/* global L */
import { ORIGIN } from './config.js';

// Teselas estándar de OpenStreetMap; en modo oscuro se invierten por CSS (.tiles-dark).
const TILE = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIB = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function createMap(el) {
  const map = L.map(el, { zoomControl: false, attributionControl: true }).setView([ORIGIN.lat, ORIGIN.lon], 14);
  L.control.zoom({ position: 'topright' }).addTo(map);

  L.tileLayer(TILE, { attribution: ATTRIB, maxZoom: 19 }).addTo(map);
  const setTheme = (theme) => el.classList.toggle('tiles-dark', theme === 'dark');

  const routeLayer = L.layerGroup().addTo(map);
  const hoverMarker = L.circleMarker([0, 0], {
    radius: 7, weight: 3, color: '#fff', fillOpacity: 1, interactive: false,
  });

  const icon = (cls, html) => L.divIcon({ className: `pin ${cls}`, html, iconSize: null });

  const originMarker = L.marker([ORIGIN.lat, ORIGIN.lon], { icon: icon('pin-origin', '<span>☕</span>'), zIndexOffset: 1000 })
    .bindTooltip(`<strong>${ORIGIN.name}</strong><br>${ORIGIN.address}`, { direction: 'top', offset: [0, -14] })
    .addTo(map);

  function draw(c) {
    routeLayer.clearLayers();
    hoverMarker.remove();
    const colors = { parque: cssVar('--series-1'), asfalto: cssVar('--series-2'), tierra: cssVar('--series-3') };
    const casing = cssVar('--map-casing');

    // Anillo del color de superficie debajo del trazado para que destaque sobre el mapa.
    L.polyline(c.coords, { color: casing, weight: 9, opacity: 0.9, lineJoin: 'round' }).addTo(routeLayer);

    if (c.cats) {
      // Tramos consecutivos de la misma superficie -> una polilínea por tramo.
      let start = 0;
      for (let i = 1; i <= c.samples.length; i++) {
        if (i === c.samples.length || c.cats[i] !== c.cats[start]) {
          const seg = c.samples.slice(start, Math.min(i + 1, c.samples.length));
          L.polyline(seg, { color: colors[c.cats[start]], weight: 5, lineJoin: 'round', lineCap: 'round' }).addTo(routeLayer);
          start = i;
        }
      }
    } else {
      L.polyline(c.coords, { color: colors.parque, weight: 5, dashArray: '1 9', lineCap: 'round' }).addTo(routeLayer);
      L.polyline(c.coords, { color: colors.parque, weight: 3, opacity: 0.8 }).addTo(routeLayer);
    }

    // Kilómetros
    const perKm = Math.round(1000 / 20);
    for (let k = 1; k * perKm < c.samples.length - perKm / 3; k++) {
      L.marker(c.samples[k * perKm], { icon: icon('pin-km', `<span>${k}</span>`), interactive: false }).addTo(routeLayer);
    }
    // Semáforos
    for (const s of c.signalPoints ?? []) {
      L.circleMarker(s, { radius: 3.5, weight: 2, color: casing, fillColor: cssVar('--signal'), fillOpacity: 1 })
        .bindTooltip('Cruce con semáforo', { direction: 'top' }).addTo(routeLayer);
    }
    // Lugares por los que pasa
    for (const a of c.anchorPoints) {
      L.circleMarker(a.at, { radius: 5, weight: 2, color: casing, fillColor: cssVar('--ink'), fillOpacity: 1 })
        .bindTooltip(a.name, { direction: 'top' }).addTo(routeLayer);
    }
    // Los 3 puntos de paso del bucle (los mismos que lleva el enlace de Google Maps)
    c.urlPoints.forEach((p, i) => {
      L.marker(p, { icon: icon('pin-wp', `<span>${'ABC'[i]}</span>`), zIndexOffset: 900 })
        .bindTooltip(`Punto de paso ${'ABC'[i]}`, { direction: 'top', offset: [0, -12] }).addTo(routeLayer);
    });

    originMarker.setZIndexOffset(1000);
  }

  function fit(c) {
    const pad = window.matchMedia('(max-width: 860px)').matches ? [24, 24] : [48, 48];
    map.invalidateSize();          // el contenedor puede haber cambiado de tamaño al mostrar el panel
    map.fitBounds(L.latLngBounds(c.coords), { padding: pad });
  }

  function hover(latlng) {
    if (!latlng) return hoverMarker.remove();
    hoverMarker.setStyle({ fillColor: cssVar('--ink'), color: cssVar('--map-casing') });
    hoverMarker.setLatLng(latlng);
    if (!map.hasLayer(hoverMarker)) hoverMarker.addTo(map);
  }

  return { map, setTheme, draw, fit, hover, invalidate: () => map.invalidateSize() };
}
