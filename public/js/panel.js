/**
 * DirectoOBS - Lógica del Panel de Control (Operate Mode)
 * Sincronización WebSocket bidireccional con Node.js, OBS Studio y la API WCA.
 */

// ── Estado Global ──
let ws = null;
let reconnectTimer = null;

let tournamentData = null;
let currentEvent = null;
let currentCompetitor = null;   // Mesa 1
let currentCompetitor2 = null;  // Mesa 2
let bannerMode = 'single';      // 'single' | 'dual'
let bannerPosition = 'top';     // 'top' | 'bottom'
let bannerAlign = 'center';     // siempre 'center' por defecto
let bannerFont = 'barlow_slim'; // 'barlow_slim' | 'barlow_bold' | 'inter' | 'roboto'
let selectedEventId = '333';
let currentRound = 1;
let totalRounds = 3;

let competitorVisible = false;
let eventVisible = false;
let showcaseCompetitor = null;
let showcaseVisible = false;
let bigLogoVisible = false;
let bigLogoUrl = null;
let bigLogoSize = 760;
let headToHeadVisible = false;
let headToHeadSize = 1150;
let h2hComp1 = null;
let h2hComp2 = null;
let h2hEventId = '333';
let h2hPodiums1 = { gold: 0, silver: 0, bronze: 0 };
let h2hPodiums2 = { gold: 0, silver: 0, bronze: 0 };

// ── Estado del Ticker de Noticias Broadcast (Lower-Third) ──
let tickerTournamentLogo = localStorage.getItem('directoobs_ticker_logo') || '';
let tickerSize = localStorage.getItem('directoobs_ticker_size') || 'small';
let tickerDay = localStorage.getItem('directoobs_ticker_day') || '';
let tickerVenue = localStorage.getItem('directoobs_ticker_venue') || '';
let tickerNews = localStorage.getItem('directoobs_ticker_news') || '';
let tickerNewsList = [];
try {
  const savedNews = localStorage.getItem('directoobs_ticker_news_list');
  if (savedNews) tickerNewsList = JSON.parse(savedNews);
} catch (e) {
  tickerNewsList = [];
}
if (!tickerNewsList || !Array.isArray(tickerNewsList) || tickerNewsList.length === 0) {
  tickerNewsList = ['Sigue los resultados en directo por WCA Live'];
}

// ── Estado de Ranking en Vivo (WCA Live) ──
let liveRankingData = null;
let liveRankingVisible = false;
let liveRankingCompId = '';
let liveRankingRounds = [];
let liveRankingSelectedRoundId = '';
let liveRankingTop = 16;
let liveRankingCutoff = 0;
let liveRankingPollInterval = 15;
let liveRankingDynamicPaging = true;
let liveRankingAutoBalance = true;
let liveRankingPageDuration = 10;

// ── Estado del Banner de Finales Versus (WCA Live) ──
let versusBannerVisible = false;
let versusRoundId = null;
let versusCompId = null;
let versusComp1Target = null;
let versusComp2Target = null;
let versusPollInterval = 2;
let versusData = null;
let isVersusMockActive = false;
let versusMockPreset = 'epic';
let versusMockStep = 5;

let obsStatus = {
  connected: false,
  currentProgramScene: null,
  scenes: [],
  isStreaming: false,
  isRecording: false
};

let simCamerasState = {
  enabled: true,
  layout: 'split_lr',
  bannerMode: 'none',
  camAId: 101,
  camBId: 102,
  cameras: [],
  transforms: null
};

const EVENT_NAMES = {
  '333': '3x3', '222': '2x2', '444': '4x4', '555': '5x5',
  '666': '6x6', '777': '7x7', '333bf': '3x3 BLD',
  '333fm': 'Fewest Moves', '333oh': '3x3 OH', 'clock': 'Clock',
  'minx': 'Megaminx', 'pyram': 'Pyraminx', 'skewb': 'Skewb',
  'sq1': 'Square-1', '444bf': '4x4 BLD', '555bf': '5x5 BLD',
  '333mbf': 'Multi-Blind'
};

function getCleanEventName(eventId, fallbackName = '') {
  if (eventId && EVENT_NAMES[eventId]) return EVENT_NAMES[eventId];
  const name = fallbackName || eventId || '';
  return name.replace(/(\d+)x\1x\1(\s*Cube)?/gi, '$1x$1');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ── Inicialización ──
document.addEventListener('DOMContentLoaded', () => {
  const savedComp = localStorage.getItem('directoobs_live_comp_id');
  if (savedComp) {
    const input = document.getElementById('live-comp-id-input');
    if (input) input.value = savedComp;
    liveRankingCompId = savedComp;
  }
  const savedTourneyComp = localStorage.getItem('directoobs_tournament_comp_id');
  if (savedTourneyComp) {
    const wcaInput = document.getElementById('wca-comp-id-input');
    if (wcaInput && !wcaInput.value) wcaInput.value = savedTourneyComp;
  }
  setBannerMode('single', false);
  const savedMenu = localStorage.getItem('directoobs_active_menu') || 'banners';
  switchMainMenu(savedMenu);
  connectWebSocket();
  setupEventListeners();
  setupKeyboardShortcuts();
  initTickerUI();
  updateFsThemeUI();
  fetch('/api/sim-cameras')
    .then(r => r.json())
    .then(st => {
      if (st && st.ok) {
        const s = st.state || st;
        simCamerasState = s;
        updateSimCamerasUI(s);
      }
    })
    .catch(() => {});
});

// ── Conexión WebSocket ──
function connectWebSocket() {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${proto}//${window.location.host}/ws?role=panel`;

  try {
    ws = new WebSocket(wsUrl);

    ws.onopen = () => {
      clearTimeout(reconnectTimer);
      updateWsIndicator(true);
      showToast('Conectado al servidor DirectoOBS', 'success');
    };

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        handleServerMessage(msg);
      } catch (err) {
        console.error('Error parseando mensaje:', err);
      }
    };

    ws.onclose = () => {
      updateWsIndicator(false);
      reconnectTimer = setTimeout(connectWebSocket, 2000);
    };

    ws.onerror = () => {
      ws.close();
    };
  } catch {
    reconnectTimer = setTimeout(connectWebSocket, 2000);
  }
}

function sendWS(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  showToast('Servidor desconectado. Reintentando...', 'error');
  return false;
}

// ── Manejo de Mensajes del Servidor ──
function handleServerMessage(msg) {
  switch (msg.type) {
    case 'init_state':
      if (msg.tournamentData) {
        loadTournament(msg.tournamentData);
      } else {
        loadTournament(null);
      }
      if (msg.simCamerasState) {
        simCamerasState = msg.simCamerasState;
      }
      if (msg.obsStatus) updateOBSUI(msg.obsStatus);
      if (!obsStatus.connected && simCamerasState && simCamerasState.cameras && simCamerasState.cameras.length > 0) {
        updateSimCamerasUI(simCamerasState);
      }
      updateOverlayCount(msg.overlayCount || 0);

      if (msg.bannerMode) setBannerMode(msg.bannerMode, false);
      if (msg.bannerPosition) setBannerPosition(msg.bannerPosition, false);
      if (msg.bannerAlign) setBannerAlign(msg.bannerAlign, false);
      if (msg.bannerFont) setBannerFont(msg.bannerFont, false);

      if (msg.currentEvent) {
        currentEvent = msg.currentEvent;
        selectedEventId = msg.currentEvent.event_id;
        currentRound = msg.currentEvent.round_number || 1;
        updateEventUI();
      }
      if (msg.currentCompetitor) {
        currentCompetitor = msg.currentCompetitor;
      }
      if (msg.currentCompetitor2) {
        currentCompetitor2 = msg.currentCompetitor2;
      }
      if (msg.showcaseCompetitor !== undefined) {
        showcaseCompetitor = msg.showcaseCompetitor;
      }
      if (msg.showcaseVisible !== undefined) {
        showcaseVisible = !!msg.showcaseVisible;
      }
      if (msg.bigLogoVisible !== undefined) {
        bigLogoVisible = !!msg.bigLogoVisible;
      }
      if (msg.bigLogoUrl !== undefined) {
        bigLogoUrl = msg.bigLogoUrl;
      }
      if (msg.bigLogoSize !== undefined) {
        bigLogoSize = parseInt(msg.bigLogoSize, 10) || 760;
      }
      if (msg.tournamentLogo !== undefined) {
        if (msg.tournamentLogo) {
          tickerTournamentLogo = msg.tournamentLogo;
          try { localStorage.setItem('directoobs_ticker_logo', tickerTournamentLogo); } catch(e){}
        }
        updateTickerLogoPreview();
      }
      if (msg.tickerSize) {
        setTickerSize(msg.tickerSize, false);
      }
      if (msg.headToHeadVisible !== undefined) {
        headToHeadVisible = !!msg.headToHeadVisible;
      }
      if (msg.headToHeadSize !== undefined) {
        headToHeadSize = parseInt(msg.headToHeadSize, 10) || 1150;
      }
      if (msg.headToHeadData) {
        if (msg.headToHeadData.competitor1) h2hComp1 = msg.headToHeadData.competitor1;
        if (msg.headToHeadData.competitor2) h2hComp2 = msg.headToHeadData.competitor2;
        if (msg.headToHeadData.event && msg.headToHeadData.event.event_id) h2hEventId = msg.headToHeadData.event.event_id;
        if (msg.headToHeadData.podiums1) h2hPodiums1 = Object.assign({}, msg.headToHeadData.podiums1);
        if (msg.headToHeadData.podiums2) h2hPodiums2 = Object.assign({}, msg.headToHeadData.podiums2);
      }
      updatePreviewUI();
      updateShowcaseUI();
      updateBigLogoUI();
      updateHeadToHeadUI();
      updateVisibilityStates(msg.competitorVisible, msg.eventVisible);

      if (msg.liveRankingVisible !== undefined) liveRankingVisible = !!msg.liveRankingVisible;
      if (msg.liveRankingRoundId) liveRankingSelectedRoundId = msg.liveRankingRoundId;
      if (msg.liveRankingCompId) liveRankingCompId = msg.liveRankingCompId;
      if (msg.liveRankingTop) liveRankingTop = msg.liveRankingTop;
      if (msg.liveRankingCutoff !== undefined) liveRankingCutoff = msg.liveRankingCutoff;
      if (msg.liveRankingPollInterval !== undefined) liveRankingPollInterval = msg.liveRankingPollInterval;
      if (msg.liveRankingDynamicPaging !== undefined) liveRankingDynamicPaging = !!msg.liveRankingDynamicPaging;
      if (msg.liveRankingAutoBalance !== undefined) liveRankingAutoBalance = !!msg.liveRankingAutoBalance;
      if (msg.liveRankingPageDuration) liveRankingPageDuration = msg.liveRankingPageDuration;
      if (msg.liveRankingViewMode) liveRankingViewMode = msg.liveRankingViewMode;
      updateViewModeButtons();

      if (msg.fsTheme) {
        currentFsTheme = Object.assign({}, currentFsTheme, msg.fsTheme);
        updateFsThemeUI();
      }

      // Recuperar competencia y ronda seleccionada (prioridad: servidor -> localStorage)
      const targetCompId = liveRankingCompId || localStorage.getItem('directoobs_live_comp_id');
      const targetRoundId = liveRankingSelectedRoundId || localStorage.getItem('directoobs_live_round_id');

      if (targetCompId) {
        liveRankingCompId = targetCompId;
        const compInput = document.getElementById('live-comp-id-input');
        if (compInput) compInput.value = targetCompId;
      }
      if (targetRoundId) {
        liveRankingSelectedRoundId = targetRoundId;
      }

      // Si el servidor nos envió las rondas pre-cargadas en init_state:
      if (msg.liveRankingRounds && msg.liveRankingRounds.length > 0) {
        liveRankingRounds = msg.liveRankingRounds;
        populateLiveRoundSelect(targetRoundId);
      } else if (targetCompId && (!liveRankingRounds || liveRankingRounds.length === 0)) {
        // Si no vienen en el mensaje, cargarlas silenciosamente
        loadLiveCompetitionRounds(targetRoundId, true);
      }

      if (msg.isLiveRankingMockActive !== undefined) isRankingMockActive = !!msg.isLiveRankingMockActive;
      if (msg.liveRankingMockPreset) rankingMockPreset = msg.liveRankingMockPreset;
      if (msg.liveRankingData) {
        liveRankingData = msg.liveRankingData;
        renderLiveRankingPreview(liveRankingData);
      } else if (targetRoundId && !isRankingMockActive) {
        fetchLiveRoundRanking(targetRoundId, false);
      }
      updateLiveRankingUI();
      updateRankingMockUI();

      // Hidratar estado de Banner Versus
      if (msg.versusBannerVisible !== undefined) versusBannerVisible = !!msg.versusBannerVisible;
      if (msg.versusRoundId) versusRoundId = msg.versusRoundId;
      if (msg.versusCompId) versusCompId = msg.versusCompId;
      if (msg.versusPollInterval !== undefined) versusPollInterval = msg.versusPollInterval;
      if (msg.versusComp1Target !== undefined) versusComp1Target = msg.versusComp1Target;
      if (msg.versusComp2Target !== undefined) versusComp2Target = msg.versusComp2Target;
      if (msg.versusData) {
        versusData = msg.versusData;
        renderVersusPanelPreview(versusData);
      }
      populateVersusRoundSelect(versusRoundId);
      updateVersusUI();
      break;

    case 'obs_status':
      updateOBSUI(msg.status);
      if (msg.status && msg.status.currentSceneItems) {
        renderSceneSources(msg.status.currentSceneItems, msg.status.currentProgramScene);
      }
      break;

    case 'obs_scene_changed':
      obsStatus.currentProgramScene = msg.sceneName;
      highlightProgramScene(msg.sceneName);
      if (msg.sceneItems) {
        renderSceneSources(msg.sceneItems, msg.sceneName);
      }
      if (obsStatus.studioMode) {
        refreshStudioScreenshots(false);
      }
      break;

    case 'obs_studio_mode_changed':
      obsStatus.studioMode = !!msg.enabled;
      updateStudioModeUI();
      break;

    case 'obs_preview_changed':
      obsStatus.currentPreviewScene = msg.sceneName;
      updateStudioPreviewUI(msg.sceneName);
      if (obsStatus.studioMode) {
        refreshStudioScreenshots(false);
      }
      break;

    case 'obs_item_state_changed':
      updateItemVisibilityUI(msg.sceneItemId, msg.sceneItemEnabled);
      break;

    case 'obs_items_updated':
      renderSceneSources(msg.sceneItems, msg.sceneName);
      break;

    case 'obs_stream_changed':
      obsStatus.isStreaming = msg.active;
      updateStreamButton(msg.active);
      break;

    case 'obs_record_changed':
      obsStatus.isRecording = msg.active;
      updateRecordButton(msg.active);
      break;

    case 'sim_cameras_state':
      if (msg.state) {
        simCamerasState = msg.state;
        updateSimCamerasUI(simCamerasState);
      }
      break;

    case 'client_count':
      updateOverlayCount(msg.count);
      break;

    case 'tournament_updated':
      loadTournament(msg.data);
      showToast(`Torneo actualizado: ${msg.data.name}`, 'success');
      break;

    case 'tournament_cleared':
      tournamentData = null;
      currentCompetitor = null;
      currentCompetitor2 = null;
      currentEvent = null;
      competitorVisible = false;
      eventVisible = false;
      loadTournament(null);
      updatePreviewUI();
      showToast('Datos del torneo reiniciados', 'info');
      break;

    case 'wca_progress':
      updateWCAProgress(msg.progress, msg.message, msg.status);
      break;

    case 'sync_state':
      if (msg.bannerMode !== undefined) setBannerMode(msg.bannerMode, false);
      if (msg.bannerPosition !== undefined) setBannerPosition(msg.bannerPosition, false);
      if (msg.bannerAlign !== undefined) setBannerAlign(msg.bannerAlign, false);
      if (msg.bannerFont !== undefined) setBannerFont(msg.bannerFont, false);
      if (msg.tickerSize !== undefined) setTickerSize(msg.tickerSize, false);

      if (msg.currentCompetitor !== undefined) {
        currentCompetitor = msg.currentCompetitor;
      }
      if (msg.currentCompetitor2 !== undefined) {
        currentCompetitor2 = msg.currentCompetitor2;
      }
      if (msg.currentEvent !== undefined) {
        currentEvent = msg.currentEvent;
        selectedEventId = currentEvent.event_id;
        currentRound = currentEvent.round_number;
        updateEventUI();
      }
      if (msg.showcaseCompetitor !== undefined) {
        showcaseCompetitor = msg.showcaseCompetitor;
      }
      if (msg.showcaseVisible !== undefined) {
        showcaseVisible = !!msg.showcaseVisible;
      }
      if (msg.bigLogoVisible !== undefined) {
        bigLogoVisible = !!msg.bigLogoVisible;
      }
      if (msg.bigLogoUrl !== undefined) {
        bigLogoUrl = msg.bigLogoUrl;
      }
      if (msg.bigLogoSize !== undefined) {
        bigLogoSize = parseInt(msg.bigLogoSize, 10) || 760;
      }
      if (msg.headToHeadVisible !== undefined) {
        headToHeadVisible = !!msg.headToHeadVisible;
      }
      if (msg.headToHeadSize !== undefined) {
        headToHeadSize = parseInt(msg.headToHeadSize, 10) || 1150;
      }
      if (msg.headToHeadData) {
        if (msg.headToHeadData.competitor1 !== undefined) h2hComp1 = msg.headToHeadData.competitor1;
        if (msg.headToHeadData.competitor2 !== undefined) h2hComp2 = msg.headToHeadData.competitor2;
        if (msg.headToHeadData.event && msg.headToHeadData.event.event_id) h2hEventId = msg.headToHeadData.event.event_id;
        if (msg.headToHeadData.podiums1) h2hPodiums1 = Object.assign({}, msg.headToHeadData.podiums1);
        if (msg.headToHeadData.podiums2) h2hPodiums2 = Object.assign({}, msg.headToHeadData.podiums2);
      }
      updatePreviewUI();
      updateShowcaseUI();
      updateBigLogoUI();
      updateHeadToHeadUI();
      if (msg.competitorVisible !== undefined || msg.eventVisible !== undefined) {
        updateVisibilityStates(msg.competitorVisible, msg.eventVisible);
      }
      break;

    case 'tournament_logo_updated':
      tickerTournamentLogo = msg.logo || '';
      if (msg.logo) {
        try { localStorage.setItem('directoobs_ticker_logo', msg.logo); } catch(e){}
      } else {
        localStorage.removeItem('directoobs_ticker_logo');
      }
      updateTickerLogoPreview();
      updateBigLogoUI();
      break;

    case 'big_logo_updated':
      bigLogoUrl = msg.url || null;
      updateBigLogoUI();
      break;

    case 'sync_live_ranking':
      liveRankingVisible = !!msg.visible;
      if (msg.isMock !== undefined) isRankingMockActive = !!msg.isMock;
      if (msg.mockPreset) rankingMockPreset = msg.mockPreset;
      if (msg.data) {
        liveRankingData = msg.data;
        renderLiveRankingPreview(liveRankingData);
      }
      if (msg.roundId) liveRankingSelectedRoundId = msg.roundId;
      if (msg.compId) liveRankingCompId = msg.compId;
      if (msg.top) liveRankingTop = msg.top;
      if (msg.cutoff !== undefined) liveRankingCutoff = msg.cutoff;
      if (msg.dynamicPaging !== undefined) liveRankingDynamicPaging = !!msg.dynamicPaging;
      if (msg.autoBalance !== undefined) liveRankingAutoBalance = !!msg.autoBalance;
      if (msg.pageDuration) liveRankingPageDuration = msg.pageDuration;
      if (msg.pollInterval !== undefined) liveRankingPollInterval = msg.pollInterval;
      if (msg.viewMode) {
        liveRankingViewMode = msg.viewMode;
        updateViewModeButtons();
      }
      if (msg.demoNote) {
        demoRunning = true;
        const btnDemo = document.getElementById('btn-demo-final');
        if (btnDemo) btnDemo.innerHTML = '<span>Detener simulación</span>';
        const pillDemo = document.getElementById('demo-status-pill');
        if (pillDemo) {
          pillDemo.style.display = 'block';
          pillDemo.innerHTML = `<strong>Paso ${msg.demoStep}/${msg.demoTotalSteps}:</strong> ${escapeHtml(msg.demoNote)}`;
        }
      }
      if (msg.data && msg.data.isFinished) {
        demoRunning = false;
        const btnDemo = document.getElementById('btn-demo-final');
        if (btnDemo) btnDemo.innerHTML = '<span>Demo en vivo: Final 3x3 (60s)</span>';
        const pillDemo = document.getElementById('demo-status-pill');
        if (pillDemo) {
          pillDemo.innerHTML = '<strong>Simulación finalizada:</strong> Podio oficial definido.';
          setTimeout(() => { if (pillDemo && !demoRunning) pillDemo.style.display = 'none'; }, 6000);
        }
      }
      if (!msg.visible) {
        demoRunning = false;
        const btnDemo = document.getElementById('btn-demo-final');
        if (btnDemo) btnDemo.innerHTML = '<span>Demo en vivo: Final 3x3 (60s)</span>';
        const pillDemo = document.getElementById('demo-status-pill');
        if (pillDemo) pillDemo.style.display = 'none';
      }
      updateLiveRankingUI();
      updateRankingMockUI();
      break;

    case 'live_ranking_updated':
      if (msg.data) {
        liveRankingData = msg.data;
        renderLiveRankingPreview(liveRankingData);
      }
      break;

    case 'fs_theme_updated':
      if (msg.data) {
        currentFsTheme = Object.assign({}, currentFsTheme, msg.data);
        updateFsThemeUI();
      }
      break;

    case 'ticker_size_updated':
      if (msg.size) {
        setTickerSize(msg.size, false);
      }
      break;

    case 'sync_versus_banner':
    case 'versus_banner_data':
      if (msg.visible !== undefined) versusBannerVisible = !!msg.visible;
      if (msg.roundId) versusRoundId = msg.roundId;
      if (msg.compId) versusCompId = msg.compId;
      if (msg.pollInterval !== undefined) versusPollInterval = msg.pollInterval;
      if (msg.comp1Target !== undefined) versusComp1Target = msg.comp1Target;
      if (msg.comp2Target !== undefined) versusComp2Target = msg.comp2Target;
      if (msg.isMock !== undefined) isVersusMockActive = !!msg.isMock;
      if (msg.mockPreset) versusMockPreset = msg.mockPreset;
      if (msg.mockStep !== undefined) versusMockStep = msg.mockStep;
      if (msg.data) {
        versusData = msg.data;
        renderVersusPanelPreview(versusData);
      }
      updateVersusMockUI();
      updateVersusUI();
      break;
  }
}

// ── Control de OBS Studio y Simulador de Cámaras en Bucle ──
function hasActiveSimCameras() {
  return !!(simCamerasState && Array.isArray(simCamerasState.cameras) && simCamerasState.cameras.length > 0);
}

function updateSimCamerasUI(state) {
  if (!state) return;
  simCamerasState = state;

  const dot = document.getElementById('obs-status-dot');
  const text = document.getElementById('obs-status-text');
  const noObsNotice = document.getElementById('obs-disconnected-box');
  const camEmptyHint = document.getElementById('camera-director-empty-hint');
  const srcEmptyHint = document.getElementById('sources-empty-hint');

  const count = Array.isArray(state.cameras) ? state.cameras.length : 0;
  if (count > 0) {
    if (dot) dot.className = state.enabled ? 'status-dot active' : 'status-dot warning';
    if (text) text.textContent = state.enabled ? `${count} Cámaras Activas` : 'Cámaras en pausa';
    if (noObsNotice) noObsNotice.style.display = 'none';
    if (camEmptyHint) camEmptyHint.style.display = 'none';
    if (srcEmptyHint) srcEmptyHint.style.display = 'none';
    renderSceneSources(state.cameras, 'Simulador Directo (videos/camaras)');
    renderSimDirectorLiveMonitor(state);
    renderPreEscenaDirectorCard(state);
    renderSimMultiviewCard(state);
    window.AdminUI?.syncAdminLiveNowUI();
  }
}

async function commuteSimScenes() {
  try {
    const r = await fetch('/api/sim-cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'commute' })
    });
    const d = await r.json();
    if (d.ok && d.state) {
      updateSimCamerasUI(d.state);
      showToast('¡PreEscena conmutada a Escena Principal! (Principal ⇄ PreEscena)', 'success');
    }
  } catch (err) {
    showToast('Error al conmutar escenas: ' + err.message, 'error');
  }
}

async function setSimBroadcastScene(scene, transitionSubScene) {
  // Si la escena solicitada ya es la escena activa al aire y no hay cambio de sub-escena de transición,
  // evitamos re-enviar la petición para no provocar re-renderizados ni rebotes innecesarios en la tabla
  if (scene && simCamerasState && simCamerasState.activeScene === scene && !transitionSubScene) {
    return;
  }
  try {
    const payload = {};
    if (scene) payload.activeScene = scene;
    if (transitionSubScene) payload.transitionSubScene = transitionSubScene;
    const r = await fetch('/api/sim-cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const d = await r.json();
    if (d.ok && d.state) {
      updateSimCamerasUI(d.state);
      if (scene) {
        const names = {
          principal: '1 · Escena Principal (Al Aire)',
          fullscreen: '3 · FullScreen (Tabla de Clasificación)',
          transicion: '4 · Escena de Transición'
        };
        showToast(`Escena al aire: ${names[scene] || scene}`, 'success');
      } else if (transitionSubScene) {
        showToast(`Modo de transición preparado: ${transitionSubScene.toUpperCase()}`, 'info');
      }
    }
  } catch (err) {
    showToast('Error cambiando escena: ' + err.message, 'error');
  }
}

const LAYOUT_OPTIONS_BY_COUNT = {
  1: [
    { id: 'single', label: 'Pantalla Completa (1)', icon: 'maximize-2' }
  ],
  2: [
    { id: 'split_lr', label: '1 | 2 (Lado a Lado)', icon: 'columns-2' },
    { id: 'split_rl', label: '2 | 1 (Invertido)', icon: 'columns-2' },
    { id: 'split_tb', label: '1 / 2 (Arriba/Abajo)', icon: 'rows-2' },
    { id: 'focus_1_2', label: '1 Grande + 2 Der', icon: 'layout-grid' },
    { id: 'rotate', label: '⇄ Rotar 1 y 2', icon: 'arrow-left-right' }
  ],
  3: [
    { id: 'main_left_2', label: '1 Grande Izq + 2 Der', icon: 'columns-2' },
    { id: 'main_top_2', label: '1 Grande Arriba + 2 Abajo', icon: 'rows-2' },
    { id: 'cols_3', label: '3 Columnas (1 | 2 | 3)', icon: 'layout-grid' },
    { id: 'rotate', label: '⇄ Rotar Posiciones', icon: 'arrow-left-right' }
  ],
  4: [
    { id: 'grid_2x2', label: 'Cuadrícula 2×2', icon: 'layout-grid' },
    { id: 'main_left_3', label: '1 Grande Izq + 3 Der', icon: 'columns-2' },
    { id: 'main_top_3', label: '1 Grande Arriba + 3 Abajo', icon: 'rows-2' },
    { id: 'rotate', label: '⇄ Rotar Posiciones', icon: 'arrow-left-right' }
  ],
  5: [
    { id: 'top2_bot3', label: '2 Arriba + 3 Abajo', icon: 'layout-grid' },
    { id: 'main_left_4', label: '1 Grande Izq + 4 Der', icon: 'columns-2' },
    { id: 'rotate', label: '⇄ Rotar Posiciones', icon: 'arrow-left-right' }
  ],
  6: [
    { id: 'grid_3x2', label: 'Cuadrícula 3×2 (6 Cám)', icon: 'layout-grid' },
    { id: 'top1_bot5', label: '1 Grande Arriba + 5 Abajo', icon: 'rows-2' },
    { id: 'rotate', label: '⇄ Rotar Posiciones', icon: 'arrow-left-right' }
  ]
};

const LAYOUT_DISPLAY_LABELS = {
  single: '1 CÁM · PANTALLA COMPLETA',
  split_lr: '2 CÁM · 1 | 2',
  split_rl: '2 CÁM · 2 | 1',
  split_tb: '2 CÁM · 1 / 2',
  split_bt: '2 CÁM · 2 / 1',
  focus_1_2: '2 CÁM · 1 GRANDE + 2 DER',
  main_left_2: '3 CÁM · 1 IZQ + 2 DER',
  main_top_2: '3 CÁM · 1 ARRIBA + 2 ABAJO',
  cols_3: '3 CÁM · 3 COLUMNAS',
  grid_2x2: '4 CÁM · CUADRÍCULA 2×2',
  main_left_3: '4 CÁM · 1 IZQ + 3 DER',
  main_top_3: '4 CÁM · 1 ARRIBA + 3 ABAJO',
  top2_bot3: '5 CÁM · 2 ARRIBA + 3 ABAJO',
  main_left_4: '5 CÁM · 1 IZQ + 4 DER',
  grid_3x2: '6 CÁM · CUADRÍCULA 3×2',
  top1_bot5: '6 CÁM · 1 ARRIBA + 5 ABAJO'
};

async function updateBusConfig(targetBus, updates = {}, toastMessage = '') {
  const isPrev = targetBus === 'preview';
  try {
    const res = await fetch('/api/sim-cameras', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        target: isPrev ? 'preview' : 'program',
        ...updates
      })
    });
    const data = await res.json();
    if (data.ok && data.state) {
      updateSimCamerasUI(data.state);
      if (toastMessage) {
        const destLabel = isPrev ? '2 · PreEscena' : '1 · Escena Principal';
        showToast(`[${destLabel}] ${toastMessage}`, 'success');
      }
    }
  } catch (err) {
    showToast('Error actualizando distribución: ' + err.message, 'error');
  }
}

async function applyIndependentSceneLayout(targetBus, layout, overrideCamAId, overrideCamBId) {
  const updates = {};
  if (layout) updates.layout = layout;
  if (overrideCamAId !== undefined) updates.camAId = overrideCamAId;
  if (overrideCamBId !== undefined) updates.camBId = overrideCamBId;
  return updateBusConfig(targetBus, updates, 'Distribución actualizada');
}

