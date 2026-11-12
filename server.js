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
  resolveWcaLiveId,
  calculateAo5Stats,
  fetchLiveVersusData
} from './server/wcaLiveService.js';
import {
  startFinalsDemo,
  stopFinalsDemo,
  isDemoActive
} from './server/liveDemoFinals.js';

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
let tickerSize = 'small';         // Tamaño del banner inferior de noticias: 'small' | 'medium' | 'large'
let bigLogoVisible = false;       // Visibilidad del Logo Central (Momentos Muertos)
let bigLogoUrl = null;           // URL específica o personalizada del Logo Central
let bigLogoSize = 760;           // Tamaño máximo en píxeles (altura) del Logo Central
let headToHeadVisible = false;   // Visibilidad del banner Head to Head
let headToHeadSize = 1150;        // Tamaño ancho base en píxeles del banner Head to Head
let headToHeadData = {           // Datos del enfrentamiento Head to Head
  competitor1: null,
  competitor2: null,
  event: null
};

// ── Estado del Banner de Finales Versus (Cara a Cara WCA Live con WPA/BPA/AVG) ──
let versusBannerVisible = false;
let versusRoundId = null;
let versusCompId = null;
let versusPollInterval = 2; // segundos (rápido para finales)
let versusPollTimer = null;
let versusComp1Target = null;
let versusComp2Target = null;
let versusData = {
  eventId: '333',
  eventName: '3x3',
  roundName: 'Final',
  competitor1: null,
  competitor2: null,
  allCompetitors: []
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
  gradientLevel: 70,
  patternSize: 80,
  colorCycle: false,
  colombiaCycle: false,
  animation: 'none',
  animSpeed: 'slow',
  scene: 'ranking',
  startingCustomTitle: '',
  startingDay: 'Día 1',
  startingText: 'Iniciando en unos minutos',
  startingMode: 'both',
  lunchText: 'Hora de almuerzo',
  reconnectingText: 'Reconectando',
  endingText: 'Gracias por vernos'
};

const LIVE_STATE_FILE = path.join(__dirname, 'live_state.json');

// ── Almacenamiento local persistente de fotos de perfil (Avatares WCA) ──
const AVATARS_DIR = path.join(__dirname, 'public', 'uploads', 'avatars');
if (!fs.existsSync(AVATARS_DIR)) {
  fs.mkdirSync(AVATARS_DIR, { recursive: true });
}

function getLocalAvatarIfExists(wcaId) {
  if (!wcaId) return null;
  const cleanId = String(wcaId).trim().toUpperCase();
  const filePath = path.join(AVATARS_DIR, `${cleanId}.jpg`);
  if (fs.existsSync(filePath)) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > 500) {
        return `/uploads/avatars/${cleanId}.jpg`;
      }
    } catch {}
  }
  return null;
}

async function downloadAvatarLocally(remoteUrl, wcaId, force = false) {
  if (!remoteUrl || !wcaId || remoteUrl.includes('missing_avatar')) return null;
  const cleanId = String(wcaId).trim().toUpperCase();
  const filePath = path.join(AVATARS_DIR, `${cleanId}.jpg`);
  const relativeUrl = `/uploads/avatars/${cleanId}.jpg`;

  if (!force && fs.existsSync(filePath)) {
    try {
      const stats = fs.statSync(filePath);
      if (stats.size > 500) {
        return relativeUrl;
      }
    } catch {}
  }

  try {
    const WCA_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    const res = await fetch(remoteUrl, { headers: WCA_HEADERS });
    if (!res.ok) return fs.existsSync(filePath) ? relativeUrl : null;
    const arrayBuffer = await res.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.length > 500) {
      fs.writeFileSync(filePath, buffer);
      console.log(`[Avatar] Foto guardada localmente para ${cleanId} (${Math.round(buffer.length / 1024)} KB)`);
      return relativeUrl;
    }
    return fs.existsSync(filePath) ? relativeUrl : null;
  } catch (err) {
    console.warn(`[Avatar] Error descargando foto para ${cleanId}:`, err.message);
    return fs.existsSync(filePath) ? relativeUrl : null;
  }
}

function enrichCompetitorWithAvatar(comp) {
  if (!comp || !comp.wca_id) return comp;
  const local = getLocalAvatarIfExists(comp.wca_id);
  if (local) comp.avatar_url = local;
  return comp;
}

function enrichCompetitorsWithLocalAvatars(competitors) {
  if (!Array.isArray(competitors)) return;
  for (const comp of competitors) {
    enrichCompetitorWithAvatar(comp);
  }
}

let saveLiveStateTimer = null;

