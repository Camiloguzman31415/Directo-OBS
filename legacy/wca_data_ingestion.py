"""
WCA Tournament Data Ingestion
==============================
Dado un competition_id, extrae:
  - Lista de competidores (nombre, WCAID, es nuevo)
  - Eventos y número de rondas
  - PRs de cada competidor por evento

Uso:
    python wca_data_ingestion.py --competition NadaQueVerBucaramanga2026
    python wca_data_ingestion.py --competition NadaQueVerBucaramanga2026 --output data/
"""

import argparse
import json
import time
from pathlib import Path

import requests

WCA_API = "https://www.worldcubeassociation.org/api/v0"

# Mapping WCA event_id → nombre legible
EVENT_NAMES = {
    "333":      "3x3",
    "222":      "2x2",
    "444":      "4x4",
    "555":      "5x5",
    "666":      "6x6",
    "777":      "7x7",
    "333bf":    "3x3 Blindfolded",
    "333fm":    "Fewest Moves",
    "333oh":    "3x3 One-Handed",
    "clock":    "Clock",
    "minx":     "Megaminx",
    "pyram":    "Pyraminx",
    "skewb":    "Skewb",
    "sq1":      "Square-1",
    "444bf":    "4x4 Blindfolded",
    "555bf":    "5x5 Blindfolded",
    "333mbf":   "Multi-Blind",
}

# Campos de PR en la respuesta de /persons/{wcaid}
# personal_records es un dict: { event_id: { "single": {...}, "average": {...} } }


def get_competition(competition_id: str) -> dict:
    """Datos básicos del torneo."""
    url = f"{WCA_API}/competitions/{competition_id}"
    r = requests.get(url, timeout=15)
    r.raise_for_status()
    return r.json()


def get_wcif(competition_id: str) -> dict:
    """
    WCIF público: contiene eventos, rondas y lista de personas registradas.
    Requiere que el torneo sea público en la WCA.
    """
    url = f"{WCA_API}/competitions/{competition_id}/wcif/public"
    r = requests.get(url, timeout=15)
    r.raise_for_status()
    return r.json()


def parse_events(wcif: dict) -> list[dict]:
    """
    Extrae eventos y número de rondas del WCIF.
    Retorna lista de dicts: { event_id, name, rounds }
    """
    events = []
    for event in wcif.get("events", []):
        eid = event["id"]
        rounds = len(event.get("rounds", []))
        events.append({
            "event_id": eid,
            "name": EVENT_NAMES.get(eid, eid),
            "rounds": rounds,
        })
    return events


def parse_competitors(wcif: dict) -> list[dict]:
    """
    Extrae competidores del WCIF.
    persons[] contiene: name, wcaId (puede ser "" si es nuevo), registrantId, registration
    Solo incluye los que tienen registration.status == "accepted".
    """
    competitors = []
    for person in wcif.get("persons", []):
        reg = person.get("registration")
        if not reg or reg.get("status") != "accepted":
            continue

        wca_id = person.get("wcaId") or None
        competitors.append({
            "name": person["name"],
            "wca_id": wca_id,
            "is_new": wca_id is None,
            "registrant_id": person.get("registrantId"),
            "events": reg.get("eventIds", []),
            "country": person.get("countryIso2", ""),
        })

    competitors.sort(key=lambda c: c["name"])
    return competitors


def get_person_prs(wca_id: str) -> dict:
    """
    Obtiene PRs de un competidor por WCAID.
    Retorna dict: { event_id: { "single": valor_cs, "average": valor_cs } }
    donde valor_cs es centésimas de segundo (int), o None si no tiene.

    La API /persons/{wca_id} devuelve:
      { "person": {...}, "personal_records": { event_id: { "single": {...}, "average": {...} } } }
    O en algunos endpoints como lista:
      { "persons": [ { ..., "personal_records": {...} } ] }
    Este código maneja ambos casos.
    """
    url = f"{WCA_API}/persons/{wca_id}"
    r = requests.get(url, timeout=15)
    if r.status_code == 404:
        return {}
    r.raise_for_status()
    data = r.json()

    # DEBUG: mostrar estructura real de la API (solo para el primer competidor)
    if not hasattr(get_person_prs, "_debug_shown"):
        get_person_prs._debug_shown = True
        print(f"\n[DEBUG] Keys raíz de /persons/{wca_id}: {list(data.keys())}")
        if "personal_records" in data:
            sample = list(data["personal_records"].items())[:2]
            print(f"[DEBUG] personal_records (muestra): {sample}")
        elif "persons" in data:
            print(f"[DEBUG] Viene en persons[], keys: {list(data['persons'][0].keys())}")

    # Caso 1: personal_records en la raíz (formato real de la API)
    raw_records = data.get("personal_records")

    # Caso 2: viene dentro de persons[0] (por si acaso)
    if raw_records is None:
        persons = data.get("persons", [])
        if persons:
            raw_records = persons[0].get("personal_records", {})

    if not raw_records:
        return {}

    prs = {}
    for event_id, records in raw_records.items():
        prs[event_id] = {
            "single":  records.get("single", {}).get("best"),
            "average": records.get("average", {}).get("best"),
        }
    return prs


def format_time(centiseconds, event_id: str) -> str:
    """
    Convierte centésimas de segundo a string legible.
    Maneja casos especiales: FMC (moves), MBLD (formato especial).
    """
    if centiseconds is None:
        return "—"

    if event_id == "333fm":
        # En FMC el valor es número de moves directamente
        return str(centiseconds)

    if event_id == "333mbf":
        # Formato MBLD: codificado como int especial de WCA
        # 1000000000 - DD*10000000 - TT*100 + MM  (ignoramos decodificación completa aquí)
        return f"MBLD:{centiseconds}"

    total_cs = int(centiseconds)
    minutes = total_cs // 6000
    seconds = (total_cs % 6000) / 100

    if minutes > 0:
        return f"{minutes}:{seconds:05.2f}"
    else:
        return f"{seconds:.2f}"