function renderSimDirectorLiveMonitor(state) {
  const scenesGrid = document.getElementById('scenes-grid');
  const directorBox = scenesGrid ? scenesGrid.parentElement : document.getElementById('camera-layout-director-box');
  if (!directorBox) return;

  const cardTitle = document.getElementById('title-obs-scenes');
  if (cardTitle) {
    cardTitle.textContent = 'Multiview de las 4 Escenas Principales';
    const sub = cardTitle.parentElement?.querySelector('.admin-card-subtitle');
    if (sub) sub.textContent = 'Previsualización en tiempo real de las 4 escenas (Principal, PreEscena, FullScreen y Transición) con soporte de 1 a 6 cámaras + PiP Casteo';
  }
  const obsVideoBox = document.getElementById('obs-video-box');
  if (obsVideoBox) obsVideoBox.style.display = 'none';

  let monitorWrap = document.getElementById('sim-director-live-monitor');
  if (!state || !Array.isArray(state.cameras) || state.cameras.length === 0) {
    if (monitorWrap) monitorWrap.style.display = 'none';
    return;
  }

  const buildMonitorSlotsHtml = (prefix, colorHex) => {
    let html = '';
    for (let i = 0; i < 6; i++) {
      html += `
        <div id="${prefix}-slot-${i}" style="position:absolute; overflow:hidden; transition:all 0.25s ease; opacity:0; pointer-events:none;">
          <video id="${prefix}-video-${i}" autoplay loop muted playsinline style="width:100%; height:100%; object-fit:cover; display:block;"></video>
          <span id="${prefix}-label-${i}" style="position:absolute; left:4px; bottom:4px; background:rgba(15,23,42,0.92); color:${colorHex}; border:1px solid ${colorHex}66; padding:1px 5px; border-radius:4px; font-size:9px; font-weight:700; pointer-events:none;"></span>
        </div>
      `;
    }
    html += `
      <div id="${prefix}-slot-pip" style="position:absolute; overflow:hidden; transition:all 0.25s ease; opacity:0; pointer-events:none; border:2px solid #38bdf8; border-radius:6px; box-shadow:0 4px 14px rgba(0,0,0,0.85);">
        <video id="${prefix}-video-pip" autoplay loop muted playsinline style="width:100%; height:100%; object-fit:cover; display:block;"></video>
        <span id="${prefix}-label-pip" style="position:absolute; left:4px; top:4px; background:rgba(15,23,42,0.92); color:#38bdf8; border:1px solid rgba(56,189,248,0.65); padding:1px 5px; border-radius:4px; font-size:9px; font-weight:800; pointer-events:none;">🎙️ PiP</span>
      </div>
    `;
    return html;
  };

  if (!monitorWrap) {
    monitorWrap = document.createElement('div');
    monitorWrap.id = 'sim-director-live-monitor';
    monitorWrap.style.cssText = 'display: flex; flex-direction: column; gap: 12px;';
    monitorWrap.innerHTML = `
      <!-- Banner informativo de Señal En Vivo Master para OBS -->
      <div class="obs-master-direct-banner" style="display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; background:linear-gradient(90deg, rgba(239,68,68,0.18) 0%, rgba(30,41,59,0.7) 100%); border:1px solid rgba(239,68,68,0.4); border-radius:8px;">
        <div style="display:flex; align-items:center; gap:10px; flex-wrap:wrap;">
          <span style="display:inline-block; width:10px; height:10px; border-radius:50%; background:#ef4444; box-shadow:0 0 8px #ef4444;"></span>
          <span style="font-size:12px; font-weight:800; color:#f8fafc; letter-spacing:0.4px;">SEÑAL EN VIVO MASTER (1 ÚNICA ESCENA EN OBS):</span>
          <code style="padding:3px 8px; border-radius:5px; background:rgba(0,0,0,0.5); border:1px solid rgba(255,255,255,0.16); color:#38bdf8; font-weight:700; font-size:12px; font-family:monospace;">http://localhost:3000/envivo</code>
          <span style="font-size:11px; color:#94a3b8;">(1920×1080 @ 60 FPS — Todo se conmuta desde este panel)</span>
        </div>
        <div style="display:flex; gap:8px;">
          <button type="button" onclick="navigator.clipboard.writeText('http://localhost:3000/envivo'); showToast('URL copiada: http://localhost:3000/envivo (Copia y pega en OBS en una fuente de navegador)', 'success');" style="height:26px; padding:0 12px; border-radius:5px; border:1px solid rgba(56,189,248,0.5); background:rgba(14,116,144,0.35); color:#e0f2fe; font-size:11px; font-weight:800; cursor:pointer;">📋 Copiar URL</button>
          <a href="/envivo" target="_blank" style="display:inline-flex; align-items:center; height:26px; padding:0 12px; border-radius:5px; border:1px solid rgba(255,255,255,0.25); background:rgba(255,255,255,0.08); color:#f8fafc; font-size:11px; font-weight:700; text-decoration:none;">↗ Abrir Señal</a>
        </div>
      </div>
      <div class="scenes-4-multiview-grid">
        <!-- ESCENA 1: ESCENA PRINCIPAL -->
        <div id="scene4-tile-principal" class="sim-multiview-tile">
          <div class="sim-multiview-tile-header">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:12px; font-weight:800; color:#38bdf8;">1 · ESCENA PRINCIPAL</span>
              <span id="badge-scene-4-principal" style="padding:2px 7px; border-radius:4px; font-size:10px; font-weight:700;">AL AIRE</span>
            </div>
            <button type="button" id="btn-scene-4-principal" style="height:24px; padding:0 10px; border-radius:5px; border:1px solid rgba(56,189,248,0.55); background:rgba(14,116,144,0.28); color:#38bdf8; font-size:11px; font-weight:700; cursor:pointer;">Al Aire</button>
          </div>
          <div id="sim-monitor-stage" class="sim-multiview-viewport">
            ${buildMonitorSlotsHtml('sim-mon-prog', '#38bdf8')}
          </div>
          <div class="sim-multiview-tile-footer">
            <span id="sim-monitor-pip-badge" style="font-size:10px; font-weight:700; color:#38bdf8;">🎙️ PiP ON</span>
            <span id="sim-monitor-layout-badge" class="admin-badge" style="font-size:10px; color:#38bdf8;">2 CÁM · 1 | 2</span>
          </div>
        </div>

        <!-- ESCENA 2: PREESCENA (PREVIA QUE CONMUTA CON PRINCIPAL) -->
        <div id="scene4-tile-preescena" class="sim-multiview-tile" style="border-color:rgba(251,191,36,0.5);">
          <div class="sim-multiview-tile-header">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:12px; font-weight:800; color:#fbbf24;">2 · PREESCENA</span>
              <span style="padding:2px 7px; border-radius:4px; font-size:10px; font-weight:700; background:rgba(251,191,36,0.18); color:#fbbf24; border:1px solid rgba(251,191,36,0.4);">PREVIA</span>
            </div>
            <button type="button" id="btn-scene-4-preescena" title="Conmutar PreEscena con Escena Principal" style="height:24px; padding:0 10px; border-radius:5px; border:1px solid rgba(251,191,36,0.65); background:rgba(180,83,9,0.32); color:#fef3c7; font-size:11px; font-weight:800; cursor:pointer;">⇄ Conmutar</button>
          </div>
          <div id="sim-prev-stage" class="sim-multiview-viewport">
            ${buildMonitorSlotsHtml('sim-mon-prev', '#fbbf24')}
          </div>
          <div class="sim-multiview-tile-footer">
            <span id="sim-prev-pip-badge" style="font-size:10px; font-weight:700; color:#fbbf24;">🎙️ PiP ON</span>
            <span id="sim-prev-layout-badge" class="admin-badge" style="font-size:10px; color:#fbbf24;">1 CÁM · COMPLETA</span>
          </div>
        </div>

        <!-- ESCENA 3: FULLSCREEN (TABLA DE CLASIFICACIÓN) -->
        <div id="scene4-tile-fullscreen" class="sim-multiview-tile">
          <div class="sim-multiview-tile-header">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:12px; font-weight:800; color:#f8fafc;">3 · FULLSCREEN</span>
              <span id="badge-scene-4-fullscreen" style="padding:2px 7px; border-radius:4px; font-size:10px; font-weight:700;">TABLA</span>
            </div>
            <button type="button" id="btn-scene-4-fullscreen" style="height:24px; padding:0 10px; border-radius:5px; border:1px solid rgba(255,255,255,0.22); background:rgba(30,41,59,0.9); color:#f8fafc; font-size:11px; font-weight:700; cursor:pointer;">Al Aire</button>
          </div>
          <div class="sim-multiview-viewport" style="background:#020409;">
            <iframe src="/fullscreen?preview=1" title="Vista previa FullScreen Clasificación" allowtransparency="true" style="width:100%; height:100%; border:0; pointer-events:none; display:block; background:#020409;"></iframe>
          </div>
          <div class="sim-multiview-tile-footer">
            <span style="font-size:11px; color:#cbd5e1; font-weight:600;">Tabla de Clasificación WCA Live</span>
            <span class="admin-badge" style="font-size:10px;">/fullscreen</span>
          </div>
        </div>

        <!-- ESCENA 4: ESCENA DE TRANSICIÓN (INICIANDO, PAUSA, RECONECTANDO, DESPEDIDA) -->
        <div id="scene4-tile-transicion" class="sim-multiview-tile">
          <div class="sim-multiview-tile-header">
            <div style="display:flex; align-items:center; gap:6px;">
              <span style="font-size:12px; font-weight:800; color:#f8fafc;">4 · TRANSICIÓN</span>
              <span id="badge-scene-4-transicion" style="padding:2px 7px; border-radius:4px; font-size:10px; font-weight:700;">PAUSA</span>
            </div>
            <button type="button" id="btn-scene-4-transicion" style="height:24px; padding:0 10px; border-radius:5px; border:1px solid rgba(255,255,255,0.22); background:rgba(30,41,59,0.9); color:#f8fafc; font-size:11px; font-weight:700; cursor:pointer;">Al Aire</button>
          </div>
          <div class="sim-multiview-viewport" style="background:#020409;">
            <iframe id="sim-transicion-preview-iframe" src="/transicion?preview=1&scene=starting" allowtransparency="true" style="width:100%; height:100%; border:0; pointer-events:none; display:block; background:#020409;"></iframe>
          </div>
          <div class="sim-multiview-tile-footer" style="padding:6px 8px; gap:4px; flex-wrap:wrap; justify-content:center;">
            <button type="button" data-trans-sub="starting" class="btn-trans-sub" style="height:22px; padding:0 7px; border-radius:4px; border:1px solid rgba(255,255,255,0.16); background:rgba(30,41,59,0.9); color:#e2e8f0; font-size:10px; font-weight:700; cursor:pointer;">Iniciando</button>
            <button type="button" data-trans-sub="lunch" class="btn-trans-sub" style="height:22px; padding:0 7px; border-radius:4px; border:1px solid rgba(255,255,255,0.16); background:rgba(30,41,59,0.9); color:#e2e8f0; font-size:10px; font-weight:700; cursor:pointer;">Pausa</button>
            <button type="button" data-trans-sub="reconnecting" class="btn-trans-sub" style="height:22px; padding:0 7px; border-radius:4px; border:1px solid rgba(255,255,255,0.16); background:rgba(30,41,59,0.9); color:#e2e8f0; font-size:10px; font-weight:700; cursor:pointer;">Reconectando</button>
            <button type="button" data-trans-sub="ending" class="btn-trans-sub" style="height:22px; padding:0 7px; border-radius:4px; border:1px solid rgba(255,255,255,0.16); background:rgba(30,41,59,0.9); color:#e2e8f0; font-size:10px; font-weight:700; cursor:pointer;">Despedida</button>
          </div>
        </div>
      </div>
    `;
    directorBox.insertBefore(monitorWrap, directorBox.firstChild);

    monitorWrap.querySelector('#btn-scene-4-principal').onclick = () => setSimBroadcastScene('principal');
    monitorWrap.querySelector('#btn-scene-4-preescena').onclick = () => commuteSimScenes();
    monitorWrap.querySelector('#btn-scene-4-fullscreen').onclick = () => setSimBroadcastScene('fullscreen');
    monitorWrap.querySelector('#btn-scene-4-transicion').onclick = () => setSimBroadcastScene('transicion', simCamerasState?.transitionSubScene || 'starting');

    monitorWrap.querySelectorAll('.btn-trans-sub').forEach(btn => {
      btn.onclick = () => {
        const sub = btn.getAttribute('data-trans-sub');
        const iframe = document.getElementById('sim-transicion-preview-iframe');
        if (iframe) iframe.src = `/transicion?preview=1&scene=${sub}`;
        setSimBroadcastScene(simCamerasState?.activeScene === 'transicion' ? 'transicion' : undefined, sub);
      };
    });
  }

  monitorWrap.style.display = 'flex';

  const actScene = state.activeScene || 'principal';
  const subScene = state.transitionSubScene || 'starting';
  const setTileState = (tileId, badgeId, btnId, isActive, idleLabel) => {
    const tile = monitorWrap.querySelector(tileId);
    const badge = monitorWrap.querySelector(badgeId);
    const btn = monitorWrap.querySelector(btnId);
    if (tile) tile.classList.toggle('is-cam-a', isActive);
    if (badge) {
      badge.textContent = isActive ? 'AL AIRE' : idleLabel;
      badge.style.background = isActive ? 'rgba(56,189,248,0.25)' : 'rgba(255,255,255,0.08)';
      badge.style.color = isActive ? '#38bdf8' : '#94a3b8';
      badge.style.border = isActive ? '1px solid rgba(56,189,248,0.5)' : '1px solid rgba(255,255,255,0.12)';
    }
    if (btn) {
      btn.textContent = isActive ? '● Al Aire' : 'Poner Al Aire';
      btn.style.background = isActive ? 'rgba(14,116,144,0.38)' : 'rgba(30,41,59,0.9)';
      btn.style.color = isActive ? '#38bdf8' : '#f8fafc';
      btn.style.borderColor = isActive ? 'rgba(56,189,248,0.65)' : 'rgba(255,255,255,0.22)';
    }
  };

  setTileState('#scene4-tile-principal', '#badge-scene-4-principal', '#btn-scene-4-principal', actScene === 'principal', 'EN ESPERA');
  setTileState('#scene4-tile-fullscreen', '#badge-scene-4-fullscreen', '#btn-scene-4-fullscreen', actScene === 'fullscreen', 'RANKING');
  setTileState('#scene4-tile-transicion', '#badge-scene-4-transicion', '#btn-scene-4-transicion', actScene === 'transicion', subScene.toUpperCase());

  monitorWrap.querySelectorAll('.btn-trans-sub').forEach(btn => {
    const isSub = btn.getAttribute('data-trans-sub') === subScene;
    btn.style.borderColor = isSub ? '#38bdf8' : 'rgba(255,255,255,0.16)';
    btn.style.background = isSub ? 'rgba(14,116,144,0.32)' : 'rgba(30,41,59,0.9)';
    btn.style.color = isSub ? '#38bdf8' : '#e2e8f0';
  });

  const cameras = state.cameras || [];
  const updateMonitorViewport = (prefix, busState, layoutBadgeId, pipBadgeId) => {
    const slots = Array.isArray(busState?.slots) ? busState.slots : [];
    const camCount = Math.max(1, Math.min(6, Number(busState?.camCount) || 2));
    for (let i = 0; i < 6; i++) {
      const slotEl = monitorWrap.querySelector(`#${prefix}-slot-${i}`);
      const vidEl = monitorWrap.querySelector(`#${prefix}-video-${i}`);
      const lblEl = monitorWrap.querySelector(`#${prefix}-label-${i}`);
      if (!slotEl || !vidEl) continue;
      const s = slots[i];
      const cam = s?.cam || cameras.find(c => Number(c.sceneItemId) === Number(s?.camId)) || null;
      const isVis = i < camCount && !!(s ? s.visible : cam) && state.enabled;
      if (!isVis || !cam || !s) {
        slotEl.style.opacity = '0';
        slotEl.style.pointerEvents = 'none';
        if (!vidEl.paused) vidEl.pause();
        continue;
      }
      slotEl.style.opacity = '1';
      slotEl.style.zIndex = '1';
      slotEl.style.left = ((s.x / 1920) * 100).toFixed(2) + '%';
      slotEl.style.top = ((s.y / 1080) * 100).toFixed(2) + '%';
      slotEl.style.width = ((s.w / 1920) * 100).toFixed(2) + '%';
      slotEl.style.height = ((s.h / 1080) * 100).toFixed(2) + '%';
      slotEl.style.borderRight = s.borderRight ? '1px solid rgba(255,255,255,0.22)' : 'none';
      slotEl.style.borderBottom = s.borderBottom ? '1px solid rgba(255,255,255,0.22)' : 'none';
      if (lblEl) lblEl.textContent = `${i + 1}: ${cam.shortName || cam.sourceName}`;
      if (vidEl.getAttribute('data-cam-url') !== cam.url) {
        vidEl.setAttribute('data-cam-url', cam.url);
        vidEl.src = cam.url;
        vidEl.load();
        vidEl.play().catch(() => {});
      } else if (vidEl.paused) {
        vidEl.play().catch(() => {});
      }
    }

    // PiP Casteo en el monitor
    const pipSlot = monitorWrap.querySelector(`#${prefix}-slot-pip`);
    const pipVid = monitorWrap.querySelector(`#${prefix}-video-pip`);
    const pipLbl = monitorWrap.querySelector(`#${prefix}-label-pip`);
    const pip = busState?.pip || {};
    const pipEnabled = !!(busState?.pipEnabled !== undefined ? busState.pipEnabled : pip.enabled);
    const pipCam = pip.cam || cameras.find(c => Number(c.sceneItemId) === Number(busState?.pipCamId || pip.camId)) || null;
    if (pipSlot && pipVid) {
      if (!pipEnabled || !pipCam || !state.enabled) {
        pipSlot.style.opacity = '0';
        if (!pipVid.paused) pipVid.pause();
      } else {
        pipSlot.style.opacity = '1';
        pipSlot.style.zIndex = '4';
        pipSlot.style.left = (((pip.x || 1424) / 1920) * 100).toFixed(2) + '%';
        pipSlot.style.top = (((pip.y || 740) / 1080) * 100).toFixed(2) + '%';
        pipSlot.style.width = (((pip.w || 496) / 1920) * 100).toFixed(2) + '%';
        pipSlot.style.height = (((pip.h || 279) / 1080) * 100).toFixed(2) + '%';
        if (pipLbl) pipLbl.textContent = `🎙️ PiP: ${pipCam.shortName || pipCam.sourceName}`;
        if (pipVid.getAttribute('data-cam-url') !== pipCam.url) {
          pipVid.setAttribute('data-cam-url', pipCam.url);
          pipVid.src = pipCam.url;
          pipVid.load();
          pipVid.play().catch(() => {});
        } else if (pipVid.paused) {
          pipVid.play().catch(() => {});
        }
      }
    }

    const layBadge = monitorWrap.querySelector(layoutBadgeId);
    if (layBadge) {
      const layKey = busState?.layout || 'split_lr';
      layBadge.textContent = LAYOUT_DISPLAY_LABELS[layKey] || `${camCount} CÁM · ${layKey.toUpperCase()}`;
    }
    const pBadge = monitorWrap.querySelector(pipBadgeId);
    if (pBadge) {
      pBadge.textContent = pipEnabled && pipCam ? `🎙️ PiP Casteo: ${pipCam.shortName}` : '🎙️ PiP Casteo: OFF';
      pBadge.style.opacity = pipEnabled ? '1' : '0.5';
    }
  };

  updateMonitorViewport('sim-mon-prog', state, '#sim-monitor-layout-badge', '#sim-monitor-pip-badge');
  updateMonitorViewport('sim-mon-prev', state.preview || state, '#sim-prev-layout-badge', '#sim-prev-pip-badge');
}

function renderIndependentBusControls(containerEl, targetBus, busState, cameras, accentColor) {
  if (!containerEl || !busState) return;
  const isPrev = targetBus === 'preview';
  const ic = (n, sz = 14) => (window.Icon ? window.Icon(n, { size: sz }) : '');
  const camCount = Math.max(1, Math.min(6, Number(busState.camCount) || 2));
  const slotIds = Array.isArray(busState.slotIds) ? busState.slotIds : [busState.camAId, busState.camBId];
  const pipEnabled = !!busState.pipEnabled;
  const pipCamId = Number(busState.pipCamId) || (cameras[3]?.sceneItemId) || (cameras[0]?.sceneItemId) || 104;
  const pipCorner = busState.pipCorner || 'br';
  const bannerMode = busState.bannerMode || 'none';
  const currentLayout = busState.layout || 'split_lr';

  let root = containerEl.querySelector('.multi-cam-director-root');
  if (!root) {
    containerEl.innerHTML = `
      <div class="multi-cam-director-root" style="display:flex; flex-direction:column; gap:10px; width:100%;">
        <!-- 1. Selección de Cantidad de Cámaras + Margen de Banners -->
        <div style="display:grid; grid-template-columns: 1.35fr 1fr; gap:10px; align-items:end;">
          <div class="admin-field">
            <label class="admin-label">1. ¿Cuántas cámaras colocar en la distribución?</label>
            <div class="cam-count-pills" style="display:grid; grid-template-columns:repeat(6, 1fr); gap:4px;">
              ${[1, 2, 3, 4, 5, 6].map(n => `
                <button type="button" data-cam-count="${n}" style="height:30px; border-radius:6px; border:1px solid rgba(255,255,255,0.16); background:rgba(15,23,42,0.8); color:#e2e8f0; font-size:11px; font-weight:800; cursor:pointer;">${n} Cám</button>
              `).join('')}
            </div>
          </div>
          <div class="admin-field">
            <label class="admin-label">Margen para banners</label>
            <select class="select-filter bus-banner-select" style="height:30px; font-size:11px;">
              <option value="none">Limpio (borde a borde)</option>
              <option value="top">Espacio superior (130px)</option>
              <option value="bottom">Espacio inferior (160px)</option>
              <option value="both">Doble margen (arriba y abajo)</option>
            </select>
          </div>
        </div>

        <!-- 2. Selectores manuales para cada posición activa (1 a N) -->
        <div class="admin-field">
          <label class="admin-label bus-slots-title">2. Asignación manual de cada cámara en la escena</label>
          <div class="bus-slots-selectors-grid" style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:8px;">
            ${[0, 1, 2, 3, 4, 5].map(idx => `
              <div class="bus-slot-field" data-slot-wrap="${idx}" style="display:flex; flex-direction:column; gap:3px;">
                <span style="font-size:10px; font-weight:700; color:#94a3b8;">Posición ${idx + 1} ${idx === 0 ? '(Principal)' : ''}</span>
                <select class="select-filter" data-slot-select="${idx}" style="height:30px; font-size:11px;"></select>
              </div>
            `).join('')}
          </div>
        </div>

        <!-- 3. Botones de Distribución (Layout) para la cantidad de cámaras elegida -->
        <div class="admin-field">
          <label class="admin-label">3. Formato de distribución en pantalla</label>
          <div class="bus-layouts-row" style="display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:6px;"></div>
        </div>

        <!-- 4. Cámara PiP de Casteo Independiente (Superpuesta en cualquier distribución) -->
        <div class="bus-pip-caster-box" style="padding:10px 12px; border-radius:9px; border:1px solid rgba(56,189,248,0.35); background:rgba(15,23,42,0.75); display:flex; flex-direction:column; gap:8px;">
          <div style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
            <div style="display:flex; align-items:center; gap:7px;">
              <span style="font-size:14px;">🎙️</span>
              <div>
                <div style="font-size:12px; font-weight:800; color:#f8fafc;">Cámara PiP de Casteo (Mini-Cámara Superpuesta)</div>
                <div style="font-size:10px; color:#94a3b8;">Actívala o desactívala sobre cualquier distribución de 1 a 6 cámaras</div>
              </div>
            </div>
            <button type="button" class="btn-toggle-caster-pip" style="height:28px; padding:0 12px; border-radius:6px; font-size:11px; font-weight:800; cursor:pointer; white-space:nowrap;"></button>
          </div>
          <div style="display:grid; grid-template-columns: 1.3fr 1fr; gap:8px;">
            <div class="admin-field">
              <label class="admin-label" style="font-size:10px;">Cámara del Caster (PiP)</label>
              <select class="select-filter bus-pip-cam-select" style="height:28px; font-size:11px;"></select>
            </div>
            <div class="admin-field">
              <label class="admin-label" style="font-size:10px;">Esquina del PiP</label>
              <select class="select-filter bus-pip-corner-select" style="height:28px; font-size:11px;">
                <option value="br">Inf. Derecha (sobre noticias)</option>
                <option value="bl">Inf. Izquierda (sobre noticias)</option>
                <option value="tr">Superior Derecha</option>
                <option value="tl">Superior Izquierda</option>
              </select>
            </div>
          </div>
        </div>

        ${isPrev ? `
          <button type="button" class="btn-bus-commute" style="margin-top:2px; height:36px; border-radius:8px; border:1.5px solid rgba(251,191,36,0.65); background:linear-gradient(90deg, rgba(180,83,9,0.34) 0%, rgba(14,116,144,0.4) 100%); color:#fef3c7; font-size:12px; font-weight:800; cursor:pointer; display:flex; align-items:center; justify-content:center; gap:8px;">
            <span>⇄ CONMUTAR PREESCENA ⇄ ESCENA PRINCIPAL</span>
          </button>
        ` : ''}
      </div>
    `;
    root = containerEl.querySelector('.multi-cam-director-root');

    // Eventos de Cantidad de Cámaras
    root.querySelectorAll('button[data-cam-count]').forEach(btn => {
      btn.onclick = () => {
        const count = Number(btn.getAttribute('data-cam-count'));
        updateBusConfig(targetBus, { camCount: count }, `${count} cámara(s) en distribución`);
      };
    });

    // Evento de Margen para banners
    const bannerSel = root.querySelector('.bus-banner-select');
    if (bannerSel) {
      bannerSel.onchange = () => {
        updateBusConfig(targetBus, { bannerMode: bannerSel.value }, 'Margen de banners actualizado');
      };
    }

    // Eventos de Selectores de cada posición (1 a 6)
    root.querySelectorAll('select[data-slot-select]').forEach(sel => {
      sel.onchange = () => {
        const slotIndex = Number(sel.getAttribute('data-slot-select'));
        updateBusConfig(targetBus, { slotIndex, slotCamId: Number(sel.value) }, `Posición ${slotIndex + 1} actualizada`);
      };
    });

    // Eventos de Cámara PiP de Casteo
    const pipToggleBtn = root.querySelector('.btn-toggle-caster-pip');
    if (pipToggleBtn) {
      pipToggleBtn.onclick = () => {
        const currentBus = isPrev ? (simCamerasState?.preview || {}) : (simCamerasState || {});
        const nextPip = !currentBus.pipEnabled;
        updateBusConfig(targetBus, { pipEnabled: nextPip }, nextPip ? '🎙️ Cámara PiP de Casteo ACTIVADA' : '🎙️ Cámara PiP de Casteo OCULTA');
      };
    }
    const pipCamSel = root.querySelector('.bus-pip-cam-select');
    if (pipCamSel) {
      pipCamSel.onchange = () => {
        updateBusConfig(targetBus, { pipCamId: Number(pipCamSel.value), pipEnabled: true }, '🎙️ Cámara de Casteo asignada');
      };
    }
    const pipCornerSel = root.querySelector('.bus-pip-corner-select');
    if (pipCornerSel) {
      pipCornerSel.onchange = () => {
        updateBusConfig(targetBus, { pipCorner: pipCornerSel.value }, 'Esquina del PiP actualizada');
      };
    }

    const commuteBtn = root.querySelector('.btn-bus-commute');
    if (commuteBtn) commuteBtn.onclick = () => commuteSimScenes();
  }

  // Sincronizar estado de botones 1..6 Cámaras
  root.querySelectorAll('button[data-cam-count]').forEach(btn => {
    const n = Number(btn.getAttribute('data-cam-count'));
    const active = n === camCount;
    btn.style.borderColor = active ? accentColor : 'rgba(255,255,255,0.14)';
    btn.style.background = active ? (isPrev ? 'rgba(180,83,9,0.34)' : 'rgba(14,116,144,0.34)') : 'rgba(15,23,42,0.8)';
    btn.style.color = active ? accentColor : '#cbd5e1';
  });

  const bannerSel = root.querySelector('.bus-banner-select');
  if (bannerSel) bannerSel.value = bannerMode;

  const slotsTitle = root.querySelector('.bus-slots-title');
  if (slotsTitle) {
    slotsTitle.textContent = `2. Cámaras en la distribución (${camCount} posición${camCount > 1 ? 'es' : ''} activa${camCount > 1 ? 's' : ''})`;
  }

  // Poblar y mostrar únicamente las N posiciones activas
  root.querySelectorAll('[data-slot-wrap]').forEach(wrap => {
    const idx = Number(wrap.getAttribute('data-slot-wrap'));
    wrap.style.display = idx < camCount ? 'flex' : 'none';
    const sel = wrap.querySelector('select');
    if (!sel) return;
    sel.innerHTML = '';
    cameras.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.sceneItemId;
      opt.textContent = c.sourceName;
      sel.appendChild(opt);
    });
    const val = slotIds[idx] || cameras[idx % Math.max(1, cameras.length)]?.sceneItemId;
    if (val) sel.value = String(val);
  });

  // Renderizar botones de formato de distribución según camCount
  const layoutsRow = root.querySelector('.bus-layouts-row');
  if (layoutsRow) {
    const presets = LAYOUT_OPTIONS_BY_COUNT[camCount] || LAYOUT_OPTIONS_BY_COUNT[2];
    layoutsRow.innerHTML = presets.map(p => {
      const isAct = p.id === currentLayout;
      return `
        <button type="button" class="btn-layout-preset" data-bus-layout="${p.id}" style="height:32px; font-size:11px; border-color:${isAct ? accentColor : ''}; color:${isAct ? accentColor : ''};">
          ${ic(p.icon)}<span>${p.label}</span>
        </button>
      `;
    }).join('');
    layoutsRow.querySelectorAll('button[data-bus-layout]').forEach(btn => {
      btn.onclick = () => {
        const layId = btn.getAttribute('data-bus-layout');
        updateBusConfig(targetBus, { layout: layId }, `Formato aplicado: ${btn.textContent.trim()}`);
      };
    });
  }

  // Sincronizar Cámara PiP de Casteo
  const pipToggleBtn = root.querySelector('.btn-toggle-caster-pip');
  if (pipToggleBtn) {
    pipToggleBtn.textContent = pipEnabled ? '🎙️ PiP Casteo: ACTIVO' : '🎙️ PiP Casteo: OCULTO';
    pipToggleBtn.style.border = pipEnabled ? '1px solid rgba(16,185,129,0.75)' : '1px solid rgba(255,255,255,0.22)';
    pipToggleBtn.style.background = pipEnabled ? 'rgba(6,95,70,0.45)' : 'rgba(30,41,59,0.85)';
    pipToggleBtn.style.color = pipEnabled ? '#34d399' : '#94a3b8';
  }
  const pipCamSel = root.querySelector('.bus-pip-cam-select');
  if (pipCamSel) {
    pipCamSel.innerHTML = '';
    cameras.forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.sceneItemId;
      opt.textContent = c.sourceName;
      pipCamSel.appendChild(opt);
    });
    if (pipCamId) pipCamSel.value = String(pipCamId);
  }
  const pipCornerSel = root.querySelector('.bus-pip-corner-select');
  if (pipCornerSel) pipCornerSel.value = pipCorner;
}

