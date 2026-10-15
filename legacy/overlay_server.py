"""
WCA Overlay WebSocket Server
==============================
Sirve como puente entre el operador (teclado/CLI) y los overlays HTML en OBS.

Uso:
    pip install websockets
    python overlay_server.py --data NadaQueVerBucaramanga2026_data.json

Comandos interactivos (escribir en la terminal):
    c <nombre_o_wcaid>      → mostrar competidor (busca por nombre parcial o WCAID)
    e <event_id> <ronda>    → cambiar evento activo  (ej: e 333 2)
    hc                      → ocultar card competidor
    he                      → ocultar badge evento
    q                       → salir
"""


import asyncio
import json
import sys
import argparse
from pathlib import Path

try:
    import websockets
except ImportError:
    print("Falta: pip install websockets")
    sys.exit(1)

# ── Estado global ──
tournament_data: dict = {}
competitors_index: dict = {}   # nombre_lower → competitor dict
wcaid_index: dict = {}         # wcaid_lower  → competitor dict
current_event: str | None = None
connected_clients: set = set()


# ── Helpers ──

def load_data(json_path: str):
    global tournament_data, competitors_index, wcaid_index
    with open(json_path, encoding="utf-8") as f:
        tournament_data = json.load(f)

    for c in tournament_data.get("competitors", []):
        competitors_index[c["name"].lower()] = c
        if c.get("wca_id"):
            wcaid_index[c["wca_id"].lower()] = c

    print(f"[server] Cargados {len(tournament_data['competitors'])} competidores")
    print(f"[server] Torneo: {tournament_data['name']}")


def find_competitor(query: str) -> dict | None:
    """Busca por WCAID exacto o nombre parcial (case-insensitive)."""
    q = query.strip().lower()

    # Exacto por WCAID
    if q in wcaid_index:
        return wcaid_index[q]

    # Exacto por nombre
    if q in competitors_index:
        return competitors_index[q]

    # Parcial por nombre
    matches = [c for name, c in competitors_index.items() if q in name]
    if len(matches) == 1:
        return matches[0]
    if len(matches) > 1:
        names = ", ".join(m["name"] for m in matches[:5])
        print(f"[server] Ambiguo — coincidencias: {names}")
        return None

    print(f"[server] No encontrado: '{query}'")
    return None


def get_event_info(event_id: str) -> dict | None:
    for e in tournament_data.get("events", []):
        if e["event_id"] == event_id:
            return e
    return None


# ── Broadcast ──

async def broadcast(message: dict):
    if not connected_clients:
        return
    payload = json.dumps(message, ensure_ascii=False)
    await asyncio.gather(
        *[ws.send(payload) for ws in connected_clients],
        return_exceptions=True
    )


# ── Comandos ──

async def cmd_competitor(args: list[str]):
    global current_event
    query = " ".join(args)
    c = find_competitor(query)
    if not c:
        return

    print(f"[server] → Competidor: {c['name']} ({c.get('wca_id') or 'NUEVO'})")
    await broadcast({
        "type": "competitor",
        "data": {
            "name":          c["name"],
            "wca_id":        c.get("wca_id"),
            "is_new":        c["is_new"],
            "country":       c.get("country", ""),
            "prs":           c.get("prs", {}),
            "current_event": current_event,
        }
    })


async def cmd_event(args: list[str]):
    global current_event
    if not args:
        print("[server] Uso: e <event_id> [ronda]")
        return

    event_id     = args[0]
    round_number = int(args[1]) if len(args) > 1 else 1
    info         = get_event_info(event_id)

    if not info:
        print(f"[server] Evento no encontrado: '{event_id}'")
        print(f"         Disponibles: {[e['event_id'] for e in tournament_data.get('events',[])]}")
        return

    current_event = event_id
    print(f"[server] → Evento: {info['name']}  ronda {round_number}/{info['rounds']}")

    await broadcast({
        "type": "event",
        "data": {
            "event_id":     event_id,
            "event_name":   info["name"],
            "round_number": round_number,
            "total_rounds": info["rounds"],
        }
    })


async def process_command(line: str):
    parts = line.strip().split()
    if not parts:
        return

    cmd  = parts[0].lower()
    args = parts[1:]

    if cmd == "c":
        await cmd_competitor(args)
    elif cmd == "e":
        await cmd_event(args)
    elif cmd == "hc":
        await broadcast({"type": "hide_competitor"})
        print("[server] → Card competidor oculto")
    elif cmd == "he":
        await broadcast({"type": "hide_event"})
        print("[server] → Badge evento oculto")
    elif cmd in ("q", "quit", "exit"):
        print("[server] Cerrando...")
        sys.exit(0)
    else:
        print(f"[server] Comando desconocido: '{cmd}'")
        print("         Comandos: c <nombre/wcaid> | e <event_id> [ronda] | hc | he | q")


# ── WebSocket handler ──

async def ws_handler(websocket):
    connected_clients.add(websocket)
    print(f"[server] Cliente conectado ({len(connected_clients)} total)")
    try:
        await websocket.wait_closed()
    finally:
        connected_clients.discard(websocket)
        print(f"[server] Cliente desconectado ({len(connected_clients)} total)")


# ── Input loop (stdin) ──

async def input_loop():
    print("\n[server] Listo. Comandos:")
    print("  c <nombre o wcaid>   → mostrar competidor")
    print("  e <event_id> [ronda] → cambiar evento  (ej: e 333 2)")
    print("  hc                   → ocultar competidor")
    print("  he                   → ocultar evento")
    print("  q                    → salir\n")

    loop = asyncio.get_event_loop()

    while True:
        try:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:
                break
            await process_command(line)
        except asyncio.CancelledError:
            break
        except Exception as e:
            print(f"[server] Error en comando: {e}")


# ── Main ──

async def main(json_path: str, host: str, port: int):
    load_data(json_path)

    for try_port in range(port, port + 10):
        try:
            server = await websockets.serve(ws_handler, host, try_port)
            if try_port != port:
                print(f"[server] Puerto {port} ocupado, usando {try_port}.")
                print(f"[server] IMPORTANTE: cambia el puerto en overlay_competitor.html a {try_port}")
            else:
                print(f"[server] WebSocket activo en ws://{host}:{try_port}")
            break
        except OSError:
            print(f"[server] Puerto {try_port} ocupado, probando siguiente...")
    else:
        print(f"[server] Error: sin puertos disponibles entre {port} y {port+9}")
        sys.exit(1)

    async with server:
        await input_loop()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="WCA Overlay WebSocket Server")
    parser.add_argument("--data",  required=True, help="JSON generado por wca_data_ingestion.py")
    parser.add_argument("--host",  default="localhost")
    parser.add_argument("--port",  type=int, default=8765)
    args = parser.parse_args()

    if not Path(args.data).exists():
        print(f"Error: no se encontró el archivo '{args.data}'")
        sys.exit(1)

    asyncio.run(main(args.data, args.host, args.port))