def fetch_all_prs(competitors: list[dict], delay: float = 0.3) -> dict:
    """
    Obtiene PRs de todos los competidores con WCAID.
    Respeta un delay entre requests para no sobrecargar la API.
    Retorna dict: { wca_id: { event_id: { single, average } } }
    """
    all_prs = {}
    veterans = [c for c in competitors if not c["is_new"]]
    total = len(veterans)

    print(f"\nObteniendo PRs de {total} competidores veteranos...")

    for i, competitor in enumerate(veterans, 1):
        wca_id = competitor["wca_id"]
        print(f"  [{i}/{total}] {competitor['name']} ({wca_id})", end=" ", flush=True)
        try:
            prs = get_person_prs(wca_id)
            all_prs[wca_id] = prs
            print(f"✓ ({len(prs)} eventos)")
        except Exception as e:
            print(f"✗ Error: {e}")
            all_prs[wca_id] = {}

        if i < total:
            time.sleep(delay)

    return all_prs


def build_tournament_data(competition_id: str) -> dict:
    """
    Función principal: ensambla todos los datos del torneo.
    """
    print(f"Cargando datos de: {competition_id}")

    # 1. Info básica
    comp = get_competition(competition_id)
    print(f"  Torneo: {comp['name']}")
    print(f"  Fecha:  {comp.get('start_date')} → {comp.get('end_date')}")
    print(f"  Ciudad: {comp.get('city')}, {comp.get('country_iso2')}")

    # 2. WCIF (eventos + personas)
    print("\nCargando WCIF público...")
    wcif = get_wcif(competition_id)

    events     = parse_events(wcif)
    competitors = parse_competitors(wcif)

    print(f"  Eventos:       {len(events)}")
    print(f"  Competidores:  {len(competitors)} aceptados")
    new_count = sum(1 for c in competitors if c["is_new"])
    print(f"  Nuevos:        {new_count}")

    # 3. PRs de todos los veteranos
    all_prs = fetch_all_prs(competitors)

    # 4. Ensamblar estructura final
    competitors_full = []
    for c in competitors:
        wca_id = c["wca_id"]
        raw_prs = all_prs.get(wca_id, {}) if wca_id else {}

        # Solo PRs de los eventos en los que está inscrito
        prs_display = {}
        for eid in c["events"]:
            if eid in raw_prs:
                prs_display[eid] = {
                    "event_name": EVENT_NAMES.get(eid, eid),
                    "single_cs":  raw_prs[eid]["single"],
                    "average_cs": raw_prs[eid]["average"],
                    "single_fmt": format_time(raw_prs[eid]["single"], eid),
                    "average_fmt": format_time(raw_prs[eid]["average"], eid),
                }
            else:
                # Veterano sin PR en este evento (nunca compitió en él)
                prs_display[eid] = {
                    "event_name":  EVENT_NAMES.get(eid, eid),
                    "single_cs":   None,
                    "average_cs":  None,
                    "single_fmt":  "—",
                    "average_fmt": "—",
                }

        competitors_full.append({
            "name":          c["name"],
            "wca_id":        wca_id,
            "is_new":        c["is_new"],
            "country":       c["country"],
            "events":        c["events"],
            "prs":           prs_display,
        })

    return {
        "competition_id":   competition_id,
        "name":             comp["name"],
        "start_date":       comp.get("start_date"),
        "end_date":         comp.get("end_date"),
        "city":             comp.get("city"),
        "events":           events,
        "competitors":      competitors_full,
    }


def print_summary(data: dict):
    """Imprime un resumen legible en consola."""
    print("\n" + "="*60)
    print(f"TORNEO: {data['name']}")
    print(f"Fecha:  {data['start_date']} → {data['end_date']}")
    print(f"Ciudad: {data['city']}")
    print("="*60)

    print(f"\nEVENTOS ({len(data['events'])}):")
    for e in data["events"]:
        print(f"  {e['name']:30s}  {e['rounds']} ronda(s)")

    print(f"\nCOMPETIDORES ({len(data['competitors'])}):")
    for c in data["competitors"]:
        tag = "[NUEVO]" if c["is_new"] else f"[{c['wca_id']}]"
        print(f"  {c['name']:35s} {tag}")
        for eid, pr in c["prs"].items():
            print(f"    {pr['event_name']:25s}  single: {pr['single_fmt']:8s}  avg: {pr['average_fmt']}")


def main():
    print("=" * 60)
    print("  WCA Tournament Data Ingestion")
    print("=" * 60)
    print()

    while True:
        competition_id = input("ID de la competencia WCA: ").strip()
        if competition_id:
            break
        print("  Advertencia: el ID no puede estar vacio, intenta de nuevo.")

    out_dir_str = input("Directorio de salida [Enter = carpeta actual]: ").strip()
    if not out_dir_str:
        out_dir_str = "."

    print()

    try:
        data = build_tournament_data(competition_id)
    except Exception as e:
        print(f"\nError al obtener datos: {e}")
        input("\nPresiona Enter para cerrar...")
        return

    print_summary(data)

    out_dir = Path(out_dir_str)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{competition_id}_data.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

    print(f"\nJSON guardado en: {out_path}")
    input("\nPresiona Enter para cerrar...")


if __name__ == "__main__":
    main()