function saveLiveState(immediate = false) {
  if (saveLiveStateTimer) {
    clearTimeout(saveLiveStateTimer);
    saveLiveStateTimer = null;
  }

  const doSave = async () => {
    try {
      // Evitar que cadenas Base64 gigantes (>150KB) saturen el archivo de estado
      const cleanLogo = (typeof tournamentLogo === 'string' && tournamentLogo.length > 150000)
        ? null
        : tournamentLogo;
      const cleanBigLogo = (typeof bigLogoUrl === 'string' && bigLogoUrl.length > 150000)
        ? null
        : bigLogoUrl;

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
        tournamentLogo: cleanLogo,
        tickerSize: tickerSize,
        bigLogoVisible: bigLogoVisible,
        bigLogoUrl: cleanBigLogo,
        bigLogoSize: bigLogoSize,
        headToHeadVisible: headToHeadVisible,
        headToHeadSize: headToHeadSize,
        headToHeadData: headToHeadData,
        versusBannerVisible: versusBannerVisible,
        versusRoundId: versusRoundId,
        versusCompId: versusCompId,
        versusPollInterval: versusPollInterval,
        versusComp1Target: versusComp1Target,
        versusComp2Target: versusComp2Target,
        versusData: versusData
      };
      await fs.promises.writeFile(LIVE_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
    } catch (err) {
      console.warn('[LiveRanking] Error guardando live_state.json:', err.message);
    }
  };

  if (immediate) {
    doSave();
  } else {
    saveLiveStateTimer = setTimeout(doSave, 300);
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
      if (state.tickerSize && ['small', 'medium', 'large'].includes(state.tickerSize)) {
        tickerSize = state.tickerSize;
      }
      if (state.bigLogoVisible !== undefined) bigLogoVisible = state.bigLogoVisible;
      if (state.bigLogoUrl !== undefined) bigLogoUrl = state.bigLogoUrl;
      if (state.bigLogoSize !== undefined) {
        const s = parseInt(state.bigLogoSize, 10);
        if (!isNaN(s) && s >= 300 && s <= 1200) bigLogoSize = s;
      }
      if (state.headToHeadVisible !== undefined) headToHeadVisible = state.headToHeadVisible;
      if (state.headToHeadSize !== undefined) {
        const s = parseInt(state.headToHeadSize, 10);
        if (!isNaN(s) && s >= 600 && s <= 1800) headToHeadSize = s;
      }
      if (state.headToHeadData !== undefined && typeof state.headToHeadData === 'object') {
        headToHeadData = Object.assign({ competitor1: null, competitor2: null, event: null }, state.headToHeadData);
      }
      if (state.versusBannerVisible !== undefined) versusBannerVisible = state.versusBannerVisible;
      if (state.versusRoundId) versusRoundId = state.versusRoundId;
      if (state.versusCompId) versusCompId = state.versusCompId;
      if (state.versusPollInterval !== undefined) versusPollInterval = state.versusPollInterval;
      if (state.versusComp1Target) versusComp1Target = state.versusComp1Target;
      if (state.versusComp2Target) versusComp2Target = state.versusComp2Target;
      if (state.versusData) versusData = state.versusData;
      if (state.fsTheme) {
        fsTheme = {
          bgColor: state.fsTheme.bgColor || '#0c4ea8',
          bgImage: state.fsTheme.bgImage || null,
          opacity: state.fsTheme.opacity !== undefined ? state.fsTheme.opacity : 100,
          blur: state.fsTheme.blur !== undefined ? state.fsTheme.blur : 0,
          gradientLevel: state.fsTheme.gradientLevel !== undefined ? state.fsTheme.gradientLevel : 70,
          patternSize: state.fsTheme.patternSize !== undefined ? state.fsTheme.patternSize : 80,
          colorCycle: state.fsTheme.colorCycle !== undefined ? !!state.fsTheme.colorCycle : false,
          colombiaCycle: state.fsTheme.colombiaCycle !== undefined ? !!state.fsTheme.colombiaCycle : false,
          animation: state.fsTheme.animation || 'none',
          animSpeed: state.fsTheme.animSpeed || 'slow',
          scene: state.fsTheme.scene || 'ranking',
          startingCustomTitle: state.fsTheme.startingCustomTitle || '',
          startingDay: state.fsTheme.startingDay || 'Día 1',
          startingText: state.fsTheme.startingText || 'Iniciando en unos minutos',
          startingMode: state.fsTheme.startingMode || 'both',
          lunchText: state.fsTheme.lunchText || 'Hora de almuerzo',
          reconnectingText: state.fsTheme.reconnectingText || 'Reconectando',
          endingText: state.fsTheme.endingText || 'Gracias por vernos'
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
      if (tournamentData?.competitors) enrichCompetitorsWithLocalAvatars(tournamentData.competitors);
      console.log(`[Torneo] Cargado desde argumento: ${tournamentData.name} (${tournamentData.competitors?.length || 0} competidores)`);
    } catch (err) {
      console.error('[Torneo] Error al leer archivo especificado:', err.message);
    }
  } else {
    console.warn(`[Torneo] Archivo especificado no encontrado: ${specifiedDataFile}`);
  }
} else {
  console.log('[Torneo] Servidor iniciado sin torneo por defecto. Carga uno desde el panel web o con --data <archivo.json>');
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

// ── Polling y Gestión en Tiempo Real de Banner de Finales Versus (WCA Live) ──
let isVersusPollingInFlight = false;

async function refreshVersusData() {
  if (!versusRoundId || isVersusPollingInFlight) return;
  isVersusPollingInFlight = true;
  try {
    const data = await fetchLiveVersusData(versusRoundId, versusComp1Target, versusComp2Target);
    if (data) {
      versusData = data;
      broadcastToOverlays({
        type: 'versus_banner_data',
        visible: versusBannerVisible,
        data: versusData
      });
      broadcastToPanels({
        type: 'sync_versus_banner',
        visible: versusBannerVisible,
        data: versusData,
        roundId: versusRoundId,
        compId: versusCompId,
        pollInterval: versusPollInterval,
        comp1Target: versusComp1Target,
        comp2Target: versusComp2Target
      });
    }
  } catch (err) {
    console.warn('[VersusPolling] Error al refrescar datos versus:', err.message);
  } finally {
    isVersusPollingInFlight = false;
  }
}

function startVersusPolling(intervalSec) {
  stopVersusPolling();
  const sec = Math.max(1, parseInt(intervalSec, 10) || 2);
  versusPollInterval = sec;
  console.log(`[VersusPolling] Iniciando polling cada ${sec}s para ronda ${versusRoundId}`);
  refreshVersusData();
  versusPollTimer = setInterval(refreshVersusData, sec * 1000);
}

function stopVersusPolling() {
  if (versusPollTimer) {
    clearInterval(versusPollTimer);
    versusPollTimer = null;
  }
}

if (versusRoundId) {
  fetchLiveVersusData(versusRoundId, versusComp1Target, versusComp2Target)
    .then(data => {
      versusData = data;
      console.log(`[VersusPolling] Datos versus precargados para ronda ${versusRoundId}`);
      if (versusBannerVisible) {
        startVersusPolling(versusPollInterval);
      }
    })
    .catch(err => {
      console.warn(`[VersusPolling] No se pudo precargar datos versus para ${versusRoundId}:`, err.message);
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

// Señal Final Definitiva para OBS (Master Program Stream 1080p60)
// Conmuta dinámicamente entre Escena Principal, FullScreen Clasificación y Transiciones
app.get(['/envivo', '/en-vivo', '/program', '/master'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

app.get('/overlay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

app.get('/fullscreen', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

app.get(['/transicion', '/transiciones'], (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'overlay.html'));
});

// Redirigir accesos individuales antiguos al enlace unificado de transiciones
app.get(['/iniciando', '/almuerzo', '/reconectando', '/gracias', '/despedida'], (req, res) => {
  res.redirect(302, '/transicion');
});

// ── Rutas API REST ──

// Obtener lista de patrocinadores desde /public/logos
app.get('/api/sponsors', (req, res) => {
  const logosDir = path.join(__dirname, 'public', 'logos');
  try {
    if (!fs.existsSync(logosDir)) {
      return res.json({ ok: true, sponsors: [] });
    }
    const files = fs.readdirSync(logosDir)
      .filter(f => /\.(png|jpe?g|svg|webp)$/i.test(f));
    const sponsors = files.map(file => {
      const name = path.parse(file).name.replace(/[-_]/g, ' ');
      return {
        filename: file,
        url: `/logos/${encodeURIComponent(file)}`,
        name: name
      };
    });
    res.json({ ok: true, sponsors });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

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
    if (tournamentData?.competitors) enrichCompetitorsWithLocalAvatars(tournamentData.competitors);

    let cleanSaveName = 'torneo_data.json';
    if (filename && typeof filename === 'string') {
      cleanSaveName = path.basename(filename);
      if (!cleanSaveName.toLowerCase().endsWith('.json')) cleanSaveName += '.json';
    } else if (data.competition_id) {
      cleanSaveName = `${String(data.competition_id).replace(/[^a-zA-Z0-9_-]/g, '_')}_data.json`;
    }
    const savePath = path.join(__dirname, cleanSaveName);

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

      // Parsear competidores aceptados extrayendo PRs y foto directamente del WCIF público
      // (Evita el rate limit de 60 req/min en /api/v0/persons/:wcaId en torneos grandes)
      const rawPersons = wcif.persons || [];
      const competitors = [];
      const allPRs = {};
      const allAvatars = {};

      for (const p of rawPersons) {
        if (p.registration && p.registration.status === 'accepted') {
          const wcaId = p.wcaId || null;
          const remoteAvatar = (
            p.avatar &&
            !p.avatar.isDefault &&
            !p.avatar.is_default &&
            (p.avatar.url || p.avatar.thumbUrl) &&
            !String(p.avatar.url || p.avatar.thumbUrl).includes('missing_avatar') &&
            !String(p.avatar.url || p.avatar.thumbUrl).includes('default_avatar')
          ) ? (p.avatar.url || p.avatar.thumbUrl) : null;

          if (wcaId) {
            const prs = {};
            for (const pb of (p.personalBests || [])) {
              const eid = pb.eventId;
              if (!eid) continue;
              if (!prs[eid]) {
                prs[eid] = { single: null, average: null, single_nr: null, average_nr: null };
              }
              if (pb.type === 'single') {
                prs[eid].single = pb.best ?? null;
                prs[eid].single_nr = pb.nationalRanking ?? pb.country_rank ?? null;
              } else if (pb.type === 'average') {
                prs[eid].average = pb.best ?? null;
                prs[eid].average_nr = pb.nationalRanking ?? pb.country_rank ?? null;
              }
            }
            allPRs[wcaId] = prs;
          }

          competitors.push({
            name: p.name,
            wca_id: wcaId,
            is_new: !wcaId,
            registrant_id: p.registrantId,
            events: p.registration.eventIds || [],
            country: p.countryIso2 || '',
            remote_avatar: remoteAvatar
          });
        }
      }
      competitors.sort((a, b) => a.name.localeCompare(b.name));

      const withRemoteAvatar = competitors.filter(c => c.wca_id && c.remote_avatar);
      emitProgress(30, `Descargando fotos de perfil de ${withRemoteAvatar.length} competidores desde CDN WCA...`);

      let avatarsSavedCount = 0;
      for (let i = 0; i < withRemoteAvatar.length; i++) {
        const c = withRemoteAvatar[i];
        const pct = 30 + Math.round(((i + 1) / Math.max(withRemoteAvatar.length, 1)) * 62);
        emitProgress(pct, `[${i + 1}/${withRemoteAvatar.length}] ${c.name} (${c.wca_id}) - Guardando foto...`);

        const localUrl = await downloadAvatarLocally(c.remote_avatar, c.wca_id, true);
        if (localUrl) {
          allAvatars[c.wca_id] = localUrl;
          avatarsSavedCount++;
        } else {
          allAvatars[c.wca_id] = getLocalAvatarIfExists(c.wca_id) || c.remote_avatar;
        }
      }

      emitProgress(95, 'Ensamblando estructura final...');

      const competitorsFull = competitors.map(c => {
        const raw = (c.wca_id && allPRs[c.wca_id]) ? allPRs[c.wca_id] : {};
        const prsDisplay = {};
        const allEventIds = new Set([...(c.events || []), ...Object.keys(raw)]);

        for (const eid of allEventIds) {
          if (raw[eid]) {
            prsDisplay[eid] = {
              event_name: EVENT_NAMES[eid] || eid,
              single_cs: raw[eid].single,
              average_cs: raw[eid].average,
              single_nr: raw[eid].single_nr ?? null,
              average_nr: raw[eid].average_nr ?? null,
              single_fmt: formatTime(raw[eid].single, eid),
              average_fmt: formatTime(raw[eid].average, eid)
            };
          } else {
            prsDisplay[eid] = {
              event_name: EVENT_NAMES[eid] || eid,
              single_cs: null,
              average_cs: null,
              single_nr: null,
              average_nr: null,
              single_fmt: '—',
              average_fmt: '—'
            };
          }
        }

        const avatarLocal = (c.wca_id && (allAvatars[c.wca_id] || getLocalAvatarIfExists(c.wca_id))) || c.remote_avatar || null;

        return {
          name: c.name,
          wca_id: c.wca_id,
          is_new: c.is_new,
          country: c.country,
          avatar_url: avatarLocal,
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

      const totalAvatars = competitorsFull.filter(c => c.avatar_url).length;
      emitProgress(100, `¡Completado! ${competitorsFull.length} inscritos y ${totalAvatars} fotos guardadas localmente.`, 'ok');
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
        single_nr: rec.single?.country_rank ?? null,
        average_nr: rec.average?.country_rank ?? null,
        single_fmt: formatTime(rec.single?.best ?? null, eid),
        average_fmt: formatTime(rec.average?.best ?? null, eid)
      };
    }

    const remoteAvatarUrl = (personObj.avatar && !personObj.avatar.is_default && personObj.avatar.url && !personObj.avatar.url.includes('missing_avatar')) ? personObj.avatar.url : null;
    let localAvatarUrl = getLocalAvatarIfExists(cleanId);
    if (remoteAvatarUrl) {
      const downloaded = await downloadAvatarLocally(remoteAvatarUrl, cleanId, false);
      if (downloaded) localAvatarUrl = downloaded;
    }

    const competitor = {
      name: personObj.name || cleanId,
      wca_id: cleanId,
      is_new: false,
      country: personObj.country_iso2 || personObj.countryIso2 || '',
      avatar_url: localAvatarUrl || remoteAvatarUrl || null,
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
  const existingLocal = getLocalAvatarIfExists(cleanId);

  try {
    const WCA_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    const pRes = await fetch(`${WCA_API}/persons/${cleanId}`, { headers: WCA_HEADERS });
    if (!pRes.ok) {
      if (existingLocal) {
        return res.json({ ok: true, wca_id: cleanId, avatar_url: existingLocal, personal_records: null });
      }
      return res.status(404).json({ ok: false, avatar_url: null });
    }

    const pData = await pRes.json();
    const personObj = pData.person || (pData.persons && pData.persons[0]) || {};
    const remoteAvatarUrl = (personObj.avatar && !personObj.avatar.is_default && personObj.avatar.url && !personObj.avatar.url.includes('missing_avatar')) ? personObj.avatar.url : null;
    let finalAvatarUrl = existingLocal;

    if (remoteAvatarUrl) {
      const downloaded = await downloadAvatarLocally(remoteAvatarUrl, cleanId, false);
      if (downloaded) finalAvatarUrl = downloaded;
    }
    if (!finalAvatarUrl && remoteAvatarUrl) {
      finalAvatarUrl = remoteAvatarUrl;
    }

    const personalRecords = personObj.personal_records || null;
    
    // Si tenemos al competidor en memoria, enriquecer su objeto con avatar y récords/rankings WCA
    if (tournamentData && tournamentData.competitors) {
      const comp = tournamentData.competitors.find(c => (c.wca_id || '').toUpperCase() === cleanId);
      if (comp) {
        comp.avatar_url = finalAvatarUrl;
        if (personalRecords) comp.personal_records = personalRecords;
      }
    }
    if (currentCompetitor && (currentCompetitor.wca_id || '').toUpperCase() === cleanId) {
      currentCompetitor.avatar_url = finalAvatarUrl;
      if (personalRecords) currentCompetitor.personal_records = personalRecords;
    }
    if (currentCompetitor2 && (currentCompetitor2.wca_id || '').toUpperCase() === cleanId) {
      currentCompetitor2.avatar_url = finalAvatarUrl;
      if (personalRecords) currentCompetitor2.personal_records = personalRecords;
    }
    if (showcaseCompetitor && (showcaseCompetitor.wca_id || '').toUpperCase() === cleanId) {
      showcaseCompetitor.avatar_url = finalAvatarUrl;
      if (personalRecords) showcaseCompetitor.personal_records = personalRecords;
    }

    res.json({ ok: true, wca_id: cleanId, avatar_url: finalAvatarUrl, personal_records: personalRecords });
  } catch (err) {
    if (existingLocal) {
      return res.json({ ok: true, wca_id: cleanId, avatar_url: existingLocal, personal_records: null });
    }
    res.json({ ok: false, avatar_url: null, error: err.message });
  }
});

// Cache en memoria para resultados históricos y récords de competidores WCA
const wcaResultsCache = new Map();
const wcaPersonRecordsCache = new Map();

// Obtener medallas, podios y rankings nacionales (NR) por categoría de un competidor
app.get('/api/wca/podiums/:wcaId', async (req, res) => {
  const { wcaId } = req.params;
  const eventId = req.query.eventId || '333';
  const cleanId = (wcaId || '').trim().toUpperCase();

  if (!cleanId) {
    return res.json({ ok: true, wca_id: '', event_id: eventId, gold: 0, silver: 0, bronze: 0, single_nr: null, average_nr: null, records: {} });
  }

  try {
    const WCA_HEADERS = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };

    let results = wcaResultsCache.get(cleanId);
    let records = wcaPersonRecordsCache.get(cleanId);

    const promises = [];
    if (!results) {
      promises.push(
        fetch(`${WCA_API}/persons/${cleanId}/results`, { headers: WCA_HEADERS })
          .then(r => r.ok ? r.json() : [])
          .then(data => { results = data; wcaResultsCache.set(cleanId, results); })
          .catch(() => { results = []; })
      );
    }
    if (!records) {
      promises.push(
        fetch(`${WCA_API}/persons/${cleanId}`, { headers: WCA_HEADERS })
          .then(r => r.ok ? r.json() : null)
          .then(pData => {
            if (pData) {
              records = pData.personal_records || (pData.persons && pData.persons[0]?.personal_records) || {};
              wcaPersonRecordsCache.set(cleanId, records);
            } else {
              records = {};
            }
          })
          .catch(() => { records = {}; })
      );
    }

    if (promises.length > 0) {
      await Promise.all(promises);
    }

    let gold = 0, silver = 0, bronze = 0;
    for (const r of (results || [])) {
      if (r.event_id === eventId && (r.round_type_id === 'f' || r.round_type_id === 'c')) {
        if (r.pos === 1) gold++;
        else if (r.pos === 2) silver++;
        else if (r.pos === 3) bronze++;
      }
    }

    const evRec = (records && records[eventId]) || {};
    const single_nr = evRec.single?.country_rank ?? null;
    const average_nr = evRec.average?.country_rank ?? null;

    // Enriquecer en memoria si existe el competidor en el torneo o en HeadToHead
    const enrichCompNr = (comp) => {
      if (!comp || (comp.wca_id || '').toUpperCase() !== cleanId) return;
      if (records) {
        comp.personal_records = records;
        if (comp.prs) {
          for (const [eid, rObj] of Object.entries(records)) {
            if (comp.prs[eid]) {
              comp.prs[eid].single_nr = rObj.single?.country_rank ?? null;
              comp.prs[eid].average_nr = rObj.average?.country_rank ?? null;
            }
          }
        }
      }
    };
    if (tournamentData?.competitors) {
      const found = tournamentData.competitors.find(c => (c.wca_id || '').toUpperCase() === cleanId);
      if (found) enrichCompNr(found);
    }
    if (headToHeadData?.competitor1) enrichCompNr(headToHeadData.competitor1);
    if (headToHeadData?.competitor2) enrichCompNr(headToHeadData.competitor2);

    res.json({ ok: true, wca_id: cleanId, event_id: eventId, gold, silver, bronze, single_nr, average_nr, records: records || {} });
  } catch (err) {
    console.error(`[WCA Podiums Error] ${cleanId}:`, err.message);
    res.json({ ok: false, gold: 0, silver: 0, bronze: 0, single_nr: null, average_nr: null, records: {} });
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

// ── Rutas de Banner de Finales Versus (WCA Live) ──
app.get('/api/versus/status', (req, res) => {
  res.json({
    ok: true,
    visible: versusBannerVisible,
    roundId: versusRoundId,
    compId: versusCompId,
    pollInterval: versusPollInterval,
    comp1Target: versusComp1Target,
    comp2Target: versusComp2Target,
    data: versusData
  });
});

app.post('/api/versus/configure', async (req, res) => {
  try {
    const { roundId, compId, comp1Target, comp2Target, pollInterval, visible } = req.body;
    if (roundId !== undefined) versusRoundId = roundId;
    if (compId !== undefined) versusCompId = compId;
    if (comp1Target !== undefined) versusComp1Target = comp1Target;
    if (comp2Target !== undefined) versusComp2Target = comp2Target;
    if (pollInterval !== undefined) {
      versusPollInterval = Math.max(1, parseInt(pollInterval, 10) || 2);
      if (versusBannerVisible) {
        startVersusPolling(versusPollInterval);
      }
    }
    if (visible !== undefined) {
      versusBannerVisible = !!visible;
      if (versusBannerVisible) {
        startVersusPolling(versusPollInterval);
      } else {
        stopVersusPolling();
        broadcastToOverlays({ type: 'hide_versus_banner' });
      }
    }
    saveLiveState();
    await refreshVersusData();
    res.json({ ok: true, data: versusData, visible: versusBannerVisible });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/versus/toggle', async (req, res) => {
  const { visible } = req.body;
  versusBannerVisible = visible !== undefined ? !!visible : !versusBannerVisible;
  if (versusBannerVisible) {
    startVersusPolling(versusPollInterval);
  } else {
    stopVersusPolling();
    broadcastToOverlays({ type: 'hide_versus_banner' });
  }
  saveLiveState();
  broadcastToPanels({
    type: 'sync_versus_banner',
    visible: versusBannerVisible,
    data: versusData,
    roundId: versusRoundId,
    compId: versusCompId,
    pollInterval: versusPollInterval,
    comp1Target: versusComp1Target,
    comp2Target: versusComp2Target
  });
  res.json({ ok: true, visible: versusBannerVisible, data: versusData });
});

app.post('/api/versus/refresh', async (req, res) => {
  try {
    await refreshVersusData();
    res.json({ ok: true, data: versusData });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Rutas de Simulación / Demostración en Vivo (Final 3x3 - 60s) ──
function runFinalsSimulation() {
  liveRankingVisible = true;
  liveRankingViewMode = 'widget';
  startFinalsDemo(
    (overlayMsg) => {
      liveRankingData = overlayMsg.data;
      liveRankingVisible = true;
      liveRankingViewMode = 'widget';
      broadcastToOverlays(overlayMsg);
    },
    (panelMsg) => {
      broadcastToPanels(panelMsg);
    }
  );
}

app.post('/api/demo/start-final-simulation', (req, res) => {
  runFinalsSimulation();
  res.json({ ok: true, message: 'Simulación de final 3x3 iniciada' });
});

app.post('/api/demo/stop-final-simulation', (req, res) => {
  stopFinalsDemo();
  res.json({ ok: true, message: 'Simulación detenida' });
});

app.get('/api/demo/status', (req, res) => {
  res.json({ ok: true, active: isDemoActive() });
});

// Helpers para subida segura y limpieza de archivos multimedia
const ALLOWED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'webp', 'svg', 'gif']);

function deleteUploadedFile(relativeUrl) {
  if (!relativeUrl || typeof relativeUrl !== 'string') return;
  if (!relativeUrl.startsWith('/uploads/')) return;
  const fileName = path.basename(relativeUrl);
  const fullPath = path.join(__dirname, 'public', 'uploads', fileName);
  fs.unlink(fullPath, (err) => {
    if (err && err.code !== 'ENOENT') {
      console.warn('[Uploads] Error borrando archivo anterior:', err.message);
    }
  });
}

function saveBase64Image(imageBase64, prefix = 'upload', originalFilename = '') {
  if (!imageBase64 || typeof imageBase64 !== 'string') {
    throw new Error('Imagen inválida o ausente');
  }

  const uploadsDir = path.join(__dirname, 'public', 'uploads');
  if (!fs.existsSync(uploadsDir)) {
    fs.mkdirSync(uploadsDir, { recursive: true });
  }

  let ext = 'png';
  let base64Data = imageBase64;

  const matches = imageBase64.match(/^data:image\/([A-Za-z0-9+.-]+);base64,(.+)$/);
  if (matches && matches.length === 3) {
    const subtype = matches[1].toLowerCase();
    if (subtype.includes('jpeg') || subtype.includes('jpg')) ext = 'jpg';
    else if (subtype.includes('png')) ext = 'png';
    else if (subtype.includes('webp')) ext = 'webp';
    else if (subtype.includes('svg')) ext = 'svg';
    else if (subtype.includes('gif')) ext = 'gif';
    base64Data = matches[2];
  } else if (imageBase64.includes(';base64,')) {
    const parts = imageBase64.split(';base64,');
    base64Data = parts[1];
  }

  if (originalFilename && originalFilename.includes('.')) {
    const candidateExt = path.extname(originalFilename).replace('.', '').toLowerCase();
    if (ALLOWED_IMAGE_EXTS.has(candidateExt)) {
      ext = candidateExt;
    }
  }

  if (!ALLOWED_IMAGE_EXTS.has(ext)) {
    ext = 'png';
  }

  const buffer = Buffer.from(base64Data, 'base64');
  if (buffer.length > 15 * 1024 * 1024) {
    throw new Error('La imagen excede el límite permitido de 15 MB');
  }

  const savedFilename = `${prefix}_${Date.now()}.${ext}`;
  const filePath = path.join(uploadsDir, savedFilename);
  fs.writeFileSync(filePath, buffer);

  return `/uploads/${savedFilename}`;
}

// Subir imagen personalizada de fondo para la tabla Fullscreen
app.post('/api/fs-background', (req, res) => {
  try {
    const { imageBase64 } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Falta la imagen' });

    deleteUploadedFile(fsTheme.bgImage);
    const publicUrl = saveBase64Image(imageBase64, 'fs_bg');
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
    deleteUploadedFile(fsTheme.bgImage);
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
    if (!imageBase64) return res.status(400).json({ error: 'Falta la imagen' });

    deleteUploadedFile(tournamentLogo);
    const publicUrl = saveBase64Image(imageBase64, 'tournament_logo');
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
    deleteUploadedFile(tournamentLogo);
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
    if (!imageBase64) return res.status(400).json({ error: 'No se recibió ninguna imagen' });

    deleteUploadedFile(bigLogoUrl);
    const publicUrl = saveBase64Image(imageBase64, 'big_logo', filename);
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
    deleteUploadedFile(bigLogoUrl);
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
    const tickerH = eventVisible ? (tickerSize === 'large' ? 76 : tickerSize === 'medium' ? 60 : 46) : 0;
    const effectiveBottom = Math.max(bottomMargin, tickerH);
    const pipX = 1920 - pipW;
    const pipY = 1080 - effectiveBottom - pipH;
    result.camBTransform = {
      alignment: 5,
      positionX: pipX,
      positionY: Math.max(topMargin, pipY),
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
    const tickerH = eventVisible ? (tickerSize === 'large' ? 76 : tickerSize === 'medium' ? 60 : 46) : 0;
    const effectiveBottom = Math.max(bottomMargin, tickerH);
    const pipX = 1920 - pipW;
    const pipY = 1080 - effectiveBottom - pipH;
    result.camATransform = {
      alignment: 5,
      positionX: pipX,
      positionY: Math.max(topMargin, pipY),
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

// ── Simulador Integrado de Cámaras en Bucle (public/videos/camaras) ──
const SIM_CAMERAS_DIR = path.join(__dirname, 'public', 'videos', 'camaras');

function scanSimulatedCameras(existingCameras = []) {
  try {
    if (!fs.existsSync(SIM_CAMERAS_DIR)) return [];
    const prevMap = new Map((existingCameras || []).map(c => [c.fileName, c]));
    const files = fs.readdirSync(SIM_CAMERAS_DIR)
      .filter(f => /\.(mp4|webm|mov|mkv)$/i.test(f))
      .sort((a, b) => a.localeCompare(b, 'es'));

    return files.map((fileName, idx) => {
      const prev = prevMap.get(fileName);
      const cleanTitle = fileName
        .replace(/\.(mp4|webm|mov|mkv)$/i, '')
        .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, '')
        .replace(/\s+/g, ' ')
        .trim();
      const sceneItemId = 101 + idx;
      return {
        sceneItemId,
        camIndex: idx + 1,
        sourceName: `Cam ${idx + 1} · ${cleanTitle}`,
        shortName: `Cam ${idx + 1}`,
        title: cleanTitle,
        fileName,
        url: `/videos/camaras/${encodeURIComponent(fileName)}`,
        inputKind: 'ffmpeg_source',
        isSimulated: true,
        sceneItemEnabled: prev ? prev.sceneItemEnabled : true
      };
    });
  } catch (err) {
    console.warn('[SimCameras] Error leyendo public/videos/camaras:', err.message);
    return [];
  }
}

const DEFAULT_LAYOUT_BY_COUNT = {
  1: 'single',
  2: 'split_lr',
  3: 'main_left_2',
  4: 'grid_2x2',
  5: 'top2_bot3',
  6: 'grid_3x2'
};

const VALID_LAYOUTS_BY_COUNT = {
  1: ['single'],
  2: ['split_lr', 'split_rl', 'split_tb', 'split_bt', 'focus_1_2'],
  3: ['main_left_2', 'main_top_2', 'cols_3'],
  4: ['grid_2x2', 'main_left_3', 'main_top_3'],
  5: ['top2_bot3', 'main_left_4'],
  6: ['grid_3x2', 'top1_bot5']
};

function computeMultiCameraGeometry(busConfig = {}, cameras = [], eventVisible = false, tickerSize = 'small') {
  const camCount = Math.max(1, Math.min(6, Number(busConfig.camCount) || 2));
  let layout = busConfig.layout || DEFAULT_LAYOUT_BY_COUNT[camCount];
  const validForCount = VALID_LAYOUTS_BY_COUNT[camCount] || VALID_LAYOUTS_BY_COUNT[2];
  if (!validForCount.includes(layout)) {
    layout = DEFAULT_LAYOUT_BY_COUNT[camCount];
  }

  const bannerMode = busConfig.bannerMode || 'none';
  const topMargin = (bannerMode === 'top' || bannerMode === 'both') ? 130 : 0;
  const bottomMargin = (bannerMode === 'bottom' || bannerMode === 'both') ? 160 : 0;
  const ux = 0;
  const uy = topMargin;
  const uw = 1920;
  const uh = Math.max(240, 1080 - topMargin - bottomMargin);

  let rects = [];
  if (camCount === 1) {
    rects = [{ x: ux, y: uy, w: uw, h: uh }];
  } else if (camCount === 2) {
    if (layout === 'split_tb' || layout === 'split_bt') {
      const h1 = Math.floor(uh / 2);
      const rTop = { x: ux, y: uy, w: uw, h: h1, borderBottom: true };
      const rBot = { x: ux, y: uy + h1, w: uw, h: uh - h1 };
      rects = (layout === 'split_bt') ? [rBot, rTop] : [rTop, rBot];
    } else if (layout === 'focus_1_2') {
      const w1 = Math.round(uw * 0.67);
      rects = [
        { x: ux, y: uy, w: w1, h: uh, borderRight: true },
        { x: ux + w1, y: uy, w: uw - w1, h: uh }
      ];
    } else {
      const w1 = Math.floor(uw / 2);
      const rLeft = { x: ux, y: uy, w: w1, h: uh, borderRight: true };
      const rRight = { x: ux + w1, y: uy, w: uw - w1, h: uh };
      rects = (layout === 'split_rl') ? [rRight, rLeft] : [rLeft, rRight];
    }
  } else if (camCount === 3) {
    if (layout === 'main_top_2') {
      const hTop = Math.round(uh * 0.58);
      const hBot = uh - hTop;
      const wHalf = Math.floor(uw / 2);
      rects = [
        { x: ux, y: uy, w: uw, h: hTop, borderBottom: true },
        { x: ux, y: uy + hTop, w: wHalf, h: hBot, borderRight: true },
        { x: ux + wHalf, y: uy + hTop, w: uw - wHalf, h: hBot }
      ];
    } else if (layout === 'cols_3') {
      const wCol = Math.floor(uw / 3);
      rects = [
        { x: ux, y: uy, w: wCol, h: uh, borderRight: true },
        { x: ux + wCol, y: uy, w: wCol, h: uh, borderRight: true },
        { x: ux + wCol * 2, y: uy, w: uw - wCol * 2, h: uh }
      ];
    } else {
      const wLeft = Math.round(uw * 0.62);
      const wRight = uw - wLeft;
      const hHalf = Math.floor(uh / 2);
      rects = [
        { x: ux, y: uy, w: wLeft, h: uh, borderRight: true },
        { x: ux + wLeft, y: uy, w: wRight, h: hHalf, borderBottom: true },
        { x: ux + wLeft, y: uy + hHalf, w: wRight, h: uh - hHalf }
      ];
    }
  } else if (camCount === 4) {
    if (layout === 'main_left_3') {
      const wLeft = Math.round(uw * 0.66);
      const wRight = uw - wLeft;
      const h3 = Math.floor(uh / 3);
      rects = [
        { x: ux, y: uy, w: wLeft, h: uh, borderRight: true },
        { x: ux + wLeft, y: uy, w: wRight, h: h3, borderBottom: true },
        { x: ux + wLeft, y: uy + h3, w: wRight, h: h3, borderBottom: true },
        { x: ux + wLeft, y: uy + h3 * 2, w: wRight, h: uh - h3 * 2 }
      ];
    } else if (layout === 'main_top_3') {
      const hTop = Math.round(uh * 0.62);
      const hBot = uh - hTop;
      const w3 = Math.floor(uw / 3);
      rects = [
        { x: ux, y: uy, w: uw, h: hTop, borderBottom: true },
        { x: ux, y: uy + hTop, w: w3, h: hBot, borderRight: true },
        { x: ux + w3, y: uy + hTop, w: w3, h: hBot, borderRight: true },
        { x: ux + w3 * 2, y: uy + hTop, w: uw - w3 * 2, h: hBot }
      ];
    } else {
      const wHalf = Math.floor(uw / 2);
      const hHalf = Math.floor(uh / 2);
      rects = [
        { x: ux, y: uy, w: wHalf, h: hHalf, borderRight: true, borderBottom: true },
        { x: ux + wHalf, y: uy, w: uw - wHalf, h: hHalf, borderBottom: true },
        { x: ux, y: uy + hHalf, w: wHalf, h: uh - hHalf, borderRight: true },
        { x: ux + wHalf, y: uy + hHalf, w: uw - wHalf, h: uh - hHalf }
      ];
    }
  } else if (camCount === 5) {
    if (layout === 'main_left_4') {
      const wLeft = Math.round(uw * 0.50);
      const wRight = uw - wLeft;
      const wR2 = Math.floor(wRight / 2);
      const hHalf = Math.floor(uh / 2);
      rects = [
        { x: ux, y: uy, w: wLeft, h: uh, borderRight: true },
        { x: ux + wLeft, y: uy, w: wR2, h: hHalf, borderRight: true, borderBottom: true },
        { x: ux + wLeft + wR2, y: uy, w: wRight - wR2, h: hHalf, borderBottom: true },
        { x: ux + wLeft, y: uy + hHalf, w: wR2, h: uh - hHalf, borderRight: true },
        { x: ux + wLeft + wR2, y: uy + hHalf, w: wRight - wR2, h: uh - hHalf }
      ];
    } else {
      const hHalf = Math.floor(uh / 2);
      const w2 = Math.floor(uw / 2);
      const w3 = Math.floor(uw / 3);
      rects = [
        { x: ux, y: uy, w: w2, h: hHalf, borderRight: true, borderBottom: true },
        { x: ux + w2, y: uy, w: uw - w2, h: hHalf, borderBottom: true },
        { x: ux, y: uy + hHalf, w: w3, h: uh - hHalf, borderRight: true },
        { x: ux + w3, y: uy + hHalf, w: w3, h: uh - hHalf, borderRight: true },
        { x: ux + w3 * 2, y: uy + hHalf, w: uw - w3 * 2, h: uh - hHalf }
      ];
    }
  } else {
    if (layout === 'top1_bot5') {
      const hTop = Math.round(uh * 0.64);
      const hBot = uh - hTop;
      const w5 = Math.floor(uw / 5);
      rects = [
        { x: ux, y: uy, w: uw, h: hTop, borderBottom: true },
        { x: ux, y: uy + hTop, w: w5, h: hBot, borderRight: true },
        { x: ux + w5, y: uy + hTop, w: w5, h: hBot, borderRight: true },
        { x: ux + w5 * 2, y: uy + hTop, w: w5, h: hBot, borderRight: true },
        { x: ux + w5 * 3, y: uy + hTop, w: w5, h: hBot, borderRight: true },
        { x: ux + w5 * 4, y: uy + hTop, w: uw - w5 * 4, h: hBot }
      ];
    } else {
      const w3 = Math.floor(uw / 3);
      const hHalf = Math.floor(uh / 2);
      rects = [
        { x: ux, y: uy, w: w3, h: hHalf, borderRight: true, borderBottom: true },
        { x: ux + w3, y: uy, w: w3, h: hHalf, borderRight: true, borderBottom: true },
        { x: ux + w3 * 2, y: uy, w: uw - w3 * 2, h: hHalf, borderBottom: true },
        { x: ux, y: uy + hHalf, w: w3, h: uh - hHalf, borderRight: true },
        { x: ux + w3, y: uy + hHalf, w: w3, h: uh - hHalf, borderRight: true },
        { x: ux + w3 * 2, y: uy + hHalf, w: uw - w3 * 2, h: uh - hHalf }
      ];
    }
  }

  const rawSlots = Array.isArray(busConfig.slotIds) ? busConfig.slotIds : [];
  const slots = [];
  for (let i = 0; i < 6; i++) {
    const camId = Number(rawSlots[i]) || (cameras[i % Math.max(1, cameras.length)]?.sceneItemId) || (101 + i);
    const cam = cameras.find(c => Number(c.sceneItemId) === camId) || cameras[0] || null;
    const r = rects[i] || { x: 0, y: 0, w: 0, h: 0 };
    slots.push({
      slotIndex: i,
      camId,
      cam,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      borderRight: !!r.borderRight,
      borderBottom: !!r.borderBottom,
      visible: i < camCount && !!cam
    });
  }

  const pipEnabled = !!busConfig.pipEnabled;
  const pipCamId = Number(busConfig.pipCamId) || (cameras[3]?.sceneItemId) || (cameras[0]?.sceneItemId) || 104;
  const pipCam = cameras.find(c => Number(c.sceneItemId) === pipCamId) || cameras[0] || null;
  const pipCorner = ['br', 'bl', 'tr', 'tl'].includes(busConfig.pipCorner) ? busConfig.pipCorner : 'br';
  const pipW = 496;
  const pipH = 279;
  const tickerH = eventVisible ? (tickerSize === 'large' ? 76 : tickerSize === 'medium' ? 60 : 46) : 0;
  const effectiveBottom = Math.max(bottomMargin, tickerH);

  let pipX = 1920 - pipW;
  let pipY = 1080 - effectiveBottom - pipH;
  if (pipCorner === 'bl') {
    pipX = 0;
    pipY = 1080 - effectiveBottom - pipH;
  } else if (pipCorner === 'tr') {
    pipX = 1920 - pipW;
    pipY = topMargin;
  } else if (pipCorner === 'tl') {
    pipX = 0;
    pipY = topMargin;
  }

  const pip = {
    enabled: pipEnabled,
    camId: pipCamId,
    cam: pipCam,
    corner: pipCorner,
    x: pipX,
    y: Math.max(0, pipY),
    w: pipW,
    h: pipH,
    visible: pipEnabled && !!pipCam
  };

  return {
    camCount,
    layout,
    bannerMode,
    slotIds: slots.map(s => s.camId),
    slots,
    pipEnabled,
    pipCamId,
    pipCorner,
    pip
  };
}

let simCamerasState = {
  enabled: true,
  activeScene: 'principal',      // 'principal' | 'fullscreen' | 'transicion'
  transitionSubScene: 'starting', // 'starting' | 'lunch' | 'reconnecting' | 'ending'
  camCount: 2,
  layout: 'split_lr',
  bannerMode: 'none',
  slotIds: [101, 102, 103, 104, 105, 106],
  pipEnabled: true,
  pipCamId: 104,
  pipCorner: 'br',
  camAId: 101,
  camBId: 102,
  preview: {
    camCount: 1,
    layout: 'single',
    bannerMode: 'none',
    slotIds: [103, 101, 102, 105, 106, 104],
    pipEnabled: true,
    pipCamId: 104,
    pipCorner: 'br',
    camAId: 103,
    camBId: 101
  },
  muted: true,
  cameras: []
};

function normalizeBusState(bus, cams, defaultOffset = 0) {
  if (!bus) return;
  bus.camCount = Math.max(1, Math.min(6, Number(bus.camCount) || 2));
  const validLayouts = VALID_LAYOUTS_BY_COUNT[bus.camCount] || VALID_LAYOUTS_BY_COUNT[2];
  if (!validLayouts.includes(bus.layout)) {
    bus.layout = DEFAULT_LAYOUT_BY_COUNT[bus.camCount];
  }
  if (!Array.isArray(bus.slotIds) || bus.slotIds.length < 6) {
    const base = Array.isArray(bus.slotIds) ? bus.slotIds.slice() : [bus.camAId, bus.camBId];
    bus.slotIds = [];
    for (let i = 0; i < 6; i++) {
      const candidate = Number(base[i]);
      if (cams.some(c => c.sceneItemId === candidate)) {
        bus.slotIds.push(candidate);
      } else if (cams.length > 0) {
        bus.slotIds.push(cams[(i + defaultOffset) % cams.length].sceneItemId);
      } else {
        bus.slotIds.push(101 + i);
      }
    }
  } else if (cams.length > 0) {
    bus.slotIds = bus.slotIds.slice(0, 6).map((id, i) => {
      const numId = Number(id);
      return cams.some(c => c.sceneItemId === numId)
        ? numId
        : cams[(i + defaultOffset) % cams.length].sceneItemId;
    });
  }
  bus.camAId = bus.slotIds[0];
  bus.camBId = bus.slotIds[1] || bus.slotIds[0];
  if (bus.pipEnabled === undefined) bus.pipEnabled = false;
  if (cams.length > 0 && !cams.some(c => c.sceneItemId === Number(bus.pipCamId))) {
    const willyCam = cams.find(c => /willy/i.test(c.fileName || c.sourceName));
    bus.pipCamId = willyCam ? willyCam.sceneItemId : (cams[3] || cams[0]).sceneItemId;
  }
  if (!['br', 'bl', 'tr', 'tl'].includes(bus.pipCorner)) {
    bus.pipCorner = 'br';
  }
}

function syncSimCamerasState() {
  const cams = scanSimulatedCameras(simCamerasState.cameras);
  simCamerasState.cameras = cams;
  normalizeBusState(simCamerasState, cams, 0);
  if (!simCamerasState.preview) {
    simCamerasState.preview = {
      camCount: 1,
      layout: 'single',
      bannerMode: 'none',
      slotIds: [103, 101, 102, 105, 106, 104],
      pipEnabled: true,
      pipCamId: 104,
      pipCorner: 'br'
    };
  }
  normalizeBusState(simCamerasState.preview, cams, 2);

  if (cams.length > 0) {
    const activeSet = new Set();
    for (let i = 0; i < simCamerasState.camCount; i++) {
      activeSet.add(Number(simCamerasState.slotIds[i]));
    }
    if (simCamerasState.pipEnabled && simCamerasState.pipCamId) {
      activeSet.add(Number(simCamerasState.pipCamId));
    }
    cams.forEach(c => {
      c.sceneItemEnabled = simCamerasState.enabled && activeSet.has(c.sceneItemId);
    });
  }
  return getSimCamerasPayload();
}

function getSimCamerasPayload(extra = {}) {
  const progGeo = computeMultiCameraGeometry(
    simCamerasState,
    simCamerasState.cameras,
    !!eventVisible,
    tickerSize || 'small'
  );
  const prevGeo = computeMultiCameraGeometry(
    simCamerasState.preview || {},
    simCamerasState.cameras,
    !!eventVisible,
    tickerSize || 'small'
  );
  const transforms = calculateCameraLayout({
    layout: simCamerasState.layout,
    bannerMode: simCamerasState.bannerMode || 'none'
  });
  const camA = progGeo.slots[0]?.cam || null;
  const camB = progGeo.slots[1]?.cam || camA;
  const previewCamA = prevGeo.slots[0]?.cam || camA;
  const previewCamB = prevGeo.slots[1]?.cam || camB;
  return {
    enabled: !!simCamerasState.enabled && simCamerasState.cameras.length > 0,
    activeScene: simCamerasState.activeScene || 'principal',
    transitionSubScene: simCamerasState.transitionSubScene || (fsTheme && fsTheme.scene !== 'ranking' ? fsTheme.scene : 'starting'),
    camCount: progGeo.camCount,
    layout: progGeo.layout,
    bannerMode: progGeo.bannerMode,
    slotIds: progGeo.slotIds,
    slots: progGeo.slots,
    pipEnabled: progGeo.pipEnabled,
    pipCamId: progGeo.pipCamId,
    pipCorner: progGeo.pipCorner,
    pip: progGeo.pip,
    camAId: progGeo.slotIds[0],
    camBId: progGeo.slotIds[1],
    camA,
    camB,
    preview: {
      camCount: prevGeo.camCount,
      layout: prevGeo.layout,
      bannerMode: prevGeo.bannerMode,
      slotIds: prevGeo.slotIds,
      slots: prevGeo.slots,
      pipEnabled: prevGeo.pipEnabled,
      pipCamId: prevGeo.pipCamId,
      pipCorner: prevGeo.pipCorner,
      pip: prevGeo.pip,
      camAId: prevGeo.slotIds[0],
      camBId: prevGeo.slotIds[1],
      camA: previewCamA,
      camB: previewCamB
    },
    muted: simCamerasState.muted !== false,
    cameras: simCamerasState.cameras,
    transforms,
    ...extra
  };
}

function broadcastSimCamerasState(extra = {}) {
  const payload = getSimCamerasPayload(extra);
  broadcastToOverlays({ type: 'sim_cameras_state', state: payload });
  broadcastToPanels({ type: 'sim_cameras_state', state: payload });
  return payload;
}

syncSimCamerasState();

app.get('/api/sim-cameras', (req, res) => {
  const state = syncSimCamerasState();
  res.json({ ok: true, state });
});

function applyBusUpdates(bus, body = {}) {
  const {
    camCount,
    layout,
    bannerMode,
    slotIds,
    slotIndex,
    slotCamId,
    camAId,
    camBId,
    pipEnabled,
    pipCamId,
    pipCorner
  } = body;

  if (camCount !== undefined) {
    const newCount = Math.max(1, Math.min(6, Number(camCount) || 2));
    if (newCount !== bus.camCount) {
      bus.camCount = newCount;
      const valid = VALID_LAYOUTS_BY_COUNT[newCount] || [];
      if (!valid.includes(bus.layout)) {
        bus.layout = DEFAULT_LAYOUT_BY_COUNT[newCount];
      }
    }
  }
  if (bannerMode !== undefined) bus.bannerMode = bannerMode;
  if (Array.isArray(slotIds)) {
    for (let i = 0; i < Math.min(6, slotIds.length); i++) {
      if (slotIds[i]) bus.slotIds[i] = Number(slotIds[i]);
    }
  }
  if (slotIndex !== undefined && slotCamId !== undefined) {
    const idx = Math.max(0, Math.min(5, Number(slotIndex) || 0));
    bus.slotIds[idx] = Number(slotCamId);
  }
  if (camAId !== undefined && camAId !== '') bus.slotIds[0] = Number(camAId);
  if (camBId !== undefined && camBId !== '') bus.slotIds[1] = Number(camBId);

  if (pipEnabled !== undefined) bus.pipEnabled = !!pipEnabled;
  if (pipCamId !== undefined && pipCamId !== '') bus.pipCamId = Number(pipCamId);
  if (pipCorner !== undefined && ['br', 'bl', 'tr', 'tl'].includes(pipCorner)) bus.pipCorner = pipCorner;

  if (layout === 'swap' || layout === 'rotate') {
    const count = Math.max(2, bus.camCount || 2);
    const activeSlice = bus.slotIds.slice(0, count);
    activeSlice.push(activeSlice.shift());
    for (let i = 0; i < count; i++) {
      bus.slotIds[i] = activeSlice[i];
    }
  } else if (layout) {
    // Compatibilidad con presets clásicos
    if (layout === 'full_a') {
      bus.camCount = 1;
      bus.layout = 'single';
    } else if (layout === 'full_b') {
      bus.camCount = 1;
      bus.layout = 'single';
      bus.slotIds[0] = bus.slotIds[1];
    } else if (layout === 'pip_a_main') {
      bus.pipEnabled = !bus.pipEnabled;
    } else {
      bus.layout = layout;
    }
  }
  bus.camAId = bus.slotIds[0];
  bus.camBId = bus.slotIds[1] || bus.slotIds[0];
}

app.post('/api/sim-cameras', async (req, res) => {
  syncSimCamerasState();
  const {
    enabled,
    target,
    muted,
    action,
    inputName,
    activeScene,
    transitionSubScene
  } = req.body || {};

  if (enabled !== undefined) simCamerasState.enabled = !!enabled;
  if (muted !== undefined) simCamerasState.muted = !!muted;

  // Conmutar PreEscena ⇄ Escena Principal
  if (action === 'commute') {
    const prevCopy = JSON.parse(JSON.stringify(simCamerasState.preview));
    simCamerasState.preview = {
      camCount: simCamerasState.camCount,
      layout: simCamerasState.layout,
      bannerMode: simCamerasState.bannerMode || 'none',
      slotIds: (simCamerasState.slotIds || []).slice(),
      pipEnabled: !!simCamerasState.pipEnabled,
      pipCamId: Number(simCamerasState.pipCamId),
      pipCorner: simCamerasState.pipCorner || 'br',
      camAId: simCamerasState.camAId,
      camBId: simCamerasState.camBId
    };
    simCamerasState.camCount = prevCopy.camCount || 2;
    simCamerasState.layout = prevCopy.layout || 'split_lr';
    simCamerasState.bannerMode = prevCopy.bannerMode || 'none';
    simCamerasState.slotIds = (prevCopy.slotIds || []).slice();
    simCamerasState.pipEnabled = !!prevCopy.pipEnabled;
    simCamerasState.pipCamId = Number(prevCopy.pipCamId);
    simCamerasState.pipCorner = prevCopy.pipCorner || 'br';
    simCamerasState.camAId = Number(prevCopy.camAId);
    simCamerasState.camBId = Number(prevCopy.camBId);
    simCamerasState.activeScene = 'principal';
    simCamerasState.enabled = true;
    if (liveRankingVisible && liveRankingViewMode === 'fullscreen') {
      liveRankingVisible = false;
      broadcastToOverlays({ type: 'live_ranking_hide' });
      broadcastToPanels({
        type: 'sync_live_ranking',
        visible: false,
        data: liveRankingData,
        roundId: liveRankingRoundId,
        compId: liveRankingCompId,
        top: liveRankingTop,
        cutoff: liveRankingCutoff,
        pollInterval: liveRankingPollInterval,
        dynamicPaging: liveRankingDynamicPaging,
        autoBalance: liveRankingAutoBalance,
        pageDuration: liveRankingPageDuration,
        viewMode: liveRankingViewMode,
        fsTheme
      });
    }
    syncSimCamerasState();
    const state = broadcastSimCamerasState({ commuted: true });
    return res.json({ ok: true, commuted: true, state });
  }

  if (transitionSubScene && ['starting', 'lunch', 'reconnecting', 'ending'].includes(transitionSubScene)) {
    simCamerasState.transitionSubScene = transitionSubScene;
    fsTheme.scene = transitionSubScene;
    broadcastToOverlays({ type: 'fs_theme_updated', data: fsTheme });
  }

  // Cambiar entre las 4 escenas principales: 'principal' | 'fullscreen' | 'transicion'
  if (activeScene) {
    const prevActiveScene = simCamerasState.activeScene;
    simCamerasState.activeScene = activeScene;
    if (activeScene === 'transicion') {
      fsTheme.scene = simCamerasState.transitionSubScene || 'starting';
      broadcastToOverlays({ type: 'fs_theme_updated', data: fsTheme });
    }
    if (activeScene === 'principal') {
      simCamerasState.enabled = true;
      if (liveRankingVisible && liveRankingViewMode === 'fullscreen') {
        liveRankingVisible = false;
        broadcastToOverlays({ type: 'live_ranking_hide' });
      }
    } else if (activeScene === 'fullscreen') {
      fsTheme.scene = 'ranking';
      liveRankingViewMode = 'fullscreen';
      liveRankingVisible = true;
      if (!liveRankingData && tournamentData && Array.isArray(tournamentData.competitors) && tournamentData.competitors.length > 0) {
        liveRankingData = {
          eventId: '333',
          eventName: '3x3x3 Cube',
          roundId: '147188',
          roundName: 'Ronda 1',
          roundNumber: 1,
          totalRounds: 3,
          competitionName: tournamentData.name || 'Colombian Nationals Paipa 2026',
          ranking: tournamentData.competitors.slice(0, 16).map((c, idx) => ({
            ranking: idx + 1,
            name: c.name,
            wcaId: c.wcaId || '',
            countryIso2: (c.countryIso2 || 'co').toLowerCase(),
            displayTime: c.prAverageFormatted || c.prSingleFormatted || '15.20',
            averageFormatted: c.prAverageFormatted || '15.20',
            bestFormatted: c.prSingleFormatted || '12.00',
            solvesCompleted: 5,
            totalSolves: 5,
            attemptsDetail: [
              { displayText: c.prSingleFormatted || '12.00', formatted: c.prSingleFormatted || '12.00', isTrimmed: true },
              { displayText: '14.50', formatted: '14.50', isTrimmed: false },
              { displayText: '15.10', formatted: '15.10', isTrimmed: false },
              { displayText: '15.80', formatted: '15.80', isTrimmed: false },
              { displayText: '19.20', formatted: '19.20', isTrimmed: true }
            ]
          }))
        };
      }
      // SOLO re-emitir live_ranking_show a los overlays si la escena REALMENTE cambió a fullscreen desde otra escena
      if (prevActiveScene !== 'fullscreen') {
        broadcastToOverlays({ type: 'fs_theme_updated', data: fsTheme });
        if (liveRankingData) {
          broadcastToOverlays({
            type: 'live_ranking_show',
            data: liveRankingData,
            dynamicPaging: liveRankingDynamicPaging,
            autoBalance: liveRankingAutoBalance,
            pageSize: liveRankingPageSize || 10,
            pageDuration: liveRankingPageDuration,
            viewMode: 'fullscreen'
          });
        }
      }
    }

    // MODO MASTER DIGITAL (/envivo): OBS Studio permanece 100% fijo e inalterado en su escena única.
    // Toda la conmutación entre Escena Principal, PreEscena, FullScreen y Transiciones se realiza
    // limpiamente dentro de la señal web /envivo sin alterar la escena activa en OBS.
    if (activeScene === 'transicion') {
      const sub = simCamerasState.transitionSubScene || 'starting';
      fsTheme.scene = sub;
      broadcastToOverlays({ type: 'fs_theme_updated', data: fsTheme });
    }
    broadcastToPanels({
      type: 'sync_live_ranking',
      visible: liveRankingVisible,
      data: liveRankingData,
      roundId: liveRankingRoundId,
      compId: liveRankingCompId,
      top: liveRankingTop,
      cutoff: liveRankingCutoff,
      pollInterval: liveRankingPollInterval,
      dynamicPaging: liveRankingDynamicPaging,
      autoBalance: liveRankingAutoBalance,
      pageDuration: liveRankingPageDuration,
      viewMode: liveRankingViewMode,
      fsTheme
    });
  }

  const bus = (target === 'preview') ? simCamerasState.preview : simCamerasState;
  applyBusUpdates(bus, req.body || {});

  syncSimCamerasState();
  const state = broadcastSimCamerasState((action && action !== 'commute') ? { mediaAction: { action, inputName, ts: Date.now() } } : {});
  res.json({ ok: true, state });
});

app.post('/api/obs/apply-layout', async (req, res) => {
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

  // Si OBS no está conectado o se están operando cámaras simuladas (IDs >= 101), aplicar sobre el simulador en bucle (PreEscena o Principal)
  if (!obsConnected || Number(camAId) >= 101 || Number(camBId) >= 101 || req.body?.camCount !== undefined || req.body?.pipEnabled !== undefined || req.body?.slotIds !== undefined) {
    syncSimCamerasState();
    simCamerasState.enabled = true;
    const isPreviewTarget = (target === 'preview');
    const bus = isPreviewTarget ? simCamerasState.preview : simCamerasState;
    applyBusUpdates(bus, req.body || {});
    syncSimCamerasState();
    const state = broadcastSimCamerasState();
    return res.json({
      ok: true,
      simulated: true,
      target: isPreviewTarget ? 'preview' : 'program',
      layout: bus.layout,
      bannerMode: bus.bannerMode,
      state
    });
  }

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

let isLiveRankingPollingInFlight = false;

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
    if (!liveRankingRoundId || isLiveRankingPollingInFlight) return;
    isLiveRankingPollingInFlight = true;
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
    } finally {
      isLiveRankingPollingInFlight = false;
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

    // Enviar logo persistente del torneo y tamaño del ticker
    socket.send(JSON.stringify({
      type: 'ticker_size_updated',
      size: tickerSize
    }));
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

    socket.send(JSON.stringify({
      type: 'head_to_head_size',
      size: headToHeadSize
    }));

    // Si Head to Head está activo, enviarlo al overlay
    if (headToHeadVisible && headToHeadData) {
      socket.send(JSON.stringify({
        type: 'show_head_to_head',
        data: headToHeadData,
        size: headToHeadSize
      }));
    }

    // Si Versus Banner está activo, enviarlo al overlay
    if (versusBannerVisible && versusData) {
      socket.send(JSON.stringify({
        type: 'versus_banner_data',
        visible: true,
        data: versusData
      }));
    }

    // Enviar estado actual de cámaras simuladas (public/videos/camaras)
    socket.send(JSON.stringify({
      type: 'sim_cameras_state',
      state: syncSimCamerasState()
    }));
  }

  function initPanel(socket) {
    console.log(`[WS] Panel de operador conectado (Total: ${panelClients.size})`);
    const simState = syncSimCamerasState();
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
      tickerSize,
      bigLogoVisible,
      bigLogoUrl: bigLogoUrl || tournamentLogo,
      bigLogoSize,
      headToHeadVisible,
      headToHeadSize,
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
      versusBannerVisible,
      versusRoundId,
      versusCompId,
      versusPollInterval,
      versusComp1Target,
      versusComp2Target,
      versusData,
      fsTheme,
      overlayCount: overlayClients.size,
      obsStatus,
      simCamerasState: simState
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
        saveLiveState();
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
          if (msg.data.ticker_size && ['small', 'medium', 'large'].includes(msg.data.ticker_size)) {
            tickerSize = msg.data.ticker_size;
            saveLiveState();
          } else {
            msg.data.ticker_size = tickerSize;
          }
          currentEvent = Object.assign({}, currentEvent || {}, msg.data);
        }
        eventVisible = true;
        broadcastToOverlays(msg);
        broadcastToOverlays({
          type: 'banner_event',
          event: currentEvent
        });
        broadcastToPanels({ type: 'sync_state', currentEvent, eventVisible, tickerSize });
        broadcastSimCamerasState();
        break;

      case 'set_ticker_size':
        if (msg.size && ['small', 'medium', 'large'].includes(msg.size)) {
          tickerSize = msg.size;
          if (currentEvent) currentEvent.ticker_size = tickerSize;
          saveLiveState();
          broadcastToOverlays({
            type: 'ticker_size_updated',
            size: tickerSize
          });
          broadcastToPanels({
            type: 'ticker_size_updated',
            size: tickerSize
          });
          broadcastSimCamerasState();
        }
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
        broadcastSimCamerasState();
        break;

      case 'hide_all':
        competitorVisible = false;
        eventVisible = false;
        liveRankingVisible = false;
        showcaseVisible = false;
        bigLogoVisible = false;
        headToHeadVisible = false;
        versusBannerVisible = false;
        saveLiveState();
        stopLiveRankingPolling();
        stopVersusPolling();
        broadcastToOverlays({ type: 'hide_competitor' });
        broadcastToOverlays({ type: 'hide_banner' });
        broadcastToOverlays({ type: 'hide_event' });
        broadcastSimCamerasState();
        broadcastToOverlays({ type: 'live_ranking_hide' });
        broadcastToOverlays({ type: 'hide_competitor_showcase' });
        broadcastToOverlays({ type: 'hide_big_logo' });
        broadcastToOverlays({ type: 'hide_head_to_head' });
        broadcastToOverlays({ type: 'hide_versus_banner' });
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
        broadcastToPanels({
          type: 'sync_versus_banner',
          visible: false,
          data: versusData,
          roundId: versusRoundId,
          compId: versusCompId,
          pollInterval: versusPollInterval,
          comp1Target: versusComp1Target,
          comp2Target: versusComp2Target
        });
        break;

      case 'show_competitor_showcase':
        if (msg.competitor) {
          showcaseCompetitor = msg.competitor;
          enrichCompetitorWithAvatar(showcaseCompetitor);
        }
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
        if (msg.size !== undefined) {
          const s = parseInt(msg.size, 10);
          if (!isNaN(s) && s >= 600 && s <= 1800) headToHeadSize = s;
        }
        if (msg.data) {
          headToHeadData = Object.assign(headToHeadData || {}, msg.data);
          if (headToHeadData.competitor1) enrichCompetitorWithAvatar(headToHeadData.competitor1);
          if (headToHeadData.competitor2) enrichCompetitorWithAvatar(headToHeadData.competitor2);
        }
        saveLiveState();
        broadcastToOverlays({
          type: 'show_head_to_head',
          data: headToHeadData,
          size: headToHeadSize
        });
        broadcastToPanels({
          type: 'sync_state',
          headToHeadVisible: true,
          headToHeadData: headToHeadData,
          headToHeadSize: headToHeadSize
        });
        break;

      case 'set_head_to_head_size':
        if (msg.size !== undefined) {
          const s = parseInt(msg.size, 10);
          if (!isNaN(s) && s >= 600 && s <= 1800) {
            headToHeadSize = s;
            saveLiveState();
            broadcastToOverlays({
              type: 'head_to_head_size',
              size: headToHeadSize
            });
            broadcastToPanels({
              type: 'sync_state',
              headToHeadSize: headToHeadSize
            });
          }
        }
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
        stopFinalsDemo();
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

      case 'demo_start_finals':
        runFinalsSimulation();
        break;

      case 'demo_stop_finals':
        stopFinalsDemo();
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

      case 'show_versus_banner':
        versusBannerVisible = true;
        if (msg.roundId) versusRoundId = msg.roundId;
        if (msg.compId) versusCompId = msg.compId;
        if (msg.comp1Target !== undefined) versusComp1Target = msg.comp1Target;
        if (msg.comp2Target !== undefined) versusComp2Target = msg.comp2Target;
        if (msg.pollInterval !== undefined) versusPollInterval = Math.max(1, parseInt(msg.pollInterval, 10) || 2);
        saveLiveState();
        startVersusPolling(versusPollInterval);
        break;

      case 'hide_versus_banner':
        versusBannerVisible = false;
        stopVersusPolling();
        saveLiveState();
        broadcastToOverlays({ type: 'hide_versus_banner' });
        broadcastToPanels({
          type: 'sync_versus_banner',
          visible: false,
          data: versusData,
          roundId: versusRoundId,
          compId: versusCompId,
          pollInterval: versusPollInterval,
          comp1Target: versusComp1Target,
          comp2Target: versusComp2Target
        });
        break;

      case 'set_versus_config':
        if (msg.roundId !== undefined) versusRoundId = msg.roundId;
        if (msg.compId !== undefined) versusCompId = msg.compId;
        if (msg.comp1Target !== undefined) versusComp1Target = msg.comp1Target;
        if (msg.comp2Target !== undefined) versusComp2Target = msg.comp2Target;
        if (msg.pollInterval !== undefined) {
          versusPollInterval = Math.max(1, parseInt(msg.pollInterval, 10) || 2);
          if (versusBannerVisible) startVersusPolling(versusPollInterval);
        }
        saveLiveState();
        refreshVersusData();
        break;

      case 'versus_refresh':
        refreshVersusData();
        break;

      case 'set_fs_theme':
        if (msg.data) {
          if (msg.data.bgColor !== undefined) fsTheme.bgColor = msg.data.bgColor;
          if (msg.data.bgImage !== undefined) fsTheme.bgImage = msg.data.bgImage;
          if (msg.data.opacity !== undefined) fsTheme.opacity = parseInt(msg.data.opacity, 10);
          if (msg.data.blur !== undefined) fsTheme.blur = parseInt(msg.data.blur, 10);
          if (msg.data.gradientLevel !== undefined) fsTheme.gradientLevel = Math.max(0, Math.min(100, parseInt(msg.data.gradientLevel, 10) || 0));
          if (msg.data.patternSize !== undefined) fsTheme.patternSize = Math.max(40, Math.min(260, parseInt(msg.data.patternSize, 10) || 80));
          if (msg.data.colorCycle !== undefined) fsTheme.colorCycle = !!msg.data.colorCycle;
          if (msg.data.colombiaCycle !== undefined) fsTheme.colombiaCycle = !!msg.data.colombiaCycle;
          if (msg.data.animation !== undefined) fsTheme.animation = msg.data.animation;
          if (msg.data.animSpeed !== undefined) fsTheme.animSpeed = msg.data.animSpeed;
          if (msg.data.scene !== undefined) {
            const validScenes = ['ranking', 'starting', 'lunch', 'reconnecting', 'ending'];
            fsTheme.scene = validScenes.includes(msg.data.scene) ? msg.data.scene : 'ranking';
          }
          if (msg.data.startingCustomTitle !== undefined) fsTheme.startingCustomTitle = String(msg.data.startingCustomTitle || '');
          if (msg.data.startingDay !== undefined) fsTheme.startingDay = String(msg.data.startingDay || 'Día 1');
          if (msg.data.startingText !== undefined) fsTheme.startingText = String(msg.data.startingText || 'Iniciando en unos minutos');
          if (msg.data.startingMode !== undefined) fsTheme.startingMode = msg.data.startingMode;
          if (msg.data.lunchText !== undefined) fsTheme.lunchText = String(msg.data.lunchText || 'Hora de almuerzo');
          if (msg.data.reconnectingText !== undefined) fsTheme.reconnectingText = String(msg.data.reconnectingText || 'Reconectando');
          if (msg.data.endingText !== undefined) fsTheme.endingText = String(msg.data.endingText || 'Gracias por vernos');
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
        if (Number(msg.sceneItemId) >= 101 || !obsConnected) {
          syncSimCamerasState();
          const itemId = Number(msg.sceneItemId);
          if (msg.enabled) {
            simCamerasState.enabled = true;
            if (itemId !== Number(simCamerasState.camAId) && itemId !== Number(simCamerasState.camBId)) {
              simCamerasState.camAId = itemId;
            }
            if (simCamerasState.layout === 'full_b' && itemId === Number(simCamerasState.camAId)) {
              simCamerasState.layout = 'full_a';
            } else if (simCamerasState.layout === 'full_a' && itemId === Number(simCamerasState.camBId)) {
              simCamerasState.layout = 'full_b';
            }
          } else {
            if (simCamerasState.layout === 'full_a' && itemId === Number(simCamerasState.camAId)) {
              simCamerasState.enabled = false;
            } else if (simCamerasState.layout === 'full_b' && itemId === Number(simCamerasState.camBId)) {
              simCamerasState.enabled = false;
            } else if (itemId === Number(simCamerasState.camAId)) {
              simCamerasState.layout = 'full_b';
            } else if (itemId === Number(simCamerasState.camBId)) {
              simCamerasState.layout = 'full_a';
            }
          }
          syncSimCamerasState();
          broadcastSimCamerasState();
        } else if (obsConnected && msg.sceneItemId !== undefined) {
          obs.call('SetSceneItemEnabled', {
            sceneName: msg.sceneName || obsStatus.currentProgramScene,
            sceneItemId: Number(msg.sceneItemId),
            sceneItemEnabled: !!msg.enabled
          }).catch(err => console.error('[OBS Toggle Item Error]', err.message));
        }
        break;

      case 'obs_set_item_transform_preset':
        if (Number(msg.sceneItemId) >= 101 || !obsConnected) {
          syncSimCamerasState();
          const itemId = Number(msg.sceneItemId);
          simCamerasState.enabled = true;
          if (msg.preset === 'fullscreen') {
            simCamerasState.camAId = itemId;
            simCamerasState.layout = 'full_a';
          } else if (msg.preset === 'split_left') {
            simCamerasState.camAId = itemId;
            simCamerasState.layout = 'split_lr';
          } else if (msg.preset === 'split_right') {
            simCamerasState.camBId = itemId;
            simCamerasState.layout = 'split_lr';
          } else if (msg.preset === 'pip_br' || msg.preset === 'pip_tr') {
            simCamerasState.camBId = itemId;
            simCamerasState.layout = 'pip_a_main';
          } else {
            simCamerasState.camAId = itemId;
            simCamerasState.layout = 'full_a';
          }
          syncSimCamerasState();
          broadcastSimCamerasState();
        } else if (obsConnected && msg.sceneItemId !== undefined && msg.preset) {
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
        if (!obsConnected || (msg.inputName && msg.inputName.startsWith('Cam '))) {
          broadcastSimCamerasState({
            mediaAction: {
              inputName: msg.inputName,
              action: msg.action || 'restart',
              ts: Date.now()
            }
          });
        } else if (obsConnected && msg.inputName) {
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

      case 'sim_cameras_update':
        syncSimCamerasState();
        if (msg.enabled !== undefined) simCamerasState.enabled = !!msg.enabled;
        if (msg.layout === 'swap') {
          const tmp = simCamerasState.camAId;
          simCamerasState.camAId = simCamerasState.camBId;
          simCamerasState.camBId = tmp;
        } else if (msg.layout) {
          simCamerasState.layout = msg.layout;
        }
        if (msg.bannerMode !== undefined) simCamerasState.bannerMode = msg.bannerMode;
        if (msg.camAId !== undefined) simCamerasState.camAId = Number(msg.camAId);
        if (msg.camBId !== undefined) simCamerasState.camBId = Number(msg.camBId);
        if (msg.muted !== undefined) simCamerasState.muted = !!msg.muted;
        syncSimCamerasState();
        broadcastSimCamerasState();
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
  console.log(`▸ Señal En Vivo (OBS Master): http://localhost:${PORT}/envivo`);
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
