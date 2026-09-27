/**
 * DirectoOBS - Servidor Node.js
 * ==============================
 * Servidor unificado:
 * 1. Servidor HTTP (Express) para el panel de control y el overlay de OBS.
 * 2. Servidor WebSocket para sincronización en tiempo real de overlays.
 * 3. Cliente OBS WebSocket (v5) para control remoto de escenas, stream y grabación.
 * 4. Ingesta de datos directa desde la API de la WCA.
 */

import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { OBSWebSocket } from 'obs-websocket-js';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import {
  fetchLiveCompetitionRounds,
  fetchLiveRoundRanking,
  resolveWcaLiveId
} from './server/wcaLiveService.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Configuración inicial ──
const PORT = process.env.PORT || 3000;
const OBS_WS_PORT = 8765; // Puerto de compatibilidad para overlays existentes
const WCA_API = 'https://www.worldcubeassociation.org/api/v0';

const EVENT_NAMES = {
  '333': '3x3',
  '222': '2x2',
  '444': '4x4',
  '555': '5x5',
  '666': '6x6',
  '777': '7x7',
  '333bf': '3x3 Blindfolded',
  '333fm': 'Fewest Moves',
  '333oh': '3x3 One-Handed',
  'clock': 'Clock',
  'minx': 'Megaminx',
  'pyram': 'Pyraminx',
  'skewb': 'Skewb',
  'sq1': 'Square-1',
  '444bf': '4x4 Blindfolded',
  '555bf': '5x5 Blindfolded',
  '333mbf': 'Multi-Blind'
};

// ── Estado en memoria ──
let tournamentData = null;
let currentEvent = null;
let currentCompetitor = null;   // Competidor 1 (Mesa 1)
let currentCompetitor2 = null;  // Competidor 2 (Mesa 2)
let bannerMode = 'single';      // 'single' | 'dual'
let bannerPosition = 'top';     // 'top' | 'bottom'
let bannerAlign = 'center';     // 'center' por defecto
let bannerFont = 'barlow_slim'; // 'barlow_slim' | 'barlow_bold' | 'inter' | 'roboto'
let competitorVisible = false;
let eventVisible = false;
let showcaseCompetitor = null;   // Competidor asignado al Showcase (esquina superior derecha)
let showcaseVisible = false;      // Visibilidad del Showcase en OBS
let tournamentLogo = null;        // URL persistente del logo del torneo en servidor
let bigLogoVisible = false;       // Visibilidad del Logo Central (Momentos Muertos)
let bigLogoUrl = null;           // URL específica o personalizada del Logo Central
let bigLogoSize = 760;           // Tamaño máximo en píxeles (altura) del Logo Central
let headToHeadVisible = false;   // Visibilidad del banner Head to Head
let headToHeadData = {           // Datos del enfrentamiento Head to Head
  competitor1: null,
  competitor2: null,
  event: null,
  nr_single1: '',
  nr_avg1: '',
  nr_single2: '',
  nr_avg2: ''
};

// ── Estado de Ranking en Vivo (WCA Live) ──
let liveRankingData = null;
let liveRankingVisible = false;
let liveRankingRoundId = null;
let liveRankingCompId = null;
let liveRankingTop = 16;
let liveRankingCutoff = 0;
let liveRankingDynamicPaging = true;
let liveRankingAutoBalance = true;
let liveRankingPageSize = 16;
let liveRankingPageDuration = 10;
let liveRankingPollTimer = null;
let liveRankingPollInterval = 0; // segundos (0 = inactivo)
let liveRankingRounds = [];
let liveRankingViewMode = 'fullscreen'; // 'fullscreen' | 'widget'

// ── Tema y Personalización de Fondo para Fullscreen ──
let fsTheme = {
  bgColor: '#0c4ea8',
  bgImage: null,
  opacity: 100,
  blur: 0,
  colorCycle: false,
  animation: 'none',
  animSpeed: 'slow'
};

const LIVE_STATE_FILE = path.join(__dirname, 'live_state.json');

