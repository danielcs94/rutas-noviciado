#!/usr/bin/env python3
"""
Genera data/elevation.json: rejilla de altitudes del centro de Madrid (DEM Copernicus
GLO-90 servido por Open-Meteo) para interpolar el desnivel en el navegador sin
depender de la API, que limita las peticiones (HTTP 429).

Uso:
  python3 tools/build_elevation.py

Si ya existe data/elevation.json, reutiliza los puntos descargados y solo pide los nuevos.
"""
import json
import pathlib
import time

import requests  # trae sus propios certificados (urllib falla en el Python de python.org en macOS)

SOUTH, WEST, NORTH, EAST = 40.385, -3.750, 40.458, -3.660  # misma zona que surface.json
STEP = 0.001                                                # ~110 m (lat) × ~85 m (lon)
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "elevation.json"


def fetch(points):
    lat = ",".join(f"{a:.4f}" for a, _ in points)
    lon = ",".join(f"{b:.4f}" for _, b in points)
    url = f"https://api.open-meteo.com/v1/elevation?latitude={lat}&longitude={lon}"
    for attempt in range(6):
        r = requests.get(url, headers={"User-Agent": "rutas-noviciado/1.0"}, timeout=30)
        if r.status_code != 429:
            r.raise_for_status()
            return r.json()["elevation"]
        time.sleep(5 * 2 ** attempt)        # límite de peticiones: espera y reintenta
    raise RuntimeError("Open-Meteo sigue devolviendo 429")


def main() -> None:
    rows = round((NORTH - SOUTH) / STEP) + 1
    cols = round((EAST - WEST) / STEP) + 1
    grid = [(round(SOUTH + r * STEP, 4), round(WEST + c * STEP, 4)) for r in range(rows) for c in range(cols)]

    known = {}                                     # puntos de una ejecución anterior
    if OUT.exists():
        old = json.loads(OUT.read_text())
        for r in range(old["rows"]):
            for c in range(old["cols"]):
                key = (round(old["south"] + r * old["step"], 4), round(old["west"] + c * old["step"], 4))
                known[key] = old["dm"][r * old["cols"] + c] / 10

    missing = [p for p in grid if p not in known]
    print(f"{len(grid) - len(missing)} puntos reutilizados, {len(missing)} por descargar")
    for i in range(0, len(missing), 100):         # 100 coordenadas por petición
        chunk = missing[i:i + 100]
        known.update(zip(chunk, fetch(chunk)))
        print(f"\r{min(i + 100, len(missing))}/{len(missing)}", end="", flush=True)
        time.sleep(1.5)
    values = [known[p] for p in grid]
    OUT.parent.mkdir(exist_ok=True)
    OUT.write_text(json.dumps({
        "south": SOUTH, "west": WEST, "step": STEP, "rows": rows, "cols": cols,
        "dm": [round(v * 10) for v in values],     # decímetros, fila a fila de sur a norte
        "source": "Copernicus GLO-90 DEM vía Open-Meteo",
    }, separators=(",", ":")))
    print(f"\n{rows}×{cols} puntos -> {OUT} ({OUT.stat().st_size / 1e3:.0f} kB)")


if __name__ == "__main__":
    main()
