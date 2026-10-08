# Rutas Noviciado

Panel web que genera **bucles aleatorios** para correr por Madrid, siempre con salida y llegada en
**Noviciado Coffee Shop** (Calle del Noviciado, 9). Ninguna ruta supera los **10 km**.

- **Distancia**: de 3 a 10 km. Cada bucle se escala para quedarse justo por debajo de lo pedido.
- **Intensidad**: Suave, Medio o Avanzado. Cambia la preferencia de cuestas del router, la puntuación (desnivel, semáforos, % de asfalto) y el ritmo y la sesión que se proponen.
- **Aleatorio**: cada vez que pulsas el botón salen 4 bucles nuevos, uno hacia cada cuadrante, y se muestra el mejor. Los otros quedan como alternativas.
- **Telemetría**: distancia exacta, desnivel positivo, tiempo, semáforos, % de superficie (parque/peatonal, asfalto/acera, tierra), % de tramos repetidos, perfil de elevación interactivo y lugares por los que pasa.
- **Salidas**: enlace a Google Maps a pie (con los mismos 3 puntos de paso), descarga de GPX e historial local de las últimas 8 rutas.

## Arrancar

```bash
cd rutas-noviciado
python3 tools/serve.py
```

Después abre http://localhost:5180. Es un servidor estático con `no-cache`, para que el navegador no sirva módulos viejos después de editarlos.

## En el móvil

Publicada con GitHub Pages en **https://danielcs94.github.io/rutas-noviciado/**

Para tenerla como una app:
- **iPhone (Safari)**: Compartir → *Añadir a pantalla de inicio*.
- **Android (Chrome)**: menú ⋮ → *Añadir a pantalla de inicio* (o *Instalar app*).

Para actualizarla, **versiona primero los archivos** y luego haz commit y push a `main`; GitHub Pages la vuelve a publicar en 1-2 minutos:

```bash
python3 tools/release.py   # pone ?v=<fecha> a CSS y módulos JS para que el móvil no mezcle versiones
```

## Cómo funciona

```
config.js     origen, lugares de referencia (para nombrar rutas) e intensidades
planner.js    genera los bucles aleatorios → calibra la distancia → telemetría → puntuación
api.js        enrutado a pie: Valhalla (preferencia de cuestas por intensidad) con OSRM de reserva
datasets.js   superficie/semáforos y elevación precalculados; "imán verde" hacia parques
map.js        mapa vectorial MapLibre GL + OpenFreeMap (sin clave); trazado por superficie y flechas de sentido
mapstyle.js   recolorea el estilo base con la estética de Apple Maps (claro y oscuro)
profile.js    perfil de elevación en SVG con cursor sincronizado con el mapa
app.js        interfaz, historial (localStorage), GPX y enlace de Google Maps
```

1. **Forma aleatoria**: se elige una dirección al azar y se traza un círculo que pasa por Noviciado. Sobre él se colocan 3 puntos de paso (A, B, C) con algo de ruido en ángulo y radio. Se generan 4 bucles, uno por cuadrante.
2. **Imán verde**: cada punto de paso se desplaza a la zona cercana con más metros de senda de parque o tierra (según OpenStreetMap), penalizando la distancia. Así los bucles tiran hacia el Parque del Oeste, la Casa de Campo, Madrid Río, el Retiro, etc., sin plantillas fijas.
3. **Calibración**: la distancia crece casi en proporción al tamaño del círculo. Se estima, se enruta a pie y se afina con el método de la secante (3-5 llamadas), quedándose siempre por debajo del objetivo y de 10 km.
4. **Enrutado a pie**: Valhalla (perfil `pedestrian`) con preferencias de corredor: `walkway_factor` para paseos peatonales, `use_tracks` para caminos de tierra y `use_hills` según la intensidad. Las rutas se guardan en `localStorage`.
5. **Telemetría local**: superficie y semáforos salen de un extracto de OpenStreetMap ya clasificado (`data/surface.json`), y el desnivel de una rejilla del modelo de terreno Copernicus de 90 m (`data/elevation.json`). Los dos cubren unos 3 km alrededor de Noviciado.
6. **Puntuación**: se elige el bucle que mejor encaja con la intensidad (desnivel por km, semáforos, % de asfalto) y que menos tramos repite.

## Regenerar los datos

Hazlo cuando quieras actualizarlos con OSM o ampliar la zona (`BBOX` en los scripts):

```bash
python3 tools/build_surface.py     # Overpass → data/surface.json   (~1 MB)
python3 tools/build_elevation.py   # Open-Meteo → data/elevation.json
```

Requisito: `pip install requests`

## Limitaciones conocidas

- **La URL de Google Maps no reproduce exactamente el trazado.** En el móvil, Google Maps solo acepta 3 paradas y recalcula el camino entre ellas. El trazado exacto está en el **GPX**.
- **El desnivel es aproximado.** El modelo de terreno tiene una resolución de 90 m, y además se suaviza y se ignoran variaciones de menos de 2 m.
- **El tramo urbano Noviciado ↔ parques es inevitable.** Por eso ninguna ruta llega al 100 % de parque.
- **Routers públicos de FOSSGIS** (Valhalla/OSRM): son gratuitos y limitan las ráfagas de peticiones. Cada generación tarda unos 20-25 s.
- **La distancia final queda entre un 90 % y un 100 % de la pedida.** Al desplazar los puntos hacia los parques, la distancia no crece de forma perfectamente suave con el tamaño del bucle.
- **Los bucles hacia el norte y el este** (Chamberí, Salamanca) tienen menos parque cerca, así que suelen salir con más asfalto.