function renderPreEscenaDirectorCard(state) {
  const scenesView = document.getElementById('view-scenes');
  const cardsGrid = scenesView ? scenesView.querySelector('.admin-cards-grid') : null;
  const mainCamCard = scenesView ? scenesView.querySelector('section[aria-labelledby="title-obs-cameras"]') : null;
  if (!cardsGrid || !mainCamCard) return;

  const mainTitle = document.getElementById('title-obs-cameras');
  if (mainTitle) {
    mainTitle.textContent = 'Distribución Interna · 1 · Escena Principal';
    const sub = mainTitle.parentElement?.querySelector('.admin-card-subtitle');
    if (sub) sub.textContent = 'Elige de 1 a 6 cámaras + Cámara PiP de Casteo directamente en la Escena Principal';
  }
  const mainBadge = document.getElementById('layout-target-badge');
  if (mainBadge) {
    mainBadge.textContent = '1 · PRINCIPAL';
    mainBadge.style.color = '#38bdf8';
  }

  const mainDirectorBox = document.getElementById('camera-layout-director-box');
  if (mainDirectorBox) {
    mainDirectorBox.style.display = 'flex';
    renderIndependentBusControls(mainDirectorBox, 'program', state, state.cameras || [], '#38bdf8');
  }

  let prevCard = document.getElementById('sim-preescena-director-card');
  if (!prevCard) {
    prevCard = document.createElement('section');
    prevCard.className = 'admin-panel-card';
    prevCard.id = 'sim-preescena-director-card';
    const ic = (n, sz = 18) => (window.Icon ? window.Icon(n, { size: sz }) : '');
    prevCard.innerHTML = `
      <div class="admin-card-header">
        <div class="admin-card-header-main">
          <div class="admin-card-icon">${ic('columns-2', 18)}</div>
          <div class="admin-card-titles">
            <h2 class="admin-card-title">Distribución Interna · 2 · PreEscena</h2>
            <p class="admin-card-subtitle">Elige de 1 a 6 cámaras + Cámara PiP de Casteo en PreEscena antes de conmutar</p>
          </div>
        </div>
        <div class="admin-card-header-meta">
          <span class="admin-status-pill" id="prev-layout-target-badge" style="color:#fbbf24;">2 · PREESCENA</span>
        </div>
      </div>
      <div class="admin-card-body">
        <div id="preescena-layout-director-box" class="camera-layout-director-box" style="display:flex;"></div>
      </div>
    `;
    if (mainCamCard.nextSibling) {
      cardsGrid.insertBefore(prevCard, mainCamCard.nextSibling);
    } else {
      cardsGrid.appendChild(prevCard);
    }
  }

  const prevDirectorBox = prevCard.querySelector('#preescena-layout-director-box');
  if (prevDirectorBox) {
    renderIndependentBusControls(prevDirectorBox, 'preview', state.preview || state, state.cameras || [], '#fbbf24');
  }
}

function renderSimMultiviewCard(state) {
  const scenesView = document.getElementById('view-scenes');
  const cardsGrid = scenesView ? scenesView.querySelector('.admin-cards-grid') : null;
  if (!cardsGrid) return;

  let mvCard = document.getElementById('sim-multiview-card');
  const cameras = (state && Array.isArray(state.cameras)) ? state.cameras : [];
  if (cameras.length === 0) {
    if (mvCard) mvCard.style.display = 'none';
    return;
  }

  if (!mvCard) {
    mvCard = document.createElement('section');
    mvCard.className = 'admin-panel-card';
    mvCard.id = 'sim-multiview-card';
    const iconHtml = window.Icon ? window.Icon('layout-grid', { size: 18 }) : '';
    mvCard.innerHTML = `
      <div class="admin-card-header">
        <div class="admin-card-header-main">
          <div class="admin-card-icon">${iconHtml}</div>
          <div class="admin-card-titles">
            <h2 class="admin-card-title">Multiview de Cámaras en Vivo (6 entradas)</h2>
            <p class="admin-card-subtitle">Envía cualquier cámara a una posición o al PiP de Casteo de PreEscena o de Escena Principal</p>
          </div>
        </div>
        <div class="admin-card-header-meta">
          <span class="admin-status-pill admin-status-pill--connected tabular-nums" id="sim-multiview-count-pill">${cameras.length} cámaras en vivo</span>
        </div>
      </div>
      <div class="admin-card-body">
        <div id="sim-multiview-grid" class="sim-multiview-grid"></div>
      </div>
    `;
    cardsGrid.appendChild(mvCard);
  }

  mvCard.style.display = '';
  const countPill = mvCard.querySelector('#sim-multiview-count-pill');
  if (countPill) countPill.textContent = `${cameras.length} cámaras en vivo`;

  const mvGrid = mvCard.querySelector('#sim-multiview-grid');
  if (!mvGrid) return;

  const progCount = Math.max(1, Math.min(6, Number(state.camCount) || 2));
  const progSlots = (state.slotIds || []).slice(0, progCount).map(Number);
  const progPip = state.pipEnabled ? Number(state.pipCamId) : null;

  const prevObj = state.preview || {};
  const prevCount = Math.max(1, Math.min(6, Number(prevObj.camCount) || 1));
  const prevSlots = (prevObj.slotIds || []).slice(0, prevCount).map(Number);
  const prevPip = prevObj.pipEnabled ? Number(prevObj.pipCamId) : null;

  cameras.forEach(cam => {
    const id = Number(cam.sceneItemId);
    const inProgIdx = progSlots.indexOf(id);
    const isProgPip = progPip === id;
    const inPrevIdx = prevSlots.indexOf(id);
    const isPrevPip = prevPip === id;

    let tile = mvGrid.querySelector(`[data-mv-id="${id}"]`);
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'sim-multiview-tile';
      tile.setAttribute('data-mv-id', String(id));
      tile.innerHTML = `
        <div class="sim-multiview-tile-header">
          <div style="display:flex; align-items:center; gap:6px; min-width:0;">
            <span class="mv-cam-num" style="font-size:12px; font-weight:800; color:#f8fafc; white-space:nowrap;"></span>
            <span class="mv-cam-tally" style="padding:2px 7px; border-radius:4px; font-size:10px; font-weight:700; white-space:nowrap;"></span>
          </div>
          <div style="display:flex; align-items:center; gap:3px; flex-wrap:wrap;">
            <button type="button" data-mv-bus="preview" data-mv-role="slot0" title="Enviar a PreEscena Posición 1" style="height:22px; padding:0 6px; border-radius:4px; border:1px solid rgba(251,191,36,0.55); background:rgba(180,83,9,0.24); color:#fbbf24; font-size:10px; font-weight:700; cursor:pointer;">Pre 1</button>
            <button type="button" data-mv-bus="preview" data-mv-role="slot1" title="Enviar a PreEscena Posición 2" style="height:22px; padding:0 6px; border-radius:4px; border:1px solid rgba(251,191,36,0.55); background:rgba(180,83,9,0.24); color:#fbbf24; font-size:10px; font-weight:700; cursor:pointer;">Pre 2</button>
            <button type="button" data-mv-bus="preview" data-mv-role="pip" title="Asignar como Cámara PiP Casteo en PreEscena" style="height:22px; padding:0 6px; border-radius:4px; border:1px solid rgba(251,191,36,0.55); background:rgba(180,83,9,0.24); color:#fef3c7; font-size:10px; font-weight:700; cursor:pointer;">🎙️Pre</button>
            <button type="button" data-mv-bus="program" data-mv-role="slot0" title="Enviar directo a Principal Posición 1" style="height:22px; padding:0 6px; border-radius:4px; border:1px solid rgba(56,189,248,0.55); background:rgba(14,116,144,0.24); color:#38bdf8; font-size:10px; font-weight:700; cursor:pointer;">Prin 1</button>
            <button type="button" data-mv-bus="program" data-mv-role="slot1" title="Enviar directo a Principal Posición 2" style="height:22px; padding:0 6px; border-radius:4px; border:1px solid rgba(56,189,248,0.55); background:rgba(14,116,144,0.24); color:#38bdf8; font-size:10px; font-weight:700; cursor:pointer;">Prin 2</button>
            <button type="button" data-mv-bus="program" data-mv-role="pip" title="Asignar como Cámara PiP Casteo en Principal" style="height:22px; padding:0 6px; border-radius:4px; border:1px solid rgba(56,189,248,0.55); background:rgba(14,116,144,0.24); color:#bae6fd; font-size:10px; font-weight:700; cursor:pointer;">🎙️Prin</button>
          </div>
        </div>
        <div class="sim-multiview-viewport">
          <video autoplay loop muted playsinline src="${cam.url}"></video>
        </div>
        <div class="sim-multiview-tile-footer">
          <span style="font-size:12px; font-weight:600; color:#e2e8f0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1;" title="${escapeHtml(cam.title || cam.sourceName)}">${escapeHtml(cam.title || cam.sourceName)}</span>
          <div style="display:flex; gap:4px;">
            <button type="button" data-mv-media="restart" title="Reiniciar video" style="height:22px; padding:0 7px; border-radius:4px; border:1px solid rgba(255,255,255,0.16); background:rgba(15,23,42,0.85); color:#cbd5e1; font-size:11px; cursor:pointer;">↺</button>
            <button type="button" data-mv-media="pause" title="Pausar video" style="height:22px; padding:0 7px; border-radius:4px; border:1px solid rgba(255,255,255,0.16); background:rgba(15,23,42,0.85); color:#cbd5e1; font-size:11px; cursor:pointer;">⏸</button>
            <button type="button" data-mv-media="play" title="Reproducir video" style="height:22px; padding:0 7px; border-radius:4px; border:1px solid rgba(255,255,255,0.16); background:rgba(15,23,42,0.85); color:#cbd5e1; font-size:11px; cursor:pointer;">▶</button>
          </div>
        </div>
      `;
      tile.querySelectorAll('button[data-mv-bus]').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const bus = btn.getAttribute('data-mv-bus');
          const role = btn.getAttribute('data-mv-role');
          if (role === 'pip') {
            updateBusConfig(bus, { pipCamId: id, pipEnabled: true }, `🎙️ ${cam.shortName} en PiP de Casteo`);
          } else if (role === 'slot0') {
            updateBusConfig(bus, { slotIndex: 0, slotCamId: id }, `${cam.shortName} en Posición 1`);
          } else if (role === 'slot1') {
            updateBusConfig(bus, { slotIndex: 1, slotCamId: id }, `${cam.shortName} en Posición 2`);
          }
        };
      });
      tile.querySelectorAll('button[data-mv-media]').forEach(btn => {
        btn.onclick = (e) => {
          e.stopPropagation();
          const action = btn.getAttribute('data-mv-media');
          const vid = tile.querySelector('video');
          if (vid) {
            if (action === 'restart') { vid.currentTime = 0; vid.play().catch(() => {}); }
            else if (action === 'pause') { vid.pause(); }
            else if (action === 'play') { vid.play().catch(() => {}); }
          }
          triggerMedia(cam.sourceName, action);
        };
      });
      mvGrid.appendChild(tile);
    }

    const isOnAir = inProgIdx !== -1 || isProgPip;
    const isOnPrev = inPrevIdx !== -1 || isPrevPip;
    tile.classList.toggle('is-cam-a', isOnAir);
    tile.classList.toggle('is-cam-b', !isOnAir && isOnPrev);

    const numEl = tile.querySelector('.mv-cam-num');
    const tallyEl = tile.querySelector('.mv-cam-tally');
    if (numEl) numEl.textContent = (cam.shortName || `CAM ${cam.camIndex || ''}`).toUpperCase();
    if (tallyEl) {
      const tags = [];
      if (inProgIdx !== -1) tags.push(`PRIN #${inProgIdx + 1}`);
      if (isProgPip) tags.push(`🎙️PRIN PiP`);
      if (inPrevIdx !== -1) tags.push(`PRE #${inPrevIdx + 1}`);
      if (isPrevPip) tags.push(`🎙️PRE PiP`);
      if (isOnAir) {
        tallyEl.textContent = tags.join(' · ');
        tallyEl.style.background = 'rgba(56,189,248,0.2)';
        tallyEl.style.color = '#38bdf8';
        tallyEl.style.border = '1px solid rgba(56,189,248,0.5)';
      } else if (isOnPrev) {
        tallyEl.textContent = tags.join(' · ');
        tallyEl.style.background = 'rgba(251,191,36,0.2)';
        tallyEl.style.color = '#fbbf24';
        tallyEl.style.border = '1px solid rgba(251,191,36,0.5)';
      } else {
        tallyEl.textContent = 'EN ESPERA';
        tallyEl.style.background = 'rgba(255,255,255,0.06)';
        tallyEl.style.color = '#94a3b8';
        tallyEl.style.border = '1px solid rgba(255,255,255,0.12)';
      }
    }
    const vidEl = tile.querySelector('video');
    if (vidEl && vidEl.paused) {
      vidEl.play().catch(() => {});
    }
  });
}


function updateOBSUI(status) {
  obsStatus = status;

  const dot = document.getElementById('obs-status-dot');
  const text = document.getElementById('obs-status-text');
  const deck = document.getElementById('scenes-grid');
  const noObsNotice = document.getElementById('obs-disconnected-box');
  const videoBox = document.getElementById('obs-video-box');
  const camEmptyHint = document.getElementById('camera-director-empty-hint');
  const srcEmptyHint = document.getElementById('sources-empty-hint');

  if (status.connected) {
    dot.className = 'status-dot active';
    text.textContent = 'OBS conectado';
    noObsNotice.style.display = 'none';
    deck.style.display = hasActiveSimCameras() ? 'none' : 'grid';
    if (videoBox) videoBox.style.display = 'block';
    if (camEmptyHint) camEmptyHint.style.display = 'none';
    if (srcEmptyHint) srcEmptyHint.style.display = 'none';

    renderScenes(status.scenes, status.currentProgramScene);
    if (hasActiveSimCameras()) {
      renderSimDirectorLiveMonitor(simCamerasState);
      renderSimMultiviewCard(simCamerasState);
    }
    if (status.currentSceneItems || hasActiveSimCameras()) {
      renderSceneSources(status.currentSceneItems || [], status.currentProgramScene);
    }
    updateOBSVideoUI(status);
    updateStudioModeUI();
    updateStreamButton(status.isStreaming);
    updateRecordButton(status.isRecording);
  } else if (hasActiveSimCameras()) {
    deck.style.display = 'none';
    if (videoBox) videoBox.style.display = 'none';
    updateStudioModeUI();
    updateStreamButton(false);
    updateRecordButton(false);
    updateSimCamerasUI(simCamerasState);
  } else {
    dot.className = 'status-dot warning';
    text.textContent = 'OBS desconectado';
    deck.style.display = 'none';
    if (videoBox) videoBox.style.display = 'none';
    const sourcesBox = document.getElementById('active-scene-sources-box');
    if (sourcesBox) sourcesBox.style.display = 'none';
    const directorBox = document.getElementById('camera-layout-director-box');
    if (directorBox) directorBox.style.display = 'none';
    if (camEmptyHint) camEmptyHint.style.display = 'flex';
    if (srcEmptyHint) srcEmptyHint.style.display = 'flex';
    updateStudioModeUI();
    noObsNotice.style.display = 'flex';
    updateStreamButton(false);
    updateRecordButton(false);
  }

  window.AdminUI?.syncAdminLiveNowUI();
}

function updateOBSVideoUI(status) {
  const badge = document.getElementById('obs-video-current-badge');
  const hint = document.getElementById('video-hint-caption');
  const vs = status?.videoSettings;

  const isBusy = !!(status?.isStreaming || status?.isRecording);

  document.querySelectorAll('.btn-video-preset').forEach(btn => {
    btn.disabled = isBusy;
  });

  if (isBusy) {
    if (hint) {
      hint.textContent = 'Detén la transmisión o grabación activa para cambiar resolución o FPS en OBS.';
      hint.style.color = 'var(--warning)';
    }
  } else {
    if (hint) {
      hint.textContent = 'Aplica a la resolución de salida y framerate de OBS.';
      hint.style.color = 'var(--text-dim)';
    }
  }

  if (vs && badge) {
    badge.textContent = `${vs.outputWidth}x${vs.outputHeight} @ ${vs.fps} FPS`;

    document.querySelectorAll('.btn-video-preset').forEach(btn => btn.classList.remove('active'));

    if (vs.outputHeight === 1080 && vs.fps === 60) {
      document.getElementById('btn-fps-1080p60')?.classList.add('active');
    } else if (vs.outputHeight === 1080 && vs.fps === 30) {
      document.getElementById('btn-fps-1080p30')?.classList.add('active');
    } else if (vs.outputHeight === 720 && vs.fps === 60) {
      document.getElementById('btn-fps-720p60')?.classList.add('active');
    } else if (vs.outputHeight === 720 && vs.fps === 30) {
      document.getElementById('btn-fps-720p30')?.classList.add('active');
    }
  }
}

async function setOBSVideoPreset(preset) {
  if (obsStatus.isStreaming || obsStatus.isRecording) {
    showToast('Detén la transmisión o grabación antes de cambiar la resolución o FPS.', 'error');
    return;
  }

  showToast(`Cambiando salida de OBS a ${preset}...`, 'info');

  try {
    const res = await fetch('/api/obs/video-settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset })
    });
    const data = await res.json();
    if (data.ok) {
      showToast(`¡Salida configurada: ${preset}!`, 'success');
      if (data.videoSettings) {
        obsStatus.videoSettings = data.videoSettings;
        updateOBSVideoUI(obsStatus);
      }
    } else {
      showToast(`Error: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error de conexión: ${err.message}`, 'error');
  }
}

// ── Control de Modo Estudio (Preview & Program) ──
let studioPollingTimer = null;
let studioQuality = 'hd';
let studioFpsInterval = 500; // 2 FPS por defecto
let isFetchingScreenshots = false;

function setStudioFps(val) {
  studioFpsInterval = parseInt(val, 10);
  startStudioPolling();
  if (studioFpsInterval === 0) {
    showToast('Refresco automático en pausa');
  } else {
    const fps = Math.round(1000 / studioFpsInterval);
    showToast(`Frecuencia de monitoreo: ${fps} FPS`);
  }
}

function setStudioQuality(val) {
  studioQuality = val;
  refreshStudioScreenshots(false);
  showToast(`Calidad de monitores: ${val.toUpperCase()}`);
}

function updateStudioModeUI() {
  const dock = document.getElementById('studio-deck-dock');
  const btnHeader = document.getElementById('btn-header-studio-toggle');
  const dotHeader = document.getElementById('header-studio-dot');
  const btnToggle = document.getElementById('btn-studio-toggle');
  const statusText = document.getElementById('studio-mode-status-text');

  const isStudio = !!(obsStatus.connected && obsStatus.studioMode);

  if (dock) dock.style.display = isStudio ? 'flex' : 'none';

  if (btnHeader) {
    btnHeader.classList.toggle('active', isStudio);
  }
  if (dotHeader) {
    dotHeader.className = `status-dot ${isStudio ? 'active' : ''}`;
  }
  if (btnToggle) {
    btnToggle.classList.toggle('active', isStudio);
  }
  if (statusText) {
    statusText.textContent = isStudio ? 'ACTIVADO' : 'DESACTIVADO';
  }

  const destBox = document.getElementById('layout-dest-box');
  const showDest = isStudio || hasActiveSimCameras();
  if (destBox) destBox.style.display = showDest ? 'flex' : 'none';
  if (showDest && !currentLayoutTarget) currentLayoutTarget = 'preview';
  setLayoutTarget(showDest ? (currentLayoutTarget || 'preview') : 'program');

  if (isStudio) {
    updateStudioPreviewUI(obsStatus.currentPreviewScene || obsStatus.currentProgramScene);
    refreshStudioScreenshots(false);
    startStudioPolling();
  } else {
    stopStudioPolling();
  }
}

function startStudioPolling() {
  stopStudioPolling();
  if (studioFpsInterval <= 0) return;

  const pollLoop = async () => {
    if (!obsStatus.connected || !obsStatus.studioMode) {
      stopStudioPolling();
      return;
    }
    if (!document.hidden && !isFetchingScreenshots) {
      await refreshStudioScreenshots(false);
    }
    if (studioPollingTimer !== null && studioFpsInterval > 0) {
      studioPollingTimer = setTimeout(pollLoop, studioFpsInterval);
    }
  };

  studioPollingTimer = setTimeout(pollLoop, studioFpsInterval);
}

function stopStudioPolling() {
  if (studioPollingTimer) {
    clearTimeout(studioPollingTimer);
    studioPollingTimer = null;
  }
}

function toggleStudioMode() {
  if (!obsStatus.connected) {
    showToast('Conecta OBS Studio primero', 'error');
    return;
  }
  sendWS({ type: 'obs_toggle_studio' });
}

function switchOBSPreviewScene(sceneName) {
  if (!sceneName) return;
  obsStatus.currentPreviewScene = sceneName;
  sendWS({ type: 'obs_set_preview', sceneName });
  updateStudioPreviewUI(sceneName);
  showToast(`Preview: ${sceneName}`);
  setTimeout(() => refreshStudioScreenshots(false), 200);
}

function updateStudioPreviewUI(sceneName) {
  const label = document.getElementById('studio-preview-name-label');
  if (label) label.textContent = `Escena: ${sceneName || '—'}`;

  const sel = document.getElementById('studio-preview-scene-select');
  if (sel && sceneName) sel.value = sceneName;

  document.querySelectorAll('.scene-tile').forEach(t => {
    t.classList.toggle('preview', t.dataset.scene === sceneName);
  });
}

async function triggerStudioTransition() {
  if (!obsStatus.connected) return;
  const btn = document.getElementById('btn-studio-transition');
  if (btn) {
    btn.style.transform = 'scale(0.95)';
    setTimeout(() => { btn.style.transform = ''; }, 180);
  }

  showToast('¡Transición en vivo ejecutada!', 'success');
  sendWS({ type: 'obs_transition' });

  setTimeout(() => {
    refreshStudioScreenshots(false);
  }, 350);
}

async function refreshStudioScreenshots(showNotice = false) {
  if (!obsStatus.connected || isFetchingScreenshots) return;
  isFetchingScreenshots = true;
  try {
    const res = await fetch(`/api/obs/studio-screenshots?quality=${studioQuality}`);
    const data = await res.json();
    if (data.ok) {
      const prevImg = document.getElementById('studio-preview-screen');
      const progImg = document.getElementById('studio-program-screen');
      const prevLabel = document.getElementById('studio-preview-name-label');
      const progLabel = document.getElementById('studio-program-name-label');
      const streamPill = document.getElementById('studio-stream-status-pill');
      const recordPill = document.getElementById('studio-record-status-pill');

      if (data.previewImage && prevImg) {
        prevImg.src = data.previewImage;
      }
      if (data.programImage && progImg) {
        progImg.src = data.programImage;
      }
      if (prevLabel && data.previewScene) {
        prevLabel.textContent = `Escena: ${data.previewScene}`;
      }
      if (progLabel && data.programScene) {
        progLabel.textContent = `En vivo: ${data.programScene}`;
      }
      if (streamPill) {
        streamPill.textContent = obsStatus.isStreaming ? 'STREAM: EN VIVO' : 'STREAM: OFF';
        streamPill.style.color = obsStatus.isStreaming ? 'var(--live)' : 'var(--text-muted)';
      }
      if (recordPill) {
        recordPill.textContent = obsStatus.isRecording ? 'REC: ACTIVO' : 'REC: OFF';
        recordPill.style.color = obsStatus.isRecording ? 'var(--live)' : 'var(--text-muted)';
      }
      if (showNotice) showToast('Vistas previas actualizadas', 'info');
    }
  } catch (err) {
    console.error('Error fetching studio screenshots:', err);
  } finally {
    isFetchingScreenshots = false;
  }
}

// ── Control de Fuentes, Cámaras y Multimedia en OBS / Simulador ──
function getSourceIcon(kind) {
  const k = (kind || '').toLowerCase();
  const render = (name) => (window.Icon ? window.Icon(name, { size: 15 }) : '');
  if (k.includes('dshow') || k.includes('video_capture') || k.includes('camera') || k.includes('avfoundation')) return render('video');
  if (k.includes('ffmpeg') || k.includes('vlc') || k.includes('media')) return render('film');
  if (k.includes('browser')) return render('globe');
  if (k.includes('image')) return render('image');
  if (k.includes('text') || k.includes('gdiplus')) return render('newspaper');
  if (k.includes('color')) return render('palette');
  if (k.includes('group')) return render('layers');
  return render('monitor');
}

function renderSceneSources(items, sceneName) {
  const box = document.getElementById('active-scene-sources-box');
  const container = document.getElementById('scene-sources-list');
  const label = document.getElementById('active-scene-name-label');
  const caption = document.getElementById('sources-count-caption');

  if (!box || !container) return;

  const directorBox = document.getElementById('camera-layout-director-box');
  const simActive = hasActiveSimCameras();
  if (simActive && Array.isArray(simCamerasState.cameras)) {
    const baseItems = Array.isArray(items) ? items.filter(i => !i.isSimulated) : [];
    items = [...simCamerasState.cameras, ...baseItems];
  }

  if (!obsStatus.connected && !simActive) {
    box.style.display = 'none';
    if (directorBox) directorBox.style.display = 'none';
    return;
  }

  box.style.display = 'flex';
  const name = sceneName || obsStatus.currentProgramScene || (simActive ? 'Simulador Directo (videos/camaras)' : 'Escena');
  label.textContent = `Capas en: ${name}`;
  caption.textContent = `${items ? items.length : 0} cámaras en bucle`;
  container.innerHTML = '';

  populateCameraLayoutSelectors(items, sceneName);

  if (!items || items.length === 0) {
    container.innerHTML = '<div class="admin-hint" style="padding:8px 0;">No hay fuentes en esta escena</div>';
    return;
  }

  items.forEach(item => {
    const card = document.createElement('div');
    card.className = 'source-item-card';
    card.id = `source-item-${item.sceneItemId}`;

    const icon = getSourceIcon(item.inputKind);
    const isVisible = !!item.sceneItemEnabled;
    const kind = item.inputKind || 'fuente';
    const isMedia = kind.includes('ffmpeg') || kind.includes('vlc') || kind.includes('media');
    const isVisual = !kind.includes('wasapi') && !kind.includes('audio');
    const isSimCam = !!item.isSimulated;
    const isCamA = isSimCam && Number(simCamerasState?.camAId) === Number(item.sceneItemId);
    const isCamB = isSimCam && Number(simCamerasState?.camBId) === Number(item.sceneItemId);

    const eyeIconHtml = window.Icon
      ? window.Icon(isVisible ? 'eye' : 'eye-off', { size: 15 })
      : (isVisible ? 'ON' : 'OFF');

    const slotTag = isCamA && isCamB
      ? 'MESA 1 & 2'
      : isCamA
      ? 'MESA 1 (CAM A)'
      : isCamB
      ? 'MESA 2 (CAM B)'
      : (isSimCam ? 'LOOP MP4' : kind.replace('_source', '').replace('_input', ''));

    const mainRow = document.createElement('div');
    mainRow.className = 'source-item-main';

    const thumbHtml = (isSimCam && item.url)
      ? `<video class="source-thumb-video" src="${item.url}" autoplay loop muted playsinline></video>`
      : `<span class="source-icon">${icon}</span>`;

    mainRow.innerHTML = `
      <div class="source-item-info">
        ${thumbHtml}
        <div style="display:flex; flex-direction:column; gap:3px; min-width:0; flex:1;">
          <span class="source-name" title="${escapeHtml(item.sourceName)}">${escapeHtml(item.sourceName)}</span>
          <div>
            <span class="source-kind-tag" style="${(isCamA || isCamB) ? 'background:rgba(56,189,248,0.18);color:#38bdf8;border-color:rgba(56,189,248,0.4);' : ''}">${slotTag}</span>
          </div>
        </div>
      </div>
      <button type="button" class="btn-source-eye ${isVisible ? 'visible' : ''}" id="btn-eye-${item.sceneItemId}" title="${isVisible ? 'Ocultar cámara' : 'Mostrar cámara'}" aria-label="${isVisible ? 'Ocultar' : 'Mostrar'} capa ${escapeHtml(item.sourceName)}">
        ${eyeIconHtml}
      </button>
    `;

    const eyeBtn = mainRow.querySelector('.btn-source-eye');
    eyeBtn.onclick = () => {
      const currentlyVisible = eyeBtn.classList.contains('visible');
      toggleSourceVisibility(item.sceneItemId, !currentlyVisible);
    };

    card.appendChild(mainRow);

    const actionsBar = document.createElement('div');
    actionsBar.className = 'source-actions-bar';
    const ic = (n) => (window.Icon ? window.Icon(n, { size: 12 }) : '');

    if (isSimCam) {
      actionsBar.innerHTML = `
        <button type="button" class="btn-source-preset ${isCamA ? 'active' : ''}" data-sim-slot="a" title="Asignar a Cámara A (Mesa 1 / Izquierda)">${ic('video')}<span>Mesa 1 (A)</span></button>
        <button type="button" class="btn-source-preset ${isCamB ? 'active' : ''}" data-sim-slot="b" title="Asignar a Cámara B (Mesa 2 / Derecha)">${ic('video')}<span>Mesa 2 (B)</span></button>
        <button type="button" class="btn-source-preset" data-sim-slot="full" title="Poner esta cámara en Pantalla Completa">${ic('maximize-2')}<span>Full</span></button>
        <button type="button" class="btn-source-preset" data-action="restart" title="Reiniciar video desde el inicio">${ic('rotate-ccw')}<span>Reiniciar</span></button>
        <button type="button" class="btn-source-preset" data-action="pause" title="Pausar video">${ic('pause')}<span>Pausa</span></button>
        <button type="button" class="btn-source-preset" data-action="play" title="Reproducir video">${ic('play')}<span>Play</span></button>
      `;
      actionsBar.querySelectorAll('button[data-sim-slot]').forEach(btn => {
        btn.onclick = () => {
          const slot = btn.dataset.simSlot;
          const selA = document.getElementById('select-cam-a');
          const selB = document.getElementById('select-cam-b');
          if (slot === 'a') {
            if (selA) selA.value = String(item.sceneItemId);
            applyCameraLayout(simCamerasState?.layout || 'split_lr');
          } else if (slot === 'b') {
            if (selB) selB.value = String(item.sceneItemId);
            applyCameraLayout(simCamerasState?.layout || 'split_lr');
          } else if (slot === 'full') {
            if (selA) selA.value = String(item.sceneItemId);
            applyCameraLayout('full_a');
          }
        };
      });
      actionsBar.querySelectorAll('button[data-action]').forEach(btn => {
        btn.onclick = () => triggerMedia(item.sourceName, btn.dataset.action);
      });
      card.appendChild(actionsBar);
    } else if (isMedia) {
      actionsBar.innerHTML = `
        <button type="button" class="btn-source-preset" data-action="restart" title="Reiniciar video desde el inicio">${ic('rotate-ccw')}<span>Reiniciar</span></button>
        <button type="button" class="btn-source-preset" data-action="pause" title="Pausar video">${ic('pause')}<span>Pausa</span></button>
        <button type="button" class="btn-source-preset" data-action="play" title="Reproducir video">${ic('play')}<span>Play</span></button>
        <button type="button" class="btn-source-preset" data-action="stop" title="Detener video">${ic('square')}<span>Stop</span></button>
      `;
      actionsBar.querySelectorAll('button').forEach(btn => {
        btn.onclick = () => triggerMedia(item.sourceName, btn.dataset.action);
      });
      card.appendChild(actionsBar);
    } else if (isVisual) {
      actionsBar.innerHTML = `
        <button type="button" class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'fullscreen')" title="Pantalla completa (1920x1080)">${ic('maximize-2')}<span>Full</span></button>
        <button type="button" class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'pip_br')" title="Picture-in-Picture: Esquina inferior">${ic('picture-in-picture-2')}<span>PiP Abajo</span></button>
        <button type="button" class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'pip_tr')" title="Picture-in-Picture: Esquina superior">${ic('picture-in-picture-2')}<span>PiP Arriba</span></button>
        <button type="button" class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'split_left')" title="Mitad izquierda de pantalla">${ic('columns-2')}<span>Izq.</span></button>
        <button type="button" class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'split_right')" title="Mitad derecha de pantalla">${ic('columns-2')}<span>Der.</span></button>
        <button type="button" class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'center_boxed')" title="Centrado con marco">${ic('layout-grid')}<span>Centro</span></button>
      `;
      card.appendChild(actionsBar);
    }

    container.appendChild(card);
  });
}

