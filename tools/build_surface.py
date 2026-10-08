#!/usr/bin/env python3
"""
Genera data/surface.json: vías peatonales/calles y semáforos del centro de Madrid,
ya clasificados por superficie, en un formato compacto para el navegador.

Por qué precalcularlo: Overpass (la API pública de OpenStreetMap) tarda 15-20 s por
consulta y devuelve 429/504 con frecuencia. Estos datos cambian muy poco, así que se
descargan una vez y la app los clasifica al instante en local.

Uso:
  python3 tools/build_surface.py                       # descarga de Overpass y genera
  python3 tools/build_surface.py --input ways.json     # usa una descarga previa
"""
import argparse
import json
import pathlib

import requests  # trae sus propios certificados (urllib falla en el Python de python.org en macOS)

BBOX = (40.385, -3.750, 40.458, -3.660)  # sur, oeste, norte, este: radio de ~3 km alrededor de Noviciado
OUT = pathlib.Path(__file__).resolve().parent.parent / "data" / "surface.json"

NOT_WALKABLE = "motorway|motorway_link|trunk_link|construction|proposed|elevator|bus_stop|platform"
QUERY = f"""[out:json][timeout:180];
(way[highway][highway!~"^({NOT_WALKABLE})$"]{BBOX};
 node[highway=traffic_signals]{BBOX};
 node[crossing=traffic_signals]{BBOX};);
out tags geom qt;"""

UNPAVED = {"unpaved", "compacted", "fine_gravel", "gravel", "dirt", "earth", "ground",
           "grass", "sand", "woodchips", "pebblestone"}
PEDESTRIAN = {"footway", "path", "pedestrian", "track", "steps", "cycleway", "living_street", "bridleway"}
CATS = ["asfalto", "parque", "tierra"]


def classify(tags: dict) -> int | None:
    hw = tags.get("highway")
    if tags.get("tunnel") == "yes" and hw not in PEDESTRIAN:
        return None                     # túneles de coches (p. ej. la M-30 bajo Madrid Río)
    if hw == "trunk":
        return None                     # vías rápidas sin acera transitable
    if tags.get("surface") in UNPAVED or hw == "track":
        return 2
    if tags.get("footway") in {"sidewalk", "crossing"}:
        return 0                        # acera de calle mapeada aparte
    if hw in PEDESTRIAN:
        return 1
    return 0


def download() -> dict:
    r = requests.post("https://overpass-api.de/api/interpreter", data={"data": QUERY},
                      headers={"User-Agent": "rutas-noviciado/1.0"}, timeout=240)
    r.raise_for_status()
    return r.json()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", help="JSON de Overpass ya descargado")
    args = ap.parse_args()
    raw = json.load(open(args.input)) if args.input else download()

    ways, signals = [], []
    for el in raw["elements"]:
        if el["type"] == "node":
            signals += [round(el["lat"] * 1e5), round(el["lon"] * 1e5)]
            continue
        cat = classify(el.get("tags", {}))
        if cat is None or "geometry" not in el:
            continue
        # [categoría, lat0, lon0, Δlat1, Δlon1, ...] en unidades de 1e-5 grados (~1 m)
        pts = [(round(g["lat"] * 1e5), round(g["lon"] * 1e5)) for g in el["geometry"]]
        flat = [cat, *pts[0]]
        for (a, b), (c, d) in zip(pts, pts[1:]):
            flat += [c - a, d - b]
        ways.append(flat)

    OUT.parent.mkdir(exist_ok=True)
    out = {"bbox": BBOX, "cats": CATS, "ways": ways, "signals": signals,
           "source": "© colaboradores de OpenStreetMap (ODbL)"}
    OUT.write_text(json.dumps(out, separators=(",", ":")))
    print(f"{len(ways)} vías · {len(signals) // 2} semáforos · {OUT.stat().st_size / 1e6:.2f} MB -> {OUT}")


if __name__ == "__main__":
    main()
