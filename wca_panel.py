"""
WCA Overlay — Panel de Control Integrado
==========================================
Servidor todo-en-uno: HTTP + WebSocket + abre el navegador automáticamente.

Uso:
    pip install websockets
    python wca_panel.py
    python wca_panel.py --data miTorneo_data.json
    python wca_panel.py --port 8080 --ws-port 8765

El panel se abre en http://localhost:8080
Los overlays de OBS siguen conectándose a ws://localhost:8765
"""

import argparse
import asyncio
import json
import os
import sys
import threading
import time
import webbrowser
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

try:
    import websockets
    from websockets.server import serve as ws_serve
except ImportError:
    print("=" * 55)
    print("  Falta la dependencia: websockets")
    print("  Instálala con:  pip install websockets")
    print("=" * 55)
    input("\nPresiona Enter para cerrar...")
    sys.exit(1)

# ══════════════════════════════════════════════════════════
#   HTML del panel (embebido)
# ══════════════════════════════════════════════════════════

PANEL_HTML = r"""<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>WCA Overlay — Panel de Control</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=DM+Sans:wght@300;400;500;600&display=swap" rel="stylesheet">
<style>
  :root {
    --bg:#0a0a0f; --surface:#13131a; --surface2:#1c1c28; --surface3:#252535;
    --accent:#00C8FF; --text:#e8e8f0; --text2:#8a8aaa; --text3:#55556a;
    --border:#2a2a3e; --danger:#ff4d6d; --success:#22c55e; --warning:#f59e0b;
    --radius:10px;
  }
  * { margin:0; padding:0; box-sizing:border-box; }
  body { font-family:'DM Sans',sans-serif; background:var(--bg); color:var(--text);
         min-height:100vh; display:grid; grid-template-rows:60px 1fr;
         grid-template-columns:260px 1fr; }
  header { grid-column:1/-1; background:var(--surface); border-bottom:1px solid var(--border);
           display:flex; align-items:center; padding:0 24px; gap:16px; }
  .logo { font-family:'Space Mono',monospace; font-size:15px; font-weight:700;
          color:var(--accent); display:flex; align-items:center; gap:10px; }
  .logo-icon { width:28px; height:28px; background:var(--accent); border-radius:6px;
               display:flex; align-items:center; justify-content:center; }
  .logo-icon svg { width:16px; height:16px; fill:#000; }
  header .spacer { flex:1; }
  .ws-status { display:flex; align-items:center; gap:8px; font-size:13px;
               color:var(--text2); font-family:'Space Mono',monospace; }
  .ws-dot { width:8px; height:8px; border-radius:50%; background:var(--text3); transition:background .3s; }
  .ws-dot.connected { background:var(--success); }
  .ws-dot.error { background:var(--danger); }
  .tournament-name { font-size:13px; color:var(--text2); padding:4px 12px;
                     background:var(--surface2); border-radius:20px; border:1px solid var(--border);
                     max-width:280px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  aside { background:var(--surface); border-right:1px solid var(--border);
          padding:20px 0; overflow-y:auto; display:flex; flex-direction:column; gap:4px; }
  .section-label { font-size:10px; letter-spacing:2px; text-transform:uppercase;
                   color:var(--text3); font-family:'Space Mono',monospace; padding:12px 20px 4px; }
  .nav-item { display:flex; align-items:center; gap:10px; padding:10px 20px;
              font-size:14px; color:var(--text2); cursor:pointer;
              border-left:2px solid transparent; transition:all .15s; }
  .nav-item:hover { background:var(--surface2); color:var(--text); }
  .nav-item.active { background:rgba(0,200,255,.08); border-left-color:var(--accent); color:var(--accent); }
  .nav-item .icon { font-size:18px; width:20px; text-align:center; }
  .nav-badge { margin-left:auto; font-size:11px; background:var(--surface3); color:var(--text2);
               padding:2px 8px; border-radius:10px; font-family:'Space Mono',monospace; }
  main { overflow-y:auto; padding:28px 32px; display:flex; flex-direction:column; gap:24px; }
  .panel { display:none; flex-direction:column; gap:20px; }
  .panel.active { display:flex; }
  .page-title { font-size:22px; font-weight:600; color:var(--text); }
  .card { background:var(--surface); border:1px solid var(--border);
          border-radius:var(--radius); padding:20px 24px; }
  .card-title { font-size:13px; font-weight:600; color:var(--text); margin-bottom:16px;
                display:flex; align-items:center; gap:8px; }
  .card-title .tag { font-size:10px; padding:2px 8px; border-radius:10px;
                     background:rgba(0,200,255,.12); color:var(--accent);
                     font-family:'Space Mono',monospace; }
  .form-row { display:flex; gap:12px; align-items:flex-end; flex-wrap:wrap; }
  .form-group { display:flex; flex-direction:column; gap:6px; flex:1; min-width:180px; }
  label { font-size:12px; color:var(--text2); font-weight:500; }
  input[type="text"],input[type="number"],select {
    background:var(--surface2); border:1px solid var(--border); border-radius:7px;
    color:var(--text); font-family:'DM Sans',sans-serif; font-size:14px;
    padding:9px 14px; outline:none; transition:border-color .15s; width:100%; }
  input:focus,select:focus { border-color:var(--accent); }
  input::placeholder { color:var(--text3); }
  select option { background:var(--surface2); }
  .btn { display:inline-flex; align-items:center; gap:8px; padding:9px 18px;
         border-radius:7px; font-size:14px; font-weight:500; cursor:pointer;
         border:none; transition:all .15s; white-space:nowrap; font-family:'DM Sans',sans-serif; }
  .btn:active { transform:scale(.97); }
  .btn-primary { background:var(--accent); color:#000; font-weight:600; }
  .btn-primary:hover { background:#22d4ff; }
  .btn-ghost { background:var(--surface2); color:var(--text); border:1px solid var(--border); }
  .btn-ghost:hover { background:var(--surface3); }
  .btn-danger { background:rgba(255,77,109,.15); color:var(--danger); border:1px solid rgba(255,77,109,.3); }
  .btn-danger:hover { background:rgba(255,77,109,.25); }
  .btn-success { background:rgba(34,197,94,.15); color:var(--success); border:1px solid rgba(34,197,94,.3); }
  .btn:disabled { opacity:.4; cursor:not-allowed; transform:none; }
  .progress-wrap { display:none; flex-direction:column; gap:8px; }
  .progress-bar-bg { background:var(--surface2); border-radius:4px; height:6px; overflow:hidden; }
  .progress-bar-fill { height:100%; background:var(--accent); border-radius:4px; transition:width .3s; width:0%; }
  .progress-label { font-size:12px; color:var(--text2); font-family:'Space Mono',monospace; }
  .log-box { background:var(--bg); border:1px solid var(--border); border-radius:7px;
             padding:14px 16px; font-family:'Space Mono',monospace; font-size:12px;
             color:var(--text2); height:200px; overflow-y:auto;
             display:flex; flex-direction:column; gap:3px; }
  .log-line { line-height:1.6; }
  .log-line.info { color:var(--accent); }
  .log-line.ok { color:var(--success); }
  .log-line.warn { color:var(--warning); }
  .log-line.error { color:var(--danger); }
  .log-line.dim { color:var(--text3); }
  .search-results { background:var(--surface2); border:1px solid var(--border);
                    border-radius:7px; max-height:260px; overflow-y:auto;
                    display:none; flex-direction:column; }
  .search-results.open { display:flex; }
  .result-item { display:flex; align-items:center; gap:12px; padding:11px 14px;
                 cursor:pointer; border-bottom:1px solid var(--border); transition:background .1s; }
  .result-item:last-child { border-bottom:none; }
  .result-item:hover { background:var(--surface3); }
  .result-avatar { width:36px; height:36px; border-radius:50%; background:var(--surface3);
                   display:flex; align-items:center; justify-content:center;
                   font-size:14px; font-weight:600; color:var(--accent); flex-shrink:0;
                   font-family:'Space Mono',monospace; }
  .result-name { font-size:14px; font-weight:500; color:var(--text); }
  .result-meta { font-size:12px; color:var(--text2); font-family:'Space Mono',monospace; margin-top:2px; }
  .result-events { margin-left:auto; display:flex; gap:4px; flex-wrap:wrap;
                   max-width:160px; justify-content:flex-end; }
  .ev-tag { font-size:10px; padding:2px 7px; border-radius:10px;
            background:var(--surface); border:1px solid var(--border);
            color:var(--text3); font-family:'Space Mono',monospace; }
  .badge-new { background:rgba(0,200,255,.15); color:var(--accent); border-color:rgba(0,200,255,.3); }
  .active-card { background:var(--surface2); border:1px solid rgba(0,200,255,.25);
                 border-radius:var(--radius); padding:20px; display:none; }
  .active-card.visible { display:block; }
  .ac-header { display:flex; align-items:center; gap:16px; margin-bottom:16px; }
  .ac-flag { font-size:36px; line-height:1; }
  .ac-name { font-size:26px; font-weight:600; color:var(--text); line-height:1.1; }
  .ac-id { font-family:'Space Mono',monospace; font-size:13px; color:var(--text2); margin-top:4px; }
  .pr-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:10px; }
  .pr-item { background:var(--surface); border:1px solid var(--border); border-radius:7px; padding:12px 14px; }
  .pr-ev { font-size:11px; color:var(--text2); font-family:'Space Mono',monospace;
           letter-spacing:.5px; margin-bottom:8px; text-transform:uppercase; }
  .pr-vals { display:flex; gap:14px; }
  .pr-val { display:flex; flex-direction:column; gap:2px; }
  .pr-type { font-size:10px; color:var(--text3); text-transform:uppercase; letter-spacing:.5px; }
  .pr-num { font-family:'Space Mono',monospace; font-size:16px; font-weight:700; color:var(--text); }
  .pr-num.na { color:var(--text3); font-size:14px; }
  .event-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(110px,1fr)); gap:10px; }
  .event-btn { background:var(--surface2); border:1px solid var(--border); border-radius:8px;
               padding:14px 12px; text-align:center; cursor:pointer; transition:all .15s;
               display:flex; flex-direction:column; align-items:center; gap:8px; }
  .event-btn:hover { border-color:var(--accent); background:rgba(0,200,255,.05); }
  .event-btn.selected { border-color:var(--accent); background:rgba(0,200,255,.12); }
  .event-btn .ev-icon { font-size:22px; line-height:1; }
  .event-btn .ev-name { font-size:11px; color:var(--text2); font-family:'Space Mono',monospace; }
  .event-btn.selected .ev-name { color:var(--accent); }
  .round-select { display:flex; align-items:center; gap:10px; }
  .round-btn { width:32px; height:32px; border-radius:6px; background:var(--surface2);
               border:1px solid var(--border); color:var(--text); font-size:18px; cursor:pointer;
               display:flex; align-items:center; justify-content:center; transition:all .1s; }
  .round-btn:hover { border-color:var(--accent); color:var(--accent); }
  .round-num { font-family:'Space Mono',monospace; font-size:22px; font-weight:700;
               color:var(--text); min-width:60px; text-align:center; }
  .stat-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:12px; }
  .stat-card { background:var(--surface2); border:1px solid var(--border); border-radius:8px; padding:16px; }
  .stat-value { font-family:'Space Mono',monospace; font-size:26px; font-weight:700;
                color:var(--text); line-height:1; }
  .stat-label { font-size:11px; color:var(--text2); margin-top:6px;
                text-transform:uppercase; letter-spacing:.5px; }
  .control-row { display:flex; gap:12px; flex-wrap:wrap; }
  .live-bar { background:rgba(34,197,94,.08); border:1px solid rgba(34,197,94,.2);
              border-radius:var(--radius); padding:12px 20px;
              display:none; align-items:center; gap:14px; }
  .live-bar.visible { display:flex; }
  .live-pulse { width:10px; height:10px; border-radius:50%; background:var(--success);
                animation:pulse 1.5s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .live-text { font-family:'Space Mono',monospace; font-size:13px; color:var(--success); flex:1; }
  .steps { display:flex; gap:0; margin-bottom:8px; }
  .step { display:flex; flex-direction:column; align-items:center; gap:6px;
          flex:1; position:relative; }
  .step:not(:last-child)::after { content:''; position:absolute; top:14px; left:50%;
    width:100%; height:1px; background:var(--border); z-index:0; }
  .step.done::after { background:var(--accent); }
  .step-circle { width:28px; height:28px; border-radius:50%; background:var(--surface2);
                 border:1px solid var(--border); display:flex; align-items:center;
                 justify-content:center; font-size:12px; font-family:'Space Mono',monospace;
                 color:var(--text3); position:relative; z-index:1; transition:all .3s; }
  .step.done .step-circle { background:var(--accent); border-color:var(--accent); color:#000; font-weight:700; }
  .step.active .step-circle { border-color:var(--accent); color:var(--accent); }
  .step-label { font-size:11px; color:var(--text3); text-align:center; font-family:'Space Mono',monospace; }
  .step.done .step-label { color:var(--accent); }
  .step.active .step-label { color:var(--text); }
  ::-webkit-scrollbar { width:5px; }
  ::-webkit-scrollbar-track { background:transparent; }
  ::-webkit-scrollbar-thumb { background:var(--surface3); border-radius:10px; }
  .empty-state { text-align:center; padding:40px 20px; color:var(--text3); font-size:14px; }
  .empty-state .big { font-size:36px; margin-bottom:12px; }
  .comp-filters { display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
  .comp-list { display:flex; flex-direction:column; gap:6px; max-height:460px; overflow-y:auto; }
  .comp-row { display:flex; align-items:center; gap:12px; padding:10px 14px;
              background:var(--surface2); border:1px solid var(--border);
              border-radius:7px; cursor:pointer; transition:border-color .15s; }
  .comp-row:hover { border-color:var(--accent); }
  .comp-row .name { font-size:14px; font-weight:500; flex:1; }
  .comp-row .wid { font-family:'Space Mono',monospace; font-size:12px; color:var(--text2); }
  .comp-row .flag { font-size:20px; }
  #toast { position:fixed; bottom:24px; right:24px; background:var(--surface3);
           border:1px solid var(--border); border-radius:9px; padding:14px 20px;
           font-size:14px; color:var(--text); opacity:0; transform:translateY(10px);
           transition:all .25s; pointer-events:none; z-index:1000;
           display:flex; align-items:center; gap:10px; max-width:320px; }
  #toast.show { opacity:1; transform:translateY(0); }
  #toast.ok { border-color:rgba(34,197,94,.5); }
  #toast.err { border-color:rgba(255,77,109,.5); }
  .search-wrap { position:relative; }
  .search-clear { position:absolute; right:12px; top:50%; transform:translateY(-50%);
                  cursor:pointer; color:var(--text3); font-size:18px; display:none; line-height:1; }
  .server-info { background:rgba(0,200,255,.06); border:1px solid rgba(0,200,255,.2);
                 border-radius:8px; padding:12px 16px; font-family:'Space Mono',monospace;
                 font-size:12px; color:var(--text2); display:flex; align-items:center; gap:12px; }
  .server-info strong { color:var(--accent); }
</style>
</head>
<body>

<header>
  <div class="logo">
    <div class="logo-icon">
      <svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
        <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
      </svg>
    </div>
    WCA Overlay
  </div>
  <div class="spacer"></div>
  <span class="tournament-name" id="header-tournament-name">Sin torneo cargado</span>
  <div class="ws-status">
    <div class="ws-dot" id="ws-dot"></div>
    <span id="ws-label">Conectando…</span>
  </div>
</header>

<aside>
  <div class="section-label">Flujo</div>
  <div class="nav-item active" onclick="navTo('data')" id="nav-data">
    <span class="icon">⬇</span> Datos del torneo
  </div>
  <div class="nav-item" onclick="navTo('control')" id="nav-control">
    <span class="icon">🎛</span> Control en vivo
    <span class="nav-badge" id="badge-count">—</span>
  </div>
  <div class="section-label">Info</div>
  <div class="nav-item" onclick="navTo('competitors')" id="nav-competitors">
    <span class="icon">👥</span> Competidores
  </div>
  <div class="nav-item" onclick="navTo('events')" id="nav-events">
    <span class="icon">🎯</span> Eventos
  </div>
</aside>

<main>

  <!-- ━━━ DATOS ━━━ -->
  <div class="panel active" id="panel-data">
    <div>
      <div class="page-title">Datos del torneo</div>
      <div style="font-size:14px;color:var(--text2);margin-top:6px;">Descarga o carga el JSON de datos de la competencia WCA.</div>
    </div>

    <div class="server-info" id="server-info">
      🖥 Servidor local activo — Panel: <strong id="info-panel-url">…</strong> &nbsp;|&nbsp; WebSocket OBS: <strong id="info-ws-url">…</strong>
    </div>

    <div class="steps">
      <div class="step done" id="step1"><div class="step-circle">1</div><div class="step-label">Servidor</div></div>
      <div class="step" id="step2"><div class="step-circle">2</div><div class="step-label">Datos</div></div>
      <div class="step" id="step3"><div class="step-circle">3</div><div class="step-label">Listo</div></div>
    </div>

    <div class="card" id="card-preloaded" style="display:none;">
      <div class="card-title">✅ Torneo precargado <span class="tag">DESDE ARGUMENTO</span></div>
      <p style="font-size:13px;color:var(--text2);" id="preloaded-desc">—</p>
      <div style="margin-top:14px;">
        <button class="btn btn-primary" onclick="usePreloaded()">▶ Usar estos datos</button>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Descargar desde WCA <span class="tag">API PÚBLICA</span></div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">
        Ingresa el ID de la competencia para descargar todos los datos.
        El JSON se guardará automáticamente en la carpeta del servidor.
      </p>
      <div class="form-row">
        <div class="form-group">
          <label>ID de la competencia</label>
          <input type="text" id="comp-id" placeholder="ej: NadaQueVerBucaramanga2026">
        </div>
      </div>
      <div style="margin-top:14px;display:flex;gap:10px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="downloadData()">⬇ Descargar datos</button>
      </div>
      <div class="progress-wrap" id="progress-wrap" style="margin-top:16px;">
        <div class="progress-label" id="progress-label">Conectando...</div>
        <div class="progress-bar-bg"><div class="progress-bar-fill" id="progress-fill"></div></div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Cargar JSON local <span class="tag">YA DESCARGADO</span></div>
      <p style="font-size:13px;color:var(--text2);margin-bottom:16px;">
        Si ya tienes el JSON generado anteriormente, cárgalo directamente.
      </p>
      <div class="form-row">
        <div class="form-group">
          <label>Archivo JSON</label>
          <input type="file" id="json-file" accept=".json"
            style="background:var(--surface2);border:1px solid var(--border);border-radius:7px;color:var(--text);padding:8px 14px;font-size:13px;">
        </div>
      </div>
      <div style="margin-top:14px;">
        <button class="btn btn-ghost" onclick="loadLocalJSON()">📂 Cargar JSON</button>
      </div>
    </div>

    <div class="log-box" id="data-log">
      <div class="log-line dim">// Esperando acción...</div>
    </div>
  </div>

  <!-- ━━━ CONTROL ━━━ -->
  <div class="panel" id="panel-control">
    <div>
      <div class="page-title">Control en vivo</div>
      <div style="font-size:14px;color:var(--text2);margin-top:6px;">Controla los overlays en OBS en tiempo real.</div>
    </div>

    <div class="live-bar" id="live-bar">
      <div class="live-pulse"></div>
      <div class="live-text" id="live-text">WebSocket conectado</div>
      <button class="btn btn-ghost" style="padding:6px 14px;font-size:13px;" onclick="reconnectWS()">⟳ Reconectar</button>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;align-items:start;">
      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="card">
          <div class="card-title">Competidor activo</div>
          <div class="search-wrap" style="margin-bottom:10px;">
            <input type="text" id="comp-search" placeholder="Buscar por nombre o WCAID…" oninput="searchCompetitor(this.value)">
            <span class="search-clear" id="search-clear" onclick="clearSearch()">✕</span>
          </div>
          <div class="search-results" id="search-results"></div>
          <div class="active-card" id="active-competitor-card">
            <div class="ac-header">
              <div class="ac-flag" id="ac-flag">🏳</div>
              <div>
                <div class="ac-name" id="ac-name">—</div>
                <div class="ac-id" id="ac-id">—</div>
              </div>
            </div>
            <div class="pr-grid" id="ac-prs"></div>
          </div>
          <div class="control-row" style="margin-top:14px;">
            <button class="btn btn-primary" id="btn-show-comp" onclick="sendCompetitor()" disabled>▶ Mostrar en overlay</button>
            <button class="btn btn-danger" onclick="sendHideCompetitor()">✕ Ocultar</button>
          </div>
        </div>
      </div>

      <div style="display:flex;flex-direction:column;gap:14px;">
        <div class="card">
          <div class="card-title">Evento activo</div>
          <div class="event-grid" id="event-grid">
            <div class="empty-state" style="grid-column:1/-1;padding:20px;">Carga datos primero</div>
          </div>
          <div style="margin-top:16px;display:flex;align-items:center;gap:16px;flex-wrap:wrap;">
            <div style="flex:1;">
              <label style="margin-bottom:8px;display:block;">Ronda</label>
              <div class="round-select">
                <button class="round-btn" onclick="changeRound(-1)">−</button>
                <div class="round-num" id="round-display">1 / 1</div>
                <button class="round-btn" onclick="changeRound(1)">+</button>
              </div>
            </div>
            <div style="display:flex;flex-direction:column;gap:8px;margin-top:20px;">
              <button class="btn btn-primary" id="btn-show-event" onclick="sendEvent()" disabled>▶ Mostrar evento</button>
              <button class="btn btn-danger" onclick="sendHideEvent()">✕ Ocultar</button>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-title">Acciones rápidas</div>
          <div class="control-row">
            <button class="btn btn-danger" onclick="sendHideAll()">🚫 Ocultar todo</button>
            <button class="btn btn-success" onclick="refreshOverlays()">⟳ Refrescar</button>
          </div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-title">Log de actividad</div>
      <div class="log-box" id="live-log">
        <div class="log-line dim">// Conectando al servidor local...</div>
      </div>
    </div>
  </div>

  <!-- ━━━ COMPETIDORES ━━━ -->
  <div class="panel" id="panel-competitors">
    <div class="page-title">Competidores</div>
    <div class="stat-grid">
      <div class="stat-card"><div class="stat-value" id="stat-total">—</div><div class="stat-label">Total</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-new">—</div><div class="stat-label">Nuevos</div></div>
      <div class="stat-card"><div class="stat-value" id="stat-countries">—</div><div class="stat-label">Países</div></div>
    </div>
    <div class="card">
      <div class="comp-filters">
        <input type="text" id="filter-search" placeholder="Buscar…" oninput="filterCompetitors()" style="flex:1;min-width:180px;">
        <select id="filter-event" onchange="filterCompetitors()"><option value="">Todos los eventos</option></select>
        <select id="filter-new" onchange="filterCompetitors()">
          <option value="">Todos</option>
          <option value="new">Solo nuevos</option>
          <option value="vet">Solo veteranos</option>
        </select>
      </div>
    </div>
    <div class="comp-list" id="comp-list">
      <div class="empty-state"><div class="big">📋</div>Carga un torneo primero</div>
    </div>
  </div>

  <!-- ━━━ EVENTOS ━━━ -->
  <div class="panel" id="panel-events">
    <div class="page-title">Eventos del torneo</div>
    <div class="card"><div id="events-table">
      <div class="empty-state"><div class="big">🎯</div>Carga un torneo primero</div>
    </div></div>
  </div>

</main>

<div id="toast"></div>

<script>
// ── Config inyectada por el servidor ──
const WS_PORT = __WS_PORT__;
const HTTP_PORT = __HTTP_PORT__;

// ── Estado ──
let tournamentData = null, ws = null, wsReconnectTimer = null;
let selectedCompetitor = null, selectedEventId = null;
let currentRound = 1, maxRounds = 1;
let preloadedData = null;

const EVENT_ICONS = {
  "333":"🟦","222":"🟩","444":"🟧","555":"🟪","666":"🟥","777":"⬛",
  "333bf":"🕶","333fm":"📝","333oh":"✋","clock":"🕐","minx":"⭐",
  "pyram":"🔺","skewb":"💠","sq1":"🔷","444bf":"🕶","555bf":"🕶","333mbf":"🏅"
};
const EVENT_NAMES = {
  "333":"3x3","222":"2x2","444":"4x4","555":"5x5","666":"6x6","777":"7x7",
  "333bf":"3x3 Blind","333fm":"Fewest Moves","333oh":"3x3 OH","clock":"Clock",
  "minx":"Megaminx","pyram":"Pyraminx","skewb":"Skewb","sq1":"Square-1",
  "444bf":"4x4 Blind","555bf":"5x5 Blind","333mbf":"Multi-Blind"
};

// ── Navegación ──
function navTo(id) {
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.getElementById('panel-' + id).classList.add('active');
  document.getElementById('nav-' + id).classList.add('active');
}

// ── Toast ──
function toast(msg, type='ok') {
  const t = document.getElementById('toast');
  t.textContent = (type==='ok'?'✓ ':type==='err'?'✕ ':'ℹ ') + msg;
  t.className = 'show ' + type;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.className='', 2800);
}

// ── Log ──
function log(boxId, msg, cls='') {
  const box = document.getElementById(boxId);
  const line = document.createElement('div');
  const ts = new Date().toLocaleTimeString('es-CO',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
  line.className = 'log-line ' + cls;
  line.textContent = `[${ts}] ${msg}`;
  box.appendChild(line);
  box.scrollTop = box.scrollHeight;
}

// ── WebSocket al servidor local ──
function connectWS() {
  clearTimeout(wsReconnectTimer);
  if (ws) { try { ws.close(); } catch(e){} ws = null; }

  ws = new WebSocket(`ws://localhost:${WS_PORT}`);

  ws.onopen = () => {
    setWSDot('connected');
    document.getElementById('ws-label').textContent = 'Conectado';
    document.getElementById('live-bar').classList.add('visible');
    log('live-log', 'WebSocket conectado al servidor local', 'ok');
    // Pedir datos precargados si existen
    ws.send(JSON.stringify({type:'get_preloaded'}));
  };

  ws.onmessage = (evt) => {
    try {
      const msg = JSON.parse(evt.data);
      if (msg.type === 'preloaded_data' && msg.data) {
        preloadedData = msg.data;
        showPreloadedCard(msg.data);
        log('data-log', `✓ Datos precargados: ${msg.data.name}`, 'ok');
      } else if (msg.type === 'client_count') {
        document.getElementById('live-text').textContent =
          `WebSocket conectado — Overlays OBS: ${msg.count}`;
      } else if (msg.type === 'save_ok') {
        log('data-log', `✓ JSON guardado en el servidor: ${msg.path}`, 'ok');
      } else {
        log('live-log', `← ${evt.data.substring(0,100)}`, 'dim');
      }
    } catch(e) {}
  };

  ws.onclose = () => {
    setWSDot('');
    document.getElementById('ws-label').textContent = 'Reconectando…';
    document.getElementById('live-bar').classList.remove('visible');
    wsReconnectTimer = setTimeout(connectWS, 3000);
  };

  ws.onerror = () => { setWSDot('error'); };
}

function reconnectWS() { connectWS(); }

function setWSDot(cls) {
  document.getElementById('ws-dot').className = 'ws-dot ' + cls;
}

function sendWS(payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    toast('Sin conexión WebSocket', 'err');
    return false;
  }
  ws.send(JSON.stringify(payload));
  log('live-log', `→ ${JSON.stringify(payload).substring(0,80)}`, 'ok');
  return true;
}

// ── Info del servidor ──
function initServerInfo() {
  document.getElementById('info-panel-url').textContent = `http://localhost:${HTTP_PORT}`;
  document.getElementById('info-ws-url').textContent = `ws://localhost:${WS_PORT}`;
}

// ── Datos precargados ──
function showPreloadedCard(data) {
  const card = document.getElementById('card-preloaded');
  const desc = document.getElementById('preloaded-desc');
  card.style.display = 'block';
  desc.textContent = `${data.name} · ${data.competitors.length} competidores · ${data.events.length} eventos`;
  setStep(2);
}

function usePreloaded() {
  if (!preloadedData) return;
  loadTournamentData(preloadedData);
  toast(`Usando: ${preloadedData.name}`);
}

// ── Steps ──
function setStep(n) {
  for (let i=1;i<=3;i++) {
    const el = document.getElementById('step'+i);
    el.className = 'step' + (i<n?' done':i===n?' active':'');
  }
}

// ── Descarga desde WCA ──
async function downloadData() {
  const compId = document.getElementById('comp-id').value.trim();
  if (!compId) { toast('Ingresa el ID de la competencia','err'); return; }

  setStep(2);
  showProgress(true);
  updateProgress(5,'Conectando a la API de WCA…');
  log('data-log',`Iniciando descarga: ${compId}`,'info');

  try {
    updateProgress(10,'Obteniendo info del torneo…');
    const compResp = await fetch(`https://www.worldcubeassociation.org/api/v0/competitions/${compId}`);
    if (!compResp.ok) throw new Error(`Competencia no encontrada (${compResp.status})`);
    const comp = await compResp.json();
    log('data-log',`✓ Torneo: ${comp.name}`,'ok');

    updateProgress(25,'Descargando WCIF público…');
    const wcifResp = await fetch(`https://www.worldcubeassociation.org/api/v0/competitions/${compId}/wcif/public`);
    if (!wcifResp.ok) throw new Error(`WCIF no disponible (${wcifResp.status})`);
    const wcif = await wcifResp.json();

    const events = parseEvents(wcif);
    const competitors = parseCompetitors(wcif);
    log('data-log',`✓ ${events.length} eventos, ${competitors.length} competidores`,'ok');
    updateProgress(40,`Obteniendo PRs de ${competitors.filter(c=>!c.is_new).length} veteranos…`);

    const veterans = competitors.filter(c=>!c.is_new);
    const allPRs = {};
    for (let i=0;i<veterans.length;i++) {
      const c = veterans[i];
      updateProgress(40+Math.round((i/veterans.length)*50),`[${i+1}/${veterans.length}] ${c.name}…`);
      try { allPRs[c.wca_id] = await getPersonPRs(c.wca_id); await sleep(200); }
      catch(e) { allPRs[c.wca_id] = {}; }
    }

    updateProgress(92,'Ensamblando datos…');
    const data = buildData(comp, events, competitors, allPRs);
    updateProgress(100,'¡Descarga completa!');
    log('data-log',`✓ Listo — ${competitors.length} competidores procesados`,'ok');

    // Guardar en servidor
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({type:'save_data', data, filename:`${compId}_data.json`}));
    }

    loadTournamentData(data);
    setStep(3);
    toast(`Datos de ${comp.name} listos`);
    setTimeout(()=>showProgress(false),2000);

  } catch(e) {
    log('data-log',`✗ Error: ${e.message}`,'error');
    toast(e.message,'err');
    updateProgress(0,'Error');
    showProgress(false);
    setStep(1);
  }
}

function showProgress(show) {
  document.getElementById('progress-wrap').style.display = show?'flex':'none';
}
function updateProgress(pct,label) {
  document.getElementById('progress-fill').style.width = pct+'%';
  document.getElementById('progress-label').textContent = label;
}

function loadLocalJSON() {
  const file = document.getElementById('json-file').files[0];
  if (!file) { toast('Selecciona un archivo JSON','err'); return; }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      loadTournamentData(data);
      log('data-log',`✓ JSON cargado: ${data.name||'Sin nombre'}`,'ok');
      toast('JSON cargado correctamente');
      setStep(3);
    } catch(err) {
      log('data-log',`✗ JSON inválido: ${err.message}`,'error');
      toast('JSON inválido','err');
    }
  };
  reader.readAsText(file);
}

// ── Parsers ──
function parseEvents(wcif) {
  return (wcif.events||[]).map(e=>({
    event_id:e.id, name:EVENT_NAMES[e.id]||e.id, rounds:(e.rounds||[]).length
  }));
}
function parseCompetitors(wcif) {
  return (wcif.persons||[])
    .filter(p=>p.registration?.status==='accepted')
    .map(p=>({name:p.name,wca_id:p.wcaId||null,is_new:!p.wcaId,
               registrant_id:p.registrantId,events:p.registration?.eventIds||[],country:p.countryIso2||''}))
    .sort((a,b)=>a.name.localeCompare(b.name));
}
async function getPersonPRs(wcaId) {
  const r = await fetch(`https://www.worldcubeassociation.org/api/v0/persons/${wcaId}`);
  if (!r.ok) return {};
  const data = await r.json();
  const raw = data.personal_records||data.persons?.[0]?.personal_records||{};
  const prs = {};
  for (const [eid,recs] of Object.entries(raw))
    prs[eid] = {single:recs.single?.best??null, average:recs.average?.best??null};
  return prs;
}
function formatTime(cs,eid) {
  if (cs==null) return '—';
  if (eid==='333fm') return String(cs);
  if (eid==='333mbf') return `MBLD:${cs}`;
  const total=Math.round(cs), min=Math.floor(total/6000), sec=(total%6000)/100;
  return min>0?`${min}:${sec.toFixed(2).padStart(5,'0')}`:sec.toFixed(2);
}
function buildData(comp,events,competitors,allPRs) {
  return {
    competition_id:comp.id, name:comp.name, start_date:comp.start_date,
    end_date:comp.end_date, city:comp.city, events,
    competitors: competitors.map(c=>{
      const rawPRs=allPRs[c.wca_id]||{}, prs={};
      for (const eid of c.events)
        prs[eid]={event_name:EVENT_NAMES[eid]||eid,
                  single_cs:rawPRs[eid]?.single??null, average_cs:rawPRs[eid]?.average??null,
                  single_fmt:formatTime(rawPRs[eid]?.single,eid),
                  average_fmt:formatTime(rawPRs[eid]?.average,eid)};
      return {...c,prs};
    })
  };
}
function sleep(ms){return new Promise(r=>setTimeout(r,ms));}

// ── Cargar datos en UI ──
function loadTournamentData(data) {
  tournamentData = data;
  document.getElementById('header-tournament-name').textContent = data.name;
  document.getElementById('badge-count').textContent = data.competitors.length;
  buildEventGrid(data.events);
  buildCompetitorList(data.competitors);
  buildEventsPanel(data.events);
  buildCompStats(data.competitors);
  populateFilterEvent(data.events);
  navTo('control');
}

// ── Panel Eventos ──
function buildEventGrid(events) {
  const grid=document.getElementById('event-grid');
  grid.innerHTML='';
  events.forEach(ev=>{
    const btn=document.createElement('div');
    btn.className='event-btn';
    btn.innerHTML=`<div class="ev-icon">${EVENT_ICONS[ev.event_id]||'🎲'}</div><div class="ev-name">${ev.name}</div>`;
    btn.onclick=()=>selectEvent(ev.event_id,ev.rounds,btn);
    grid.appendChild(btn);
  });
}
function selectEvent(eventId,rounds,btn) {
  selectedEventId=eventId; maxRounds=rounds; currentRound=1; updateRoundDisplay();
  document.querySelectorAll('.event-btn').forEach(b=>b.classList.remove('selected'));
  btn.classList.add('selected');
  document.getElementById('btn-show-event').disabled=false;
}
function updateRoundDisplay(){document.getElementById('round-display').textContent=`${currentRound} / ${maxRounds}`;}
function changeRound(d){currentRound=Math.max(1,Math.min(maxRounds,currentRound+d));updateRoundDisplay();}
function buildEventsPanel(events){
  let html=`<table style="width:100%;border-collapse:collapse;"><thead><tr>
    <th style="text-align:left;padding:8px 12px;font-size:12px;color:var(--text3);border-bottom:1px solid var(--border);">Evento</th>
    <th style="text-align:left;padding:8px 12px;font-size:12px;color:var(--text3);border-bottom:1px solid var(--border);">ID</th>
    <th style="text-align:center;padding:8px 12px;font-size:12px;color:var(--text3);border-bottom:1px solid var(--border);">Rondas</th>
  </tr></thead><tbody>`;
  events.forEach(ev=>{html+=`<tr>
    <td style="padding:10px 12px;font-size:14px;">${EVENT_ICONS[ev.event_id]||'🎲'} ${ev.name}</td>
    <td style="padding:10px 12px;font-family:'Space Mono',monospace;font-size:12px;color:var(--text2);">${ev.event_id}</td>
    <td style="padding:10px 12px;text-align:center;font-family:'Space Mono',monospace;color:var(--accent);">${ev.rounds}</td>
  </tr>`;});
  document.getElementById('events-table').innerHTML=html+'</tbody></table>';
}

// ── Panel Competidores ──
function buildCompStats(competitors){
  const countries=new Set(competitors.map(c=>c.country).filter(Boolean));
  document.getElementById('stat-total').textContent=competitors.length;
  document.getElementById('stat-new').textContent=competitors.filter(c=>c.is_new).length;
  document.getElementById('stat-countries').textContent=countries.size;
}
function populateFilterEvent(events){
  const sel=document.getElementById('filter-event');
  sel.innerHTML='<option value="">Todos los eventos</option>';
  events.forEach(ev=>{const o=document.createElement('option');o.value=ev.event_id;o.textContent=ev.name;sel.appendChild(o);});
}
function filterCompetitors(){
  const q=document.getElementById('filter-search').value.toLowerCase();
  const evF=document.getElementById('filter-event').value;
  const nF=document.getElementById('filter-new').value;
  const filtered=(tournamentData?.competitors||[]).filter(c=>{
    if(q&&!c.name.toLowerCase().includes(q)&&!(c.wca_id||'').toLowerCase().includes(q))return false;
    if(evF&&!c.events.includes(evF))return false;
    if(nF==='new'&&!c.is_new)return false;
    if(nF==='vet'&&c.is_new)return false;
    return true;
  });
  buildCompetitorList(filtered);
}
function buildCompetitorList(competitors){
  const list=document.getElementById('comp-list');
  if(!competitors.length){list.innerHTML='<div class="empty-state">No hay resultados</div>';return;}
  list.innerHTML='';
  competitors.forEach(c=>{
    const row=document.createElement('div'); row.className='comp-row';
    const ini=c.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
    row.innerHTML=`<div class="result-avatar">${ini}</div><div class="flag">${isoToFlag(c.country)}</div>
      <div class="name">${c.name}</div><div class="wid">${c.wca_id||'—'}</div>
      ${c.is_new?'<span class="ev-tag badge-new">NUEVO</span>':''}`;
    row.onclick=()=>{navTo('control');setActiveCompetitor(c);};
    list.appendChild(row);
  });
}

// ── Búsqueda ──
function searchCompetitor(query){
  const results=document.getElementById('search-results');
  const clear=document.getElementById('search-clear');
  clear.style.display=query?'block':'none';
  if(!query||!tournamentData){results.classList.remove('open');return;}
  const q=query.toLowerCase();
  const matches=tournamentData.competitors.filter(c=>
    c.name.toLowerCase().includes(q)||(c.wca_id||'').toLowerCase().includes(q)
  ).slice(0,8);
  if(!matches.length){
    results.innerHTML='<div class="result-item" style="color:var(--text3);cursor:default;">Sin resultados</div>';
    results.classList.add('open'); return;
  }
  results.innerHTML='';
  matches.forEach(c=>{
    const item=document.createElement('div'); item.className='result-item';
    const ini=c.name.split(' ').map(w=>w[0]).join('').substring(0,2).toUpperCase();
    const evTags=c.events.slice(0,4).map(e=>`<span class="ev-tag">${e}</span>`).join('');
    item.innerHTML=`<div class="result-avatar">${ini}</div>
      <div><div class="result-name">${c.name} ${c.is_new?'<span class="ev-tag badge-new">NUEVO</span>':''}</div>
      <div class="result-meta">${c.wca_id||'Sin WCAID'} · ${isoToFlag(c.country)} ${c.country}</div></div>
      <div class="result-events">${evTags}</div>`;
    item.onclick=()=>{setActiveCompetitor(c);results.classList.remove('open');
      document.getElementById('comp-search').value='';clear.style.display='none';};
    results.appendChild(item);
  });
  results.classList.add('open');
}
function clearSearch(){
  document.getElementById('comp-search').value='';
  document.getElementById('search-clear').style.display='none';
  document.getElementById('search-results').classList.remove('open');
}
function setActiveCompetitor(c){
  selectedCompetitor=c;
  document.getElementById('ac-flag').textContent=isoToFlag(c.country)||'🏳';
  document.getElementById('ac-name').textContent=c.name;
  document.getElementById('ac-id').textContent=c.is_new?'🆕 Competidor Nuevo':(c.wca_id||'—');
  const prsGrid=document.getElementById('ac-prs'); prsGrid.innerHTML='';
  const evShow=selectedEventId
    ?[selectedEventId,...c.events.filter(e=>e!==selectedEventId)].filter(e=>c.events.includes(e))
    :c.events;
  evShow.slice(0,6).forEach(eid=>{
    const pr=c.prs?.[eid], isCur=eid===selectedEventId;
    const item=document.createElement('div'); item.className='pr-item';
    if(isCur)item.style.borderColor='var(--accent)';
    item.innerHTML=`<div class="pr-ev">${EVENT_ICONS[eid]||''} ${EVENT_NAMES[eid]||eid}</div>
      <div class="pr-vals">
        <div class="pr-val"><div class="pr-type">Single</div>
          <div class="pr-num ${pr?.single_cs?'':'na'}">${pr?.single_fmt||'—'}</div></div>
        <div class="pr-val"><div class="pr-type">Avg</div>
          <div class="pr-num ${pr?.average_cs?'':'na'}">${pr?.average_fmt||'—'}</div></div>
      </div>`;
    prsGrid.appendChild(item);
  });
  document.getElementById('active-competitor-card').classList.add('visible');
  document.getElementById('btn-show-comp').disabled=false;
}

// ── Comandos overlay ──
function sendCompetitor(){
  if(!selectedCompetitor)return;
  const ok=sendWS({type:'competitor',data:{
    name:selectedCompetitor.name, wca_id:selectedCompetitor.wca_id,
    is_new:selectedCompetitor.is_new, country:selectedCompetitor.country,
    prs:selectedCompetitor.prs||{}, current_event:selectedEventId
  }});
  if(ok)toast(`Mostrando: ${selectedCompetitor.name}`);
}
function sendEvent(){
  if(!selectedEventId||!tournamentData)return;
  const ev=tournamentData.events.find(e=>e.event_id===selectedEventId);
  if(!ev)return;
  const ok=sendWS({type:'event',data:{
    event_id:ev.event_id,event_name:ev.name,round_number:currentRound,total_rounds:ev.rounds
  }});
  if(ok)toast(`Evento: ${ev.name} — Ronda ${currentRound}`);
}
function sendHideCompetitor(){if(sendWS({type:'hide_competitor'}))toast('Competidor ocultado');}
function sendHideEvent(){if(sendWS({type:'hide_event'}))toast('Evento ocultado');}
function sendHideAll(){sendWS({type:'hide_competitor'});sendWS({type:'hide_event'});toast('Todo ocultado');}
function refreshOverlays(){if(selectedCompetitor)sendCompetitor();if(selectedEventId)sendEvent();toast('Overlays refrescados');}

// ── Helpers ──
function isoToFlag(iso2){
  if(!iso2||iso2.length!==2)return '';
  return iso2.toUpperCase().split('').map(c=>String.fromCodePoint(c.charCodeAt(0)+127397)).join('');
}

// ── Init ──
document.addEventListener('click',e=>{
  const r=document.getElementById('search-results');
  if(!document.getElementById('comp-search').contains(e.target)&&!r.contains(e.target))
    r.classList.remove('open');
});

initServerInfo();
connectWS();
</script>
</body>
</html>"""