function updateItemVisibilityUI(sceneItemId, enabled) {
  const eyeBtn = document.getElementById(`btn-eye-${sceneItemId}`);
  if (eyeBtn) {
    eyeBtn.classList.toggle('visible', !!enabled);
    eyeBtn.innerHTML = window.Icon
      ? window.Icon(enabled ? 'eye' : 'eye-off', { size: 15 })
      : (enabled ? 'ON' : 'OFF');
    eyeBtn.title = enabled ? 'Ocultar capa' : 'Mostrar capa';
  }
}

function toggleSourceVisibility(sceneItemId, enabled) {
  sendWS({
    type: 'obs_toggle_item',
    sceneName: obsStatus.currentProgramScene,
    sceneItemId: Number(sceneItemId),
    enabled: !!enabled
  });
  updateItemVisibilityUI(sceneItemId, enabled);
  showToast(enabled ? 'Cámara visible en transmisión' : 'Cámara oculta en transmisión');
}

function setSourceTransformPreset(sceneItemId, preset) {
  sendWS({
    type: 'obs_set_item_transform_preset',
    sceneName: obsStatus.currentProgramScene,
    sceneItemId: Number(sceneItemId),
    preset
  });
  showToast(`Encuadre aplicado: ${preset}`);
}

function triggerMedia(inputName, action) {
  sendWS({
    type: 'obs_media_action',
    inputName,
    action
  });
  showToast(`Video ${inputName}: ${action}`);
}

// ── Director de Cámaras y Pantalla Dividida (Layouts) ──
let currentLayoutTarget = 'preview'; // 'preview' (PreEscena por defecto) o 'program' (Escena Principal)

function setLayoutTarget(target) {
  currentLayoutTarget = target;
  const btnPrev = document.getElementById('btn-dest-prev');
  const btnProg = document.getElementById('btn-dest-prog');
  const badge = document.getElementById('layout-target-badge');

  if (btnPrev) {
    btnPrev.textContent = 'PreEscena';
    btnPrev.classList.toggle('active', target === 'preview');
  }
  if (btnProg) {
    btnProg.textContent = 'Principal';
    btnProg.classList.toggle('active', target === 'program');
  }
  if (badge) {
    badge.textContent = target === 'preview' ? 'EDITANDO: PREESCENA' : 'DIRECTO: PRINCIPAL';
    badge.style.color = target === 'preview' ? '#fbbf24' : '#38bdf8';
  }
  // Sincronizar selectores con el bus seleccionado (PreEscena o Principal)
  if (hasActiveSimCameras()) {
    const bus = (target === 'preview' && simCamerasState.preview) ? simCamerasState.preview : simCamerasState;
    const selectA = document.getElementById('select-cam-a');
    const selectB = document.getElementById('select-cam-b');
    const bannerSelect = document.getElementById('select-banner-mode');
    if (selectA && bus.camAId) selectA.value = String(bus.camAId);
    if (selectB && bus.camBId) selectB.value = String(bus.camBId);
    if (bannerSelect && bus.bannerMode) bannerSelect.value = bus.bannerMode;
  }
}

function populateCameraLayoutSelectors(items, sceneName) {
  const directorBox = document.getElementById('camera-layout-director-box');
  const selectA = document.getElementById('select-cam-a');
  const selectB = document.getElementById('select-cam-b');
  const destBox = document.getElementById('layout-dest-box');
  const bannerSelect = document.getElementById('select-banner-mode');

  if (!directorBox || !selectA || !selectB) return;

  const simActive = hasActiveSimCameras();

  if (!obsStatus.connected && !simActive) {
    directorBox.style.display = 'none';
    return;
  }

  directorBox.style.display = 'flex';

  if (destBox) {
    destBox.style.display = (simActive || (obsStatus.connected && obsStatus.studioMode)) ? 'flex' : 'none';
  }
  if (simActive || (obsStatus.connected && obsStatus.studioMode)) {
    if (!currentLayoutTarget) currentLayoutTarget = 'preview';
    setLayoutTarget(currentLayoutTarget);
  } else {
    setLayoutTarget('program');
  }

  const visualItems = (items || []).filter(item => {
    const k = (item.inputKind || '').toLowerCase();
    return !k.includes('wasapi') && !k.includes('audio');
  });

  const activeBus = simCamerasState;
  const prevValA = simActive && activeBus.camAId ? String(activeBus.camAId) : selectA.value;
  const prevValB = simActive && activeBus.camBId ? String(activeBus.camBId) : selectB.value;

  selectA.innerHTML = '<option value="">Selecciona Cámara A...</option>';
  selectB.innerHTML = '<option value="">Selecciona Cámara B...</option>';

  visualItems.forEach(item => {
    const kindTag = item.isSimulated ? 'LOOP' : (item.inputKind || 'capa').replace('_source', '').replace('_input', '');
    const optA = document.createElement('option');
    optA.value = item.sceneItemId;
    optA.textContent = `${item.sourceName} (${kindTag})`;
    selectA.appendChild(optA);

    const optB = document.createElement('option');
    optB.value = item.sceneItemId;
    optB.textContent = `${item.sourceName} (${kindTag})`;
    selectB.appendChild(optB);
  });

  if (prevValA && visualItems.some(i => String(i.sceneItemId) === String(prevValA))) {
    selectA.value = prevValA;
  } else if (visualItems.length > 0) {
    selectA.value = visualItems[0].sceneItemId;
  }

  if (prevValB && visualItems.some(i => String(i.sceneItemId) === String(prevValB))) {
    selectB.value = prevValB;
  } else if (visualItems.length > 1) {
    selectB.value = visualItems[1].sceneItemId;
  }

  if (!selectA.dataset.simBound) {
    selectA.dataset.simBound = '1';
    selectA.addEventListener('change', () => {
      if (hasActiveSimCameras()) {
        applyCameraLayout(simCamerasState?.layout || 'split_lr');
      }
    });
  }
  if (!selectB.dataset.simBound) {
    selectB.dataset.simBound = '1';
    selectB.addEventListener('change', () => {
      if (hasActiveSimCameras()) {
        applyCameraLayout(simCamerasState?.layout || 'split_lr');
      }
    });
  }
  if (bannerSelect && !bannerSelect.dataset.simBound) {
    bannerSelect.dataset.simBound = '1';
    bannerSelect.addEventListener('change', () => {
      if (hasActiveSimCameras()) {
        applyCameraLayout(simCamerasState?.layout || 'split_lr');
      }
    });
  }
}

async function applyCameraLayout(layout) {
  const simActive = hasActiveSimCameras();
  if (!obsStatus.connected && !simActive) {
    showToast('Conecta OBS Studio primero', 'error');
    return;
  }

  const selectA = document.getElementById('select-cam-a');
  const selectB = document.getElementById('select-cam-b');
  const bannerMode = document.getElementById('select-banner-mode')?.value || 'none';

  const camAId = selectA?.value;
  const camBId = selectB?.value;

  if (!camAId && !camBId) {
    showToast('Selecciona al menos una cámara en los selectores', 'warning');
    return;
  }

  const target = simActive ? 'program' : ((obsStatus.connected && obsStatus.studioMode) ? currentLayoutTarget : 'program');
  const targetScene = (target === 'preview' && obsStatus.connected && obsStatus.studioMode)
    ? (obsStatus.currentPreviewScene || obsStatus.currentProgramScene)
    : obsStatus.currentProgramScene;

  try {
    const res = await fetch('/api/obs/apply-layout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sceneName: targetScene,
        target,
        camAId,
        camBId,
        layout,
        bannerMode
      })
    });
    const data = await res.json();
    if (data.ok) {
      if (data.state) {
        updateSimCamerasUI(data.state);
      }
      const layoutNames = {
        'split_lr': 'Pantalla Dividida (A | B)',
        'split_rl': 'Pantalla Dividida (B | A)',
        'split_tb': 'Pantalla Dividida (A sobre B)',
        'split_bt': 'Pantalla Dividida (B sobre A)',
        'pip_a_main': 'Picture-in-Picture (A Principal)',
        'pip_b_main': 'Picture-in-Picture (B Principal)',
        'full_a': 'Solo Cam A (Pantalla Completa)',
        'full_b': 'Solo Cam B (Pantalla Completa)',
        'swap': 'Posiciones Invertidas (Swap A ⇄ B)'
      };
      const destName = target === 'preview' ? 'PreEscena (Preparación)' : 'Escena Principal (Al Aire)';
      showToast(`¡Layout ${layoutNames[layout] || layout} aplicado a ${destName}!`, 'success');
      if (obsStatus.connected) {
        setTimeout(() => refreshStudioScreenshots(false), 200);
      }
    } else {
      showToast(`Error aplicando layout: ${data.error}`, 'error');
    }
  } catch (err) {
    showToast(`Error al aplicar layout: ${err.message}`, 'error');
  }
}

function renderScenes(scenes, currentProgram) {
  const container = document.getElementById('scenes-grid');
  container.innerHTML = '';

  const previewSelect = document.getElementById('studio-preview-scene-select');
  if (previewSelect) {
    const currentVal = previewSelect.value;
    previewSelect.innerHTML = '<option value="">Seleccionar escena...</option>';
    (scenes || []).forEach(name => {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === obsStatus.currentPreviewScene) opt.selected = true;
      previewSelect.appendChild(opt);
    });
    if (currentVal && scenes?.includes(currentVal)) previewSelect.value = currentVal;
  }

  if (!scenes || scenes.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;grid-column:1/-1;">Sin escenas detectadas en OBS</div>';
    return;
  }

  scenes.forEach(sceneName => {
    const tile = document.createElement('button');
    tile.type = 'button';
    const isProg = sceneName === currentProgram;
    const isPrev = !!(obsStatus.studioMode && sceneName === obsStatus.currentPreviewScene);

    tile.className = `scene-tile ${isProg ? 'program' : ''} ${isPrev ? 'preview' : ''}`;
    tile.dataset.scene = sceneName;

    tile.innerHTML = `
      <span class="scene-icon">${window.Icon ? window.Icon('tv', { size: 15 }) : ''}</span>
      <span class="scene-name">${escapeHtml(sceneName)}</span>
    `;

    tile.onclick = () => {
      if (obsStatus.studioMode) {
        switchOBSPreviewScene(sceneName);
      } else {
        switchOBSScene(sceneName);
      }
    };

    container.appendChild(tile);
  });
}

function highlightProgramScene(sceneName) {
  const tiles = document.querySelectorAll('.scene-tile');
  tiles.forEach(tile => {
    const isProg = tile.dataset.scene === sceneName;
    const isPrev = !!(obsStatus.studioMode && tile.dataset.scene === obsStatus.currentPreviewScene);
    tile.classList.toggle('program', isProg);
    tile.classList.toggle('preview', isPrev);
  });
}

function switchOBSScene(sceneName) {
  sendWS({ type: 'obs_set_scene', sceneName });
  highlightProgramScene(sceneName);
  showToast(`Escena OBS: ${sceneName}`);
}

function toggleStream() {
  sendWS({ type: 'obs_toggle_stream' });
}

function toggleRecord() {
  sendWS({ type: 'obs_toggle_record' });
}

function updateStreamButton(active) {
  const btn = document.getElementById('btn-stream-toggle');
  if (!btn) return;
  if (active) {
    btn.classList.add('active', 'live');
    btn.innerHTML = `<span class="status-dot danger"></span><span>Stream en vivo</span>`;
  } else {
    btn.classList.remove('active', 'live');
    btn.innerHTML = `<span class="status-dot"></span><span>Stream</span>`;
  }
}

function updateRecordButton(active) {
  const btn = document.getElementById('btn-record-toggle');
  if (!btn) return;
  if (active) {
    btn.classList.add('active', 'live');
    btn.innerHTML = `<span class="status-dot danger"></span><span>Grabando</span>`;
  } else {
    btn.classList.remove('active');
    btn.classList.remove('live');
    btn.innerHTML = `<span class="status-dot"></span><span>Grabar</span>`;
  }
}

async function connectToOBSManual() {
  const addressInput = document.getElementById('obs-address-input');
  const passwordInput = document.getElementById('obs-password-input');
  const address = addressInput?.value.trim() || 'ws://127.0.0.1:4455';
  const password = passwordInput?.value.trim() || '';

  showToast('Conectando a OBS Studio...', 'info');

  try {
    const res = await fetch('/api/obs/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, password })
    });
    const data = await res.json();
    if (data.ok) {
      if (password) localStorage.setItem('directoobs_obs_pwd', password);
      localStorage.setItem('directoobs_obs_addr', address);
      showToast('¡Conectado a OBS Studio con éxito!', 'success');
    } else {
      const errLower = (data.error || '').toLowerCase();
      if (errLower.includes('auth') || errLower.includes('identif') || errLower.includes('password')) {
        showToast('Error de autenticación: Ingresa la contraseña de OBS o desmarca "Habilitar autenticación" en los ajustes de OBS.', 'error');
      } else {
        showToast(`Error conectando a OBS: ${data.error}`, 'error');
      }
    }
  } catch (err) {
    showToast(`Error de conexión: ${err.message}`, 'error');
  }
}

// ── Control de Torneo WCA ──
function loadTournament(data) {
  tournamentData = data;
  const titleEl = document.getElementById('tournament-title');
  const clearBtn = document.getElementById('btn-clear-header');

  if (!data) {
    titleEl.textContent = 'Sin torneo cargado';
    titleEl.title = 'No hay datos de torneo activos';
    if (clearBtn) clearBtn.style.display = 'none';

    const emptyIcon = window.Icon ? window.Icon('database', { size: 18 }) : '';
    const dlIcon = window.Icon ? window.Icon('download', { size: 14 }) : '';

    document.getElementById('event-chips-bar').innerHTML = `
      <div class="admin-empty-state" style="width:100%;">
        <div class="admin-empty-icon">${emptyIcon}</div>
        <div class="admin-empty-title">No hay torneo cargado</div>
        <div class="admin-empty-desc">Importa una competencia oficial desde la WCA o carga un respaldo JSON local.</div>
        <button type="button" class="admin-btn admin-btn--ghost" onclick="switchMainMenu('database'); setTimeout(() => document.getElementById('wca-comp-id-input')?.focus(), 60);">
          ${dlIcon}<span>Importar torneo WCA</span>
        </button>
      </div>`;

    document.getElementById('competitors-scroll-list').innerHTML = `
      <div class="admin-empty-state">
        <div class="admin-empty-icon">${emptyIcon}</div>
        <div class="admin-empty-title">Directorio vacío</div>
        <div class="admin-empty-desc">Ingresa un WCA ID a la izquierda y descarga la competencia para listar los inscritos.</div>
      </div>`;

    const badgeEl = document.getElementById('tab-directory-count');
    if (badgeEl) badgeEl.textContent = '0';
    const navBadge = document.getElementById('nav-db-count');
    if (navBadge) navBadge.textContent = '0';
    const countTextEl = document.getElementById('directory-count-text');
    if (countTextEl) countTextEl.textContent = '0 competidores';
    const filterTag = document.getElementById('directory-filter-badge');
    if (filterTag) filterTag.style.display = 'none';

    document.getElementById('simulated-card').style.display = 'none';
    document.getElementById('sim-card-placeholder').style.display = 'block';
    document.getElementById('btn-show-competitor').disabled = true;
    return;
  }

  titleEl.textContent = data.name || 'Torneo WCA';
  titleEl.title = `Torneo: ${data.name}`;
  if (clearBtn) clearBtn.style.display = 'inline-flex';

  if (data.competition_id) {
    localStorage.setItem('directoobs_tournament_comp_id', data.competition_id);
    const wcaInput = document.getElementById('wca-comp-id-input');
    if (wcaInput && !wcaInput.value) {
      wcaInput.value = data.competition_id;
    }
  }

  autoDetectTickerInfo(false);

  // Renderizar chips de eventos
  renderEventChips(data.events || []);

  // Renderizar selector de filtro de eventos
  renderEventFilterOptions(data.events || []);

  // Renderizar lista de competidores en Base de Datos y en Banners
  filterCompetitorList();
  filterBannerCompetitorList();

  // Actualizar evento activo al nuevo torneo
  if (data.events && data.events.length > 0) {
    const evExists = data.events.find(e => e.event_id === selectedEventId);
    if (evExists) {
      selectEvent(selectedEventId);
    } else {
      selectEvent(data.events[0].event_id);
    }
  }

  const liveCompInput = document.getElementById('live-comp-id-input');
  if (liveCompInput && !liveCompInput.value && !liveRankingCompId && data.id) {
    liveCompInput.value = data.id;
  }
}

async function clearCurrentTournament() {
  try {
    const res = await fetch('/api/tournament/clear', { method: 'POST' });
    const data = await res.json();
    if (data.ok) {
      tournamentData = null;
      currentCompetitor = null;
      currentEvent = null;
      competitorVisible = false;
      eventVisible = false;
      loadTournament(null);
      showToast('Torneo limpiado. Listo para cargar uno nuevo.', 'info');
    }
  } catch (err) {
    showToast(`Error limpiando torneo: ${err.message}`, 'error');
  }
}

function renderEventChips(events) {
  const container = document.getElementById('event-chips-bar');
  if (!container) return;
  container.innerHTML = '';

  events.forEach(ev => {
    const chip = document.createElement('div');
    const isAct = ev.event_id === selectedEventId;
    chip.className = `event-chip ${isAct ? 'active' : ''}`;
    chip.dataset.eventId = ev.event_id;

    const roundCount = ev.rounds ? `${ev.rounds}R` : '';

    chip.innerHTML = `
      <div class="event-chip-icon-box">
        <img src="icons/${ev.event_id}.svg" alt="${ev.name}" onerror="this.style.display='none'">

      </div>
      <span class="event-chip-title">${getCleanEventName(ev.event_id, ev.name)}</span> ${roundCount ? `<span class="event-chip-rounds">${roundCount}</span>` : ''}
    `;

    chip.onclick = () => selectEvent(ev.event_id);
    container.appendChild(chip);
  });
}

function selectEvent(eventId) {
  selectedEventId = eventId;
  const ev = (tournamentData?.events || []).find(e => e.event_id === eventId);
  totalRounds = ev ? ev.rounds : 3;

  if (currentRound > totalRounds) currentRound = totalRounds;

  document.querySelectorAll('.event-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.eventId === eventId);
  });

  updateEventUI();
  updatePreviewUI();

  if (eventVisible) {
    sendShowEvent();
  }
}

function setRound(r) {
  if (r >= 1 && r <= totalRounds) {
    currentRound = r;
    updateEventUI();
    updatePreviewUI();
    if (eventVisible) {
      sendShowEvent();
    }
  }
}

function adjustRound(delta) {
  const newRound = currentRound + delta;
  if (newRound >= 1 && newRound <= totalRounds) {
    setRound(newRound);
  }
}

function updateEventUI() {
  const ev = (tournamentData?.events || []).find(e => e.event_id === selectedEventId);
  const cleanName = getCleanEventName(selectedEventId, ev ? ev.name : selectedEventId);

  const activeDisciplineBadge = document.getElementById('active-discipline-badge');
  if (activeDisciplineBadge) activeDisciplineBadge.textContent = cleanName;

  const cardIcon = document.getElementById('event-card-icon');
  if (cardIcon) {
    cardIcon.src = `icons/${selectedEventId}.svg`;
    cardIcon.style.display = 'block';
  }

  const cardTitle = document.getElementById('event-card-title');
  if (cardTitle) cardTitle.textContent = cleanName.toUpperCase();

  const cardSubtitle = document.getElementById('event-card-subtitle');
  if (cardSubtitle) cardSubtitle.textContent = tournamentData?.name ? tournamentData.name.toUpperCase() : 'WORLD CUBE ASSOCIATION';

  const roundBadge = document.getElementById('event-card-round-badge');
  if (roundBadge) {
    roundBadge.textContent = formatRoundName(currentRound, totalRounds);
  }

  const chipsContainer = document.getElementById('event-rounds-chips');
  if (chipsContainer) {
    chipsContainer.innerHTML = '';
    for (let r = 1; r <= totalRounds; r++) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `round-chip-btn ${r === currentRound ? 'active' : ''}`;
      
      let label = `R${r}`;
      if (r === totalRounds) label = totalRounds === 1 ? 'Final' : 'Final';
      else if (r === totalRounds - 1 && totalRounds >= 3) label = 'Semi';

      btn.textContent = label;
      btn.title = `Seleccionar Ronda ${r}`;
      btn.onclick = () => setRound(r);
      chipsContainer.appendChild(btn);
    }
  }
}

// ── Lógica del Ticker de Noticias Inferior (Lower-Third) ──
function getAutoDayAndDate() {
  const now = new Date();
  const daysOfWeek = ['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado'];
  const months = ['Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio', 'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre'];
  
  const dayName = daysOfWeek[now.getDay()];
  const dayNum = now.getDate();
  const monthName = months[now.getMonth()];
  const dateFormatted = `${dayName}, ${dayNum} de ${monthName}`;

  if (tournamentData?.start_date) {
    try {
      const startParts = tournamentData.start_date.split('-');
      if (startParts.length === 3) {
        const startDate = new Date(parseInt(startParts[0]), parseInt(startParts[1]) - 1, parseInt(startParts[2]));
        const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const diffTime = todayMidnight.getTime() - startDate.getTime();
        const diffDays = Math.round(diffTime / (1000 * 60 * 60 * 24)) + 1;

        if (diffDays >= 1 && diffDays <= 7) {
          return `Día ${diffDays} · ${dateFormatted}`;
        }
      }
    } catch (e) {
      console.warn('Error calculando día del torneo:', e);
    }
  }

  return `Día 1 · ${dateFormatted}`;
}

function getAutoVenue() {
  if (!tournamentData) return 'Sede Oficial';
  return tournamentData.venue || tournamentData.venue_address || tournamentData.city || 'Floridablanca, Santander';
}

function autoDetectTickerInfo(force = false) {
  const dayInput = document.getElementById('ticker-day-input');
  const venueInput = document.getElementById('ticker-venue-input');

  const autoDay = getAutoDayAndDate();
  const autoVenue = getAutoVenue();

  if (dayInput && (force || !dayInput.value.trim() || !tickerDay)) {
    dayInput.value = autoDay;
    tickerDay = autoDay;
    localStorage.setItem('directoobs_ticker_day', tickerDay);
  }

  if (venueInput && (force || !venueInput.value.trim() || !tickerVenue)) {
    venueInput.value = autoVenue;
    tickerVenue = autoVenue;
    localStorage.setItem('directoobs_ticker_venue', tickerVenue);
  }

  if (force) {
    showToast(`Detectado: ${autoDay} | ${autoVenue}`, 'success');
    if (eventVisible) {
      sendShowEvent();
    }
  }
}

function initTickerUI() {
  const dayInput = document.getElementById('ticker-day-input');
  const venueInput = document.getElementById('ticker-venue-input');

  if (!tickerDay) {
    tickerDay = getAutoDayAndDate();
    localStorage.setItem('directoobs_ticker_day', tickerDay);
  }
  if (!tickerVenue) {
    tickerVenue = getAutoVenue();
    localStorage.setItem('directoobs_ticker_venue', tickerVenue);
  }

  if (dayInput) dayInput.value = tickerDay;
  if (venueInput) venueInput.value = tickerVenue;

  setTickerSize(tickerSize, false);
  updateTickerLogoPreview();
  renderTickerNewsList();
}

function setTickerSize(size, broadcast = true) {
  const validSizes = ['small', 'medium', 'large'];
  tickerSize = validSizes.includes(size) ? size : 'small';
  try {
    localStorage.setItem('directoobs_ticker_size', tickerSize);
  } catch (e) {}

  document.querySelectorAll('#ticker-size-selector .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.size === tickerSize);
  });

  const badge = document.getElementById('ticker-size-badge');
  if (badge) {
    const labels = {
      'small': 'Pequeño (Por Defecto)',
      'medium': 'Intermedio',
      'large': 'Grande'
    };
    badge.textContent = labels[tickerSize] || 'Pequeño (Por Defecto)';
  }

  if (broadcast) {
    sendWS({
      type: 'set_ticker_size',
      size: tickerSize
    });
    const toastLabels = { 'small': 'Pequeño', 'medium': 'Intermedio', 'large': 'Grande' };
    showToast(`Tamaño del banner de noticias: ${toastLabels[tickerSize]}`, 'info');
  }
}

function renderTickerNewsList() {
  const container = document.getElementById('ticker-news-list');
  if (!container) return;

  container.innerHTML = '';

  if (tickerNewsList.length === 0) {
    container.innerHTML = `
      <div style="font-size:11px;color:var(--text-muted);font-style:italic;padding:6px 0;">
        Sin avisos especiales. Presiona <b>+ Agregar Noticia</b> para añadir uno.
      </div>`;
    return;
  }

  tickerNewsList.forEach((text, index) => {
    const row = document.createElement('div');
    row.style.display = 'flex';
    row.style.gap = '6px';
    row.style.alignItems = 'center';

    row.innerHTML = `
      <span style="font-family:'Space Mono',monospace;font-size:10px;font-weight:700;color:var(--text-muted);width:16px;text-align:center;">${index + 1}.</span>
      <input type="text" class="search-input news-item-input" value="${escapeHtml(text)}" placeholder="Escribe un aviso especial (ej: Próxima ronda a las 14:00)..." style="height:30px;font-size:12px;padding:3px 8px;flex:1;">
      <button type="button" class="admin-icon-btn remove-news-btn" title="Quitar este aviso" aria-label="Quitar este aviso">${window.Icon ? window.Icon('x', { size: 14 }) : '×'}</button>
    `;

    const input = row.querySelector('.news-item-input');
    input.addEventListener('input', (e) => {
      onTickerNewsItemChange(index, e.target.value);
    });

    const removeBtn = row.querySelector('.remove-news-btn');
    removeBtn.addEventListener('click', () => {
      removeTickerNewsItem(index);
    });

    container.appendChild(row);
  });
}

function addTickerNewsItem(defaultVal = '') {
  tickerNewsList.push(defaultVal);
  saveTickerNewsList();
  renderTickerNewsList();

  setTimeout(() => {
    const inputs = document.querySelectorAll('.news-item-input');
    if (inputs.length > 0) {
      const last = inputs[inputs.length - 1];
      last.focus();
    }
  }, 50);

  if (eventVisible) {
    sendShowEvent();
  }
}

function removeTickerNewsItem(index) {
  tickerNewsList.splice(index, 1);
  saveTickerNewsList();
  renderTickerNewsList();
  if (eventVisible) {
    sendShowEvent();
  }
}

let tickerNewsDebounce = null;
function onTickerNewsItemChange(index, value) {
  if (index >= 0 && index < tickerNewsList.length) {
    tickerNewsList[index] = value;
    saveTickerNewsList();

    if (eventVisible) {
      clearTimeout(tickerNewsDebounce);
      tickerNewsDebounce = setTimeout(() => {
        sendShowEvent();
      }, 300);
    }
  }
}

function saveTickerNewsList() {
  try {
    localStorage.setItem('directoobs_ticker_news_list', JSON.stringify(tickerNewsList));
  } catch (e) {
    console.warn('Error guardando tickerNewsList:', e);
  }
}

function updateTickerLogoPreview() {
  const imgEl = document.getElementById('panel-ticker-logo-img');
  const placeholderEl = document.getElementById('panel-ticker-logo-placeholder');
  if (imgEl && placeholderEl) {
    if (tickerTournamentLogo) {
      imgEl.src = tickerTournamentLogo;
      imgEl.style.display = 'block';
      placeholderEl.style.display = 'none';
    } else {
      imgEl.src = '';
      imgEl.style.display = 'none';
      placeholderEl.style.display = 'flex';
    }
  }
}

function handleTickerLogoUpload(event) {
  const file = event.target?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64Data = e.target.result;
    try {
      showToast('Guardando logo en el servidor...', 'info');
      const resp = await fetch('/api/tournament-logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ imageBase64: base64Data })
      });
      const result = await resp.json();
      if (result.ok && result.url) {
        tickerTournamentLogo = result.url;
        try {
          localStorage.setItem('directoobs_ticker_logo', result.url);
        } catch (err) {}
        updateTickerLogoPreview();
        showToast('Logo del torneo guardado con éxito', 'success');
        if (eventVisible) {
          sendShowEvent();
        }
      } else {
        throw new Error(result.error || 'Error al guardar');
      }
    } catch (err) {
      console.warn('Error subiendo logo al servidor, usando fallback local:', err);
      tickerTournamentLogo = base64Data;
      updateTickerLogoPreview();
      showToast('Logo cargado localmente', 'info');
      if (eventVisible) sendShowEvent();
    }
  };
  reader.readAsDataURL(file);
}

function clearTickerLogo() {
  tickerTournamentLogo = '';
  localStorage.removeItem('directoobs_ticker_logo');
  fetch('/api/tournament-logo/delete', { method: 'POST' }).catch(() => {});
  const fileInput = document.getElementById('ticker-logo-file-input');
  if (fileInput) fileInput.value = '';
  updateTickerLogoPreview();
  showToast('Logo del torneo eliminado', 'info');
  if (eventVisible) {
    sendShowEvent();
  }
}