function saveLiveState() {
  try {
    const state = {
      compId: liveRankingCompId,
      roundId: liveRankingRoundId,
      rounds: liveRankingRounds,
      top: liveRankingTop,
      cutoff: liveRankingCutoff,
      dynamicPaging: liveRankingDynamicPaging,
      autoBalance: liveRankingAutoBalance,
      pageSize: liveRankingPageSize,
      pageDuration: liveRankingPageDuration,
      pollInterval: liveRankingPollInterval,
      visible: liveRankingVisible,
      viewMode: liveRankingViewMode,
      fsTheme: fsTheme,
      tournamentLogo: tournamentLogo,
      bigLogoVisible: bigLogoVisible,
      bigLogoUrl: bigLogoUrl,
      bigLogoSize: bigLogoSize,
      headToHeadVisible: headToHeadVisible,
      headToHeadData: headToHeadData
    };
    fs.writeFileSync(LIVE_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (err) {
    console.warn('[LiveRanking] Error guardando live_state.json:', err.message);
  }
}

function loadLiveState() {
  try {
    if (fs.existsSync(LIVE_STATE_FILE)) {
      const state = JSON.parse(fs.readFileSync(LIVE_STATE_FILE, 'utf8'));
      if (state.compId) liveRankingCompId = state.compId;
      if (state.roundId) liveRankingRoundId = state.roundId;
      if (state.rounds && Array.isArray(state.rounds)) liveRankingRounds = state.rounds;
      if (state.top !== undefined) liveRankingTop = state.top;
      if (state.cutoff !== undefined) {
        const c = parseInt(state.cutoff, 10);
        liveRankingCutoff = isNaN(c) || c < 0 ? 0 : c;
      }
      if (state.dynamicPaging !== undefined) liveRankingDynamicPaging = state.dynamicPaging;
      if (state.autoBalance !== undefined) liveRankingAutoBalance = state.autoBalance;
      if (state.pageSize !== undefined) liveRankingPageSize = state.pageSize;
      if (state.pageDuration !== undefined) liveRankingPageDuration = state.pageDuration;
      if (state.pollInterval !== undefined) liveRankingPollInterval = state.pollInterval;
      if (state.visible !== undefined) liveRankingVisible = state.visible;
      if (state.viewMode) liveRankingViewMode = state.viewMode;
      if (state.tournamentLogo !== undefined) tournamentLogo = state.tournamentLogo;
      if (state.bigLogoVisible !== undefined) bigLogoVisible = state.bigLogoVisible;
      if (state.bigLogoUrl !== undefined) bigLogoUrl = state.bigLogoUrl;
      if (state.bigLogoSize !== undefined) {
        const s = parseInt(state.bigLogoSize, 10);
        if (!isNaN(s) && s >= 300 && s <= 1200) bigLogoSize = s;
      }
      if (state.headToHeadVisible !== undefined) headToHeadVisible = state.headToHeadVisible;
      if (state.headToHeadData !== undefined && typeof state.headToHeadData === 'object') {
        headToHeadData = Object.assign({ competitor1: null, competitor2: null, event: null, nr_single1: '', nr_avg1: '', nr_single2: '', nr_avg2: '' }, state.headToHeadData);
      }
      if (state.fsTheme) {
        fsTheme = {
          bgColor: state.fsTheme.bgColor || '#0c4ea8',
          bgImage: state.fsTheme.bgImage || null,
          opacity: state.fsTheme.opacity !== undefined ? state.fsTheme.opacity : 100,
          blur: state.fsTheme.blur !== undefined ? state.fsTheme.blur : 0,
          colorCycle: state.fsTheme.colorCycle !== undefined ? !!state.fsTheme.colorCycle : false,
          animation: state.fsTheme.animation || 'none',
          animSpeed: state.fsTheme.animSpeed || 'slow'
        };
      }
      console.log(`[LiveRanking] Estado restaurado: compId=${liveRankingCompId}, roundId=${liveRankingRoundId}`);
    }
  } catch (err) {
    console.warn('[LiveRanking] Error cargando live_state.json:', err.message);
  }
}

loadLiveState();

const overlayClients = new Set();
const panelClients = new Set();

// ── Cargar datos por argumento CLI si se especifica (ej: node server.js --data archivo.json) ──
const cliArgs = process.argv.slice(2);
const dataArgIdx = cliArgs.indexOf('--data');
const specifiedDataFile = dataArgIdx !== -1 ? cliArgs[dataArgIdx + 1] : null;

if (specifiedDataFile) {
  const customPath = path.resolve(process.cwd(), specifiedDataFile);
  if (fs.existsSync(customPath)) {
    try {
      tournamentData = JSON.parse(fs.readFileSync(customPath, 'utf8'));
      console.log(`[Torneo] Cargado desde argumento: ${tournamentData.name} (${tournamentData.competitors?.length || 0} competidores)`);
    } catch (err) {
      console.error('[Torneo] Error al leer archivo especificado:', err.message);
    }
  } else {
    console.warn(`[Torneo] Archivo especificado no encontrado: ${specifiedDataFile}`);
  }
} else {
  // Buscar archivos locales de torneos previos automáticamente para conveniencia del operador
  const fallbackFiles = ['RegionalesSantander2026_data.json', 'RoadToSACSantander2026_data.json'];
  let loadedFallback = false;
  for (const f of fallbackFiles) {
    const p = path.join(__dirname, f);
    if (fs.existsSync(p)) {
      try {
        tournamentData = JSON.parse(fs.readFileSync(p, 'utf8'));
        console.log(`[Torneo] Auto-precargado: ${tournamentData.name} (${tournamentData.competitors?.length || 0} competidores)`);
        loadedFallback = true;
        break;
      } catch (err) {}
    }
  }
  if (!loadedFallback) {
    console.log('[Torneo] Servidor iniciado sin torneo por defecto. Carga uno desde el panel web o con --data <archivo.json>');
  }
}

// Si había una ronda de WCA Live guardada en estado previo, precargar su ranking
if (liveRankingRoundId) {
  fetchLiveRoundRanking(liveRankingRoundId, liveRankingDynamicPaging ? 0 : liveRankingTop, liveRankingCutoff)
    .then(ranking => {
      liveRankingData = ranking;
      console.log(`[LiveRanking] Ranking precargado para ronda ${liveRankingRoundId} (${ranking?.ranking?.length || 0} competidores)`);
    })
    .catch(err => {
      console.warn(`[LiveRanking] No se pudo precargar ranking para ${liveRankingRoundId}:`, err.message);
    });
}

// ── Instancia OBS WebSocket ──
const obs = new OBSWebSocket();
let obsConnected = false;
let obsStatus = {
  connected: false,
  currentProgramScene: null,
  currentPreviewScene: null,
  scenes: [],
  isStreaming: false,
  isRecording: false,
  streamTimecode: '00:00:00',
  recordTimecode: '00:00:00'
};

// ── Funciones de ayuda WCA ──
function formatTime(centiseconds, eventId) {
  if (centiseconds === null || centiseconds === undefined) return '—';
  if (eventId === '333fm') return String(centiseconds);
  if (eventId === '333mbf') return `MBLD:${centiseconds}`;

  const totalCs = parseInt(centiseconds, 10);
  const minutes = Math.floor(totalCs / 6000);
  const seconds = ((totalCs % 6000) / 100).toFixed(2);

  if (minutes > 0) {
    return `${minutes}:${seconds.padStart(5, '0')}`;
  }
  return seconds;
}

// ── Inicialización de Express ──
const app = express();
const server = http.createServer(app);

app.use(express.json({ limit: '15mb' }));

// Servir carpetas estáticas
app.use(express.static(path.join(__dirname, 'public')));
app.use('/icons', express.static(path.join(__dirname, 'icons')));

// Rutas directas para OBS y el operador
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

app.get('/fullscreen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// ── Rutas API REST ──

// Obtener datos del torneo activo
app.get('/api/tournament', (req, res) => {
  res.json({
    data: tournamentData,
    currentEvent,
    currentCompetitor,
    currentCompetitor2,
    bannerMode,
    bannerPosition,
    bannerAlign,
    competitorVisible,
    eventVisible
  });
});

// Cargar o guardar datos del torneo
app.post('/api/tournament', (req, res) => {
  try {
    const { data, filename } = req.body;
    if (!data) return res.status(400).json({ error: 'Faltan los datos del torneo' });

    tournamentData = data;
    const saveName = filename || `${data.competition_id || 'torneo'}_data.json`;
    const savePath = path.join(__dirname, saveName);

    fs.writeFileSync(savePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[Torneo] Guardado en: ${savePath}`);

    // Notificar a todos los paneles
    broadcastToPanels({ type: 'tournament_updated', data: tournamentData });

    res.json({ ok: true, path: savePath, name: data.name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Limpiar los datos del torneo actual
app.post('/api/tournament/clear', (req, res) => {
  tournamentData = null;
  currentEvent = null;
  currentCompetitor = null;
  competitorVisible = false;
  eventVisible = false;

  broadcastToOverlays({ type: 'hide_competitor' });
  broadcastToOverlays({ type: 'hide_event' });
  broadcastToPanels({ type: 'tournament_cleared' });

  console.log('[Torneo] Datos del torneo limpiados.');
  res.json({ ok: true });
});

// Ingesta directa de datos WCA desde el backend
app.post('/api/wca/fetch', async (req, res) => {
  const { competitionId } = req.body;
  if (!competitionId) return res.status(400).json({ error: 'competitionId es obligatorio' });

  res.json({ ok: true, message: 'Descarga iniciada' });

  // Iniciar descarga asíncrona informando progreso por WebSocket
  (async () => {
    try {
      const emitProgress = (pct, message, status = 'info') => {
        broadcastToPanels({
          type: 'wca_progress',
          progress: pct,
          message,
          status
        });
      };

      emitProgress(5, `Consultando datos de: ${competitionId}...`);

      const WCA_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

      const compRes = await fetch(`${WCA_API}/competitions/${competitionId}`, { headers: WCA_HEADERS });
      if (!compRes.ok) throw new Error(`Torneo no encontrado en la WCA (${compRes.status})`);
      const comp = await compRes.json();

      emitProgress(15, `Torneo: ${comp.name}. Obteniendo WCIF público...`);

      const wcifRes = await fetch(`${WCA_API}/competitions/${competitionId}/wcif/public`, { headers: WCA_HEADERS });
      if (!wcifRes.ok) throw new Error(`No se pudo obtener el WCIF público (${wcifRes.status})`);
      const wcif = await wcifRes.json();

      // Parsear eventos
      const events = (wcif.events || []).map(ev => ({
        event_id: ev.id,
        name: EVENT_NAMES[ev.id] || ev.id,
        rounds: (ev.rounds || []).length
      }));

      // Parsear competidores aceptados
      const rawPersons = wcif.persons || [];
      const competitors = [];
      for (const p of rawPersons) {
        if (p.registration && p.registration.status === 'accepted') {
          const wcaId = p.wcaId || null;
          competitors.push({
            name: p.name,
            wca_id: wcaId,
            is_new: !wcaId,
            registrant_id: p.registrantId,
            events: p.registration.eventIds || [],
            country: p.countryIso2 || ''
          });
        }
      }
      competitors.sort((a, b) => a.name.localeCompare(b.name));

      const veterans = competitors.filter(c => !c.is_new);
      emitProgress(30, `Descargando récords de ${veterans.length} competidores veteranos...`);

      // Descargar PRs con pequeña pausa
      const allPRs = {};
      for (let i = 0; i < veterans.length; i++) {
        const c = veterans[i];
        const pct = 30 + Math.round((i / Math.max(veterans.length, 1)) * 60);
        emitProgress(pct, `[${i + 1}/${veterans.length}] ${c.name} (${c.wca_id})`);

        try {
          const pRes = await fetch(`${WCA_API}/persons/${c.wca_id}`, { headers: WCA_HEADERS });
          if (pRes.ok) {
            const pData = await pRes.json();
            const rawRecords = pData.personal_records || (pData.persons && pData.persons[0]?.personal_records) || {};
            const prs = {};
            for (const [eid, rec] of Object.entries(rawRecords)) {
              prs[eid] = {
                single: rec.single?.best ?? null,
                average: rec.average?.best ?? null
              };
            }
            allPRs[c.wca_id] = prs;
          }
        } catch {
          allPRs[c.wca_id] = {};
        }

        // Pequeño retardo de 250ms para respetar la API WCA
        await new Promise(r => setTimeout(r, 250));
      }

      emitProgress(95, 'Ensamblando estructura final...');

      const competitorsFull = competitors.map(c => {
        const raw = allPRs[c.wca_id] || {};
        const prsDisplay = {};

        for (const eid of c.events) {
          if (raw[eid]) {
            prsDisplay[eid] = {
              event_name: EVENT_NAMES[eid] || eid,
              single_cs: raw[eid].single,
              average_cs: raw[eid].average,
              single_fmt: formatTime(raw[eid].single, eid),
              average_fmt: formatTime(raw[eid].average, eid)
            };
          } else {
            prsDisplay[eid] = {
              event_name: EVENT_NAMES[eid] || eid,
              single_cs: null,
              average_cs: null,
              single_fmt: '—',
              average_fmt: '—'
            };
          }
        }

        return {
          name: c.name,
          wca_id: c.wca_id,
          is_new: c.is_new,
          country: c.country,
          events: c.events,
          prs: prsDisplay
        };
      });

      const finalTournament = {
        competition_id: competitionId,
        name: comp.name,
        start_date: comp.start_date,
        end_date: comp.end_date,
        city: comp.city,
        venue: comp.venue || comp.venue_address || comp.city,
        events,
        competitors: competitorsFull
      };

      tournamentData = finalTournament;

      const outPath = path.join(__dirname, `${competitionId}_data.json`);
      fs.writeFileSync(outPath, JSON.stringify(finalTournament, null, 2), 'utf8');

      emitProgress(100, `¡Completado! Datos guardados en ${competitionId}_data.json`, 'ok');
      broadcastToPanels({ type: 'tournament_updated', data: tournamentData });
    } catch (err) {
      console.error('[WCA Fetch Error]', err);
      broadcastToPanels({
        type: 'wca_progress',
        progress: 0,
        message: `Error: ${err.message}`,
        status: 'error'
      });
    }
  })();
});

// Búsqueda en vivo de un competidor individual por su WCA ID
app.get('/api/wca/person/:wcaId', async (req, res) => {
  const { wcaId } = req.params;
  const cleanId = wcaId.trim().toUpperCase();

  try {
    const WCA_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    const pRes = await fetch(`${WCA_API}/persons/${cleanId}`, { headers: WCA_HEADERS });
    if (!pRes.ok) return res.status(404).json({ error: `Competidor ${cleanId} no encontrado en la WCA` });

    const pData = await pRes.json();
    const personObj = pData.person || (pData.persons && pData.persons[0]) || {};
    const rawRecords = pData.personal_records || (pData.persons && pData.persons[0]?.personal_records) || {};

    const prsDisplay = {};
    for (const [eid, rec] of Object.entries(rawRecords)) {
      prsDisplay[eid] = {
        event_name: EVENT_NAMES[eid] || eid,
        single_cs: rec.single?.best ?? null,
        average_cs: rec.average?.best ?? null,
        single_fmt: formatTime(rec.single?.best ?? null, eid),
        average_fmt: formatTime(rec.average?.best ?? null, eid)
      };
    }

    const avatarUrl = (personObj.avatar && !personObj.avatar.is_default && personObj.avatar.url && !personObj.avatar.url.includes('missing_avatar')) ? personObj.avatar.url : null;

    const competitor = {
      name: personObj.name || cleanId,
      wca_id: cleanId,
      is_new: false,
      country: personObj.country_iso2 || personObj.countryIso2 || '',
      avatar_url: avatarUrl,
      events: Object.keys(prsDisplay),
      prs: prsDisplay
    };

    // Si hay un torneo cargado, agregarlo a la lista de competidores en memoria
    if (tournamentData && tournamentData.competitors) {
      const idx = tournamentData.competitors.findIndex(c => (c.wca_id || '').toUpperCase() === cleanId);
      if (idx >= 0) {
        tournamentData.competitors[idx] = competitor;
      } else {
        tournamentData.competitors.push(competitor);
      }
      broadcastToPanels({ type: 'tournament_updated', data: tournamentData });
    }

    res.json({ ok: true, competitor });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Obtener avatar oficial de un competidor por su WCA ID
app.get('/api/wca/avatar/:wcaId', async (req, res) => {
  const { wcaId } = req.params;
  const cleanId = wcaId.trim().toUpperCase();
  try {
    const WCA_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    const pRes = await fetch(`${WCA_API}/persons/${cleanId}`, { headers: WCA_HEADERS });
    if (!pRes.ok) return res.status(404).json({ ok: false, avatar_url: null });

    const pData = await pRes.json();
    const personObj = pData.person || (pData.persons && pData.persons[0]) || {};
    const avatarUrl = (personObj.avatar && !personObj.avatar.is_default && personObj.avatar.url && !personObj.avatar.url.includes('missing_avatar')) ? personObj.avatar.url : null;
    const personalRecords = personObj.personal_records || null;
    
    // Si tenemos al competidor en memoria, enriquecer su objeto con avatar y récords/rankings WCA
    if (tournamentData && tournamentData.competitors) {
      const comp = tournamentData.competitors.find(c => (c.wca_id || '').toUpperCase() === cleanId);
      if (comp) {
        comp.avatar_url = avatarUrl;
        if (personalRecords) comp.personal_records = personalRecords;
      }
    }
    if (currentCompetitor && (currentCompetitor.wca_id || '').toUpperCase() === cleanId) {
      currentCompetitor.avatar_url = avatarUrl;
      if (personalRecords) currentCompetitor.personal_records = personalRecords;
    }
    if (currentCompetitor2 && (currentCompetitor2.wca_id || '').toUpperCase() === cleanId) {
      currentCompetitor2.avatar_url = avatarUrl;
      if (personalRecords) currentCompetitor2.personal_records = personalRecords;
    }
    if (showcaseCompetitor && (showcaseCompetitor.wca_id || '').toUpperCase() === cleanId) {
      showcaseCompetitor.avatar_url = avatarUrl;
      if (personalRecords) showcaseCompetitor.personal_records = personalRecords;
    }

    res.json({ ok: true, wca_id: cleanId, avatar_url: avatarUrl, personal_records: personalRecords });
  } catch (err) {
    res.json({ ok: false, avatar_url: null, error: err.message });
  }
});

// ── Rutas de Ranking en Vivo (WCA Live) ──
// Obtener eventos y rondas de una competencia en WCA Live
app.get('/api/live/competitions/:id', async (req, res) => {
  try {
    const compId = req.params.id;
    const comp = await fetchLiveCompetitionRounds(compId);
    if (comp && comp.rounds) {
      liveRankingCompId = compId;
      liveRankingRounds = comp.rounds;
      saveLiveState();
    }
    res.json({ ok: true, competition: comp });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Obtener ranking en vivo de una ronda
app.get('/api/live/rounds/:roundId', async (req, res) => {
  try {
    const { roundId } = req.params;
    const top = parseInt(req.query.top || '16', 10);
    const cutoff = req.query.cutoff !== undefined ? (parseInt(req.query.cutoff, 10) || 0) : liveRankingCutoff;
    const ranking = await fetchLiveRoundRanking(roundId, top, cutoff);
    liveRankingRoundId = roundId;
    liveRankingData = ranking;
    saveLiveState();
    res.json({ ok: true, ranking });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Consultar estado actual del ranking en vivo
app.get('/api/live/status', (req, res) => {
  if (liveRankingData && !liveRankingData.competitionName && tournamentData?.name) {
    liveRankingData.competitionName = tournamentData.name;
  }
  res.json({
    ok: true,
    visible: liveRankingVisible,
    roundId: liveRankingRoundId,
    compId: liveRankingCompId,
    top: liveRankingTop,
    cutoff: liveRankingCutoff,
    pollInterval: liveRankingPollInterval,
    dynamicPaging: liveRankingDynamicPaging,
    autoBalance: liveRankingAutoBalance,
    pageSize: liveRankingPageSize,
    pageDuration: liveRankingPageDuration,
    viewMode: liveRankingViewMode,
    data: liveRankingData,
    fsTheme: fsTheme
  });
});

// Subir imagen personalizada de fondo para la tabla Fullscreen
app.post('/api/fs-background', (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Falta la imagen' });
    }

    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let ext = 'jpg';
    let buffer;

    if (matches && matches.length === 3) {
      const mime = matches[1];
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('webp')) ext = 'webp';
      else if (mime.includes('gif')) ext = 'gif';
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(imageBase64, 'base64');
    }

    const savedFilename = `fs_bg_${Date.now()}.${ext}`;
    const filePath = path.join(uploadsDir, savedFilename);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${savedFilename}`;
    fsTheme.bgImage = publicUrl;
    saveLiveState();

    broadcastToOverlays({ type: 'fs_theme_updated', data: fsTheme });
    broadcastToPanels({ type: 'fs_theme_updated', data: fsTheme });

    res.json({ ok: true, url: publicUrl, theme: fsTheme });
  } catch (err) {
    console.error('[Upload FS BG Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Eliminar imagen personalizada de fondo
app.post('/api/fs-background/delete', (req, res) => {
  try {
    fsTheme.bgImage = null;
    saveLiveState();

    broadcastToOverlays({ type: 'fs_theme_updated', data: fsTheme });
    broadcastToPanels({ type: 'fs_theme_updated', data: fsTheme });

    res.json({ ok: true, theme: fsTheme });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Subir logo del torneo para el ticker inferior y overlays
app.post('/api/tournament-logo', (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'Falta la imagen' });
    }

    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    const matches = imageBase64.match(/^data:([A-Za-z-+\/]+);base64,(.+)$/);
    let ext = 'png';
    let buffer;

    if (matches && matches.length === 3) {
      const mime = matches[1];
      if (mime.includes('png')) ext = 'png';
      else if (mime.includes('webp')) ext = 'webp';
      else if (mime.includes('svg')) ext = 'svg';
      else if (mime.includes('gif')) ext = 'gif';
      else if (mime.includes('jpeg') || mime.includes('jpg')) ext = 'jpg';
      buffer = Buffer.from(matches[2], 'base64');
    } else {
      buffer = Buffer.from(imageBase64, 'base64');
    }

    const savedFilename = `tournament_logo_${Date.now()}.${ext}`;
    const filePath = path.join(uploadsDir, savedFilename);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${savedFilename}`;
    tournamentLogo = publicUrl;
    if (currentEvent) {
      currentEvent.tournament_logo = publicUrl;
    }
    saveLiveState();

    broadcastToOverlays({ type: 'tournament_logo_updated', logo: publicUrl });
    broadcastToPanels({ type: 'tournament_logo_updated', logo: publicUrl });

    res.json({ ok: true, url: publicUrl });
  } catch (err) {
    console.error('[Upload Tournament Logo Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Eliminar logo del torneo
app.post('/api/tournament-logo/delete', (req, res) => {
  try {
    tournamentLogo = null;
    if (currentEvent) {
      currentEvent.tournament_logo = null;
    }
    saveLiveState();

    broadcastToOverlays({ type: 'tournament_logo_updated', logo: null });
    broadcastToPanels({ type: 'tournament_logo_updated', logo: null });

    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Subir logo central grande para momentos muertos / descanso
app.post('/api/big-logo', (req, res) => {
  try {
    const { imageBase64, filename } = req.body;
    if (!imageBase64) {
      return res.status(400).json({ error: 'No se recibió ninguna imagen' });
    }

    const uploadsDir = path.join(__dirname, 'public', 'uploads');
    if (!fs.existsSync(uploadsDir)) {
      fs.mkdirSync(uploadsDir, { recursive: true });
    }

    let ext = 'png';
    if (filename && filename.includes('.')) {
      ext = filename.split('.').pop().toLowerCase();
    } else if (imageBase64.startsWith('data:image/jpeg')) {
      ext = 'jpg';
    } else if (imageBase64.startsWith('data:image/webp')) {
      ext = 'webp';
    } else if (imageBase64.startsWith('data:image/svg+xml')) {
      ext = 'svg';
    }

    let buffer;
    if (imageBase64.includes(';base64,')) {
      const parts = imageBase64.split(';base64,');
      buffer = Buffer.from(parts[1], 'base64');
    } else {
      buffer = Buffer.from(imageBase64, 'base64');
    }

    const savedFilename = `big_logo_${Date.now()}.${ext}`;
    const filePath = path.join(uploadsDir, savedFilename);
    fs.writeFileSync(filePath, buffer);

    const publicUrl = `/uploads/${savedFilename}`;
    bigLogoUrl = publicUrl;
    saveLiveState();

    broadcastToOverlays({ type: 'big_logo_updated', url: publicUrl });
    broadcastToPanels({ type: 'big_logo_updated', url: publicUrl });

    if (bigLogoVisible) {
      broadcastToOverlays({ type: 'show_big_logo', url: publicUrl });
    }

    res.json({ ok: true, url: publicUrl });
  } catch (err) {
    console.error('[Upload Big Logo Error]', err);
    res.status(500).json({ error: err.message });
  }
});

// Eliminar logo central personalizado
app.post('/api/big-logo/delete', (req, res) => {
  try {
    bigLogoUrl = null;
    saveLiveState();

    const fallbackUrl = tournamentLogo || null;
    broadcastToOverlays({ type: 'big_logo_updated', url: fallbackUrl });
    broadcastToPanels({ type: 'big_logo_updated', url: fallbackUrl });

    if (bigLogoVisible) {
      broadcastToOverlays({ type: 'show_big_logo', url: fallbackUrl });
    }

    res.json({ ok: true, fallbackUrl });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Estado y control de OBS
app.get('/api/obs/status', (req, res) => {
  res.json(obsStatus);
});

let lastObsAddress = 'ws://127.0.0.1:4455';
let lastObsPassword = '';

app.post('/api/obs/connect', async (req, res) => {
  const { address = 'ws://127.0.0.1:4455', password = '' } = req.body;
  try {
    await connectToOBS(address, password);
    lastObsAddress = address;
    lastObsPassword = password;
    res.json({ ok: true, status: obsStatus });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/obs/disconnect', async (req, res) => {
  try {
    await obs.disconnect();
    obsConnected = false;
    obsStatus.connected = false;
    broadcastToPanels({ type: 'obs_status', status: obsStatus });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obs/scene', async (req, res) => {
  const { sceneName } = req.body;
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  try {
    await obs.call('SetCurrentProgramScene', { sceneName });
    res.json({ ok: true, sceneName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obs/stream', async (req, res) => {
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  try {
    const response = await obs.call('ToggleStream');
    res.json({ ok: true, active: response.outputActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obs/record', async (req, res) => {
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  try {
    const response = await obs.call('ToggleRecord');
    res.json({ ok: true, active: response.outputActive });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Control de Fuentes, Cámaras y Multimedia ──
function getTransformForPreset(preset) {
  switch (preset) {
    case 'fullscreen':
      return {
        alignment: 5,
        positionX: 0,
        positionY: 0,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsWidth: 1920,
        boundsHeight: 1080
      };
    case 'pip_br': // Esquina inferior derecha
      return {
        alignment: 5,
        positionX: 1360,
        positionY: 740,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsWidth: 520,
        boundsHeight: 300
      };
    case 'pip_tr': // Esquina superior derecha
      return {
        alignment: 5,
        positionX: 1360,
        positionY: 40,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsWidth: 520,
        boundsHeight: 300
      };
    case 'split_left':
      return {
        alignment: 5,
        positionX: 40,
        positionY: 140,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsWidth: 900,
        boundsHeight: 800
      };
    case 'split_right':
      return {
        alignment: 5,
        positionX: 980,
        positionY: 140,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsWidth: 900,
        boundsHeight: 800
      };
    case 'center_boxed':
      return {
        alignment: 5,
        positionX: 260,
        positionY: 140,
        boundsType: 'OBS_BOUNDS_SCALE_INNER',
        boundsWidth: 1400,
        boundsHeight: 800
      };
    default:
      return null;
  }
}

async function getSceneItemsForScene(sceneName) {
  if (!obsConnected || !sceneName) return [];
  try {
    const res = await obs.call('GetSceneItemList', { sceneName });
    return (res.sceneItems || []).map(item => ({
      sceneItemId: item.sceneItemId,
      sourceName: item.sourceName,
      sceneItemEnabled: item.sceneItemEnabled,
      sceneItemIndex: item.sceneItemIndex,
      inputKind: item.inputKind || 'unknown',
      isGroup: item.isGroup || false
    }));
  } catch (err) {
    console.error(`[OBS] Error obteniendo fuentes de ${sceneName}:`, err.message);
    return [];
  }
}

app.post('/api/obs/toggle-item', async (req, res) => {
  const { sceneName, sceneItemId, enabled } = req.body;
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  try {
    await obs.call('SetSceneItemEnabled', {
      sceneName: sceneName || obsStatus.currentProgramScene,
      sceneItemId: Number(sceneItemId),
      sceneItemEnabled: !!enabled
    });
    res.json({ ok: true, sceneItemId, enabled });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obs/preset-transform', async (req, res) => {
  const { sceneName, sceneItemId, preset } = req.body;
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  const transform = getTransformForPreset(preset);
  if (!transform) return res.status(400).json({ error: 'Preset no válido' });

  try {
    await obs.call('SetSceneItemTransform', {
      sceneName: sceneName || obsStatus.currentProgramScene,
      sceneItemId: Number(sceneItemId),
      sceneItemTransform: transform
    });
    res.json({ ok: true, sceneItemId, preset });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Compositor de Cámaras y Pantalla Dividida (Layouts) ──
function calculateCameraLayout({ layout, bannerMode }) {
  let topMargin = 0;
  let bottomMargin = 0;

  if (bannerMode === 'top') {
    topMargin = 130;
  } else if (bannerMode === 'bottom') {
    bottomMargin = 160;
  } else if (bannerMode === 'both') {
    topMargin = 130;
    bottomMargin = 160;
  }

  const usableY = topMargin;
  const usableHeight = 1080 - topMargin - bottomMargin;

  const result = {
    camATransform: null,
    camBTransform: null
  };

  if (layout === 'split_lr' || layout === 'split_rl') {
    // 2 cámaras lado a lado (16:9 con separación y centrado vertical)
    const camW = 948;
    const camH = Math.round(camW * 9 / 16); // 533px
    let finalH = camH;
    let finalW = camW;
    if (finalH > usableHeight) {
      finalH = usableHeight;
      finalW = Math.round(finalH * 16 / 9);
    }
    const camY = Math.round(usableY + (usableHeight - finalH) / 2);
    const leftX = Math.round((1920 - (finalW * 2 + 10)) / 2);
    const rightX = leftX + finalW + 10;

    const leftTransform = {
      alignment: 5,
      positionX: leftX,
      positionY: camY,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: finalW,
      boundsHeight: finalH
    };

    const rightTransform = {
      alignment: 5,
      positionX: rightX,
      positionY: camY,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: finalW,
      boundsHeight: finalH
    };

    if (layout === 'split_lr') {
      result.camATransform = leftTransform;
      result.camBTransform = rightTransform;
    } else {
      result.camATransform = rightTransform;
      result.camBTransform = leftTransform;
    }
  } else if (layout === 'split_tb' || layout === 'split_bt') {
    // 2 cámaras vertical (arriba / abajo)
    const gap = 8;
    const camH = Math.floor((usableHeight - gap) / 2);
    let camW = Math.round(camH * 16 / 9);
    if (camW > 1900) {
      camW = 1900;
    }
    const camX = Math.round((1920 - camW) / 2);

    const topTransform = {
      alignment: 5,
      positionX: camX,
      positionY: usableY,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: camW,
      boundsHeight: camH
    };

    const bottomTransform = {
      alignment: 5,
      positionX: camX,
      positionY: usableY + camH + gap,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: camW,
      boundsHeight: camH
    };

    if (layout === 'split_tb') {
      result.camATransform = topTransform;
      result.camBTransform = bottomTransform;
    } else {
      result.camATransform = bottomTransform;
      result.camBTransform = topTransform;
    }
  } else if (layout === 'pip_a_main') {
    result.camATransform = {
      alignment: 5,
      positionX: 0,
      positionY: 0,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: 1920,
      boundsHeight: 1080
    };
    const pipW = 540;
    const pipH = 304;
    const pipX = 1920 - pipW - 24;
    const pipY = (1080 - bottomMargin) - pipH - 20;
    result.camBTransform = {
      alignment: 5,
      positionX: pipX,
      positionY: Math.max(topMargin + 20, pipY),
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: pipW,
      boundsHeight: pipH
    };
  } else if (layout === 'pip_b_main') {
    result.camBTransform = {
      alignment: 5,
      positionX: 0,
      positionY: 0,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: 1920,
      boundsHeight: 1080
    };
    const pipW = 540;
    const pipH = 304;
    const pipX = 1920 - pipW - 24;
    const pipY = (1080 - bottomMargin) - pipH - 20;
    result.camATransform = {
      alignment: 5,
      positionX: pipX,
      positionY: Math.max(topMargin + 20, pipY),
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: pipW,
      boundsHeight: pipH
    };
  } else if (layout === 'full_a') {
    result.camATransform = {
      alignment: 5,
      positionX: 0,
      positionY: 0,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: 1920,
      boundsHeight: 1080
    };
  } else if (layout === 'full_b') {
    result.camBTransform = {
      alignment: 5,
      positionX: 0,
      positionY: 0,
      boundsType: 'OBS_BOUNDS_SCALE_INNER',
      boundsWidth: 1920,
      boundsHeight: 1080
    };
  }

  return result;
}

app.post('/api/obs/apply-layout', async (req, res) => {
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  const {
    sceneName,
    target = 'active',
    camAId,
    camBId,
    layout,
    bannerMode = 'none',
    bannerSourceId,
    bannerPosition
  } = req.body;

  let targetScene = sceneName;
  if (!targetScene) {
    if (target === 'preview' && obsStatus.studioMode) {
      targetScene = obsStatus.currentPreviewScene || obsStatus.currentProgramScene;
    } else {
      targetScene = obsStatus.currentProgramScene;
    }
  }
  if (!targetScene) return res.status(400).json({ error: 'No hay escena seleccionada en OBS' });

  try {
    // Si es ajuste directo de banner o capa secundaria
    if (bannerSourceId && bannerPosition) {
      let bTransform = null;
      if (bannerPosition === 'top') {
        bTransform = { alignment: 5, positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 130 };
      } else if (bannerPosition === 'bottom') {
        bTransform = { alignment: 5, positionX: 0, positionY: 920, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 160 };
      } else if (bannerPosition === 'fullscreen') {
        bTransform = { alignment: 5, positionX: 0, positionY: 0, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsWidth: 1920, boundsHeight: 1080 };
      }
      if (bTransform) {
        await obs.call('SetSceneItemTransform', {
          sceneName: targetScene,
          sceneItemId: Number(bannerSourceId),
          sceneItemTransform: bTransform
        });
        return res.json({ ok: true, bannerPosition, targetScene });
      }
    }

    // Invertir / Swap dinámico entre Cam A y Cam B
    if (layout === 'swap') {
      if (!camAId || !camBId) return res.status(400).json({ error: 'Debes seleccionar Cam A y Cam B para intercambiar posiciones' });
      const [tA, tB] = await Promise.all([
        obs.call('GetSceneItemTransform', { sceneName: targetScene, sceneItemId: Number(camAId) }),
        obs.call('GetSceneItemTransform', { sceneName: targetScene, sceneItemId: Number(camBId) })
      ]);
      await Promise.all([
        obs.call('SetSceneItemTransform', {
          sceneName: targetScene,
          sceneItemId: Number(camAId),
          sceneItemTransform: {
            alignment: tB.sceneItemTransform.alignment,
            positionX: tB.sceneItemTransform.positionX,
            positionY: tB.sceneItemTransform.positionY,
            boundsType: tB.sceneItemTransform.boundsType,
            boundsWidth: tB.sceneItemTransform.boundsWidth,
            boundsHeight: tB.sceneItemTransform.boundsHeight
          }
        }),
        obs.call('SetSceneItemTransform', {
          sceneName: targetScene,
          sceneItemId: Number(camBId),
          sceneItemTransform: {
            alignment: tA.sceneItemTransform.alignment,
            positionX: tA.sceneItemTransform.positionX,
            positionY: tA.sceneItemTransform.positionY,
            boundsType: tA.sceneItemTransform.boundsType,
            boundsWidth: tA.sceneItemTransform.boundsWidth,
            boundsHeight: tA.sceneItemTransform.boundsHeight
          }
        })
      ]);
      return res.json({ ok: true, layout: 'swap', targetScene });
    }

    const { camATransform, camBTransform } = calculateCameraLayout({ layout, bannerMode });
    const promises = [];
    if (camAId && camATransform) {
      promises.push(obs.call('SetSceneItemTransform', {
        sceneName: targetScene,
        sceneItemId: Number(camAId),
        sceneItemTransform: camATransform
      }));
      promises.push(obs.call('SetSceneItemEnabled', {
        sceneName: targetScene,
        sceneItemId: Number(camAId),
        sceneItemEnabled: true
      }).catch(() => null));
    }
    if (camBId && camBTransform) {
      promises.push(obs.call('SetSceneItemTransform', {
        sceneName: targetScene,
        sceneItemId: Number(camBId),
        sceneItemTransform: camBTransform
      }));
      promises.push(obs.call('SetSceneItemEnabled', {
        sceneName: targetScene,
        sceneItemId: Number(camBId),
        sceneItemEnabled: true
      }).catch(() => null));
    }

    await Promise.all(promises);
    res.json({ ok: true, layout, bannerMode, targetScene });
  } catch (err) {
    console.error('[OBS Layout Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obs/media-action', async (req, res) => {
  const { inputName, action } = req.body;
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });

  let mediaAction = 'OBS_WEBMEDIA_INPUT_ACTION_RESTART';
  if (action === 'pause') mediaAction = 'OBS_WEBMEDIA_INPUT_ACTION_PAUSE';
  else if (action === 'play') mediaAction = 'OBS_WEBMEDIA_INPUT_ACTION_PLAY';
  else if (action === 'stop') mediaAction = 'OBS_WEBMEDIA_INPUT_ACTION_STOP';

  try {
    await obs.call('TriggerMediaInputAction', { inputName, mediaAction });
    res.json({ ok: true, inputName, action });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obs/set-media-file', async (req, res) => {
  const { inputName, filePath } = req.body;
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  try {
    await obs.call('SetInputSettings', {
      inputName,
      inputSettings: { local_file: filePath }
    });
    res.json({ ok: true, inputName, filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Configuración de resolución de video y FPS en OBS
app.get('/api/obs/video-settings', async (req, res) => {
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  try {
    const s = await obs.call('GetVideoSettings');
    const settings = {
      ...s,
      fps: Math.round(s.fpsNumerator / (s.fpsDenominator || 1))
    };
    res.json({ ok: true, settings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obs/video-settings', async (req, res) => {
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  if (obsStatus.isStreaming || obsStatus.isRecording) {
    return res.status(400).json({
      error: 'OBS no permite cambiar la resolución o los FPS mientras la transmisión o grabación esté activa. Detén el stream/grabación primero.'
    });
  }

  const { preset, outputWidth, outputHeight, fps, baseWidth, baseHeight } = req.body;
  let newSettings = {};

  if (preset === '1080p60') {
    newSettings = { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 60, fpsDenominator: 1 };
  } else if (preset === '1080p30') {
    newSettings = { baseWidth: 1920, baseHeight: 1080, outputWidth: 1920, outputHeight: 1080, fpsNumerator: 30, fpsDenominator: 1 };
  } else if (preset === '720p60') {
    newSettings = { outputWidth: 1280, outputHeight: 720, fpsNumerator: 60, fpsDenominator: 1 };
  } else if (preset === '720p30') {
    newSettings = { outputWidth: 1280, outputHeight: 720, fpsNumerator: 30, fpsDenominator: 1 };
  } else {
    if (outputWidth && outputHeight) {
      newSettings.outputWidth = Number(outputWidth);
      newSettings.outputHeight = Number(outputHeight);
    }
    if (baseWidth && baseHeight) {
      newSettings.baseWidth = Number(baseWidth);
      newSettings.baseHeight = Number(baseHeight);
    }
    if (fps) {
      newSettings.fpsNumerator = Number(fps);
      newSettings.fpsDenominator = 1;
    }
  }

  try {
    await obs.call('SetVideoSettings', newSettings);
    await updateOBSFullState();
    console.log(`[OBS] Configuración de video actualizada: ${JSON.stringify(obsStatus.videoSettings)}`);
    res.json({ ok: true, videoSettings: obsStatus.videoSettings });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Control de Modo Estudio y Transiciones (OBS) ──
app.post('/api/obs/studio-mode', async (req, res) => {
  const { enabled } = req.body;
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  try {
    await obs.call('SetStudioModeEnabled', { studioModeEnabled: !!enabled });
    await updateOBSFullState();
    res.json({ ok: true, studioMode: obsStatus.studioMode });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obs/preview-scene', async (req, res) => {
  const { sceneName } = req.body;
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  try {
    if (!obsStatus.studioMode) {
      await obs.call('SetStudioModeEnabled', { studioModeEnabled: true });
    }
    await obs.call('SetCurrentPreviewScene', { sceneName });
    obsStatus.currentPreviewScene = sceneName;
    broadcastToPanels({ type: 'obs_preview_changed', sceneName });
    res.json({ ok: true, sceneName });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/obs/transition', async (req, res) => {
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });
  try {
    await obs.call('TriggerStudioModeTransition');
    setTimeout(() => updateOBSFullState(), 350);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/obs/studio-screenshots', async (req, res) => {
  if (!obsConnected) return res.status(400).json({ error: 'OBS no está conectado' });

  const programScene = obsStatus.currentProgramScene;
  const previewScene = obsStatus.currentPreviewScene || programScene;
  const quality = req.query.quality || 'hd';

  let width = 960;
  let height = 540;
  let compressionQuality = 80;

  if (quality === 'fhd') {
    width = 1280;
    height = 720;
    compressionQuality = 85;
  } else if (quality === 'sd') {
    width = 640;
    height = 360;
    compressionQuality = 70;
  }

  try {
    const promises = [];
    if (previewScene) {
      promises.push(obs.call('GetSourceScreenshot', {
        sourceName: previewScene,
        imageFormat: 'jpg',
        imageWidth: width,
        imageHeight: height,
        imageCompressionQuality: compressionQuality
      }).catch(() => null));
    } else {
      promises.push(Promise.resolve(null));
    }

    if (programScene) {
      promises.push(obs.call('GetSourceScreenshot', {
        sourceName: programScene,
        imageFormat: 'jpg',
        imageWidth: width,
        imageHeight: height,
        imageCompressionQuality: compressionQuality
      }).catch(() => null));
    } else {
      promises.push(Promise.resolve(null));
    }

    const [prevRes, progRes] = await Promise.all(promises);

    res.json({
      ok: true,
      studioMode: obsStatus.studioMode,
      previewScene,
      programScene,
      previewImage: prevRes ? prevRes.imageData : null,
      programImage: progRes ? progRes.imageData : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Integración con OBS WebSocket (v5) ──
async function updateOBSFullState() {
  if (!obsConnected) return;
  try {
    const sceneList = await obs.call('GetSceneList');
    const currentScene = await obs.call('GetCurrentProgramScene');
    
    let studioMode = false;
    let previewScene = null;
    try {
      const sm = await obs.call('GetStudioModeEnabled');
      studioMode = sm.studioModeEnabled;
      if (studioMode) {
        const p = await obs.call('GetCurrentPreviewScene');
        previewScene = p.currentPreviewSceneName;
      }
    } catch {
      // Ignorado si no está disponible
    }

    const streamStatus = await obs.call('GetStreamStatus');
    const recordStatus = await obs.call('GetRecordStatus');
    const currentSceneItems = await getSceneItemsForScene(currentScene.currentProgramSceneName);

    let videoSettings = null;
    try {
      const vs = await obs.call('GetVideoSettings');
      videoSettings = {
        baseWidth: vs.baseWidth,
        baseHeight: vs.baseHeight,
        outputWidth: vs.outputWidth,
        outputHeight: vs.outputHeight,
        fpsNumerator: vs.fpsNumerator,
        fpsDenominator: vs.fpsDenominator,
        fps: Math.round(vs.fpsNumerator / (vs.fpsDenominator || 1))
      };
    } catch (e) {
      // Si OBS no retorna video settings en este momento
    }

    obsStatus = {
      connected: true,
      studioMode: studioMode,
      currentProgramScene: currentScene.currentProgramSceneName,
      currentPreviewScene: previewScene,
      scenes: (sceneList.scenes || []).map(s => s.sceneName).reverse(),
      currentSceneItems: currentSceneItems,
      videoSettings: videoSettings,
      isStreaming: streamStatus.outputActive,
      isRecording: recordStatus.outputActive,
      streamTimecode: streamStatus.outputTimecode || '00:00:00',
      recordTimecode: recordStatus.outputTimecode || '00:00:00'
    };

    broadcastToPanels({ type: 'obs_status', status: obsStatus });
  } catch (err) {
    console.error('[OBS State Error]', err.message);
  }
}

async function connectToOBS(address = 'ws://127.0.0.1:4455', password = '') {
  try {
    console.log(`[OBS] Intentando conectar a ${address}...`);
    await obs.connect(address, password || undefined, { rpcVersion: 1 });
    obsConnected = true;
    console.log('[OBS] ¡Conexión exitosa a OBS Studio!');
    await updateOBSFullState();
  } catch (err) {
    obsConnected = false;
    obsStatus.connected = false;
    broadcastToPanels({ type: 'obs_status', status: obsStatus });
    console.log(`[OBS] No se pudo conectar: ${err.message}`);
    throw err;
  }
}

// Eventos de OBS
obs.on('CurrentProgramSceneChanged', async data => {
  obsStatus.currentProgramScene = data.sceneName;
  obsStatus.currentSceneItems = await getSceneItemsForScene(data.sceneName);
  broadcastToPanels({
    type: 'obs_scene_changed',
    sceneName: data.sceneName,
    sceneItems: obsStatus.currentSceneItems
  });
});

obs.on('CurrentPreviewSceneChanged', data => {
  obsStatus.currentPreviewScene = data.sceneName;
  broadcastToPanels({ type: 'obs_preview_changed', sceneName: data.sceneName });
});

obs.on('StudioModeStateChanged', data => {
  obsStatus.studioMode = data.studioModeEnabled;
  broadcastToPanels({ type: 'obs_studio_mode_changed', enabled: data.studioModeEnabled });
  updateOBSFullState();
});

obs.on('SceneItemEnableStateChanged', data => {
  if (obsStatus.currentSceneItems) {
    const item = obsStatus.currentSceneItems.find(i => i.sceneItemId === data.sceneItemId);
    if (item) item.sceneItemEnabled = data.sceneItemEnabled;
  }
  broadcastToPanels({
    type: 'obs_item_state_changed',
    sceneName: data.sceneName,
    sceneItemId: data.sceneItemId,
    sceneItemEnabled: data.sceneItemEnabled
  });
});

obs.on('SceneItemListReindexed', async data => {
  if (data.sceneName === obsStatus.currentProgramScene) {
    obsStatus.currentSceneItems = await getSceneItemsForScene(data.sceneName);
    broadcastToPanels({
      type: 'obs_items_updated',
      sceneName: data.sceneName,
      sceneItems: obsStatus.currentSceneItems
    });
  }
});

obs.on('SceneListChanged', () => {
  updateOBSFullState();
});

obs.on('StreamStateChanged', data => {
  obsStatus.isStreaming = data.outputActive;
  broadcastToPanels({ type: 'obs_stream_changed', active: data.outputActive });
});

obs.on('RecordStateChanged', data => {
  obsStatus.isRecording = data.outputActive;
  broadcastToPanels({ type: 'obs_record_changed', active: data.outputActive });
});

obs.on('ConnectionClosed', () => {
  obsConnected = false;
  obsStatus.connected = false;
  console.log('[OBS] Conexión cerrada con OBS Studio');
  broadcastToPanels({ type: 'obs_status', status: obsStatus });
});

// ── Manejo de WebSockets ──
function broadcastToOverlays(message) {
  if (overlayClients.size === 0) return;
  const payload = JSON.stringify(message);
  for (const client of overlayClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastToPanels(message) {
  if (panelClients.size === 0) return;
  const payload = JSON.stringify(message);
  for (const client of panelClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// ── Control de Sondeo (Polling) para Ranking en Vivo ──
function stopLiveRankingPolling() {
  if (liveRankingPollTimer) {
    clearInterval(liveRankingPollTimer);
    liveRankingPollTimer = null;
  }
}

function startLiveRankingPolling(intervalSecs) {
  stopLiveRankingPolling();
  const secs = parseInt(intervalSecs, 10);
  if (isNaN(secs) || secs <= 0) {
    liveRankingPollInterval = 0;
    return;
  }
  liveRankingPollInterval = secs;
  console.log(`[LiveRanking] Iniciando polling cada ${secs}s para ronda ${liveRankingRoundId}`);
  liveRankingPollTimer = setInterval(async () => {
    if (!liveRankingRoundId) return;
    try {
      const fetchTop = liveRankingDynamicPaging ? 0 : liveRankingTop;
      const ranking = await fetchLiveRoundRanking(liveRankingRoundId, fetchTop, liveRankingCutoff);
      liveRankingData = ranking;
      if (liveRankingVisible) {
        if (liveRankingData && !liveRankingData.competitionName && tournamentData?.name) {
          liveRankingData.competitionName = tournamentData.name;
        }
        broadcastToOverlays({
          type: 'live_ranking_show',
          data: liveRankingData,
          dynamicPaging: liveRankingDynamicPaging,
          autoBalance: liveRankingAutoBalance,
          pageSize: liveRankingPageSize,
          pageDuration: liveRankingPageDuration,
          viewMode: liveRankingViewMode
        });
      }
      broadcastToPanels({
        type: 'sync_live_ranking',
        visible: liveRankingVisible,
        data: liveRankingData,
        roundId: liveRankingRoundId,
        compId: liveRankingCompId,
        pollInterval: liveRankingPollInterval,
        top: liveRankingTop,
        cutoff: liveRankingCutoff,
        dynamicPaging: liveRankingDynamicPaging,
        autoBalance: liveRankingAutoBalance,
        pageSize: liveRankingPageSize,
        pageDuration: liveRankingPageDuration,
        viewMode: liveRankingViewMode
      });
    } catch (err) {
      console.warn('[LiveRanking Polling Error]', err.message);
    }
  }, secs * 1000);
}

function handleSocketConnection(ws, req) {
  let isPanel = false;

  // Si la URL contiene role=overlay o role=panel
  const urlParams = new URL(req.url, 'http://localhost').searchParams;
  const explicitRole = urlParams.get('role');

  if (explicitRole === 'panel') {
    isPanel = true;
    panelClients.add(ws);
    initPanel(ws);
  } else if (explicitRole === 'overlay') {
    overlayClients.add(ws);
    initOverlay(ws);
  } else {
    // Si no es explícito, escuchar primer mensaje o asignar como overlay tras 1s
    const identifyTimeout = setTimeout(() => {
      if (!isPanel) {
        overlayClients.add(ws);
        initOverlay(ws);
      }
    }, 1000);

    ws.once('message', raw => {
      clearTimeout(identifyTimeout);
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.role === 'panel' || msg.type === 'get_preloaded' || msg.type === 'panel_init') {
          isPanel = true;
          panelClients.add(ws);
          initPanel(ws);
          handlePanelMessage(ws, msg);
        } else {
          overlayClients.add(ws);
          initOverlay(ws);
          handleOverlayMessage(ws, msg);
        }
      } catch {
        overlayClients.add(ws);
        initOverlay(ws);
      }
    });
  }

  function initOverlay(socket) {
    console.log(`[WS] Overlay OBS conectado (Total: ${overlayClients.size})`);
    broadcastToPanels({ type: 'client_count', count: overlayClients.size });

    // Enviar configuración del banner
    socket.send(JSON.stringify({
      type: 'banner_config',
      mode: bannerMode,
      position: bannerPosition,
      align: bannerAlign,
      font: bannerFont
    }));

    // Hidratar datos del evento para la cabecera del banner
    if (currentEvent) {
      socket.send(JSON.stringify({ type: 'banner_event', event: currentEvent }));
    }

    // Solo mostrar el badge standalone de evento si está explícitamente activo
    if (eventVisible && currentEvent) {
      socket.send(JSON.stringify({ type: 'event', data: currentEvent }));
    }

    if (competitorVisible) {
      socket.send(JSON.stringify({
        type: 'banner_data',
        mode: bannerMode,
        position: bannerPosition,
        align: bannerAlign,
        competitor1: currentCompetitor,
        competitor2: currentCompetitor2,
        event: currentEvent,
        visible: true
      }));
    }

    // Enviar configuración de tema de fondo para Fullscreen
    socket.send(JSON.stringify({
      type: 'fs_theme_updated',
      data: fsTheme
    }));

    // Si el ranking en vivo está activo, enviarlo al nuevo overlay
    if (liveRankingVisible && liveRankingData) {
      if (!liveRankingData.competitionName && tournamentData?.name) {
        liveRankingData.competitionName = tournamentData.name;
      }
      socket.send(JSON.stringify({
        type: 'live_ranking_show',
        data: liveRankingData,
        dynamicPaging: liveRankingDynamicPaging,
        autoBalance: liveRankingAutoBalance,
        pageSize: liveRankingPageSize,
        pageDuration: liveRankingPageDuration,
        viewMode: liveRankingViewMode
      }));
    }

    // Si el showcase de competidor está activo, enviarlo al nuevo overlay
    if (showcaseVisible && showcaseCompetitor) {
      socket.send(JSON.stringify({
        type: 'show_competitor_showcase',
        competitor: showcaseCompetitor,
        event: currentEvent
      }));
    }

    // Enviar logo persistente del torneo
    if (tournamentLogo) {
      socket.send(JSON.stringify({
        type: 'tournament_logo_updated',
        logo: tournamentLogo
      }));
    }

    // Enviar estado de Logo Central (Momentos Muertos)
    const activeBigLogoUrl = bigLogoUrl || tournamentLogo;
    socket.send(JSON.stringify({
      type: 'big_logo_size',
      size: bigLogoSize
    }));
    if (activeBigLogoUrl) {
      socket.send(JSON.stringify({
        type: 'big_logo_updated',
        url: activeBigLogoUrl
      }));
    }
    if (bigLogoVisible) {
      socket.send(JSON.stringify({
        type: 'show_big_logo',
        url: activeBigLogoUrl,
        size: bigLogoSize
      }));
    }

    // Si Head to Head está activo, enviarlo al overlay
    if (headToHeadVisible && headToHeadData) {
      socket.send(JSON.stringify({
        type: 'show_head_to_head',
        data: headToHeadData
      }));
    }
  }

  function initPanel(socket) {
    console.log(`[WS] Panel de operador conectado (Total: ${panelClients.size})`);
    socket.send(JSON.stringify({
      type: 'init_state',
      tournamentData,
      currentEvent,
      currentCompetitor,
      currentCompetitor2,
      bannerMode,
      bannerPosition,
      bannerAlign,
      bannerFont,
      competitorVisible,
      eventVisible,
      showcaseCompetitor,
      showcaseVisible,
      tournamentLogo,
      bigLogoVisible,
      bigLogoUrl: bigLogoUrl || tournamentLogo,
      bigLogoSize,
      headToHeadVisible,
      headToHeadData,
      liveRankingVisible,
      liveRankingRoundId,
      liveRankingCompId,
      liveRankingRounds,
      liveRankingTop,
      liveRankingCutoff,
      liveRankingPollInterval,
      liveRankingData,
      liveRankingDynamicPaging,
      liveRankingAutoBalance,
      liveRankingPageSize,
      liveRankingPageDuration,
      liveRankingViewMode,
      fsTheme,
      overlayCount: overlayClients.size,
      obsStatus
    }));
  }

  function handleOverlayMessage(socket, msg) {
    // Overlays normalmente solo escuchan
  }

  function handlePanelMessage(socket, msg) {
    switch (msg.type) {
      case 'banner_data':
      case 'set_banner':
        if (msg.data) {
          if (msg.data.competitor1 !== undefined) currentCompetitor = msg.data.competitor1;
          if (msg.data.competitor2 !== undefined) currentCompetitor2 = msg.data.competitor2;
          if (msg.data.mode) bannerMode = msg.data.mode;
          if (msg.data.position) bannerPosition = msg.data.position;
          if (msg.data.align) bannerAlign = msg.data.align;
          if (msg.data.event) {
            if (tournamentLogo && !msg.data.event.tournament_logo) {
              msg.data.event.tournament_logo = tournamentLogo;
            } else if (currentEvent?.tournament_logo && !msg.data.event.tournament_logo) {
              msg.data.event.tournament_logo = currentEvent.tournament_logo;
            }
            if (currentEvent) {
              currentEvent = Object.assign({}, currentEvent, msg.data.event);
            } else {
              currentEvent = msg.data.event;
            }
          }
          if (msg.data.visible !== undefined) competitorVisible = !!msg.data.visible;
          else competitorVisible = true;
        }
        broadcastToOverlays({
          type: 'banner_data',
          mode: bannerMode,
          position: bannerPosition,
          align: bannerAlign,
          competitor1: currentCompetitor,
          competitor2: currentCompetitor2,
          event: currentEvent,
          visible: competitorVisible
        });
        broadcastToPanels({
          type: 'sync_state',
          currentCompetitor,
          currentCompetitor2,
          bannerMode,
          bannerPosition,
          bannerAlign,
          bannerFont,
          competitorVisible,
          eventVisible
        });
        break;

      case 'set_banner_config':
        if (msg.mode) bannerMode = msg.mode;
        if (msg.position) bannerPosition = msg.position;
        if (msg.align) bannerAlign = msg.align;
        if (msg.font) bannerFont = msg.font;
        broadcastToOverlays({
          type: 'banner_config',
          mode: bannerMode,
          position: bannerPosition,
          align: bannerAlign,
          font: bannerFont
        });
        broadcastToPanels({
          type: 'sync_state',
          bannerMode,
          bannerPosition,
          bannerAlign,
          bannerFont
        });
        break;

      case 'swap_competitors':
        const tmp = currentCompetitor;
        currentCompetitor = currentCompetitor2;
        currentCompetitor2 = tmp;
        broadcastToOverlays({
          type: 'banner_data',
          mode: bannerMode,
          position: bannerPosition,
          align: bannerAlign,
          competitor1: currentCompetitor,
          competitor2: currentCompetitor2,
          event: currentEvent,
          visible: competitorVisible
        });
        broadcastToPanels({
          type: 'sync_state',
          currentCompetitor,
          currentCompetitor2
        });
        break;

      case 'competitor':
        currentCompetitor = msg.data;
        competitorVisible = true;
        broadcastToOverlays({
          type: 'banner_data',
          mode: bannerMode,
          position: bannerPosition,
          align: bannerAlign,
          competitor1: currentCompetitor,
          competitor2: currentCompetitor2,
          event: currentEvent,
          visible: true
        });
        broadcastToOverlays(msg);
        broadcastToPanels({ type: 'sync_state', currentCompetitor, competitorVisible });
        break;

      case 'event':
        if (msg.data) {
          if (tournamentLogo && !msg.data.tournament_logo) {
            msg.data.tournament_logo = tournamentLogo;
          } else if (msg.data.tournament_logo) {
            tournamentLogo = msg.data.tournament_logo;
            saveLiveState();
          }
          currentEvent = Object.assign({}, currentEvent || {}, msg.data);
        }
        eventVisible = true;
        broadcastToOverlays(msg);
        broadcastToOverlays({
          type: 'banner_event',
          event: currentEvent
        });
        broadcastToPanels({ type: 'sync_state', currentEvent, eventVisible });
        break;

      case 'hide_competitor':
      case 'hide_banner':
        competitorVisible = false;
        broadcastToOverlays({ type: 'hide_competitor' });
        broadcastToOverlays({ type: 'hide_banner' });
        broadcastToPanels({ type: 'sync_state', competitorVisible: false });
        break;

      case 'hide_event':
        eventVisible = false;
        broadcastToOverlays({ type: 'hide_event' });
        broadcastToPanels({ type: 'sync_state', eventVisible: false });
        break;

      case 'hide_all':
        competitorVisible = false;
        eventVisible = false;
        liveRankingVisible = false;
        showcaseVisible = false;
        bigLogoVisible = false;
        headToHeadVisible = false;
        saveLiveState();
        stopLiveRankingPolling();
        broadcastToOverlays({ type: 'hide_competitor' });
        broadcastToOverlays({ type: 'hide_banner' });
        broadcastToOverlays({ type: 'hide_event' });
        broadcastToOverlays({ type: 'live_ranking_hide' });
        broadcastToOverlays({ type: 'hide_competitor_showcase' });
        broadcastToOverlays({ type: 'hide_big_logo' });
        broadcastToOverlays({ type: 'hide_head_to_head' });
        broadcastToPanels({
          type: 'sync_state',
          competitorVisible: false,
          eventVisible: false,
          showcaseVisible: false,
          bigLogoVisible: false,
          headToHeadVisible: false
        });
        broadcastToPanels({
          type: 'sync_live_ranking',
          visible: false,
          data: liveRankingData,
          roundId: liveRankingRoundId,
          compId: liveRankingCompId,
          pollInterval: liveRankingPollInterval,
          top: liveRankingTop,
          cutoff: liveRankingCutoff
        });
        break;

      case 'show_competitor_showcase':
        if (msg.competitor) showcaseCompetitor = msg.competitor;
        showcaseVisible = true;
        broadcastToOverlays({
          type: 'show_competitor_showcase',
          competitor: showcaseCompetitor,
          event: currentEvent
        });
        broadcastToPanels({
          type: 'sync_state',
          showcaseCompetitor,
          showcaseVisible: true
        });
        break;

      case 'hide_competitor_showcase':
        showcaseVisible = false;
        broadcastToOverlays({ type: 'hide_competitor_showcase' });
        broadcastToPanels({
          type: 'sync_state',
          showcaseVisible: false
        });
        break;

      case 'show_big_logo':
        if (msg.url) bigLogoUrl = msg.url;
        if (msg.size !== undefined) {
          const s = parseInt(msg.size, 10);
          if (!isNaN(s) && s >= 300 && s <= 1200) bigLogoSize = s;
        }
        bigLogoVisible = true;
        saveLiveState();
        const activeUrl = bigLogoUrl || tournamentLogo;
        broadcastToOverlays({
          type: 'show_big_logo',
          url: activeUrl,
          size: bigLogoSize
        });
        broadcastToPanels({
          type: 'sync_state',
          bigLogoVisible: true,
          bigLogoUrl: activeUrl,
          bigLogoSize: bigLogoSize
        });
        break;

      case 'hide_big_logo':
        bigLogoVisible = false;
        saveLiveState();
        broadcastToOverlays({ type: 'hide_big_logo' });
        broadcastToPanels({
          type: 'sync_state',
          bigLogoVisible: false
        });
        break;

      case 'set_big_logo_size':
        if (msg.size !== undefined) {
          const s = parseInt(msg.size, 10);
          if (!isNaN(s) && s >= 300 && s <= 1200) {
            bigLogoSize = s;
            saveLiveState();
            broadcastToOverlays({
              type: 'big_logo_size',
              size: bigLogoSize
            });
            broadcastToPanels({
              type: 'sync_state',
              bigLogoSize: bigLogoSize
            });
          }
        }
        break;

      case 'show_head_to_head':
        headToHeadVisible = true;
        if (msg.data) {
          headToHeadData = Object.assign(headToHeadData || {}, msg.data);
        }
        saveLiveState();
        broadcastToOverlays({
          type: 'show_head_to_head',
          data: headToHeadData
        });
        broadcastToPanels({
          type: 'sync_state',
          headToHeadVisible: true,
          headToHeadData: headToHeadData
        });
        break;

      case 'hide_head_to_head':
        headToHeadVisible = false;
        saveLiveState();
        broadcastToOverlays({ type: 'hide_head_to_head' });
        broadcastToPanels({
          type: 'sync_state',
          headToHeadVisible: false
        });
        break;

      case 'live_ranking_show':
        if (msg.data) liveRankingData = msg.data;
        if (msg.roundId) liveRankingRoundId = msg.roundId;
        if (msg.compId) liveRankingCompId = msg.compId;
        if (msg.top !== undefined) liveRankingTop = parseInt(msg.top, 10) || 16;
        if (msg.cutoff !== undefined) {
          const c = parseInt(msg.cutoff, 10);
          liveRankingCutoff = isNaN(c) || c < 0 ? 0 : c;
        }
        if (msg.dynamicPaging !== undefined) liveRankingDynamicPaging = !!msg.dynamicPaging;
        if (msg.autoBalance !== undefined) liveRankingAutoBalance = !!msg.autoBalance;
        if (msg.pageSize !== undefined) liveRankingPageSize = parseInt(msg.pageSize, 10) || 16;
        if (msg.pageDuration !== undefined) liveRankingPageDuration = parseInt(msg.pageDuration, 10) || 10;
        if (msg.viewMode) liveRankingViewMode = msg.viewMode;

        if (liveRankingData && !liveRankingData.competitionName && tournamentData?.name) {
          liveRankingData.competitionName = tournamentData.name;
        }

        liveRankingVisible = true;
        saveLiveState();

        if (msg.pollInterval !== undefined) {
          startLiveRankingPolling(msg.pollInterval);
        }
        broadcastToOverlays({
          type: 'live_ranking_show',
          data: liveRankingData,
          dynamicPaging: liveRankingDynamicPaging,
          autoBalance: liveRankingAutoBalance,
          pageSize: liveRankingPageSize,
          pageDuration: liveRankingPageDuration,
          viewMode: liveRankingViewMode
        });
        broadcastToPanels({
          type: 'sync_live_ranking',
          visible: true,
          data: liveRankingData,
          roundId: liveRankingRoundId,
          compId: liveRankingCompId,
          pollInterval: liveRankingPollInterval,
          top: liveRankingTop,
          cutoff: liveRankingCutoff,
          dynamicPaging: liveRankingDynamicPaging,
          autoBalance: liveRankingAutoBalance,
          pageSize: liveRankingPageSize,
          pageDuration: liveRankingPageDuration,
          viewMode: liveRankingViewMode
        });
        break;

      case 'live_ranking_set_view':
        if (msg.viewMode) {
          liveRankingViewMode = msg.viewMode;
          saveLiveState();
          if (liveRankingVisible) {
            broadcastToOverlays({
              type: 'live_ranking_show',
              data: liveRankingData,
              dynamicPaging: liveRankingDynamicPaging,
              autoBalance: liveRankingAutoBalance,
              pageSize: liveRankingPageSize,
              pageDuration: liveRankingPageDuration,
              viewMode: liveRankingViewMode
            });
          }
          broadcastToPanels({
            type: 'sync_live_ranking',
            visible: liveRankingVisible,
            data: liveRankingData,
            roundId: liveRankingRoundId,
            compId: liveRankingCompId,
            pollInterval: liveRankingPollInterval,
            top: liveRankingTop,
            cutoff: liveRankingCutoff,
            dynamicPaging: liveRankingDynamicPaging,
            autoBalance: liveRankingAutoBalance,
            pageSize: liveRankingPageSize,
            pageDuration: liveRankingPageDuration,
            viewMode: liveRankingViewMode
          });
        }
        break;

      case 'live_ranking_hide':
        liveRankingVisible = false;
        stopLiveRankingPolling();
        saveLiveState();
        broadcastToOverlays({
          type: 'live_ranking_hide'
        });
        broadcastToPanels({
          type: 'sync_live_ranking',
          visible: false,
          data: liveRankingData,
          roundId: liveRankingRoundId,
          compId: liveRankingCompId,
          pollInterval: liveRankingPollInterval,
          top: liveRankingTop,
          cutoff: liveRankingCutoff
        });
        break;

      case 'live_ranking_comp_selected':
        if (msg.compId) liveRankingCompId = msg.compId;
        if (msg.roundId) liveRankingRoundId = msg.roundId;
        if (msg.rounds && Array.isArray(msg.rounds)) liveRankingRounds = msg.rounds;
        saveLiveState();
        break;

      case 'live_ranking_select_round':
        if (msg.roundId) liveRankingRoundId = msg.roundId;
        if (msg.compId) liveRankingCompId = msg.compId;
        saveLiveState();
        break;

      case 'live_ranking_params':
        if (msg.top !== undefined) liveRankingTop = parseInt(msg.top, 10) || 16;
        if (msg.cutoff !== undefined) {
          const c = parseInt(msg.cutoff, 10);
          liveRankingCutoff = isNaN(c) || c < 0 ? 0 : c;
        }
        if (msg.dynamicPaging !== undefined) liveRankingDynamicPaging = !!msg.dynamicPaging;
        if (msg.autoBalance !== undefined) liveRankingAutoBalance = !!msg.autoBalance;
        if (msg.pageDuration !== undefined) liveRankingPageDuration = parseInt(msg.pageDuration, 10) || 10;
        if (msg.pageSize !== undefined) liveRankingPageSize = parseInt(msg.pageSize, 10) || 16;
        saveLiveState();
        if (liveRankingVisible) {
          broadcastToOverlays({
            type: 'live_ranking_update',
            visible: true,
            data: liveRankingData,
            roundId: liveRankingRoundId,
            compId: liveRankingCompId,
            top: liveRankingTop,
            cutoff: liveRankingCutoff,
            dynamicPaging: liveRankingDynamicPaging,
            autoBalance: liveRankingAutoBalance,
            pageSize: liveRankingPageSize,
            pageDuration: liveRankingPageDuration,
            viewMode: liveRankingViewMode
          });
        }
        break;

      case 'live_ranking_poll_config':
        if (msg.pollInterval !== undefined) {
          liveRankingPollInterval = parseInt(msg.pollInterval, 10) || 0;
          startLiveRankingPolling(liveRankingPollInterval);
          saveLiveState();
        }
        broadcastToPanels({
          type: 'sync_live_ranking',
          visible: liveRankingVisible,
          data: liveRankingData,
          roundId: liveRankingRoundId,
          compId: liveRankingCompId,
          pollInterval: liveRankingPollInterval,
          top: liveRankingTop,
          cutoff: liveRankingCutoff
        });
        break;

      case 'set_fs_theme':
        if (msg.data) {
          if (msg.data.bgColor !== undefined) fsTheme.bgColor = msg.data.bgColor;
          if (msg.data.bgImage !== undefined) fsTheme.bgImage = msg.data.bgImage;
          if (msg.data.opacity !== undefined) fsTheme.opacity = parseInt(msg.data.opacity, 10);
          if (msg.data.blur !== undefined) fsTheme.blur = parseInt(msg.data.blur, 10);
          if (msg.data.colorCycle !== undefined) fsTheme.colorCycle = !!msg.data.colorCycle;
          if (msg.data.animation !== undefined) fsTheme.animation = msg.data.animation;
          if (msg.data.animSpeed !== undefined) fsTheme.animSpeed = msg.data.animSpeed;
          saveLiveState();
          broadcastToOverlays({ type: 'fs_theme_updated', data: fsTheme });
          broadcastToPanels({ type: 'fs_theme_updated', data: fsTheme });
        }
        break;

      case 'get_preloaded':
        socket.send(JSON.stringify({ type: 'preloaded_data', data: tournamentData }));
        break;

      case 'obs_set_scene':
        if (obsConnected && msg.sceneName) {
          obs.call('SetCurrentProgramScene', { sceneName: msg.sceneName }).catch(err => {
            console.error('[OBS Scene Error]', err.message);
          });
        }
        break;

      case 'obs_set_preview':
        if (obsConnected && msg.sceneName) {
          if (!obsStatus.studioMode) {
            obs.call('SetStudioModeEnabled', { studioModeEnabled: true }).catch(() => {});
          }
          obs.call('SetCurrentPreviewScene', { sceneName: msg.sceneName }).catch(err => {
            console.error('[OBS Preview Error]', err.message);
          });
        }
        break;

      case 'obs_transition':
        if (obsConnected) {
          obs.call('TriggerStudioModeTransition').then(() => {
            setTimeout(() => updateOBSFullState(), 350);
          }).catch(err => {
            console.error('[OBS Transition Error]', err.message);
          });
        }
        break;

      case 'obs_toggle_studio':
        if (obsConnected) {
          obs.call('SetStudioModeEnabled', { studioModeEnabled: !obsStatus.studioMode }).then(() => {
            updateOBSFullState();
          }).catch(err => {
            console.error('[OBS Toggle Studio Error]', err.message);
          });
        }
        break;

      case 'obs_toggle_stream':
        if (obsConnected) obs.call('ToggleStream').catch(() => {});
        break;

      case 'obs_toggle_record':
        if (obsConnected) obs.call('ToggleRecord').catch(() => {});
        break;

      case 'obs_toggle_item':
        if (obsConnected && msg.sceneItemId !== undefined) {
          obs.call('SetSceneItemEnabled', {
            sceneName: msg.sceneName || obsStatus.currentProgramScene,
            sceneItemId: Number(msg.sceneItemId),
            sceneItemEnabled: !!msg.enabled
          }).catch(err => console.error('[OBS Toggle Item Error]', err.message));
        }
        break;

      case 'obs_set_item_transform_preset':
        if (obsConnected && msg.sceneItemId !== undefined && msg.preset) {
          const transform = getTransformForPreset(msg.preset);
          if (transform) {
            obs.call('SetSceneItemTransform', {
              sceneName: msg.sceneName || obsStatus.currentProgramScene,
              sceneItemId: Number(msg.sceneItemId),
              sceneItemTransform: transform
            }).catch(err => console.error('[OBS Transform Error]', err.message));
          }
        }
        break;

      case 'obs_media_action':
        if (obsConnected && msg.inputName) {
          let mediaAction = 'OBS_WEBMEDIA_INPUT_ACTION_RESTART';
          if (msg.action === 'pause') mediaAction = 'OBS_WEBMEDIA_INPUT_ACTION_PAUSE';
          else if (msg.action === 'play') mediaAction = 'OBS_WEBMEDIA_INPUT_ACTION_PLAY';
          else if (msg.action === 'stop') mediaAction = 'OBS_WEBMEDIA_INPUT_ACTION_STOP';

          obs.call('TriggerMediaInputAction', {
            inputName: msg.inputName,
            mediaAction
          }).catch(err => console.error('[OBS Media Action Error]', err.message));
        }
        break;
    }
  }

  ws.on('message', raw => {
    try {
      const msg = JSON.parse(raw.toString());
      if (isPanel) {
        handlePanelMessage(ws, msg);
      }
    } catch (e) {
      // Ignorar mensajes no JSON
    }
  });

  ws.on('close', () => {
    if (isPanel) {
      panelClients.delete(ws);
      console.log(`[WS] Panel desconectado (Restan: ${panelClients.size})`);
    } else {
      overlayClients.delete(ws);
      console.log(`[WS] Overlay OBS desconectado (Restan: ${overlayClients.size})`);
      broadcastToPanels({ type: 'client_count', count: overlayClients.size });
    }
  });
}

// ── Crear Servidores WebSocket ──
// 1. WebSocket principal integrado en el servidor HTTP (/ws)
const wssMain = new WebSocketServer({ server, path: '/ws' });
wssMain.on('connection', handleSocketConnection);

// 2. WebSocket secundario en puerto 8765 para compatibilidad retroactiva con OBS
let wssLegacy = null;
try {
  wssLegacy = new WebSocketServer({ port: OBS_WS_PORT });
  wssLegacy.on('connection', handleSocketConnection);
  console.log(`[WS Legacy] Activo en ws://localhost:${OBS_WS_PORT} (para compatibilidad con OBS Browser Sources)`);
} catch (err) {
  console.log(`[WS Legacy] Puerto ${OBS_WS_PORT} no disponible, overlays usarán ws://localhost:${PORT}/ws`);
}

// ── Iniciar servidor HTTP ──
server.listen(PORT, async () => {
  console.log('====================================================');
  console.log('   DirectoOBS v2.0 - Node.js Broadcast Engine');
  console.log('====================================================');
  console.log(`▸ Panel de Control:   http://localhost:${PORT}`);
  console.log(`▸ Overlay para OBS:   http://localhost:${PORT}/overlay`);
  console.log(`▸ WebSocket (HTTP):   ws://localhost:${PORT}/ws`);
  console.log(`▸ WebSocket (Legacy): ws://localhost:${OBS_WS_PORT}`);
  console.log('----------------------------------------------------');

  // Intentar auto-conectar a OBS WebSocket en localhost por defecto
  try {
    await connectToOBS('ws://127.0.0.1:4455', '');
  } catch {
    console.log('[OBS] OBS Studio no detectado en puerto 4455 (puedes conectarlo desde el panel).');
  }
});