# ══════════════════════════════════════════════════════════
#   Estado global del WebSocket
# ══════════════════════════════════════════════════════════

connected_clients: set = set()   # overlays OBS
panel_clients: set = set()       # pestañas del panel
preloaded_data: dict | None = None
ws_port: int = 8765
http_port: int = 8080


# ══════════════════════════════════════════════════════════
#   HTTP Server (sirve el panel HTML)
# ══════════════════════════════════════════════════════════

class PanelHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        pass  # silenciar logs HTTP

    def do_GET(self):
        if self.path in ('/', '/panel'):
            html = PANEL_HTML.replace('__WS_PORT__', str(ws_port)) \
                             .replace('__HTTP_PORT__', str(http_port))
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(html.encode('utf-8'))))
            self.end_headers()
            self.wfile.write(html.encode('utf-8'))
        else:
            self.send_response(404)
            self.end_headers()


def start_http_server(port: int):
    server = HTTPServer(('localhost', port), PanelHandler)
    print(f"[panel] HTTP activo en http://localhost:{port}")
    server.serve_forever()


# ══════════════════════════════════════════════════════════
#   WebSocket Server
# ══════════════════════════════════════════════════════════

async def broadcast_to_overlays(message: dict):
    """Envía a los overlays de OBS (no al panel)."""
    if not connected_clients:
        return
    payload = json.dumps(message, ensure_ascii=False)
    await asyncio.gather(
        *[ws.send(payload) for ws in connected_clients],
        return_exceptions=True
    )