let tickerInputDebounce = null;
function onTickerInputChange() {
  const dayInput = document.getElementById('ticker-day-input');
  const venueInput = document.getElementById('ticker-venue-input');

  tickerDay = dayInput ? dayInput.value.trim() : '';
  tickerVenue = venueInput ? venueInput.value.trim() : '';

  localStorage.setItem('directoobs_ticker_day', tickerDay);
  localStorage.setItem('directoobs_ticker_venue', tickerVenue);

  if (eventVisible) {
    clearTimeout(tickerInputDebounce);
    tickerInputDebounce = setTimeout(() => {
      sendShowEvent();
    }, 280);
  }
}

function sendShowEvent() {
  const ev = (tournamentData?.events || []).find(e => e.event_id === selectedEventId);
  const cleanName = getCleanEventName(selectedEventId, ev ? ev.name : selectedEventId);

  const venueValue = tickerVenue || getAutoVenue();
  const dayValue = tickerDay || getAutoDayAndDate();
  const activeNews = tickerNewsList.map(n => (n || '').trim()).filter(n => n.length > 0);

  const data = {
    event_id: selectedEventId,
    event_name: cleanName,
    round_number: currentRound,
    total_rounds: totalRounds,
    tournament_name: tournamentData?.name || 'Regionales Santander 2026',
    city: venueValue,
    venue: venueValue,
    day: dayValue,
    news: activeNews.join(' • '),
    news_list: activeNews,
    tournament_logo: tickerTournamentLogo || '',
    ticker_size: tickerSize || 'small'
  };

  currentEvent = data;
  eventVisible = true;
  sendWS({ type: 'event', data });
  updateVisibilityStates(competitorVisible, true);
  showToast(`Ticker en OBS: ${data.event_name} (${formatRoundName(currentRound, totalRounds)})`, 'success');
}

function sendHideEvent() {
  eventVisible = false;
  sendWS({ type: 'hide_event' });
  updateVisibilityStates(competitorVisible, false);
  showToast('Barra de noticias ocultada de OBS');
}

// ── Búsqueda y Configuración de Banner Broadcast (Euro 2026 Style) ──

function setBannerMode(mode, broadcast = true) {
  bannerMode = mode;
  document.querySelectorAll('#mode-selector .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  });

  const dualWrapper = document.getElementById('dual-selection-wrapper');
  const singleWrapper = document.getElementById('single-selection-wrapper');
  const simRow2 = document.getElementById('sim-row-2');

  if (mode === 'dual') {
    if (dualWrapper) dualWrapper.style.display = 'flex';
    if (singleWrapper) singleWrapper.style.display = 'none';
    if (simRow2) simRow2.style.display = 'grid';
  } else {
    if (dualWrapper) dualWrapper.style.display = 'none';
    if (singleWrapper) singleWrapper.style.display = 'block';
    if (simRow2) simRow2.style.display = 'none';
  }

  updatePreviewUI();
  if (broadcast) {
    sendWS({
      type: 'set_banner_config',
      mode: bannerMode,
      position: bannerPosition,
      align: bannerAlign,
      font: bannerFont
    });
  }
}

function setBannerPosition(pos, broadcast = true) {
  bannerPosition = pos;
  document.querySelectorAll('#position-selector .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.pos === pos);
  });
  updatePreviewUI();
  if (broadcast) {
    sendWS({
      type: 'set_banner_config',
      mode: bannerMode,
      position: bannerPosition,
      align: bannerAlign,
      font: bannerFont
    });
  }
}

function setBannerAlign(align = 'center', broadcast = true) {
  bannerAlign = 'center';
  updatePreviewUI();
  if (broadcast) {
    sendWS({
      type: 'set_banner_config',
      mode: bannerMode,
      position: bannerPosition,
      align: bannerAlign,
      font: bannerFont
    });
  }
}

function setBannerFont(font, broadcast = true) {
  bannerFont = font || 'barlow_slim';
  document.querySelectorAll('#font-selector .segment-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.font === bannerFont);
  });
  const simTable = document.getElementById('simulated-table');
  if (simTable) {
    simTable.classList.remove('font-barlow_slim', 'font-barlow_bold', 'font-inter', 'font-roboto');
    simTable.classList.add(`font-${bannerFont}`);
  }
  if (broadcast) {
    sendWS({
      type: 'set_banner_config',
      mode: bannerMode,
      position: bannerPosition,
      align: bannerAlign,
      font: bannerFont
    });
  }
}

function swapTables() {
  const tmp = currentCompetitor;
  currentCompetitor = currentCompetitor2;
  currentCompetitor2 = tmp;

  updatePreviewUI();
  sendWS({ type: 'swap_competitors' });
  showToast('Mesas 1 y 2 intercambiadas', 'info');
}

function selectCompetitor(c, slot = 1) {
  if (slot === 2 && bannerMode === 'single') {
    setBannerMode('dual');
  }
  if (slot === 1) {
    currentCompetitor = c;
    showToast(`Mesa 1: ${c.name}`, 'info');
  } else if (slot === 2) {
    currentCompetitor2 = c;
    showToast(`Mesa 2: ${c.name}`, 'info');
  }
  updatePreviewUI();
}

function selectCompetitorDirectly(c, targetSlot) {
  if (targetSlot === 1 || targetSlot === 2) {
    selectCompetitor(c, targetSlot);
  } else if (bannerMode === 'dual') {
    if (!currentCompetitor) selectCompetitor(c, 1);
    else if (!currentCompetitor2) selectCompetitor(c, 2);
    else selectCompetitor(c, 1);
  } else {
    selectCompetitor(c, 1);
  }
}

function closeAndClearSearch(targetSlot) {
  let menuId = 'search-results-menu';
  let inputId = 'competitor-search-input';

  if (targetSlot === 2) {
    menuId = 'search-results-slot-2';
    inputId = 'search-slot-2';
  } else if (targetSlot === 1 && bannerMode === 'dual') {
    menuId = 'search-results-slot-1';
    inputId = 'search-slot-1';
  } else {
    menuId = 'search-results-menu';
    inputId = 'competitor-search-input';
  }

  const resultsMenu = document.getElementById(menuId);
  if (resultsMenu) resultsMenu.classList.remove('open');

  const inp = document.getElementById(inputId);
  if (inp) inp.value = '';
}

function renderPill(slot, comp) {
  const flagEl = document.getElementById(slot === 'single' ? 'pill-flag-single' : `pill-flag-${slot}`);
  const nameEl = document.getElementById(slot === 'single' ? 'pill-name-single' : `pill-name-${slot}`);
  const statsEl = document.getElementById(slot === 'single' ? 'pill-stats-single' : `pill-stats-${slot}`);

  if (!nameEl) return;

  if (!comp) {
    if (flagEl) flagEl.innerHTML = '';
    nameEl.textContent = slot === 2 ? 'Mesa 2 sin competidor' : (slot === 1 ? 'Mesa 1 sin competidor' : 'Sin competidor seleccionado');
    if (statsEl) statsEl.textContent = 'Busca o selecciona de la lista';
    return;
  }

  if (flagEl) {
    flagEl.innerHTML = comp.country
      ? `<img src="https://flagcdn.com/w40/${comp.country.toLowerCase()}.png" alt="${comp.country}" style="width:24px;height:16px;border-radius:2px;" onerror="this.style.display='none'">`
      : '';
  }

  nameEl.textContent = comp.name;

  const pr = comp.prs && comp.prs[selectedEventId];
  const single = (pr && pr.single_fmt) ? pr.single_fmt : '—';
  const average = (pr && pr.average_fmt) ? pr.average_fmt : '—';
  const idStr = comp.is_new ? 'NUEVO' : (comp.wca_id || '—');

  if (statsEl) {
    statsEl.textContent = `${idStr} · Single: ${single} · Avg: ${average}`;
  }
}

function formatCustomRoundName(rNumOrName, total, fullText = false) {
  let rNum = null;
  let tot = parseInt(total, 10);

  if (typeof rNumOrName === 'number') {
    rNum = rNumOrName;
  } else if (typeof rNumOrName === 'string') {
    const s = rNumOrName.trim().toLowerCase();
    if (s.includes('semi')) return 'Semi final';
    if (s.includes('final') && !s.includes('semi')) return 'Final';

    const m = s.match(/(?:round|ronda|r)\s*(\d+)/i) || s.match(/(\d+)/);
    if (m) {
      rNum = parseInt(m[1], 10);
    } else if (s.includes('first') || s.includes('primera')) {
      rNum = 1;
    } else if (s.includes('second') || s.includes('segunda')) {
      rNum = 2;
    } else if (s.includes('third') || s.includes('tercera')) {
      rNum = 3;
    } else if (s.includes('fourth') || s.includes('cuarta')) {
      rNum = 4;
    }
  }

  if (!rNum) {
    return rNumOrName ? String(rNumOrName) : 'Final';
  }

  const prefix = fullText ? 'Ronda ' : 'R';

  if (!tot || isNaN(tot) || tot < 1) {
    return rNum === 1 ? (fullText ? 'Ronda 1' : 'R1') : `${prefix}${rNum}`;
  }

  // 1 Ronda:
  if (tot === 1) return 'Final';

  // 2 Rondas:
  if (tot === 2) return rNum >= 2 ? 'Final' : (fullText ? 'Ronda 1' : 'R1');

  // 3 Rondas:
  if (tot === 3) {
    if (rNum >= 3) return 'Final';
    if (rNum === 2) return 'Semi final';
    return fullText ? 'Ronda 1' : 'R1';
  }

  // 4 Rondas (o más):
  if (tot >= 4) {
    if (rNum >= tot) return 'Final';
    if (rNum === tot - 1) return 'Semi final';
    return `${prefix}${rNum}`;
  }

  return `${prefix}${rNum}`;
}

function formatRoundName(rNum, total) {
  return formatCustomRoundName(rNum, total);
}

function renderSimulatedRow(slot, comp) {
  const nameEl = document.getElementById(`sim-name-${slot}`);
  const flagEl = document.getElementById(`sim-flag-${slot}`);
  const wcaidEl = document.getElementById(`sim-wcaid-${slot}`);
  const singleEl = document.getElementById(`sim-single-${slot}`);
  const avgEl = document.getElementById(`sim-avg-${slot}`);

  if (!nameEl) return;

  if (!comp) {
    nameEl.textContent = slot === 1 ? 'Competidor 1' : 'Competidor 2';
    if (flagEl) flagEl.innerHTML = '';
    if (wcaidEl) wcaidEl.textContent = '—';
    if (singleEl) singleEl.textContent = '—';
    if (avgEl) avgEl.textContent = '—';
    return;
  }

  nameEl.textContent = comp.name;
  if (flagEl) {
    flagEl.innerHTML = comp.country
      ? `<img src="https://flagcdn.com/w40/${comp.country.toLowerCase()}.png" style="width:24px;height:16px;border-radius:2px;" onerror="this.style.display='none'">`
      : '';
  }

  if (wcaidEl) {
    wcaidEl.textContent = comp.is_new ? 'NUEVO' : (comp.wca_id || '—');
  }

  const pr = comp.prs && comp.prs[selectedEventId];
  if (singleEl) singleEl.textContent = (pr && pr.single_fmt) ? pr.single_fmt : '—';
  if (avgEl) avgEl.textContent = (pr && pr.average_fmt) ? pr.average_fmt : '—';
}

function updatePreviewUI() {
  const ind = document.getElementById('preview-pos-indicator');
  if (ind) {
    const posText = bannerPosition === 'top' ? 'ARRIBA' : 'ABAJO';
    ind.textContent = `${posText} · CENTRO`;
  }

  const evTitle = document.getElementById('sim-event-title');
  const evRound = document.getElementById('sim-round-title');
  if (evTitle) {
    const ev = (tournamentData?.events || []).find(e => e.event_id === selectedEventId);
    const cleanName = getCleanEventName(selectedEventId, ev ? ev.name : selectedEventId);
    evTitle.textContent = cleanName.toUpperCase();
  }
  if (evRound) {
    evRound.textContent = formatRoundName(currentRound, totalRounds);
  }

  renderPill(1, currentCompetitor);
  renderPill(2, currentCompetitor2);
  renderPill('single', currentCompetitor);

  renderSimulatedRow(1, currentCompetitor);
  renderSimulatedRow(2, currentCompetitor2);

  const simRow2 = document.getElementById('sim-row-2');
  if (simRow2) {
    simRow2.style.display = (bannerMode === 'dual') ? 'grid' : 'none';
  }

  updateShowcaseUI();
}

function handleSearchInput(query, targetSlot = 'single') {
  let menuId = 'search-results-menu';
  if (targetSlot === 'single') {
    menuId = 'search-results-menu';
  } else if (targetSlot === 2) {
    menuId = 'search-results-slot-2';
  } else if (targetSlot === 1) {
    menuId = (bannerMode === 'dual') ? 'search-results-slot-1' : 'search-results-menu';
  }

  const resultsMenu = document.getElementById(menuId);
  if (!resultsMenu) return;

  const q = query.trim().toLowerCase();
  if (!q || !tournamentData) {
    resultsMenu.classList.remove('open');
    return;
  }

  const allComps = tournamentData.competitors || [];
  const matches = allComps.filter(c =>
    (c.name || '').toLowerCase().includes(q) || (c.wca_id || '').toLowerCase().includes(q)
  ).slice(0, 8);

  resultsMenu.innerHTML = '';

  if (matches.length === 0 && q.length < 4) {
    resultsMenu.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:13px;text-align:center;">Sin competidores encontrados</div>';
    resultsMenu.classList.add('open');
    return;
  }
  matches.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = `search-result-item ${idx === 0 ? 'highlighted' : ''}`;

    const flagHtml = c.country
      ? `<img src="https://flagcdn.com/w40/${c.country.toLowerCase()}.png" style="width:22px;height:15px;border-radius:2px;" onerror="this.style.display='none'">`
      : '';

    item.innerHTML = `
      <div class="search-result-left" style="flex:1;min-width:0;">
        ${flagHtml}
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;">
          <div class="search-result-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(c.name)}</div>
          <div class="search-result-meta">${escapeHtml(c.wca_id || 'NUEVO COMPETIDOR')} · ${escapeHtml(c.country || '')}</div>
        </div>
      </div>
      <div class="search-result-actions">
        <button type="button" class="btn-assign-mini m1" title="Asignar a Mesa 1">M1</button>
        <button type="button" class="btn-assign-mini m2" title="Asignar a Mesa 2">M2</button>
        <button type="button" class="btn-assign-mini sel" title="Elegir competidor">Elegir</button>
      </div>
    `;

    item.querySelector('.btn-assign-mini.m1')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCompetitor(c, 1);
      closeAndClearSearch(targetSlot);
    });

    item.querySelector('.btn-assign-mini.m2')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCompetitor(c, 2);
      closeAndClearSearch(targetSlot);
    });

    item.querySelector('.btn-assign-mini.sel')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCompetitorDirectly(c, targetSlot);
      closeAndClearSearch(targetSlot);
    });

    item.onclick = () => {
      selectCompetitorDirectly(c, targetSlot);
      closeAndClearSearch(targetSlot);
    };

    resultsMenu.appendChild(item);
  });

  if (q.length >= 4) {
    const directWcaItem = document.createElement('div');
    directWcaItem.className = 'search-result-item';
    directWcaItem.style.background = 'rgba(0, 200, 255, 0.06)';
    directWcaItem.style.borderTop = '1px dashed var(--accent)';
    directWcaItem.innerHTML = `
      <div class="search-result-left">
        <span style="color:var(--admin-accent);display:inline-flex;">${window.Icon ? window.Icon('globe', { size: 16 }) : ''}</span>
        <div>
          <div class="search-result-name" style="color:var(--admin-accent);">Buscar WCA ID "${q.toUpperCase()}" en vivo</div>
          <div class="search-result-meta">Consultar tiempos y PRs en la base oficial WCA</div>
        </div>
      </div>
      <div>
        <span class="comp-list-badge new">Consultar</span>
      </div>
    `;

    directWcaItem.onclick = async () => {
      await fetchPersonByWcaId(q, targetSlot);
      resultsMenu.classList.remove('open');
      const inputId = targetSlot === 1 ? 'search-slot-1' : (targetSlot === 2 ? 'search-slot-2' : 'competitor-search-input');
      const inp = document.getElementById(inputId);
      if (inp) inp.value = '';
    };

    resultsMenu.appendChild(directWcaItem);
  }

  resultsMenu.classList.add('open');
}

async function fetchPersonByWcaId(wcaId, targetSlot = 1) {
  const cleanId = wcaId.trim().toUpperCase();
  showToast(`Consultando WCA ID: ${cleanId}...`, 'info');

  try {
    const res = await fetch(`/api/wca/person/${cleanId}`);
    const data = await res.json();
    if (data.ok && data.competitor) {
      selectCompetitor(data.competitor, targetSlot);
      showToast(`¡Encontrado! ${data.competitor.name} (${cleanId})`, 'success');
    } else {
      showToast(data.error || 'Competidor no encontrado en la WCA', 'error');
    }
  } catch (err) {
    showToast(`Error al consultar WCA: ${err.message}`, 'error');
  }
}

function sendShowCompetitor() {
  const ev = (tournamentData?.events || []).find(e => e.event_id === selectedEventId);
  const cleanName = getCleanEventName(selectedEventId, ev ? ev.name : selectedEventId);
  const eventPayload = {
    event_id: selectedEventId,
    event_name: cleanName,
    round_number: currentRound,
    total_rounds: totalRounds,
    tournament_name: tournamentData?.name || 'Regionales Santander 2026',
    city: tickerVenue || tournamentData?.city || 'Floridablanca, Santander',
    day: tickerDay || '',
    venue: tickerVenue || '',
    news_list: (Array.isArray(tickerNewsList) && tickerNewsList.length > 0) ? tickerNewsList : ['Sigue los resultados en directo por WCA Live'],
    tournament_logo: tickerTournamentLogo || '',
    ticker_size: tickerSize || 'small'
  };

  const payload = {
    mode: bannerMode,
    position: bannerPosition,
    align: bannerAlign,
    competitor1: currentCompetitor ? {
      name: currentCompetitor.name,
      wca_id: currentCompetitor.wca_id,
      is_new: currentCompetitor.is_new,
      country: currentCompetitor.country,
      prs: currentCompetitor.prs || {},
      current_event: selectedEventId
    } : null,
    competitor2: (bannerMode === 'dual' && currentCompetitor2) ? {
      name: currentCompetitor2.name,
      wca_id: currentCompetitor2.wca_id,
      is_new: currentCompetitor2.is_new,
      country: currentCompetitor2.country,
      prs: currentCompetitor2.prs || {},
      current_event: selectedEventId
    } : null,
    event: eventPayload,
    visible: true
  };

  competitorVisible = true;
  sendWS({ type: 'set_banner', data: payload });
  updateVisibilityStates(true, eventVisible);
  showToast('Banner broadcast mostrado en pantalla', 'success');
}

function sendHideCompetitor() {
  competitorVisible = false;
  sendWS({ type: 'hide_banner' });
  sendWS({ type: 'hide_competitor' });
  updateVisibilityStates(false, eventVisible);
  showToast('Banner ocultado de OBS');
}

function sendHideAll() {
  competitorVisible = false;
  eventVisible = false;
  showcaseVisible = false;
  bigLogoVisible = false;
  headToHeadVisible = false;
  liveRankingVisible = false;
  versusBannerVisible = false;
  sendWS({ type: 'hide_all' });
  updateVisibilityStates(false, false);
  updateShowcaseUI();
  updateBigLogoUI();
  updateHeadToHeadUI();
  updateLiveRankingUI();
  updateVersusUI();
  window.AdminUI?.syncAdminLiveNowUI();
  showToast('Todos los overlays ocultados de OBS', 'warning');
}

function updateVisibilityStates(compVis, evVis) {
  competitorVisible = !!compVis;
  eventVisible = !!evVis;

  const btnShowComp = document.getElementById('btn-show-competitor');
  const btnShowEv = document.getElementById('btn-show-event');
  const playIc = window.Icon ? window.Icon('play', { size: 15 }) : '';
  const checkIc = window.Icon ? window.Icon('check', { size: 15 }) : '';

  if (btnShowComp) {
    btnShowComp.innerHTML = competitorVisible
      ? `${checkIc}<span>Al aire en OBS</span><kbd>F8</kbd>`
      : `${playIc}<span>Mostrar en OBS</span><kbd>F8</kbd>`;
  }

  const deckCard = document.getElementById('event-deck-card');

  if (btnShowEv) {
    btnShowEv.innerHTML = eventVisible
      ? `${checkIc}<span>Al aire en OBS</span><kbd>F9</kbd>`
      : `${playIc}<span>Mostrar en OBS</span><kbd>F9</kbd>`;
  }
  if (deckCard) {
    deckCard.classList.toggle('is-live', eventVisible);
  }

  window.AdminUI?.syncAdminLiveNowUI();
}

// ── Lista y Filtros de Competidores ──
function renderEventFilterOptions(events) {
  const sel = document.getElementById('competitor-event-filter');
  if (sel) {
    sel.innerHTML = '<option value="">Todos los eventos</option>';
    events.forEach(ev => {
      const opt = document.createElement('option');
      opt.value = ev.event_id;
      opt.textContent = ev.name;
      sel.appendChild(opt);
    });
  }

  const bannerSel = document.getElementById('banner-comp-event-filter');
  if (bannerSel) {
    bannerSel.innerHTML = '<option value="">Todos los eventos</option>';
    events.forEach(ev => {
      const opt = document.createElement('option');
      opt.value = ev.event_id;
      opt.textContent = ev.name;
      bannerSel.appendChild(opt);
    });
    if (selectedEventId) bannerSel.value = selectedEventId;
  }
}

// Directorio en Base de Datos: SOLO LECTURA
function filterCompetitorList() {
  const badgeEl = document.getElementById('tab-directory-count');
  const countTextEl = document.getElementById('directory-count-text');
  const filterTag = document.getElementById('directory-filter-badge');

  if (!tournamentData) {
    if (badgeEl) badgeEl.textContent = '0';
    if (countTextEl) countTextEl.textContent = '0 competidores';
    if (filterTag) filterTag.style.display = 'none';
    return;
  }

  const allComps = tournamentData.competitors || [];
  const searchQ = (document.getElementById('competitor-list-search')?.value || '').toLowerCase();
  const eventF = document.getElementById('competitor-event-filter')?.value || '';

  const isFiltered = !!(searchQ || eventF);

  const filtered = allComps.filter(c => {
    if (searchQ && !c.name.toLowerCase().includes(searchQ) && !(c.wca_id || '').toLowerCase().includes(searchQ)) return false;
    if (eventF && !c.events.includes(eventF)) return false;
    return true;
  });

  if (badgeEl) badgeEl.textContent = allComps.length;
  const navBadge = document.getElementById('nav-db-count');
  if (navBadge) navBadge.textContent = allComps.length;
  if (filterTag) filterTag.style.display = isFiltered ? 'inline-block' : 'none';

  if (countTextEl) {
    if (filtered.length === allComps.length) {
      countTextEl.textContent = `${allComps.length} competidores registrados`;
    } else {
      countTextEl.textContent = `Mostrando ${filtered.length} de ${allComps.length} competidores`;
    }
  }

  const listContainer = document.getElementById('competitors-scroll-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (filtered.length === 0) {
    listContainer.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px;">Sin resultados</div>';
    return;
  }

  filtered.forEach(c => {
    const row = document.createElement('div');
    row.className = 'comp-list-row readonly';

    const flagHtml = c.country
      ? `<img src="https://flagcdn.com/w40/${c.country.toLowerCase()}.png" style="width:20px;height:14px;border-radius:2px;" onerror="this.style.display='none'">`
      : '';

    const eventsCount = Array.isArray(c.events) ? c.events.length : 0;
    const eventsBadges = Array.isArray(c.events)
      ? c.events.slice(0, 4).map(ev => `<span style="font-size:10.5px;font-weight:600;background:rgba(255,255,255,0.11);border:1px solid rgba(255,255,255,0.16);padding:2px 6px;border-radius:4px;color:var(--admin-text-primary);font-family:var(--admin-font-mono);">${ev}</span>`).join(' ')
      : '';
    const moreEvents = eventsCount > 4 ? `<span style="font-size:10.5px;color:var(--admin-accent);font-weight:700;font-family:var(--admin-font-mono);">+${eventsCount - 4}</span>` : '';

    const avatarHtml = c.avatar_url && !c.avatar_url.includes('missing_avatar')
      ? `<img src="${c.avatar_url}" style="width:26px;height:26px;border-radius:50%;object-fit:cover;border:1px solid rgba(255,255,255,0.18);flex-shrink:0;" onerror="this.style.display='none'">`
      : '';

    row.innerHTML = `
      <div class="comp-list-info" style="gap:10px;align-items:center;">
        ${avatarHtml}
        ${flagHtml}
        <div>
          <div class="comp-list-name" style="font-weight:600;">${escapeHtml(c.name)}</div>
          <div style="font-size:11.5px;font-weight:500;color:var(--admin-text-secondary);font-family:var(--admin-font-mono);display:flex;align-items:center;gap:6px;">
            <span>${escapeHtml(c.wca_id || 'NUEVO')}</span>
            <span>·</span>
            <span>${escapeHtml(c.country || '')}</span>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        <div style="display:flex;align-items:center;gap:4px;">
          ${eventsBadges} ${moreEvents}
        </div>
        ${c.is_new ? '<span class="comp-list-badge new">NUEVO</span>' : '<span class="comp-list-badge">WCA</span>'}
      </div>
    `;

    listContainer.appendChild(row);
  });
}

// ── Asignación Rápida de Competidores en Vista BANNERS ──
let bannerCompListOpen = false;

function toggleBannerCompList() {
  bannerCompListOpen = !bannerCompListOpen;
  const drawer = document.getElementById('banner-comp-list-drawer');
  const icon = document.getElementById('banner-comp-list-toggle-icon');
  const btnText = document.getElementById('banner-comp-list-btn-text');

  if (drawer) {
    drawer.style.display = bannerCompListOpen ? 'block' : 'none';
  }
  if (icon) {
    icon.innerHTML = window.Icon
      ? window.Icon(bannerCompListOpen ? 'chevron-down' : 'chevron-right', { size: 14 })
      : '';
  }
  if (btnText) {
    btnText.textContent = bannerCompListOpen ? 'Cerrar lista' : 'Abrir lista';
  }

  if (bannerCompListOpen) {
    filterBannerCompetitorList();
  }
}

function filterBannerCompetitorList() {
  const countBadge = document.getElementById('banner-comp-count');
  if (!tournamentData) {
    if (countBadge) countBadge.textContent = '0';
    return;
  }

  const allComps = tournamentData.competitors || [];
  if (countBadge) countBadge.textContent = allComps.length;

  const searchQ = (document.getElementById('banner-comp-search-input')?.value || '').toLowerCase();
  const eventF = document.getElementById('banner-comp-event-filter')?.value || '';

  const filtered = allComps.filter(c => {
    if (searchQ && !c.name.toLowerCase().includes(searchQ) && !(c.wca_id || '').toLowerCase().includes(searchQ)) return false;
    if (eventF && !c.events.includes(eventF)) return false;
    return true;
  });

  const listContainer = document.getElementById('banner-comp-scroll-list');
  if (!listContainer) return;
  listContainer.innerHTML = '';

  if (filtered.length === 0) {
    listContainer.innerHTML = '<div style="color:var(--text-muted);font-size:12px;padding:10px;text-align:center;">Sin coincidencias</div>';
    return;
  }

  filtered.slice(0, 60).forEach(c => {
    const row = document.createElement('div');
    row.className = 'banner-comp-row';

    const flagHtml = c.country
      ? `<img src="https://flagcdn.com/w40/${c.country.toLowerCase()}.png" style="width:18px;height:12px;border-radius:2px;" onerror="this.style.display='none'">`
      : '';

    row.innerHTML = `
      <div class="banner-comp-info" title="Haga clic para seleccionar">
        ${flagHtml}
        <div style="min-width:0;overflow:hidden;text-overflow:ellipsis;">
          <div class="banner-comp-name">${escapeHtml(c.name)}</div>
          <div class="banner-comp-meta">${escapeHtml(c.wca_id || 'NUEVO')} · ${escapeHtml(c.country || '')}</div>
        </div>
      </div>
      <div class="search-result-actions">
        <button type="button" class="btn-assign-mini m1" title="Asignar a Mesa 1">M1</button>
        <button type="button" class="btn-assign-mini m2" title="Asignar a Mesa 2">M2</button>
        <button type="button" class="btn-assign-mini sel" title="Elegir competidor">Elegir</button>
      </div>
    `;

    row.querySelector('.btn-assign-mini.m1')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCompetitor(c, 1);
    });

    row.querySelector('.btn-assign-mini.m2')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCompetitor(c, 2);
    });

    row.querySelector('.btn-assign-mini.sel')?.addEventListener('click', (e) => {
      e.stopPropagation();
      selectCompetitorDirectly(c);
    });

    row.querySelector('.banner-comp-info')?.addEventListener('click', () => {
      selectCompetitorDirectly(c);
    });

    listContainer.appendChild(row);
  });
}


// ── Ingesta WCA Directa y Refresco de Directorio ──
async function refreshTournamentDirectory() {
  const compId = (
    tournamentData?.competition_id ||
    tournamentData?.id ||
    document.getElementById('wca-comp-id-input')?.value.trim() ||
    localStorage.getItem('directoobs_tournament_comp_id') ||
    ''
  ).trim();

  if (!compId) {
    showToast('No hay un ID de torneo cargado. Ingresa el ID oficial en la pestaña API WCA.', 'warning');
    switchTab('wca');
    const compInput = document.getElementById('wca-comp-id-input');
    if (compInput) compInput.focus();
    return;
  }

  // Sincronizar input y almacenamiento
  const compInput = document.getElementById('wca-comp-id-input');
  if (compInput) compInput.value = compId;
  localStorage.setItem('directoobs_tournament_comp_id', compId);

  const refreshBtn = document.getElementById('btn-refresh-directory');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('is-refreshing');
    const textSpan = refreshBtn.querySelector('.btn-text');
    if (textSpan) textSpan.textContent = 'Actualizando...';
  }

  const wcaBtn = document.getElementById('btn-wca-fetch');
  if (wcaBtn) {
    wcaBtn.disabled = true;
    wcaBtn.textContent = 'Descargando...';
  }

  showToast(`Actualizando lista de inscritos para "${compId}" desde WCA...`, 'info');

  try {
    const res = await fetch('/api/wca/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competitionId: compId })
    });
    const data = await res.json();
    if (!data.ok) {
      showToast(`Error: ${data.error}`, 'error');
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('is-refreshing');
        const textSpan = refreshBtn.querySelector('.btn-text');
        if (textSpan) textSpan.textContent = 'Actualizar';
      }
      if (wcaBtn) {
        wcaBtn.disabled = false;
        wcaBtn.textContent = 'Descargar desde WCA';
      }
    }
  } catch (err) {
    showToast(`Error al actualizar inscritos: ${err.message}`, 'error');
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-refreshing');
      const textSpan = refreshBtn.querySelector('.btn-text');
      if (textSpan) textSpan.textContent = 'Actualizar';
    }
    if (wcaBtn) {
      wcaBtn.disabled = false;
      wcaBtn.textContent = 'Descargar desde WCA';
    }
  }
}