async def broadcast_to_panels(message: dict):
    """Envía a las pestañas del panel."""
    if not panel_clients:
        return
    payload = json.dumps(message, ensure_ascii=False)
    await asyncio.gather(
        *[ws.send(payload) for ws in panel_clients],
        return_exceptions=True
    )


async def ws_handler(websocket):
    global preloaded_data

    # Identificar si es panel o overlay OBS
    # El panel siempre manda get_preloaded como primer mensaje;
    # los overlays de OBS nunca mandan nada (solo escuchan).
    # Usamos un flag para clasificarlos tras el primer mensaje.
    is_panel = False

    # Timeout de identificación: si en 2s no manda nada → es overlay OBS
    try:
        raw = await asyncio.wait_for(websocket.recv(), timeout=2.0)
        msg = json.loads(raw)
        is_panel = True
    except (asyncio.TimeoutError, Exception):
        msg = None

    if is_panel:
        panel_clients.add(websocket)
        obs_count = len(connected_clients)
        print(f"[ws] Panel conectado ({len(panel_clients)} panel(es), {obs_count} overlay(s) OBS)")

        # Procesar primer mensaje
        await handle_panel_message(websocket, msg)

        try:
            async for raw in websocket:
                try:
                    await handle_panel_message(websocket, json.loads(raw))
                except Exception as e:
                    print(f"[ws] Error procesando mensaje: {e}")
        except Exception:
            pass
        finally:
            panel_clients.discard(websocket)
            print(f"[ws] Panel desconectado ({len(panel_clients)} panel(es))")
    else:
        # Es overlay OBS
        connected_clients.add(websocket)
        obs_count = len(connected_clients)
        print(f"[ws] Overlay OBS conectado ({obs_count} overlay(s))")
        await broadcast_to_panels({'type': 'client_count', 'count': obs_count})
        try:
            await websocket.wait_closed()
        finally:
            connected_clients.discard(websocket)
            obs_count = len(connected_clients)
            print(f"[ws] Overlay OBS desconectado ({obs_count} overlay(s))")
            await broadcast_to_panels({'type': 'client_count', 'count': obs_count})