async function triggerWCAFetch() {
  const compId = document.getElementById('wca-comp-id-input').value.trim();
  if (!compId) {
    showToast('Ingresa un ID de competencia WCA', 'error');
    return;
  }

  localStorage.setItem('directoobs_tournament_comp_id', compId);

  const btn = document.getElementById('btn-wca-fetch');
  btn.disabled = true;
  btn.textContent = 'Descargando...';

  const refreshBtn = document.getElementById('btn-refresh-directory');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.classList.add('is-refreshing');
    const textSpan = refreshBtn.querySelector('.btn-text');
    if (textSpan) textSpan.textContent = 'Actualizando...';
  }

  try {
    const res = await fetch('/api/wca/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ competitionId: compId })
    });
    const data = await res.json();
    if (data.ok) {
      showToast('Descarga iniciada. Sigue el progreso abajo.', 'success');
    } else {
      showToast(`Error: ${data.error}`, 'error');
      btn.disabled = false;
      btn.textContent = 'Descargar desde WCA';
      if (refreshBtn) {
        refreshBtn.disabled = false;
        refreshBtn.classList.remove('is-refreshing');
        const textSpan = refreshBtn.querySelector('.btn-text');
        if (textSpan) textSpan.textContent = 'Actualizar';
      }
    }
  } catch (err) {
    showToast(`Error al iniciar descarga: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Descargar desde WCA';
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-refreshing');
      const textSpan = refreshBtn.querySelector('.btn-text');
      if (textSpan) textSpan.textContent = 'Actualizar';
    }
  }
}

function updateWCAProgress(pct, message, status) {
  const container = document.getElementById('wca-progress-box');
  if (container) container.style.display = 'flex';

  const fill = document.getElementById('wca-progress-fill');
  const text = document.getElementById('wca-progress-status-text');
  const btn = document.getElementById('btn-wca-fetch');
  const refreshBtn = document.getElementById('btn-refresh-directory');

  if (fill) fill.style.transform = `scaleX(${Math.min(Math.max(pct, 0), 100) / 100})`;
  if (text) text.textContent = `[${pct}%] ${message}`;

  if (status === 'ok' || pct >= 100) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Descargar desde WCA';
    }
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-refreshing');
      const textSpan = refreshBtn.querySelector('.btn-text');
      if (textSpan) textSpan.textContent = 'Actualizar';
    }
    showToast('¡Datos WCA descargados y listos!', 'success');
  } else if (status === 'error') {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Descargar desde WCA';
    }
    if (refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.classList.remove('is-refreshing');
      const textSpan = refreshBtn.querySelector('.btn-text');
      if (textSpan) textSpan.textContent = 'Actualizar';
    }
    showToast(message, 'error');
  }
}

// ── Carga de JSON Local ──
function handleJSONUpload(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = JSON.parse(e.target.result);
      const res = await fetch('/api/tournament', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data, filename: file.name })
      });
      const resData = await res.json();
      if (resData.ok) {
        loadTournament(data);
        showToast(`JSON cargado: ${data.name}`, 'success');
      }
    } catch (err) {
      showToast('Archivo JSON no válido', 'error');
    }
  };
  reader.readAsText(file);
}

// ── UI Helpers ──
function updateWsIndicator(connected) {
  const dot = document.getElementById('ws-status-dot');
  const text = document.getElementById('ws-status-text');
  if (connected) {
    dot.className = 'status-dot active';
    text.textContent = 'Servidor conectado';
  } else {
    dot.className = 'status-dot danger';
    text.textContent = 'Servidor desconectado';
  }
  window.AdminUI?.syncAdminLiveNowUI();
}

function updateOverlayCount(count) {
  const badge = document.getElementById('overlay-count-badge');
  if (badge) badge.textContent = `${count} overlay(s) OBS`;
}

function switchMainMenu(menuKey) {
  if (window.AdminUI && typeof window.AdminUI.activateAdminView === 'function') {
    window.AdminUI.activateAdminView(menuKey);
    return;
  }
  const normalized = (!menuKey || menuKey === 'banners') ? 'mesa' : menuKey;
  document.querySelectorAll('.deck-nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.nav === normalized);
  });
  document.querySelectorAll('.main-view-panel').forEach(view => {
    const active = view.id === `view-${normalized}`;
    view.classList.toggle('active', active);
    view.hidden = !active;
  });
  localStorage.setItem('directoobs_active_menu', normalized);
}

function switchTab(tabId) {
  if (['database', 'scenes', 'banners', 'mesa', 'clasificacion', 'finales', 'pantalla'].includes(tabId)) {
    switchMainMenu(tabId);
    return;
  }
  if (tabId === 'wca' || tabId === 'directory' || tabId === 'json' || tabId === 'live') {
    switchMainMenu('database');
  }
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  });
  document.querySelectorAll('.tab-content').forEach(content => {
    content.classList.toggle('active', content.id === `tab-${tabId}`);
  });
}

function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const iconMap = {
    success: 'check-circle-2',
    error: 'alert-circle',
    warning: 'alert-triangle',
    info: 'info'
  };
  const iconHtml = window.Icon ? window.Icon(iconMap[type] || 'info', { size: 16 }) : '';

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.tabIndex = 0;
  toast.innerHTML = `${iconHtml}<span style="flex:1;min-width:0;">${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  let timerId = null;
  const scheduleDismiss = (delay = 3400) => {
    clearTimeout(timerId);
    timerId = setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(8px)';
      toast.style.transition = 'opacity 180ms ease, transform 180ms ease';
      setTimeout(() => toast.remove(), 190);
    }, delay);
  };

  toast.addEventListener('mouseenter', () => clearTimeout(timerId));
  toast.addEventListener('mouseleave', () => scheduleDismiss(1800));
  toast.addEventListener('focusin', () => clearTimeout(timerId));
  toast.addEventListener('focusout', () => scheduleDismiss(1800));

  scheduleDismiss();
}

// ── Event Listeners y Atajos de Teclado ──
function setupEventListeners() {
  const searchInput1 = document.getElementById('search-slot-1');
  const searchInput2 = document.getElementById('search-slot-2');
  const searchInputSingle = document.getElementById('competitor-search-input');

  if (searchInput1) {
    searchInput1.addEventListener('input', (e) => handleSearchInput(e.target.value, 1));
    searchInput1.addEventListener('focus', (e) => {
      if (e.target.value.trim()) handleSearchInput(e.target.value, 1);
    });
  }
  if (searchInput2) {
    searchInput2.addEventListener('input', (e) => handleSearchInput(e.target.value, 2));
    searchInput2.addEventListener('focus', (e) => {
      if (e.target.value.trim()) handleSearchInput(e.target.value, 2);
    });
  }
  if (searchInputSingle) {
    searchInputSingle.addEventListener('input', (e) => handleSearchInput(e.target.value, 'single'));
    searchInputSingle.addEventListener('focus', (e) => {
      if (e.target.value.trim()) handleSearchInput(e.target.value, 'single');
    });
  }

  document.addEventListener('click', (e) => {
    const menu1 = document.getElementById('search-results-slot-1');
    const menu2 = document.getElementById('search-results-slot-2');
    const menuSingle = document.getElementById('search-results-menu');

    if (searchInput1 && menu1 && !searchInput1.contains(e.target) && !menu1.contains(e.target)) {
      menu1.classList.remove('open');
    }
    if (searchInput2 && menu2 && !searchInput2.contains(e.target) && !menu2.contains(e.target)) {
      menu2.classList.remove('open');
    }
    if (searchInputSingle && menuSingle && !searchInputSingle.contains(e.target) && !menuSingle.contains(e.target)) {
      menuSingle.classList.remove('open');
    }
  });

  const savedAddr = localStorage.getItem('directoobs_obs_addr');
  if (savedAddr && document.getElementById('obs-address-input')) {
    document.getElementById('obs-address-input').value = savedAddr;
  }
  const savedPwd = localStorage.getItem('directoobs_obs_pwd');
  if (savedPwd && document.getElementById('obs-password-input')) {
    document.getElementById('obs-password-input').value = savedPwd;
  }
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const searchInput1 = document.getElementById('search-slot-1');
    const searchInputSingle = document.getElementById('competitor-search-input');
    const targetSearch = (bannerMode === 'dual' ? searchInput1 : searchInputSingle) || searchInput1 || searchInputSingle;

    // Atajo '/' para enfocar buscador de competidores sin interferir con inputs activos
    if (e.key === '/' && targetSearch && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      const mesaPanel = document.getElementById('view-mesa');
      if (mesaPanel && mesaPanel.hidden) {
        switchMainMenu('mesa');
      }
      targetSearch.focus();
      targetSearch.select();
    }

    // Atajos de producción
    if (e.key === 'F8') {
      e.preventDefault();
      if (competitorVisible) sendHideCompetitor();
      else sendShowCompetitor();
    }

    if (e.key === 'F9') {
      e.preventDefault();
      if (eventVisible) sendHideEvent();
      else sendShowEvent();
    }

    if (e.key === 'F10') {
      e.preventDefault();
      sendHideAll();
    }

    // Atajo Barra Espaciadora para Transición en Modo Estudio
    if (e.code === 'Space' && obsStatus.studioMode && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) {
      e.preventDefault();
      triggerStudioTransition();
    }
  });
}

// ══════════════════════════════════════════════════════════════════
// ── FUNCIONES DE CONTROL DE RANKING EN VIVO (WCA LIVE) ──
// ══════════════════════════════════════════════════════════════════

function populateLiveRoundSelect(targetRoundId = null) {
  const select = document.getElementById('live-round-select');
  if (!select) return;

  if (!liveRankingRounds || liveRankingRounds.length === 0) {
    select.innerHTML = '<option value="">No hay rondas disponibles</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = liveRankingRounds.map(r => {
    const eName = EVENT_NAMES[r.eventId] || r.eventName || r.eventId;
    return `<option value="${r.roundId}">${eName} - ${r.roundName} (Ronda ${r.roundNumber})</option>`;
  }).join('');
  select.disabled = false;

  const toSelect = targetRoundId || liveRankingSelectedRoundId || localStorage.getItem('directoobs_live_round_id');
  if (toSelect && liveRankingRounds.some(r => r.roundId === toSelect)) {
    select.value = toSelect;
    liveRankingSelectedRoundId = toSelect;
  } else {
    select.value = liveRankingRounds[0].roundId;
    liveRankingSelectedRoundId = select.value;
  }
}

async function loadLiveCompetitionRounds(targetRoundId = null, silent = false) {
  const input = document.getElementById('live-comp-id-input');
  let compId = input ? input.value.trim() : '';
  if (!compId) {
    compId = liveRankingCompId || localStorage.getItem('directoobs_live_comp_id') || '';
    if (input && compId) input.value = compId;
  }
  if (!compId && tournamentData && tournamentData.id) {
    compId = tournamentData.id;
    if (input) input.value = compId;
  }
  if (!compId) {
    if (!silent) showToast('Ingresa un ID de competencia de WCA Live', 'warning');
    return;
  }

  if (!silent) showToast(`Buscando competencia ${compId} en WCA Live...`, 'info');
  try {
    const res = await fetch(`/api/live/competitions/${encodeURIComponent(compId)}`);
    const data = await res.json();
    if (!data.ok || !data.competition) {
      if (!silent) showToast(data.error || 'No se pudo cargar la competencia de WCA Live', 'error');
      return;
    }

    liveRankingCompId = compId;
    liveRankingRounds = data.competition.rounds || [];
    localStorage.setItem('directoobs_live_comp_id', compId);

    if (!silent) {
      showToast(`Cargada: ${data.competition.name} (${liveRankingRounds.length} rondas)`, 'success');
    }

    const preferredRound = targetRoundId || liveRankingSelectedRoundId || localStorage.getItem('directoobs_live_round_id');
    populateLiveRoundSelect(preferredRound);
    populateVersusRoundSelect(versusRoundId || preferredRound);

    if (liveRankingSelectedRoundId) {
      localStorage.setItem('directoobs_live_round_id', liveRankingSelectedRoundId);
      sendWS({
        type: 'live_ranking_comp_selected',
        compId: liveRankingCompId,
        roundId: liveRankingSelectedRoundId,
        rounds: liveRankingRounds
      });
      // Cargar automáticamente los datos de la ronda seleccionada si no los tenemos
      if (!liveRankingData || liveRankingData.roundId !== liveRankingSelectedRoundId) {
        fetchLiveRoundRanking(liveRankingSelectedRoundId);
      }
    }
  } catch (err) {
    if (!silent) showToast(`Error al consultar WCA Live: ${err.message}`, 'error');
  }
}

async function fetchLiveRoundRanking(roundId, isUserTriggered = false) {
  if (!roundId) return;
  try {
    // Pedir con top=0 para recibir la lista completa de competidores y poder paginarla
    const fetchTop = liveRankingDynamicPaging ? 0 : liveRankingTop;
    const res = await fetch(`/api/live/rounds/${roundId}?top=${fetchTop}&cutoff=${liveRankingCutoff}`);
    const data = await res.json();
    if (data.ok && data.ranking) {
      liveRankingData = data.ranking;
      renderLiveRankingPreview(liveRankingData);
      if (isUserTriggered) {
        showToast('Resultados en vivo actualizados', 'success');
      }
      if (liveRankingVisible) {
        sendWS({
          type: 'live_ranking_show',
          roundId: liveRankingSelectedRoundId,
          compId: liveRankingCompId,
          top: liveRankingTop,
          pageSize: liveRankingTop,
          pageDuration: liveRankingPageDuration,
          dynamicPaging: liveRankingDynamicPaging,
          autoBalance: liveRankingAutoBalance,
          cutoff: liveRankingCutoff,
          pollInterval: liveRankingPollInterval,
          data: liveRankingData
        });
      }
    } else {
      if (isUserTriggered) showToast(data.error || 'Error al obtener ranking', 'error');
    }
  } catch (err) {
    if (isUserTriggered) showToast(`Error: ${err.message}`, 'error');
  }
}

function onLiveRoundChanged() {
  const select = document.getElementById('live-round-select');
  if (!select) return;
  liveRankingSelectedRoundId = select.value;
  localStorage.setItem('directoobs_live_round_id', liveRankingSelectedRoundId);
  sendWS({
    type: 'live_ranking_select_round',
    roundId: liveRankingSelectedRoundId,
    compId: liveRankingCompId
  });
  fetchLiveRoundRanking(liveRankingSelectedRoundId, true);
}

function onLiveParamsChanged() {
  const topInput = document.getElementById('live-top-input');
  const topSel = document.getElementById('live-top-select');
  const cutInput = document.getElementById('live-cutoff-input') || document.getElementById('live-cutoff-select');
  const modeSel = document.getElementById('live-paging-mode-select');
  const balSel = document.getElementById('live-balance-select');
  const durSel = document.getElementById('live-page-duration-select');

  if (topInput) liveRankingTop = Math.max(1, Math.min(60, parseInt(topInput.value, 10) || 16));
  else if (topSel) liveRankingTop = parseInt(topSel.value, 10) || 16;

  if (cutInput) {
    const val = parseInt(cutInput.value, 10);
    liveRankingCutoff = isNaN(val) || val < 0 ? 0 : val;
  }
  if (modeSel) liveRankingDynamicPaging = modeSel.value === 'dynamic';
  if (balSel) liveRankingAutoBalance = balSel.value === 'balanced';
  if (durSel) liveRankingPageDuration = parseInt(durSel.value, 10) || 10;

  localStorage.setItem('directoobs_live_top', liveRankingTop);
  localStorage.setItem('directoobs_live_cutoff', liveRankingCutoff);
  localStorage.setItem('directoobs_live_dynamic_paging', liveRankingDynamicPaging);
  localStorage.setItem('directoobs_live_auto_balance', liveRankingAutoBalance);
  localStorage.setItem('directoobs_live_page_duration', liveRankingPageDuration);

  sendWS({
    type: 'live_ranking_params',
    top: liveRankingTop,
    pageSize: liveRankingTop,
    cutoff: liveRankingCutoff,
    dynamicPaging: liveRankingDynamicPaging,
    autoBalance: liveRankingAutoBalance,
    pageDuration: liveRankingPageDuration
  });

  updatePagingSummary();

  if (liveRankingSelectedRoundId) {
    fetchLiveRoundRanking(liveRankingSelectedRoundId, false);
  } else if (liveRankingVisible) {
    sendWS({
      type: 'live_ranking_show',
      roundId: liveRankingSelectedRoundId,
      compId: liveRankingCompId,
      top: liveRankingTop,
      pageSize: liveRankingTop,
      pageDuration: liveRankingPageDuration,
      dynamicPaging: liveRankingDynamicPaging,
      autoBalance: liveRankingAutoBalance,
      cutoff: liveRankingCutoff,
      pollInterval: liveRankingPollInterval,
      data: liveRankingData
    });
  }
}

function onLivePollingChanged() {
  const pollSel = document.getElementById('live-polling-select');
  if (!pollSel) return;
  liveRankingPollInterval = parseInt(pollSel.value, 10) || 0;
  localStorage.setItem('directoobs_live_poll_interval', liveRankingPollInterval);
  sendWS({
    type: 'live_ranking_poll_config',
    pollInterval: liveRankingPollInterval
  });
  if (liveRankingPollInterval > 0) {
    showToast(`Auto-actualización configurada cada ${liveRankingPollInterval}s`, 'info');
  } else {
    showToast('Auto-actualización desactivada', 'info');
  }
}

function refreshCurrentLiveRanking() {
  if (!liveRankingSelectedRoundId) {
    showToast('Selecciona una ronda primero', 'warning');
    return;
  }
  fetchLiveRoundRanking(liveRankingSelectedRoundId, true);
}

let liveRankingViewMode = 'fullscreen'; // 'fullscreen' | 'widget'

function setRankingViewMode(mode) {
  liveRankingViewMode = mode;
  updateViewModeButtons();
  sendWS({
    type: 'live_ranking_set_view',
    viewMode: mode
  });
  updateLiveRankingUI();
  showToast(`Modo cambiado a: ${mode === 'fullscreen' ? 'Pantalla Completa' : 'Mini Widget'}`, 'info');
}

function updateViewModeButtons() {
  const btnFs = document.getElementById('btn-mode-fs');
  const btnW = document.getElementById('btn-mode-widget');
  if (btnFs && btnW) {
    if (liveRankingViewMode === 'fullscreen') {
      btnFs.classList.add('active');
      btnW.classList.remove('active');
    } else {
      btnW.classList.add('active');
      btnFs.classList.remove('active');
    }
  }
}

function sendShowLiveRanking() {
  if (!liveRankingSelectedRoundId && !isRankingMockActive) {
    showToast('Selecciona una ronda de WCA Live o usa "Mockear Tabla"', 'warning');
    return;
  }

  // Si no tenemos datos aún y no es mock, intentar cargar y luego mostrar
  if (!liveRankingData && !isRankingMockActive) {
    fetchLiveRoundRanking(liveRankingSelectedRoundId).then(() => {
      sendWS({
        type: 'live_ranking_show',
        roundId: liveRankingSelectedRoundId,
        compId: liveRankingCompId,
        top: liveRankingTop,
        pageSize: liveRankingTop,
        pageDuration: liveRankingPageDuration,
        dynamicPaging: liveRankingDynamicPaging,
        autoBalance: liveRankingAutoBalance,
        cutoff: liveRankingCutoff,
        pollInterval: liveRankingPollInterval,
        viewMode: liveRankingViewMode,
        data: liveRankingData
      });
      liveRankingVisible = true;
      updateLiveRankingUI();
      showToast('Ranking en Vivo AL AIRE en OBS', 'success');
    });
    return;
  }

  sendWS({
    type: 'live_ranking_show',
    roundId: liveRankingSelectedRoundId || 'mock_ranking_round',
    compId: liveRankingCompId || 'mock_comp',
    top: liveRankingTop,
    pageSize: liveRankingTop,
    pageDuration: liveRankingPageDuration,
    dynamicPaging: liveRankingDynamicPaging,
    autoBalance: liveRankingAutoBalance,
    cutoff: liveRankingCutoff,
    pollInterval: isRankingMockActive ? 0 : liveRankingPollInterval,
    viewMode: liveRankingViewMode,
    data: liveRankingData
  });
  liveRankingVisible = true;
  updateLiveRankingUI();
  showToast(isRankingMockActive ? 'Tabla de Clasificación (Mock) AL AIRE en OBS' : 'Ranking en Vivo AL AIRE en OBS', 'success');
}

function sendHideLiveRanking() {
  sendWS({ type: 'live_ranking_hide' });
  liveRankingVisible = false;
  demoRunning = false;
  const btn = document.getElementById('btn-demo-final');
  if (btn) btn.innerHTML = '<span>Demo en vivo: Final 3x3 (60s)</span>';
  const statusPill = document.getElementById('demo-status-pill');
  if (statusPill) statusPill.style.display = 'none';
  updateLiveRankingUI();
  showToast('Ranking en Vivo ocultado de OBS', 'info');
}

let demoRunning = false;

async function triggerFinalsDemo() {
  const btn = document.getElementById('btn-demo-final');
  const statusPill = document.getElementById('demo-status-pill');
  if (demoRunning) {
    try {
      await fetch('/api/demo/stop-final-simulation', { method: 'POST' });
      demoRunning = false;
      if (btn) btn.innerHTML = '<span>Demo en vivo: Final 3x3 (60s)</span>';
      if (statusPill) statusPill.style.display = 'none';
      showToast('Simulación de final detenida', 'info');
    } catch (e) {
      console.error(e);
    }
    return;
  }

  try {
    demoRunning = true;
    if (btn) btn.innerHTML = '<span>Detener simulación</span>';
    if (statusPill) {
      statusPill.style.display = 'block';
      statusPill.innerHTML = '<em>Iniciando simulación de Final 3x3 (60s)...</em>';
    }
    showToast('Iniciando demostración en vivo de Final 3x3...', 'success');
    await fetch('/api/demo/start-final-simulation', { method: 'POST' });
  } catch (err) {
    showToast('Error al iniciar simulación: ' + err.message, 'error');
    demoRunning = false;
    if (btn) btn.innerHTML = '<span>Demo en vivo: Final 3x3 (60s)</span>';
    if (statusPill) statusPill.style.display = 'none';
  }
}

function updatePagingSummary() {
  const summaryBox = document.getElementById('live-paging-summary');
  const summaryText = document.getElementById('live-paging-summary-text');
  if (!summaryBox || !summaryText) return;

  const total = liveRankingData?.ranking?.length || 0;
  if (total === 0) {
    summaryBox.style.display = 'none';
    return;
  }

  const maxPerPage = Math.max(1, liveRankingTop || 16);
  summaryBox.style.display = 'flex';

  if (!liveRankingDynamicPaging) {
    summaryText.innerHTML = `Mostrando <strong>Top ${Math.min(total, maxPerPage)}</strong> de ${total} competidores (Modo Fijo)`;
    return;
  }

  if (total <= maxPerPage) {
    summaryText.innerHTML = `<strong>${total} competidores</strong> • 1 sola página completa (${total} filas, sin rotación)`;
    return;
  }

  const numPages = Math.ceil(total / maxPerPage);

  if (!liveRankingAutoBalance) {
    const pageCounts = [];
    for (let i = 0; i < numPages; i++) {
      const start = i * maxPerPage;
      const count = Math.min(maxPerPage, total - start);
      pageCounts.push(count);
    }
    summaryText.innerHTML = `<strong>${total} competidores</strong> • <strong>${numPages} páginas</strong> (${pageCounts.join(' + ')} filas) • ${liveRankingPageDuration}s por página (Sin balanceo)`;
    return;
  }

  // Auto-balanceo equitativo
  const baseCount = Math.floor(total / numPages);
  const remainder = total % numPages;
  const pageCounts = [];
  for (let i = 0; i < numPages; i++) {
    pageCounts.push(baseCount + (i < remainder ? 1 : 0));
  }

  summaryText.innerHTML = `<strong>${total} competidores</strong> • <strong>${numPages} páginas balanceadas</strong> (${pageCounts.join(' + ')} filas) • ${liveRankingPageDuration}s por página`;
}

function renderLiveRankingPreview(rankingObj) {
  const tbody = document.getElementById('live-preview-table-body');
  if (!tbody) return;

  if (!rankingObj || !rankingObj.ranking || rankingObj.ranking.length === 0) {
    tbody.innerHTML = `
      <tr>
        <td colspan="5" style="text-align:center;color:var(--text-dim);padding:24px 8px;">
          Sin resultados registrados en esta ronda aún
        </td>
      </tr>
    `;
    updatePagingSummary();
    return;
  }

  tbody.innerHTML = rankingObj.ranking.map(r => {
    const isAdv = !!r.isAdvancing;
    const badgeClass = isAdv ? 'advancing' : 'non-advancing';
    const isFinalSolve = (r.solvesCompleted === 4 && (r.totalSolves === 5 || !r.totalSolves));
    const solvesPillClass = isFinalSolve ? 'final-solve' : (r.inProgress ? 'in-progress' : 'completed');
    const flagIso = (r.countryIso2 || 'co').toLowerCase();
    const isProj = !!r.isProjected;
    const displayTime = r.displayTime || (r.solvesCompleted > 0 ? (r.projectedAverageFormatted || r.averageFormatted || r.bestFormatted) : '—');
    const timeStyle = isProj ? 'color:#38bdf8;font-style:italic;' : 'color:#f8fafc;';

    let targetsBadges = '';
    if (r.podiumTargets && Array.isArray(r.podiumTargets) && r.podiumTargets.length > 0) {
      targetsBadges = '<div style="display:flex;gap:4px;margin-top:3px;font-size:10px;">' + r.podiumTargets.map(t => {
        const color = t.color === 'gold' ? '#ffd000' : t.color === 'bronze' ? '#fb923c' : '#e2e8f0';
        return `<span style="background:rgba(0,0,0,0.5);border:1px solid ${color};color:${color};padding:1px 5px;border-radius:3px;font-weight:700;font-family:\'Space Mono\',monospace;">${t.label}: ${t.maxSolveFormatted}</span>`;
      }).join('') + '</div>';
    }

    const recTag = (r.recordTag && r.recordTag !== 'PB')
      ? `<span class="live-record-badge">${escapeHtml(r.recordTag)}</span>`
      : '';

    return `
      <tr style="${isFinalSolve ? 'background:rgba(2, 132, 199, 0.1);' : ''}">
        <td style="text-align:center;">
          <span class="live-pos-badge ${badgeClass}">${r.ranking}</span>
        </td>
        <td style="text-align:center;">
          <img src="https://flagcdn.com/w40/${flagIso}.png" alt="${flagIso}" style="width:18px;height:12px;border-radius:2px;vertical-align:middle;" onerror="this.style.display='none'">
        </td>
        <td style="font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(r.name)}">
          ${escapeHtml(r.name)}
          ${targetsBadges}
        </td>
        <td style="text-align:center;">
          <span class="live-solves-pill ${solvesPillClass}" style="${isFinalSolve ? 'color:#f87171;font-weight:800;' : ''}">${r.solvesText || `${r.solvesCompleted || 0}/${r.totalSolves || 5}`}</span>
        </td>
        <td style="text-align:right;font-family:'Space Mono',monospace;font-weight:700;${timeStyle}" title="${isProj ? 'Promedio Proyectado' : 'Promedio Oficial'}">
          ${recTag}${displayTime}
        </td>
      </tr>
    `;
  }).join('');

  updatePagingSummary();
}

function updateLiveRankingUI() {
  updateViewModeButtons();

  const btnShow = document.getElementById('btn-show-live-ranking');
  const playIc = window.Icon ? window.Icon('play', { size: 15 }) : '';
  const checkIc = window.Icon ? window.Icon('check', { size: 15 }) : '';
  if (btnShow) {
    if (liveRankingVisible) {
      btnShow.classList.add('active');
      btnShow.innerHTML = `${checkIc}<span>Al aire en OBS</span>`;
    } else {
      btnShow.classList.remove('active');
      btnShow.innerHTML = `${playIc}<span>Mostrar en OBS</span>`;
    }
  }
  window.AdminUI?.syncAdminLiveNowUI();

  const compInput = document.getElementById('live-comp-id-input');
  if (compInput && !compInput.value && liveRankingCompId) {
    compInput.value = liveRankingCompId;
  }

  const topInput = document.getElementById('live-top-input');
  if (topInput && liveRankingTop) topInput.value = String(liveRankingTop);

  const topSel = document.getElementById('live-top-select');
  if (topSel && liveRankingTop) topSel.value = String(liveRankingTop);

  const cutInput = document.getElementById('live-cutoff-input') || document.getElementById('live-cutoff-select');
  if (cutInput && liveRankingCutoff !== undefined) cutInput.value = String(liveRankingCutoff);

  const pollSel = document.getElementById('live-polling-select');
  if (pollSel && liveRankingPollInterval !== undefined) pollSel.value = String(liveRankingPollInterval);

  const modeSel = document.getElementById('live-paging-mode-select');
  if (modeSel) modeSel.value = liveRankingDynamicPaging ? 'dynamic' : 'static';

  const balSel = document.getElementById('live-balance-select');
  if (balSel) balSel.value = liveRankingAutoBalance ? 'balanced' : 'fill';

  const durSel = document.getElementById('live-page-duration-select');
  if (durSel && liveRankingPageDuration) durSel.value = String(liveRankingPageDuration);

  const roundSel = document.getElementById('live-round-select');
  if (roundSel && liveRankingSelectedRoundId && roundSel.value !== liveRankingSelectedRoundId) {
    if (Array.from(roundSel.options).some(o => o.value === liveRankingSelectedRoundId)) {
      roundSel.value = liveRankingSelectedRoundId;
    }
  }

  updatePagingSummary();
}