async def handle_panel_message(websocket, msg: dict):
    global preloaded_data

    t = msg.get('type')

    if t == 'get_preloaded':
        # El panel pide los datos precargados
        if preloaded_data:
            await websocket.send(json.dumps({
                'type': 'preloaded_data',
                'data': preloaded_data
            }, ensure_ascii=False))
        else:
            await websocket.send(json.dumps({'type': 'preloaded_data', 'data': None}))

    elif t == 'save_data':
        # El panel pide guardar el JSON descargado
        data = msg.get('data')
        filename = msg.get('filename', 'tournament_data.json')
        if data:
            preloaded_data = data
            path = Path(filename)
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
            print(f"[ws] JSON guardado: {path}")
            await websocket.send(json.dumps({'type': 'save_ok', 'path': str(path)}))

    elif t in ('competitor', 'event', 'hide_competitor', 'hide_event'):
        # Reenviar a los overlays OBS
        await broadcast_to_overlays(msg)
        print(f"[ws] → Overlay: {t}")

    else:
        print(f"[ws] Mensaje desconocido: {t}")


# ══════════════════════════════════════════════════════════
#   Main
# ══════════════════════════════════════════════════════════

async def main_async(json_path: str | None, h_port: int, w_port: int):
    global preloaded_data, ws_port, http_port
    ws_port = w_port
    http_port = h_port

    # Cargar JSON si se pasó como argumento
    if json_path:
        p = Path(json_path)
        if p.exists():
            with open(p, encoding='utf-8') as f:
                preloaded_data = json.load(f)
            print(f"[panel] Datos precargados: {preloaded_data['name']}")
            print(f"[panel]   Competidores: {len(preloaded_data['competitors'])}")
        else:
            print(f"[panel] Advertencia: no se encontró '{json_path}'")

    # Iniciar HTTP en hilo aparte
    http_thread = threading.Thread(
        target=start_http_server, args=(h_port,), daemon=True
    )
    http_thread.start()

    # Iniciar WebSocket
    print(f"[panel] WebSocket activo en ws://localhost:{w_port}")
    print(f"[panel] ─────────────────────────────────────────")
    print(f"[panel] Abriendo panel en http://localhost:{h_port}")
    print(f"[panel] En OBS usa Browser Source: ws://localhost:{w_port}")
    print(f"[panel] ─────────────────────────────────────────")
    print(f"[panel] Ctrl+C para cerrar")

    # Pequeña espera para que el HTTP arranque
    await asyncio.sleep(0.5)

    # Abrir navegador
    webbrowser.open(f"http://localhost:{h_port}")

    async with ws_serve(ws_handler, 'localhost', w_port):
        await asyncio.Future()  # correr indefinidamente


def main():
    print("=" * 55)
    print("  WCA Overlay — Panel de Control")
    print("=" * 55)
    print()

    parser = argparse.ArgumentParser(description="WCA Overlay Panel todo-en-uno")
    parser.add_argument('--data',     help='JSON generado por wca_data_ingestion.py', default=None)
    parser.add_argument('--port',     type=int, default=8080, help='Puerto HTTP del panel (default: 8080)')
    parser.add_argument('--ws-port',  type=int, default=8765, help='Puerto WebSocket OBS (default: 8765)')
    args = parser.parse_args()

    try:
        asyncio.run(main_async(args.data, args.port, args.ws_port))
    except KeyboardInterrupt:
        print("\n[panel] Cerrado. ¡Hasta la próxima!")
    except OSError as e:
        print(f"\n[panel] Error de puerto: {e}")
        print(f"        Prueba con otro puerto: python wca_panel.py --port 8081")
        input("\nPresiona Enter para cerrar...")


if __name__ == '__main__':
    main()