// ━━━ TEMA Y PERSONALIZACIÓN DE FONDO FULLSCREEN ━━━
let currentFsTheme = {
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

function formatPatternSizeLabel(s) {
  const val = parseInt(s, 10) || 80;
  if (val === 80) return '80px (Por defecto)';
  if (val < 80) return `${val}px (Pequeño)`;
  if (val <= 130) return `${val}px (Mediano)`;
  return `${val}px (Grande)`;
}

function rgbToHex(rgbStr) {
  if (!rgbStr) return '';
  if (rgbStr.startsWith('#')) return rgbStr.toLowerCase();
  const match = rgbStr.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
  if (!match) return rgbStr.toLowerCase();
  const hex = (x) => ('0' + parseInt(x, 10).toString(16)).slice(-2);
  return ('#' + hex(match[1]) + hex(match[2]) + hex(match[3])).toLowerCase();
}

function updateFsThemeUI() {
  const picker = document.getElementById('fs-color-picker');
  const valLabel = document.getElementById('fs-color-val');
  const slider = document.getElementById('fs-opacity-slider');
  const opLabel = document.getElementById('fs-opacity-val');
  const blurSlider = document.getElementById('fs-blur-slider');
  const blurLabel = document.getElementById('fs-blur-val');
  const gradSlider = document.getElementById('fs-gradient-slider');
  const gradLabel = document.getElementById('fs-gradient-val');
  const patSlider = document.getElementById('fs-pattern-size-slider');
  const patLabel = document.getElementById('fs-pattern-size-val');
  const cycleCheck = document.getElementById('fs-color-cycle-check');
  const colombiaCheck = document.getElementById('fs-colombia-cycle-check');
  const animSelect = document.getElementById('fs-anim-select');
  const speedSelect = document.getElementById('fs-speed-select');
  const statusLabel = document.getElementById('fs-image-status');
  const previewBox = document.getElementById('fs-image-preview-container');
  const previewImg = document.getElementById('fs-image-preview');
  const btnRemove = document.getElementById('btn-fs-remove-image');

  const curColor = (currentFsTheme.bgColor || '#0c4ea8').toLowerCase();
  const curOpacity = currentFsTheme.opacity !== undefined ? currentFsTheme.opacity : 100;
  const curBlur = currentFsTheme.blur !== undefined ? currentFsTheme.blur : 0;
  const curGrad = currentFsTheme.gradientLevel !== undefined ? currentFsTheme.gradientLevel : 70;
  const curPatSize = currentFsTheme.patternSize !== undefined ? currentFsTheme.patternSize : 80;
  const curCycle = !!currentFsTheme.colorCycle;
  const curColombia = !!currentFsTheme.colombiaCycle;
  const curAnim = currentFsTheme.animation || 'none';
  const curSpeed = currentFsTheme.animSpeed || 'slow';

  if (picker) picker.value = curColor;
  if (valLabel) valLabel.textContent = curColor;
  if (slider) slider.value = curOpacity;
  if (opLabel) opLabel.textContent = `${curOpacity}%`;
  if (blurSlider) blurSlider.value = curBlur;
  if (blurLabel) blurLabel.textContent = `${curBlur}px`;
  if (gradSlider) gradSlider.value = curGrad;
  if (gradLabel) gradLabel.textContent = `${curGrad}%`;
  if (patSlider) patSlider.value = curPatSize;
  if (patLabel) patLabel.textContent = formatPatternSizeLabel(curPatSize);
  if (cycleCheck) cycleCheck.checked = curCycle;
  if (colombiaCheck) colombiaCheck.checked = curColombia;
  if (animSelect) animSelect.value = curAnim;
  if (speedSelect) speedSelect.value = curSpeed;

  // Resaltar preset activo si coincide
  document.querySelectorAll('.fs-color-preset').forEach(btn => {
    const dataCol = (btn.getAttribute('data-color') || '').toLowerCase();
    const bgCol = rgbToHex(btn.style.background || '');
    if (dataCol === curColor || bgCol === curColor) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });

  // Imagen personalizada
  if (currentFsTheme.bgImage) {
    if (statusLabel) {
      statusLabel.textContent = 'Imagen personalizada activa';
      statusLabel.style.color = '#38bdf8';
    }
    if (btnRemove) btnRemove.style.display = 'inline-block';
    if (previewBox && previewImg) {
      previewBox.style.display = 'block';
      previewImg.src = currentFsTheme.bgImage;
    }
  } else {
    if (statusLabel) {
      statusLabel.textContent = 'Sin imagen (usa degradado)';
      statusLabel.style.color = '#94a3b8';
    }
    if (btnRemove) btnRemove.style.display = 'none';
    if (previewBox) previewBox.style.display = 'none';
  }

  // Escenas activas en Pantalla Completa (/fullscreen)
  const curScene = currentFsTheme.scene || 'ranking';
  const scenesList = ['ranking', 'starting', 'lunch', 'reconnecting', 'ending'];
  
  scenesList.forEach(sc => {
    const btn = document.getElementById(`btn-fs-scene-${sc}`);
    if (btn) btn.classList.toggle('active', curScene === sc);
    const row = document.getElementById(`fs-${sc}-settings-row`);
    if (row) row.style.display = (curScene === sc && sc !== 'ranking') ? 'flex' : 'none';
  });

  // Sincronizar textos en inputs si el usuario no los está editando
  const startingCustomTitleInput = document.getElementById('fs-starting-custom-title-input');
  if (startingCustomTitleInput && document.activeElement !== startingCustomTitleInput) {
    startingCustomTitleInput.value = currentFsTheme.startingCustomTitle || '';
  }

  const startingDaySelect = document.getElementById('fs-starting-day-select');
  const startingDayCustomCont = document.getElementById('fs-starting-custom-day-container');
  const startingDayCustomInput = document.getElementById('fs-starting-custom-day-input');
  const curDay = currentFsTheme.startingDay !== undefined ? currentFsTheme.startingDay : 'Día 1';
  const standardDays = ['Día 1', 'Día 2', 'Día 3', 'Día 4', 'Día 5', 'none'];

  if (startingDaySelect) {
    if (standardDays.includes(curDay)) {
      startingDaySelect.value = curDay;
      if (startingDayCustomCont) startingDayCustomCont.style.display = 'none';
    } else {
      startingDaySelect.value = 'custom';
      if (startingDayCustomCont) startingDayCustomCont.style.display = 'flex';
      if (startingDayCustomInput && document.activeElement !== startingDayCustomInput) {
        startingDayCustomInput.value = curDay;
      }
    }
  }

  const startingInput = document.getElementById('fs-starting-text-input');
  if (startingInput && document.activeElement !== startingInput) {
    startingInput.value = currentFsTheme.startingText || 'Iniciando en unos minutos';
  }
  const startingModeSelect = document.getElementById('fs-starting-mode-select');
  if (startingModeSelect) {
    startingModeSelect.value = currentFsTheme.startingMode || 'both';
  }
  const lunchInput = document.getElementById('fs-lunch-text-input');
  if (lunchInput && document.activeElement !== lunchInput) {
    lunchInput.value = currentFsTheme.lunchText || 'Hora de almuerzo';
  }
  const recInput = document.getElementById('fs-reconnecting-text-input');
  if (recInput && document.activeElement !== recInput) {
    recInput.value = currentFsTheme.reconnectingText || 'Reconectando';
  }
  const endingInput = document.getElementById('fs-ending-text-input');
  if (endingInput && document.activeElement !== endingInput) {
    endingInput.value = currentFsTheme.endingText || 'Gracias por vernos';
  }
  window.AdminUI?.syncAdminLiveNowUI();
}

function setFsScene(scene) {
  const validScenes = ['ranking', 'starting', 'lunch', 'reconnecting', 'ending'];
  const cleanScene = validScenes.includes(scene) ? scene : 'ranking';
  currentFsTheme.scene = cleanScene;
  updateFsThemeUI();
  sendWS({
    type: 'set_fs_theme',
    data: {
      scene: cleanScene,
      startingCustomTitle: currentFsTheme.startingCustomTitle || '',
      startingDay: currentFsTheme.startingDay || 'Día 1',
      startingText: currentFsTheme.startingText || 'Iniciando en unos minutos',
      startingMode: currentFsTheme.startingMode || 'both',
      lunchText: currentFsTheme.lunchText || 'Hora de almuerzo',
      reconnectingText: currentFsTheme.reconnectingText || 'Reconectando',
      endingText: currentFsTheme.endingText || 'Gracias por vernos'
    }
  });

  const toastLabels = {
    ranking: 'Tabla de clasificación activa en /fullscreen',
    starting: 'Escena "Iniciando en unos minutos" activa en /transicion',
    lunch: 'Escena "Hora de almuerzo" activa en /transicion',
    reconnecting: 'Escena "Reconectando" activa en /transicion',
    ending: 'Escena "Gracias por vernos" activa en /transicion'
  };
  showToast(toastLabels[cleanScene] || cleanScene, 'info');
}

function onFsStartingCustomTitleChange(val) {
  currentFsTheme.startingCustomTitle = val ? val.trim() : '';
  sendWS({
    type: 'set_fs_theme',
    data: { startingCustomTitle: currentFsTheme.startingCustomTitle }
  });
}

function setFsStartingDay(val) {
  const customCont = document.getElementById('fs-starting-custom-day-container');
  const customInput = document.getElementById('fs-starting-custom-day-input');
  if (val === 'custom') {
    if (customCont) customCont.style.display = 'flex';
    const customVal = customInput ? (customInput.value.trim() || 'Finales') : 'Finales';
    currentFsTheme.startingDay = customVal;
  } else {
    if (customCont) customCont.style.display = 'none';
    currentFsTheme.startingDay = val;
  }
  sendWS({
    type: 'set_fs_theme',
    data: { startingDay: currentFsTheme.startingDay }
  });
  showToast(`Día a mostrar actualizado: ${currentFsTheme.startingDay === 'none' ? 'Oculto' : currentFsTheme.startingDay}`, 'info');
}

function onFsStartingCustomDayInput(val) {
  currentFsTheme.startingDay = val ? val.trim() : 'Día 1';
  sendWS({
    type: 'set_fs_theme',
    data: { startingDay: currentFsTheme.startingDay }
  });
}

function onFsStartingTextChange(val) {
  currentFsTheme.startingText = val || 'Iniciando en unos minutos';
  sendWS({
    type: 'set_fs_theme',
    data: { startingText: currentFsTheme.startingText }
  });
}

function setFsStartingMode(mode) {
  currentFsTheme.startingMode = mode || 'both';
  sendWS({
    type: 'set_fs_theme',
    data: { startingMode: currentFsTheme.startingMode }
  });
  showToast('Modo de animación de inicio actualizado', 'info');
}

function onFsLunchTextChange(val) {
  currentFsTheme.lunchText = val || 'Hora de almuerzo';
  sendWS({
    type: 'set_fs_theme',
    data: { lunchText: currentFsTheme.lunchText }
  });
}

function onFsReconnectingTextChange(val) {
  currentFsTheme.reconnectingText = val || 'Reconectando';
  sendWS({
    type: 'set_fs_theme',
    data: { reconnectingText: currentFsTheme.reconnectingText }
  });
}

function onFsEndingTextChange(val) {
  currentFsTheme.endingText = val || 'Gracias por vernos';
  sendWS({
    type: 'set_fs_theme',
    data: { endingText: currentFsTheme.endingText }
  });
}

function onFsColorPickerChange(color) {
  const valLabel = document.getElementById('fs-color-val');
  if (valLabel) valLabel.textContent = color;
  currentFsTheme.bgColor = color;
  sendWS({
    type: 'set_fs_theme',
    data: { bgColor: color }
  });
}

function onFsColorPickerFinal(color) {
  currentFsTheme.bgColor = color;
  updateFsThemeUI();
  sendWS({
    type: 'set_fs_theme',
    data: { bgColor: color }
  });
}

function setFsPresetColor(color) {
  currentFsTheme.bgColor = color;
  updateFsThemeUI();
  sendWS({
    type: 'set_fs_theme',
    data: { bgColor: color }
  });
  showToast(`Color de fondo cambiado a ${color}`, 'info');
}

function onFsOpacityChange(val) {
  const op = parseInt(val, 10);
  currentFsTheme.opacity = op;
  const opLabel = document.getElementById('fs-opacity-val');
  if (opLabel) opLabel.textContent = `${op}%`;
  sendWS({
    type: 'set_fs_theme',
    data: { opacity: op }
  });
}

function onFsBlurChange(val) {
  const b = parseInt(val, 10);
  currentFsTheme.blur = b;
  const blurLabel = document.getElementById('fs-blur-val');
  if (blurLabel) blurLabel.textContent = `${b}px`;
  sendWS({
    type: 'set_fs_theme',
    data: { blur: b }
  });
}

function onFsGradientLevelChange(val) {
  const g = Math.max(0, Math.min(100, parseInt(val, 10) || 0));
  currentFsTheme.gradientLevel = g;
  const gradLabel = document.getElementById('fs-gradient-val');
  if (gradLabel) gradLabel.textContent = `${g}%`;
  sendWS({
    type: 'set_fs_theme',
    data: { gradientLevel: g }
  });
}

function onFsPatternSizeChange(val) {
  const s = Math.max(40, Math.min(260, parseInt(val, 10) || 80));
  currentFsTheme.patternSize = s;
  const patLabel = document.getElementById('fs-pattern-size-val');
  if (patLabel) patLabel.textContent = formatPatternSizeLabel(s);
  sendWS({
    type: 'set_fs_theme',
    data: { patternSize: s }
  });
}

function onFsColorCycleChange(checked) {
  currentFsTheme.colorCycle = !!checked;
  if (checked) {
    currentFsTheme.colombiaCycle = false;
    const colombiaCheck = document.getElementById('fs-colombia-cycle-check');
    if (colombiaCheck) colombiaCheck.checked = false;
  }
  sendWS({
    type: 'set_fs_theme',
    data: {
      colorCycle: currentFsTheme.colorCycle,
      colombiaCycle: currentFsTheme.colombiaCycle
    }
  });
  showToast(`Transición de degradé multicolor: ${checked ? 'Activada' : 'Desactivada'}`, 'info');
}

function onFsColombiaCycleChange(checked) {
  currentFsTheme.colombiaCycle = !!checked;
  if (checked) {
    currentFsTheme.colorCycle = false;
    const cycleCheck = document.getElementById('fs-color-cycle-check');
    if (cycleCheck) cycleCheck.checked = false;
    if (!currentFsTheme.animation || currentFsTheme.animation === 'none') {
      currentFsTheme.animation = 'scroll-right';
      const animSelect = document.getElementById('fs-anim-select');
      if (animSelect) animSelect.value = 'scroll-right';
    }
  }
  sendWS({
    type: 'set_fs_theme',
    data: {
      colombiaCycle: currentFsTheme.colombiaCycle,
      colorCycle: currentFsTheme.colorCycle,
      animation: currentFsTheme.animation
    }
  });
  showToast(`Degradé Bandera de Colombia: ${checked ? 'Activado (flujo continuo)' : 'Desactivado'}`, 'info');
}

function onFsAnimationChange(anim) {
  currentFsTheme.animation = anim;
  sendWS({
    type: 'set_fs_theme',
    data: { animation: anim }
  });
  const labelMap = {
    'none': 'Estático (sin movimiento)',
    'ken-burns': 'Cinemático Ken Burns',
    'scroll-left': 'Flujo continuo: Izquierda',
    'scroll-right': 'Flujo continuo: Derecha',
    'scroll-up': 'Flujo continuo: Arriba',
    'scroll-down': 'Flujo continuo: Abajo',
    'diagonal': 'Flujo continuo: Diagonal'
  };
  showToast(`Movimiento de fondo: ${labelMap[anim] || anim}`, 'info');
}

function onFsSpeedChange(speed) {
  currentFsTheme.animSpeed = speed;
  sendWS({
    type: 'set_fs_theme',
    data: { animSpeed: speed }
  });
  const speedMap = {
    'slow': 'Lento (Elegante)',
    'normal': 'Normal',
    'fast': 'Rápido'
  };
  showToast(`Velocidad de fondo: ${speedMap[speed] || speed}`, 'info');
}

function handleFsImageUpload(input) {
  if (!input.files || input.files.length === 0) return;
  const file = input.files[0];
  if (!file.type.startsWith('image/')) {
    showToast('Selecciona un archivo de imagen válido (PNG, JPG, WebP)', 'error');
    input.value = '';
    return;
  }
  if (file.size > 12 * 1024 * 1024) {
    showToast('La imagen es demasiado pesada (máximo 12MB)', 'error');
    input.value = '';
    return;
  }

  showToast('Subiendo imagen de fondo...', 'info');
  const reader = new FileReader();
  reader.onload = function(e) {
    const base64Data = e.target.result;
    fetch('/api/fs-background', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imageBase64: base64Data,
        filename: file.name
      })
    })
    .then(res => res.json())
    .then(data => {
      if (data.ok && data.theme) {
        currentFsTheme = data.theme;
        updateFsThemeUI();
        showToast('Imagen de fondo aplicada a pantalla completa', 'success');
      } else {
        showToast('Error al subir: ' + (data.error || 'Desconocido'), 'error');
      }
    })
    .catch(err => {
      console.error(err);
      showToast('Error de red al subir imagen', 'error');
    })
    .finally(() => {
      input.value = '';
    });
  };
  reader.readAsDataURL(file);
}

function removeFsImage() {
  fetch('/api/fs-background/delete', {
    method: 'POST'
  })
  .then(res => res.json())
  .then(data => {
    if (data.ok && data.theme) {
      currentFsTheme = data.theme;
      updateFsThemeUI();
      showToast('Imagen de fondo eliminada', 'info');
    }
  })
  .catch(err => {
    console.error(err);
    showToast('Error al eliminar imagen', 'error');
  });
}

function resetFsTheme() {
  const prevScene = currentFsTheme.scene || 'ranking';
  const prevStartingCustomTitle = currentFsTheme.startingCustomTitle || '';
  const prevStartingDay = currentFsTheme.startingDay || 'Día 1';
  const prevStartingText = currentFsTheme.startingText || 'Iniciando en unos minutos';
  const prevStartingMode = currentFsTheme.startingMode || 'both';
  const prevLunchText = currentFsTheme.lunchText || 'Hora de almuerzo';
  const prevReconnectingText = currentFsTheme.reconnectingText || 'Reconectando';
  const prevEndingText = currentFsTheme.endingText || 'Gracias por vernos';
  currentFsTheme = {
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
    scene: prevScene,
    startingCustomTitle: prevStartingCustomTitle,
    startingDay: prevStartingDay,
    startingText: prevStartingText,
    startingMode: prevStartingMode,
    lunchText: prevLunchText,
    reconnectingText: prevReconnectingText,
    endingText: prevEndingText
  };
  fetch('/api/fs-background/delete', { method: 'POST' }).catch(() => {});
  sendWS({
    type: 'set_fs_theme',
    data: {
      bgColor: '#0c4ea8',
      bgImage: null,
      opacity: 100,
      blur: 0,
      gradientLevel: 70,
      colorCycle: false,
      colombiaCycle: false,
      animation: 'none',
      animSpeed: 'slow'
    }
  });
  updateFsThemeUI();
  showToast('Fondo restablecido por defecto (Azul WCA, 100%, Nítido, Estático)', 'info');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── GESTIÓN DE TARJETA DE COMPETIDOR EN VIVO (SHOWCASE ESQUINA DERECHA) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function fetchCompetitorAvatarIfNeeded(comp) {
  if (!comp || !comp.wca_id || comp.is_new) return;
  if (comp.avatar_url && !comp.avatar_url.includes('missing_avatar')) return;
  try {
    const res = await fetch(`/api/wca/avatar/${encodeURIComponent(comp.wca_id)}`);
    if (res.ok) {
      const data = await res.json();
      comp.avatar_url = data.avatar_url || null;
      if (tournamentData && tournamentData.competitors) {
        const found = tournamentData.competitors.find(c => (c.wca_id || '').toUpperCase() === comp.wca_id.toUpperCase());
        if (found) found.avatar_url = comp.avatar_url;
      }
      updateShowcaseUI();
      if (showcaseVisible && showcaseCompetitor && showcaseCompetitor.wca_id === comp.wca_id) {
        sendShowCompetitorShowcase();
      }
    }
  } catch (err) {
    console.warn('[Showcase] Error obteniendo avatar WCA:', err.message);
  }
}

function setShowcaseCompetitor(comp) {
  showcaseCompetitor = comp;
  updateShowcaseUI();
  if (comp && comp.wca_id && !comp.avatar_url) {
    fetchCompetitorAvatarIfNeeded(comp);
  }
}

function updateShowcaseUI() {
  const badge = document.getElementById('showcase-status-badge');
  const btnShow = document.getElementById('btn-show-showcase');
  const playIc = window.Icon ? window.Icon('play', { size: 15 }) : '';
  const checkIc = window.Icon ? window.Icon('check', { size: 15 }) : '';

  // 1. Estado en Vivo
  if (badge) {
    badge.textContent = showcaseVisible ? 'Al aire' : 'En espera';
    badge.className = showcaseVisible ? 'live-status-pill online' : 'live-status-pill offline';
  }

  if (btnShow) {
    btnShow.innerHTML = showcaseVisible
      ? `${checkIc}<span>Al aire en OBS</span>`
      : `${playIc}<span>Mostrar en OBS</span>`;
  }
  window.AdminUI?.syncAdminLiveNowUI();

  // 2. Previsualización de la tarjeta
  const elFlag = document.getElementById('panel-showcase-bg-flag');
  const elAvatar = document.getElementById('panel-showcase-avatar');
  const elEmpty = document.getElementById('panel-showcase-empty');
  const elName = document.getElementById('panel-showcase-name');
  const elSingle = document.getElementById('panel-showcase-single');
  const elAvg = document.getElementById('panel-showcase-average');

  const eid = selectedEventId || (currentEvent && currentEvent.event_id) || '333';
  const elEventName = document.getElementById('panel-showcase-event-name');
  const elEventIcon = document.getElementById('panel-showcase-event-icon');
  if (elEventName) {
    const rawEvName = (currentEvent && (currentEvent.event_name || currentEvent.name)) || (typeof EVENT_NAMES !== 'undefined' && EVENT_NAMES[eid]) || eid;
    elEventName.textContent = String(rawEvName).replace(/(\d+)x\1x\1(\s*Cube)?/gi, '$1x$1').toUpperCase();
  }
  if (elEventIcon) {
    elEventIcon.src = `icons/${eid}.svg`;
  }

  if (!showcaseCompetitor) {
    if (elFlag) elFlag.style.display = 'none';
    if (elAvatar) elAvatar.style.display = 'none';
    if (elEmpty) elEmpty.style.display = 'block';
    elName.textContent = '—';
    if (elSingle) elSingle.textContent = '—';
    if (elAvg) elAvg.textContent = '—';
    return;
  }

  if (elEmpty) elEmpty.style.display = 'none';

  // Bandera
  if (elFlag) {
    if (showcaseCompetitor.country) {
      elFlag.src = `https://flagcdn.com/w640/${showcaseCompetitor.country.toLowerCase()}.png`;
      elFlag.style.display = 'block';
    } else {
      elFlag.style.display = 'none';
    }
  }

  // Avatar WCA
  if (elAvatar) {
    if (showcaseCompetitor.avatar_url && !showcaseCompetitor.avatar_url.includes('missing_avatar')) {
      elAvatar.src = showcaseCompetitor.avatar_url;
      elAvatar.style.display = 'block';
    } else {
      elAvatar.style.display = 'none';
      elAvatar.src = '';
    }
  }

  // Nombre
  elName.textContent = (showcaseCompetitor.name || 'COMPETIDOR').toUpperCase();

  // Récords de la categoría actual
  const pr = (showcaseCompetitor.prs && showcaseCompetitor.prs[eid]) || null;
  if (elSingle) elSingle.textContent = (pr && pr.single_fmt) ? pr.single_fmt : '—';
  if (elAvg) elAvg.textContent = (pr && pr.average_fmt) ? pr.average_fmt : '—';
}

function onShowcaseSearchInput(query) {
  const resultsDropdown = document.getElementById('showcase-search-results');
  if (!resultsDropdown) return;

  const q = (query || '').trim().toLowerCase();
  if (!q) {
    resultsDropdown.style.display = 'none';
    resultsDropdown.innerHTML = '';
    return;
  }

  const allComps = (tournamentData && tournamentData.competitors) || [];
  const filtered = allComps.filter(c => {
    return (c.name || '').toLowerCase().includes(q) || (c.wca_id || '').toLowerCase().includes(q);
  }).slice(0, 10);

  if (filtered.length === 0) {
    const isWcaId = /^[0-9]{4}[A-Za-z]{4}[0-9]{2}$/.test(q);
    resultsDropdown.innerHTML = `
      <div style="padding:10px;font-size:12px;color:var(--text-dim);text-align:center;">
        No encontrado en lista de inscritos.
        ${isWcaId ? `<button type="button" class="admin-btn admin-btn--ghost" style="margin-top:8px;width:100%;" onclick="fetchAndSelectShowcaseWCA('${q.toUpperCase()}')">${window.Icon ? window.Icon('search', { size: 14 }) : ''}<span>Buscar WCA ID ${q.toUpperCase()}</span></button>` : ''}
      </div>
    `;
    resultsDropdown.style.display = 'block';
    return;
  }

  resultsDropdown.innerHTML = filtered.map(c => `
    <div class="search-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);transition:background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='transparent'" onclick="selectShowcaseFromSearch(decodeURIComponent('${encodeURIComponent(c.wca_id || c.name)}'))">
      <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
        ${c.country ? `<img src="https://flagcdn.com/w40/${c.country.toLowerCase()}.png" style="width:20px;height:14px;border-radius:2px;" onerror="this.style.display='none'">` : ''}
        <span style="font-size:12px;font-weight:700;color:var(--text-main);">${escapeHtml(c.name)}</span>
      </div>
      <span style="font-family:var(--admin-font-mono);font-size:11px;font-weight:500;color:var(--admin-text-secondary);">${escapeHtml(c.wca_id || 'NUEVO')}</span>
    </div>
  `).join('');
  resultsDropdown.style.display = 'block';
}

function selectShowcaseFromSearch(idOrName) {
  const allComps = (tournamentData && tournamentData.competitors) || [];
  const comp = allComps.find(c => (c.wca_id && c.wca_id.toUpperCase() === idOrName.toUpperCase()) || c.name === idOrName);
  if (comp) {
    setShowcaseCompetitor(comp);
    const searchInp = document.getElementById('showcase-search-input');
    const resultsDropdown = document.getElementById('showcase-search-results');
    if (searchInp) searchInp.value = '';
    if (resultsDropdown) resultsDropdown.style.display = 'none';
    showToast(`Competidor seleccionado: ${comp.name}`, 'info');
  }
}

async function fetchAndSelectShowcaseWCA(wcaId) {
  showToast(`Buscando ${wcaId} en WCA...`, 'info');
  try {
    const res = await fetch(`/api/wca/person/${encodeURIComponent(wcaId)}`);
    if (res.ok) {
      const data = await res.json();
      if (data.competitor) {
        setShowcaseCompetitor(data.competitor);
        const searchInp = document.getElementById('showcase-search-input');
        const resultsDropdown = document.getElementById('showcase-search-results');
        if (searchInp) searchInp.value = '';
        if (resultsDropdown) resultsDropdown.style.display = 'none';
        showToast(`Competidor cargado de WCA: ${data.competitor.name}`, 'success');
      }
    } else {
      showToast(`No se encontró ${wcaId} en la WCA`, 'error');
    }
  } catch (err) {
    showToast(`Error al consultar WCA: ${err.message}`, 'error');
  }
}

function sendShowCompetitorShowcase() {
  if (!showcaseCompetitor) {
    showToast('Selecciona primero un competidor para mostrar su tarjeta', 'warning');
    return;
  }
  showcaseVisible = true;
  sendWS({
    type: 'show_competitor_showcase',
    competitor: showcaseCompetitor
  });
  updateShowcaseUI();
  showToast(`Tarjeta de ${showcaseCompetitor.name} mostrada en OBS`, 'success');
}

function sendHideCompetitorShowcase() {
  showcaseVisible = false;
  sendWS({ type: 'hide_competitor_showcase' });
  updateShowcaseUI();
  showToast('Tarjeta de competidor ocultada de OBS');
}

// ── GESTIÓN DE LOGO CENTRAL DEL TORNEO (MOMENTOS MUERTOS / DESCANSO) ──
function updateBigLogoUI() {
  const badge = document.getElementById('big-logo-status-badge');
  const btnShow = document.getElementById('btn-show-big-logo');
  const btnHide = document.getElementById('btn-hide-big-logo');
  const imgPreview = document.getElementById('panel-big-logo-preview');
  const emptyPlaceholder = document.getElementById('panel-big-logo-empty');

  if (badge) {
    badge.textContent = bigLogoVisible ? 'Al aire' : 'En espera';
    badge.className = bigLogoVisible ? 'live-status-pill online' : 'live-status-pill offline';
  }

  if (btnShow) {
    const ic = window.Icon ? window.Icon(bigLogoVisible ? 'check' : 'play', { size: 15 }) : '';
    btnShow.innerHTML = bigLogoVisible
      ? `${ic}<span>Al aire en OBS</span>`
      : `${ic}<span>Mostrar en OBS</span>`;
  }
  window.AdminUI?.syncAdminLiveNowUI();

  const effectiveUrl = bigLogoUrl || tickerTournamentLogo || null;
  if (imgPreview && emptyPlaceholder) {
    if (effectiveUrl) {
      imgPreview.src = effectiveUrl;
      imgPreview.style.display = 'block';
      emptyPlaceholder.style.display = 'none';
    } else {
      imgPreview.src = '';
      imgPreview.style.display = 'none';
      emptyPlaceholder.style.display = 'flex';
    }
  }

  const sizeSlider = document.getElementById('big-logo-size-slider');
  const sizeLabel = document.getElementById('big-logo-size-val');
  if (sizeSlider) sizeSlider.value = bigLogoSize;
  if (sizeLabel) sizeLabel.textContent = `${bigLogoSize}px`;
}

function onBigLogoSizeInput(val) {
  const s = parseInt(val, 10);
  if (!isNaN(s)) {
    bigLogoSize = s;
    const sizeLabel = document.getElementById('big-logo-size-val');
    if (sizeLabel) sizeLabel.textContent = `${bigLogoSize}px`;
    sendWS({ type: 'set_big_logo_size', size: bigLogoSize });
  }
}

function onBigLogoSizeChange(val) {
  const s = parseInt(val, 10);
  if (!isNaN(s)) {
    bigLogoSize = s;
    const sizeLabel = document.getElementById('big-logo-size-val');
    if (sizeLabel) sizeLabel.textContent = `${bigLogoSize}px`;
    sendWS({ type: 'set_big_logo_size', size: bigLogoSize });
  }
}

function setBigLogoSizePreset(val) {
  const s = parseInt(val, 10);
  if (!isNaN(s)) {
    bigLogoSize = s;
    const sizeSlider = document.getElementById('big-logo-size-slider');
    const sizeLabel = document.getElementById('big-logo-size-val');
    if (sizeSlider) sizeSlider.value = bigLogoSize;
    if (sizeLabel) sizeLabel.textContent = `${bigLogoSize}px`;
    sendWS({ type: 'set_big_logo_size', size: bigLogoSize });
    showToast(`Tamaño del logo ajustado a ${bigLogoSize}px`, 'info');
  }
}

function sendShowBigLogo() {
  bigLogoVisible = true;
  const activeUrl = bigLogoUrl || tickerTournamentLogo || null;
  sendWS({
    type: 'show_big_logo',
    url: activeUrl,
    size: bigLogoSize
  });
  updateBigLogoUI();
  showToast('Logo central activado en OBS', 'success');
}

function sendHideBigLogo() {
  bigLogoVisible = false;
  sendWS({ type: 'hide_big_logo' });
  updateBigLogoUI();
  showToast('Logo central ocultado de OBS');
}

function handleBigLogoUpload(event) {
  const file = event.target?.files?.[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async (e) => {
    const base64Data = e.target.result;
    try {
      showToast('Guardando logo central en servidor...', 'info');
      const resp = await fetch('/api/big-logo', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          imageBase64: base64Data,
          filename: file.name
        })
      });
      const result = await resp.json();
      if (result.ok && result.url) {
        bigLogoUrl = result.url;
        updateBigLogoUI();
        showToast('Logo central en alta resolución subido con éxito', 'success');
      } else {
        throw new Error(result.error || 'Error al guardar');
      }
    } catch (err) {
      console.warn('Error subiendo logo central:', err);
      bigLogoUrl = base64Data;
      updateBigLogoUI();
      showToast('Logo central cargado localmente', 'info');
    }
  };
  reader.readAsDataURL(file);
}

function clearBigLogo() {
  bigLogoUrl = null;
  fetch('/api/big-logo/delete', { method: 'POST' }).catch(() => {});
  const fileInput = document.getElementById('big-logo-file-input');
  if (fileInput) fileInput.value = '';
  updateBigLogoUI();
  showToast('Logo personalizado restablecido al logo del torneo', 'info');
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ── GESTIÓN DE ENFRENTAMIENTOS HEAD TO HEAD (FINALES) ──
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function updateHeadToHeadUI() {
  const badge = document.getElementById('h2h-status-badge');
  const btnShow = document.getElementById('btn-show-h2h');
  const btnHide = document.getElementById('btn-hide-h2h');

  if (badge) {
    badge.textContent = headToHeadVisible ? 'Al aire' : 'En espera';
    badge.className = headToHeadVisible ? 'live-status-pill online' : 'live-status-pill offline';
  }

  if (btnShow) {
    const ic = window.Icon ? window.Icon(headToHeadVisible ? 'check' : 'play', { size: 15 }) : '';
    btnShow.innerHTML = headToHeadVisible
      ? `${ic}<span>Al aire en OBS</span>`
      : `${ic}<span>Mostrar en OBS</span>`;
  }
  window.AdminUI?.syncAdminLiveNowUI();

  const name1El = document.getElementById('panel-h2h-name-1');
  const name2El = document.getElementById('panel-h2h-name-2');
  const pr1El = document.getElementById('panel-h2h-pr-1');
  const pr2El = document.getElementById('panel-h2h-pr-2');
  const evSelect = document.getElementById('h2h-event-select');

  if (evSelect && h2hEventId) evSelect.value = h2hEventId;

  const currentEid = h2hEventId || selectedEventId || '333';

  if (name1El) {
    name1El.textContent = (h2hComp1 && h2hComp1.name) ? h2hComp1.name.toUpperCase() : 'COMPETIDOR 1';
  }
  if (name2El) {
    name2El.textContent = (h2hComp2 && h2hComp2.name) ? h2hComp2.name.toUpperCase() : 'COMPETIDOR 2';
  }

  const fmtPanelPr = (comp, eid) => {
    if (!comp) return '— / —';
    const pr = comp.prs && comp.prs[eid];
    const rec = comp.personal_records && comp.personal_records[eid];
    const s = (pr && pr.single_fmt) ? pr.single_fmt : '—';
    const a = (pr && pr.average_fmt) ? pr.average_fmt : '—';
    const sNr = pr?.single_nr ?? rec?.single?.country_rank ?? null;
    const aNr = pr?.average_nr ?? rec?.average?.country_rank ?? null;
    const sTxt = (s !== '—' && s !== '-' && sNr) ? `${s} (NR ${sNr})` : s;
    const aTxt = (a !== '—' && a !== '-' && aNr) ? `${a} (NR ${aNr})` : a;
    return `${sTxt} / ${aTxt}`;
  };

  if (pr1El) pr1El.textContent = fmtPanelPr(h2hComp1, currentEid);
  if (pr2El) pr2El.textContent = fmtPanelPr(h2hComp2, currentEid);

  const sizeSlider = document.getElementById('h2h-size-slider');
  const sizeVal = document.getElementById('h2h-size-val');
  if (sizeSlider && document.activeElement !== sizeSlider) sizeSlider.value = headToHeadSize;
  if (sizeVal) sizeVal.textContent = `${headToHeadSize}px`;

  const p1g = document.getElementById('h2h-p1-gold');
  const p1s = document.getElementById('h2h-p1-silver');
  const p1b = document.getElementById('h2h-p1-bronze');
  const p2g = document.getElementById('h2h-p2-gold');
  const p2s = document.getElementById('h2h-p2-silver');
  const p2b = document.getElementById('h2h-p2-bronze');

  if (p1g && document.activeElement !== p1g) p1g.value = h2hPodiums1.gold || 0;
  if (p1s && document.activeElement !== p1s) p1s.value = h2hPodiums1.silver || 0;
  if (p1b && document.activeElement !== p1b) p1b.value = h2hPodiums1.bronze || 0;
  if (p2g && document.activeElement !== p2g) p2g.value = h2hPodiums2.gold || 0;
  if (p2s && document.activeElement !== p2s) p2s.value = h2hPodiums2.silver || 0;
  if (p2b && document.activeElement !== p2b) p2b.value = h2hPodiums2.bronze || 0;
}

function onH2HSearchInput(slot, query) {
  const dropdown = document.getElementById(`h2h-results-${slot}`);
  if (!dropdown) return;

  const q = (query || '').trim().toLowerCase();
  if (q.length < 2) {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    return;
  }

  const comps = (tournamentData && tournamentData.competitors) || [];
  const matches = comps.filter(c => {
    const n = (c.name || '').toLowerCase();
    const w = (c.wca_id || '').toLowerCase();
    return n.includes(q) || w.includes(q);
  }).slice(0, 8);

  if (matches.length === 0) {
    dropdown.innerHTML = '<div style="padding:8px 12px;color:var(--text-dim);font-size:12px;">No se encontraron competidores</div>';
    dropdown.style.display = 'block';
    return;
  }

  dropdown.innerHTML = matches.map(c => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);transition:background 0.15s;" 
         onmouseover="this.style.background='rgba(255,255,255,0.08)'" 
         onmouseout="this.style.background='transparent'" 
         onclick="selectH2HCompetitor(${slot}, decodeURIComponent('${encodeURIComponent(c.wca_id || c.name)}'))">
      <span style="font-weight:700;font-size:12px;color:#fff;">${escapeHtml(c.name)}</span>
      <span style="font-size:11px;font-weight:500;color:var(--admin-text-secondary);font-family:var(--admin-font-mono);">${escapeHtml(c.wca_id || 'NUEVO')}</span>
    </div>
  `).join('');
  dropdown.style.display = 'block';
}

function selectH2HCompetitor(slot, idOrName) {
  const comps = (tournamentData && tournamentData.competitors) || [];
  const comp = comps.find(c => (c.wca_id || '').toUpperCase() === idOrName.toUpperCase() || c.name === idOrName);
  if (!comp) return;

  if (slot === 1) {
    h2hComp1 = comp;
    const inp = document.getElementById('h2h-search-1');
    if (inp) inp.value = comp.name;
    const drop = document.getElementById('h2h-results-1');
    if (drop) drop.style.display = 'none';
    if (comp.wca_id) {
      fetchCompetitorAvatarIfNeeded(comp).then(() => {
        updateHeadToHeadUI();
        if (headToHeadVisible) sendShowHeadToHead();
      });
    }
  } else {
    h2hComp2 = comp;
    const inp = document.getElementById('h2h-search-2');
    if (inp) inp.value = comp.name;
    const drop = document.getElementById('h2h-results-2');
    if (drop) drop.style.display = 'none';
    if (comp.wca_id) {
      fetchCompetitorAvatarIfNeeded(comp).then(() => {
        updateHeadToHeadUI();
        if (headToHeadVisible) sendShowHeadToHead();
      });
    }
  }

  fetchH2HPodiumsFromWCA();
  updateHeadToHeadUI();
  if (headToHeadVisible) {
    sendShowHeadToHead();
  }
}

function swapHeadToHeadCompetitors() {
  const tmpComp = h2hComp1;
  h2hComp1 = h2hComp2;
  h2hComp2 = tmpComp;

  const tmpPod = h2hPodiums1;
  h2hPodiums1 = h2hPodiums2;
  h2hPodiums2 = tmpPod;

  const s1 = document.getElementById('h2h-search-1');
  const s2 = document.getElementById('h2h-search-2');
  if (s1) s1.value = h2hComp1 ? h2hComp1.name : '';
  if (s2) s2.value = h2hComp2 ? h2hComp2.name : '';

  updateHeadToHeadUI();
  if (headToHeadVisible) {
    sendShowHeadToHead();
  }
}

function onH2HEventSelectChange(eid) {
  h2hEventId = eid || '333';
  fetchH2HPodiumsFromWCA();
  updateHeadToHeadUI();
  if (headToHeadVisible) {
    sendShowHeadToHead();
  }
}

function onH2HPodiumChange() {
  const p1g = parseInt(document.getElementById('h2h-p1-gold')?.value, 10) || 0;
  const p1s = parseInt(document.getElementById('h2h-p1-silver')?.value, 10) || 0;
  const p1b = parseInt(document.getElementById('h2h-p1-bronze')?.value, 10) || 0;
  const p2g = parseInt(document.getElementById('h2h-p2-gold')?.value, 10) || 0;
  const p2s = parseInt(document.getElementById('h2h-p2-silver')?.value, 10) || 0;
  const p2b = parseInt(document.getElementById('h2h-p2-bronze')?.value, 10) || 0;

  h2hPodiums1 = { gold: p1g, silver: p1s, bronze: p1b };
  h2hPodiums2 = { gold: p2g, silver: p2s, bronze: p2b };

  if (headToHeadVisible) {
    sendShowHeadToHead();
  }
}

async function fetchH2HPodiumsFromWCA() {
  const eid = h2hEventId || selectedEventId || '333';
  let updated = false;

  const applyRecordsToComp = (comp, data) => {
    if (!comp || !data) return;
    if (data.records && Object.keys(data.records).length > 0) {
      comp.personal_records = data.records;
      if (comp.prs) {
        for (const [evKey, rObj] of Object.entries(data.records)) {
          if (comp.prs[evKey]) {
            comp.prs[evKey].single_nr = rObj.single?.country_rank ?? null;
            comp.prs[evKey].average_nr = rObj.average?.country_rank ?? null;
          }
        }
      }
    } else if (comp.prs && comp.prs[eid]) {
      if (data.single_nr !== undefined) comp.prs[eid].single_nr = data.single_nr;
      if (data.average_nr !== undefined) comp.prs[eid].average_nr = data.average_nr;
    }
  };

  if (h2hComp1 && h2hComp1.wca_id) {
    try {
      const res = await fetch(`/api/wca/podiums/${h2hComp1.wca_id}?eventId=${eid}`);
      const data = await res.json();
      if (data.ok) {
        h2hPodiums1 = { gold: data.gold, silver: data.silver, bronze: data.bronze };
        applyRecordsToComp(h2hComp1, data);
        updated = true;
      }
    } catch (e) {
      console.warn('Error fetching podiums 1:', e);
    }
  } else {
    h2hPodiums1 = { gold: 0, silver: 0, bronze: 0 };
  }

  if (h2hComp2 && h2hComp2.wca_id) {
    try {
      const res = await fetch(`/api/wca/podiums/${h2hComp2.wca_id}?eventId=${eid}`);
      const data = await res.json();
      if (data.ok) {
        h2hPodiums2 = { gold: data.gold, silver: data.silver, bronze: data.bronze };
        applyRecordsToComp(h2hComp2, data);
        updated = true;
      }
    } catch (e) {
      console.warn('Error fetching podiums 2:', e);
    }
  } else {
    h2hPodiums2 = { gold: 0, silver: 0, bronze: 0 };
  }

  updateHeadToHeadUI();
  if (headToHeadVisible && updated) {
    sendShowHeadToHead();
  }
}

function sendShowHeadToHead() {
  if (!h2hComp1 && !h2hComp2) {
    showToast('Selecciona al menos un competidor para el Head to Head', 'warning');
    return;
  }
  headToHeadVisible = true;
  const payload = {
    competitor1: h2hComp1,
    competitor2: h2hComp2,
    event: { event_id: h2hEventId || selectedEventId || '333' },
    podiums1: h2hPodiums1,
    podiums2: h2hPodiums2
  };
  sendWS({
    type: 'show_head_to_head',
    data: payload,
    size: headToHeadSize
  });
  updateHeadToHeadUI();
  showToast('Enfrentamiento Head to Head en pantalla', 'success');
}

function sendHideHeadToHead() {
  headToHeadVisible = false;
  sendWS({ type: 'hide_head_to_head' });
  updateHeadToHeadUI();
  showToast('Enfrentamiento Head to Head ocultado');
}

function onH2HSizeInput(val) {
  const s = parseInt(val, 10);
  if (isNaN(s)) return;
  headToHeadSize = s;
  const sizeVal = document.getElementById('h2h-size-val');
  if (sizeVal) sizeVal.textContent = `${headToHeadSize}px`;
  sendWS({
    type: 'set_head_to_head_size',
    size: headToHeadSize
  });
}

function setH2HSizePreset(val) {
  const slider = document.getElementById('h2h-size-slider');
  if (slider) slider.value = val;
  onH2HSizeInput(val);
}

// ══════════════════════════════════════════════════════════════════
// ── GESTIÓN DEL BANNER DE FINALES VERSUS (CARA A CARA WCA LIVE) ──
// ══════════════════════════════════════════════════════════════════

function populateVersusRoundSelect(targetRoundId = null) {
  const select = document.getElementById('versus-round-select');
  if (!select) return;

  if (!liveRankingRounds || liveRankingRounds.length === 0) {
    select.innerHTML = '<option value="">No hay rondas de WCA Live disponibles</option>';
    select.disabled = true;
    return;
  }

  select.innerHTML = liveRankingRounds.map(r => {
    const eName = EVENT_NAMES[r.eventId] || r.eventName || r.eventId;
    return `<option value="${r.roundId}">${eName} - ${r.roundName} (Ronda ${r.roundNumber})</option>`;
  }).join('');
  select.disabled = false;

  const toSelect = targetRoundId || versusRoundId || liveRankingSelectedRoundId || localStorage.getItem('directoobs_versus_round_id');
  if (toSelect && liveRankingRounds.some(r => r.roundId === toSelect)) {
    select.value = toSelect;
    versusRoundId = toSelect;
  } else {
    select.value = liveRankingRounds[0].roundId;
    versusRoundId = select.value;
  }

  // Cargar competidores de la ronda para los selects
  fetchVersusDataForRound(versusRoundId);
}

async function fetchVersusDataForRound(roundId) {
  if (!roundId) return;
  try {
    const res = await fetch(`/api/live/rounds/${encodeURIComponent(roundId)}?top=0`);
    const data = await res.json();
    const results = data.ranking?.ranking || data.ranking?.results || [];
    if (data.ok && results.length > 0) {
      populateVersusCompetitors(results);
    }
  } catch (err) {
    console.warn('[VersusPanel] Error obteniendo competidores de la ronda:', err);
  }
}

function populateVersusCompetitors(results) {
  const sel1 = document.getElementById('versus-comp1-select');
  const sel2 = document.getElementById('versus-comp2-select');
  if (!sel1 || !sel2) return;

  if (!results || results.length === 0) {
    sel1.innerHTML = '<option value="">Sin competidores</option>';
    sel2.innerHTML = '<option value="">Sin competidores</option>';
    return;
  }

  const optionsHtml = '<option value="">-- Seleccionar de la ronda --</option>' + results.map(r => {
    const name = r.name || 'Desconocido';
    const wcaId = r.wcaId ? ` (${r.wcaId})` : '';
    const pos = r.ranking ? `#${r.ranking} ` : '';
    return `<option value="${escapeHtml(name)}">${pos}${escapeHtml(name)}${wcaId}</option>`;
  }).join('');

  sel1.innerHTML = optionsHtml;
  sel2.innerHTML = optionsHtml;

  // Restaurar selección previa si existe
  if (versusComp1Target) {
    sel1.value = versusComp1Target;
    const inp1 = document.getElementById('versus-comp1-custom');
    if (inp1) inp1.value = versusComp1Target;
  } else if (results.length > 0) {
    sel1.value = results[0].name;
    versusComp1Target = results[0].name;
    const inp1 = document.getElementById('versus-comp1-custom');
    if (inp1) inp1.value = results[0].name;
  }

  if (versusComp2Target) {
    sel2.value = versusComp2Target;
    const inp2 = document.getElementById('versus-comp2-custom');
    if (inp2) inp2.value = versusComp2Target;
  } else if (results.length > 1) {
    sel2.value = results[1].name;
    versusComp2Target = results[1].name;
    const inp2 = document.getElementById('versus-comp2-custom');
    if (inp2) inp2.value = results[1].name;
  }

  // Refrescar los datos del versus en el servidor y panel
  sendVersusConfigToServer();
}

function onVersusRoundChanged() {
  const sel = document.getElementById('versus-round-select');
  if (!sel) return;
  versusRoundId = sel.value;
  localStorage.setItem('directoobs_versus_round_id', versusRoundId);
  fetchVersusDataForRound(versusRoundId);
}

function syncVersusWithCurrentRound() {
  if (liveRankingSelectedRoundId) {
    const sel = document.getElementById('versus-round-select');
    if (sel) {
      sel.value = liveRankingSelectedRoundId;
      onVersusRoundChanged();
      showToast('Ronda sincronizada con Ranking WCA Live', 'info');
    }
  } else {
    showToast('No hay ronda activa seleccionada en el ranking', 'warning');
  }
}

function onVersusCompSelectChange(slot) {
  const sel = document.getElementById(`versus-comp${slot}-select`);
  const inp = document.getElementById(`versus-comp${slot}-custom`);
  if (!sel) return;
  const val = sel.value;
  if (inp) inp.value = val;
  if (slot === 1) versusComp1Target = val;
  if (slot === 2) versusComp2Target = val;
  sendVersusConfigToServer();
}

function onVersusCompCustomChange(slot) {
  const inp = document.getElementById(`versus-comp${slot}-custom`);
  const sel = document.getElementById(`versus-comp${slot}-select`);
  if (!inp) return;
  const val = inp.value.trim();
  if (sel) sel.value = val;
  if (slot === 1) versusComp1Target = val;
  if (slot === 2) versusComp2Target = val;
  sendVersusConfigToServer();
}

function swapVersusCompetitors() {
  const tmp = versusComp1Target;
  versusComp1Target = versusComp2Target;
  versusComp2Target = tmp;

  const sel1 = document.getElementById('versus-comp1-select');
  const sel2 = document.getElementById('versus-comp2-select');
  const inp1 = document.getElementById('versus-comp1-custom');
  const inp2 = document.getElementById('versus-comp2-custom');

  if (sel1) sel1.value = versusComp1Target || '';
  if (inp1) inp1.value = versusComp1Target || '';
  if (sel2) sel2.value = versusComp2Target || '';
  if (inp2) inp2.value = versusComp2Target || '';

  sendVersusConfigToServer();
}

function onVersusPollChanged(val) {
  const sec = parseInt(val, 10) || 2;
  versusPollInterval = sec;
  sendVersusConfigToServer();
}

function sendVersusConfigToServer() {
  sendWS({
    type: 'set_versus_config',
    roundId: versusRoundId,
    compId: liveRankingCompId || versusCompId,
    comp1Target: versusComp1Target,
    comp2Target: versusComp2Target,
    pollInterval: versusPollInterval
  });
}

function manualRefreshVersus() {
  sendWS({ type: 'versus_refresh' });
  showToast('Actualizando datos de Versus WCA Live...', 'info');
}

function sendShowVersusBanner() {
  if (!versusRoundId && !isVersusMockActive && !versusData) {
    showToast('Selecciona primero una ronda de WCA Live o usa "Mockear Duelo"', 'warning');
    return;
  }
  versusBannerVisible = true;
  sendWS({
    type: 'show_versus_banner',
    roundId: versusRoundId,
    compId: liveRankingCompId || versusCompId,
    comp1Target: versusComp1Target,
    comp2Target: versusComp2Target,
    pollInterval: versusPollInterval
  });
  updateVersusUI();
  showToast('Banner de Finales Versus enviado a OBS', 'success');
}

function sendHideVersusBanner() {
  versusBannerVisible = false;
  sendWS({ type: 'hide_versus_banner' });
  updateVersusUI();
  showToast('Banner de Finales Versus ocultado', 'info');
}

function updateVersusUI() {
  const badge = document.getElementById('versus-status-badge');
  const btnShow = document.getElementById('btn-show-versus');

  if (badge) {
    if (versusBannerVisible) {
      badge.className = 'live-status-pill online';
      badge.textContent = `Al aire · ${versusPollInterval}s`;
    } else {
      badge.className = 'live-status-pill offline';
      badge.textContent = 'En espera';
    }
  }

  if (btnShow) {
    const ic = window.Icon ? window.Icon(versusBannerVisible ? 'check' : 'play', { size: 15 }) : '';
    btnShow.classList.toggle('active', versusBannerVisible);
    btnShow.innerHTML = versusBannerVisible
      ? `${ic}<span>Al aire en OBS</span>`
      : `${ic}<span>Mostrar en OBS</span>`;
  }

  const pollSel = document.getElementById('versus-poll-select');
  if (pollSel && versusPollInterval) {
    pollSel.value = String(versusPollInterval);
  }
  window.AdminUI?.syncAdminLiveNowUI();
}

function renderVersusPanelPreview(data) {
  if (!data) return;

  const evPreview = document.getElementById('versus-preview-event');
  if (evPreview) {
    let evName = data.eventName || '3x3';
    evName = evName.replace(/(\d+)x\1x\1(\s*Cube)?/gi, '$1x$1');
    evPreview.textContent = `${evName.toUpperCase()} • ${(data.roundName || 'FINAL').toUpperCase()}`;
  }

  renderVersusPanelRow(1, data.competitor1);
  renderVersusPanelRow(2, data.competitor2);
}

function renderVersusPanelRow(slot, comp) {
  const elName = document.getElementById(`vp-name-${slot}`);
  if (elName) {
    elName.textContent = (comp && comp.name) ? comp.name : (slot === 1 ? 'Competidor 1' : 'Competidor 2');
  }

  const attempts = comp?.attempts || [];
  for (let i = 1; i <= 5; i++) {
    const td = document.getElementById(`vp-s${slot}-${i}`);
    if (!td) continue;
    const att = attempts[i - 1];
    if (att && att.text && att.text !== '—') {
      td.textContent = att.text;
      td.style.color = att.isTrimmed ? '#94a3b8' : '#e2e8f0';
    } else {
      td.textContent = '—';
      td.style.color = '#64748b';
    }
  }

  const wpaTd = document.getElementById(`vp-wpa-${slot}`);
  if (wpaTd) {
    wpaTd.textContent = comp?.wpaFormatted || comp?.wpa || '—';
  }

  const bpaTd = document.getElementById(`vp-bpa-${slot}`);
  if (bpaTd) {
    bpaTd.textContent = comp?.bpaFormatted || comp?.bpa || '—';
  }

  const avgTd = document.getElementById(`vp-avg-${slot}`);
  if (avgTd) {
    avgTd.textContent = comp?.avgFormatted || comp?.averageOfficialFormatted || comp?.average || '—';
  }
}





function toggleVersusMockSection() {
  const box = document.getElementById('versus-mock-box');
  if (!box) return;
  box.style.display = (box.style.display === 'none') ? 'flex' : 'none';
}

async function triggerVersusMock(preset = 'epic', step = 5) {
  try {
    versusMockPreset = preset;
    versusMockStep = step;
    isVersusMockActive = true;
    showToast(`Cargando mock: ${preset.toUpperCase()} (Paso ${step}/5)...`, 'info');

    const res = await fetch('/api/versus/mock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ preset, step, visible: versusBannerVisible })
    });
    const d = await res.json();
    if (d.ok && d.data) {
      versusData = d.data;
      renderVersusPanelPreview(versusData);
      updateVersusMockUI();
      updateVersusUI();
      showToast('¡Mock de Versus cargado con éxito!', 'success');
    }
  } catch (err) {
    showToast('Error cargando mock: ' + err.message, 'error');
  }
}

async function setVersusMockStep(step) {
  try {
    versusMockStep = step;
    const res = await fetch('/api/versus/mock/step', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ step })
    });
    const d = await res.json();
    if (d.ok && d.data) {
      versusData = d.data;
      renderVersusPanelPreview(versusData);
      updateVersusMockUI();
      showToast(`Paso ${step}/5 simulado (Solves 1 a ${step})`, 'info');
    }
  } catch (err) {
    showToast('Error cambiando paso de mock: ' + err.message, 'error');
  }
}

async function nextVersusMockStep() {
  try {
    const nextStep = (versusMockStep % 5) + 1;
    await setVersusMockStep(nextStep);
  } catch (err) {
    showToast('Error avanzando solve: ' + err.message, 'error');
  }
}

async function resetVersusMock() {
  try {
    isVersusMockActive = false;
    versusMockStep = 5;
    const res = await fetch('/api/versus/mock/reset', { method: 'POST' });
    const d = await res.json();
    if (d.ok) {
      updateVersusMockUI();
      updateVersusUI();
      showToast('Mock desactivado. Vinculación WCA Live restaurada.', 'info');
    }
  } catch (err) {
    showToast('Error restableciendo mock: ' + err.message, 'error');
  }
}

function updateVersusMockUI() {
  const badge = document.getElementById('versus-mock-badge');
  if (badge) {
    badge.style.display = isVersusMockActive ? 'inline-flex' : 'none';
    if (isVersusMockActive) {
      badge.textContent = `MOCK ACTIVO · PASO ${versusMockStep}/5`;
    }
  }

  const stepBtns = document.querySelectorAll('#versus-mock-step-btns button');
  stepBtns.forEach(btn => {
    const s = parseInt(btn.getAttribute('data-step'), 10);
    if (s === versusMockStep && isVersusMockActive) {
      btn.classList.add('is-active', 'admin-btn--primary');
      btn.classList.remove('admin-btn--ghost');
    } else {
      btn.classList.remove('is-active', 'admin-btn--primary');
      btn.classList.add('admin-btn--ghost');
    }
  });
}

// ═════════════════════════════════════════════════════════════════
// HERRAMIENTAS DE MOCK Y SIMULACIÓN PARA TABLA DE CLASIFICACIÓN
// ═════════════════════════════════════════════════════════════════
let isRankingMockActive = false;
let rankingMockPreset = 'world_finals';

function toggleRankingMockSection() {
  const box = document.getElementById('ranking-mock-box');
  const btn = document.getElementById('btn-toggle-ranking-mock');
  if (!box) return;
  const isHidden = box.style.display === 'none';
  box.style.display = isHidden ? 'flex' : 'none';
  if (btn) {
    if (isHidden) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  }
}

async function triggerRankingMock(preset = 'world_finals') {
  try {
    rankingMockPreset = preset;
    isRankingMockActive = true;
    showToast(`Cargando mock de clasificación: ${preset.toUpperCase()}...`, 'info');

    const res = await fetch('/api/live/ranking/mock', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        preset,
        top: liveRankingTop,
        cutoff: liveRankingCutoff,
        viewMode: liveRankingViewMode,
        visible: liveRankingVisible
      })
    });
    const d = await res.json();
    if (d.ok && d.data) {
      liveRankingData = d.data;
      renderLiveRankingPreview(liveRankingData);
      updatePagingSummary();
      updateRankingMockUI();
      updateLiveRankingUI();
      showToast('¡Tabla de clasificación mock cargada con éxito!', 'success');
    }
  } catch (err) {
    showToast('Error cargando mock de clasificación: ' + err.message, 'error');
  }
}

async function setRankingMockCutoff(cutoff) {
  try {
    liveRankingCutoff = parseInt(cutoff, 10) || 0;
    const cutoffInput = document.getElementById('live-cutoff-input');
    if (cutoffInput) cutoffInput.value = liveRankingCutoff;

    const res = await fetch('/api/live/ranking/mock/cutoff', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cutoff: liveRankingCutoff })
    });
    const d = await res.json();
    if (d.ok && d.data) {
      liveRankingData = d.data;
      renderLiveRankingPreview(liveRankingData);
      updatePagingSummary();
      updateRankingMockUI();
      showToast(`Corte establecido en: ${liveRankingCutoff === 0 ? 'Sin corte' : 'Top ' + liveRankingCutoff}`, 'info');
    }
  } catch (err) {
    showToast('Error actualizando corte: ' + err.message, 'error');
  }
}

async function resetRankingMock() {
  try {
    isRankingMockActive = false;
    const res = await fetch('/api/live/ranking/mock/reset', { method: 'POST' });
    const d = await res.json();
    if (d.ok) {
      liveRankingData = d.data;
      renderLiveRankingPreview(liveRankingData);
      updatePagingSummary();
      updateRankingMockUI();
      updateLiveRankingUI();
      showToast('Mock de clasificación desactivado. Restaurado estado de WCA Live.', 'info');
    }
  } catch (err) {
    showToast('Error restableciendo mock: ' + err.message, 'error');
  }
}

function updateRankingMockUI() {
  const badge = document.getElementById('ranking-mock-badge');
  if (badge) {
    badge.style.display = isRankingMockActive ? 'inline-flex' : 'none';
    if (isRankingMockActive) {
      const pName = rankingMockPreset === 'world_finals' ? 'FINAL MUNDIAL' :
                    rankingMockPreset === 'colombia_nationals' ? 'PAIPA 2026' : 'EN CURSO';
      badge.textContent = `MOCK: ${pName}`;
    }
  }

  // Resaltar preset activo
  const btnWorld = document.getElementById('btn-mock-rf-world');
  const btnCol = document.getElementById('btn-mock-rf-col');
  const btnProg = document.getElementById('btn-mock-rf-prog');

  [btnWorld, btnCol, btnProg].forEach(b => b?.classList.remove('is-active', 'admin-btn--primary'));
  if (isRankingMockActive) {
    if (rankingMockPreset === 'world_finals' && btnWorld) btnWorld.classList.add('is-active', 'admin-btn--primary');
    else if (rankingMockPreset === 'colombia_nationals' && btnCol) btnCol.classList.add('is-active', 'admin-btn--primary');
    else if (rankingMockPreset === 'in_progress' && btnProg) btnProg.classList.add('is-active', 'admin-btn--primary');
  }

  // Resaltar botón de corte activo
  const cutoffBtns = document.querySelectorAll('#ranking-mock-cutoff-btns button');
  cutoffBtns.forEach(btn => {
    const c = parseInt(btn.getAttribute('data-cutoff'), 10);
    if (c === liveRankingCutoff) {
      btn.classList.add('is-active', 'admin-btn--primary');
      btn.classList.remove('admin-btn--ghost');
    } else {
      btn.classList.remove('is-active', 'admin-btn--primary');
      btn.classList.add('admin-btn--ghost');
    }
  });
}
