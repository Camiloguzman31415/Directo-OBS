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

let obsStatus = {
  connected: false,
  currentProgramScene: null,
  scenes: [],
  isStreaming: false,
  isRecording: false
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
      if (msg.obsStatus) updateOBSUI(msg.obsStatus);
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

      if (msg.liveRankingData) {
        liveRankingData = msg.liveRankingData;
        renderLiveRankingPreview(liveRankingData);
      } else if (targetRoundId) {
        fetchLiveRoundRanking(targetRoundId, false);
      }
      updateLiveRankingUI();

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
        if (btnDemo) btnDemo.innerHTML = '<span>⏹ DETENER SIMULACIÓN</span>';
        const pillDemo = document.getElementById('demo-status-pill');
        if (pillDemo) {
          pillDemo.style.display = 'block';
          pillDemo.innerHTML = `⏱ <strong>Paso ${msg.demoStep}/${msg.demoTotalSteps}:</strong> ${escapeHtml(msg.demoNote)}`;
        }
      }
      if (msg.data && msg.data.isFinished) {
        demoRunning = false;
        const btnDemo = document.getElementById('btn-demo-final');
        if (btnDemo) btnDemo.innerHTML = '<span>⚡ DEMO EN VIVO: FINAL 3X3 (60s)</span>';
        const pillDemo = document.getElementById('demo-status-pill');
        if (pillDemo) {
          pillDemo.innerHTML = '✅ <strong>¡Simulación Finalizada!</strong> Podio oficial definido.';
          setTimeout(() => { if (pillDemo && !demoRunning) pillDemo.style.display = 'none'; }, 6000);
        }
      }
      if (!msg.visible) {
        demoRunning = false;
        const btnDemo = document.getElementById('btn-demo-final');
        if (btnDemo) btnDemo.innerHTML = '<span>⚡ DEMO EN VIVO: FINAL 3X3 (60s)</span>';
        const pillDemo = document.getElementById('demo-status-pill');
        if (pillDemo) pillDemo.style.display = 'none';
      }
      updateLiveRankingUI();
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

    case 'sync_versus_banner':
    case 'versus_banner_data':
      if (msg.visible !== undefined) versusBannerVisible = !!msg.visible;
      if (msg.roundId) versusRoundId = msg.roundId;
      if (msg.compId) versusCompId = msg.compId;
      if (msg.pollInterval !== undefined) versusPollInterval = msg.pollInterval;
      if (msg.comp1Target !== undefined) versusComp1Target = msg.comp1Target;
      if (msg.comp2Target !== undefined) versusComp2Target = msg.comp2Target;
      if (msg.data) {
        versusData = msg.data;
        renderVersusPanelPreview(versusData);
      }
      updateVersusUI();
      break;
  }
}

// ── Control de OBS Studio ──
function updateOBSUI(status) {
  obsStatus = status;

  const dot = document.getElementById('obs-status-dot');
  const text = document.getElementById('obs-status-text');
  const deck = document.getElementById('scenes-grid');
  const noObsNotice = document.getElementById('obs-disconnected-box');
  const videoBox = document.getElementById('obs-video-box');

  if (status.connected) {
    dot.className = 'status-dot active';
    text.textContent = 'OBS Conectado';
    noObsNotice.style.display = 'none';
    deck.style.display = 'grid';
    if (videoBox) videoBox.style.display = 'flex';

    renderScenes(status.scenes, status.currentProgramScene);
    if (status.currentSceneItems) {
      renderSceneSources(status.currentSceneItems, status.currentProgramScene);
    }
    updateOBSVideoUI(status);
    updateStudioModeUI();
    updateStreamButton(status.isStreaming);
    updateRecordButton(status.isRecording);
  } else {
    dot.className = 'status-dot danger';
    text.textContent = 'OBS Desconectado';
    deck.style.display = 'none';
    if (videoBox) videoBox.style.display = 'none';
    const sourcesBox = document.getElementById('active-scene-sources-box');
    if (sourcesBox) sourcesBox.style.display = 'none';
    updateStudioModeUI();
    noObsNotice.style.display = 'flex';
    updateStreamButton(false);
    updateRecordButton(false);
  }
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
      hint.textContent = '⚠️ Detén la transmisión o grabación para cambiar resolución o FPS en OBS.';
      hint.style.color = 'var(--warning)';
    }
  } else {
    if (hint) {
      hint.textContent = '* Aplica a la resolución del lienzo/salida y framerate de OBS.';
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
  if (destBox) destBox.style.display = isStudio ? 'flex' : 'none';
  setLayoutTarget(isStudio ? 'preview' : 'program');

  // Si modo estudio está activo, asegurar polling y cargar capturas
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
  if (studioFpsInterval <= 0) return; // Modo Pausa

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

// ── Control de Fuentes, Cámaras y Multimedia en OBS ──
function getSourceIcon(kind) {
  const k = (kind || '').toLowerCase();
  if (k.includes('dshow') || k.includes('video_capture') || k.includes('camera') || k.includes('avfoundation')) return '📷';
  if (k.includes('ffmpeg') || k.includes('vlc') || k.includes('media')) return '🎬';
  if (k.includes('browser')) return '🌐';
  if (k.includes('image')) return '🖼️';
  if (k.includes('text') || k.includes('gdiplus')) return '🔤';
  if (k.includes('color')) return '🎨';
  if (k.includes('group')) return '📁';
  return '📺';
}

function renderSceneSources(items, sceneName) {
  const box = document.getElementById('active-scene-sources-box');
  const container = document.getElementById('scene-sources-list');
  const label = document.getElementById('active-scene-name-label');
  const caption = document.getElementById('sources-count-caption');

  if (!box || !container) return;

  const directorBox = document.getElementById('camera-layout-director-box');

  if (!obsStatus.connected) {
    box.style.display = 'none';
    if (directorBox) directorBox.style.display = 'none';
    return;
  }

  box.style.display = 'flex';
  const name = sceneName || obsStatus.currentProgramScene || 'Escena';
  label.textContent = `Capas en: ${name}`;
  caption.textContent = `${items ? items.length : 0} fuentes`;
  container.innerHTML = '';

  populateCameraLayoutSelectors(items, sceneName);

  if (!items || items.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:var(--type-xs);padding:8px 0;">No hay fuentes en esta escena</div>';
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

    // Fila principal
    const mainRow = document.createElement('div');
    mainRow.className = 'source-item-main';

    mainRow.innerHTML = `
      <div class="source-item-info">
        <span class="source-icon">${icon}</span>
        <span class="source-name" title="${item.sourceName}">${item.sourceName}</span>
        <span class="source-kind-tag">${kind.replace('_source', '').replace('_input', '')}</span>
      </div>
      <button class="btn-source-eye ${isVisible ? 'visible' : ''}" id="btn-eye-${item.sceneItemId}" title="${isVisible ? 'Ocultar capa' : 'Mostrar capa'}">
        ${isVisible ? '👁️' : '👁️‍🗨️'}
      </button>
    `;

    const eyeBtn = mainRow.querySelector('.btn-source-eye');
    eyeBtn.onclick = () => {
      const currentlyVisible = eyeBtn.classList.contains('visible');
      toggleSourceVisibility(item.sceneItemId, !currentlyVisible);
    };

    card.appendChild(mainRow);

    // Barra de acciones / presets
    const actionsBar = document.createElement('div');
    actionsBar.className = 'source-actions-bar';

    if (isMedia) {
      actionsBar.innerHTML = `
        <button class="btn-source-preset" onclick="triggerMedia('${item.sourceName}', 'restart')" title="Reiniciar video desde el inicio">↺ Reiniciar</button>
        <button class="btn-source-preset" onclick="triggerMedia('${item.sourceName}', 'pause')" title="Pausar video">⏸ Pausa</button>
        <button class="btn-source-preset" onclick="triggerMedia('${item.sourceName}', 'play')" title="Reproducir video">▶ Play</button>
        <button class="btn-source-preset" onclick="triggerMedia('${item.sourceName}', 'stop')" title="Detener video">⏹ Stop</button>
      `;
      card.appendChild(actionsBar);
    } else if (isVisual) {
      actionsBar.innerHTML = `
        <button class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'fullscreen')" title="Pantalla completa (1920x1080)">⛶ Full</button>
        <button class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'pip_br')" title="Picture-in-Picture: Esquina inferior">◲ PiP Abajo</button>
        <button class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'pip_tr')" title="Picture-in-Picture: Esquina superior">◳ PiP Arriba</button>
        <button class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'split_left')" title="Mitad izquierda de pantalla">◫ Izq</button>
        <button class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'split_right')" title="Mitad derecha de pantalla">◫ Der</button>
        <button class="btn-source-preset" onclick="setSourceTransformPreset(${item.sceneItemId}, 'center_boxed')" title="Centrado con marco">▣ Centro</button>
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
    eyeBtn.innerHTML = enabled ? '👁️' : '👁️‍🗨️';
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
  showToast(enabled ? 'Capa visible en OBS' : 'Capa oculta en OBS');
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
let currentLayoutTarget = 'program'; // 'preview' o 'program'

function setLayoutTarget(target) {
  currentLayoutTarget = target;
  const btnPrev = document.getElementById('btn-dest-prev');
  const btnProg = document.getElementById('btn-dest-prog');
  const badge = document.getElementById('layout-target-badge');

  if (btnPrev) btnPrev.classList.toggle('active', target === 'preview');
  if (btnProg) btnProg.classList.toggle('active', target === 'program');
  if (badge) {
    badge.textContent = target === 'preview' ? 'PREVIEW' : 'EN VIVO';
    badge.style.color = target === 'preview' ? 'var(--success)' : 'var(--live)';
  }
}

function populateCameraLayoutSelectors(items, sceneName) {
  const directorBox = document.getElementById('camera-layout-director-box');
  const selectA = document.getElementById('select-cam-a');
  const selectB = document.getElementById('select-cam-b');
  const destBox = document.getElementById('layout-dest-box');

  if (!directorBox || !selectA || !selectB) return;

  if (!obsStatus.connected) {
    directorBox.style.display = 'none';
    return;
  }

  directorBox.style.display = 'flex';

  if (destBox) {
    destBox.style.display = obsStatus.studioMode ? 'flex' : 'none';
  }
  if (obsStatus.studioMode) {
    if (!currentLayoutTarget) currentLayoutTarget = 'preview';
    setLayoutTarget(currentLayoutTarget);
  } else {
    setLayoutTarget('program');
  }

  // Filtrar elementos visuales (cámaras, navegadores, imágenes, videos)
  const visualItems = (items || []).filter(item => {
    const k = (item.inputKind || '').toLowerCase();
    return !k.includes('wasapi') && !k.includes('audio');
  });

  const prevValA = selectA.value;
  const prevValB = selectB.value;

  selectA.innerHTML = '<option value="">Selecciona Cámara A...</option>';
  selectB.innerHTML = '<option value="">Selecciona Cámara B...</option>';

  visualItems.forEach(item => {
    const kindTag = (item.inputKind || 'capa').replace('_source', '').replace('_input', '');
    const optA = document.createElement('option');
    optA.value = item.sceneItemId;
    optA.textContent = `${item.sourceName} (${kindTag})`;
    selectA.appendChild(optA);

    const optB = document.createElement('option');
    optB.value = item.sceneItemId;
    optB.textContent = `${item.sourceName} (${kindTag})`;
    selectB.appendChild(optB);
  });

  // Restaurar selección previa si aún existe o autoseleccionar
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
}

async function applyCameraLayout(layout) {
  if (!obsStatus.connected) {
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

  const target = obsStatus.studioMode ? currentLayoutTarget : 'program';
  const targetScene = (target === 'preview' && obsStatus.studioMode)
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
      const destName = target === 'preview' ? 'Preview' : 'En Vivo';
      showToast(`¡Layout ${layoutNames[layout] || layout} aplicado a ${destName}!`, 'success');
      setTimeout(() => refreshStudioScreenshots(false), 200);
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
    const tile = document.createElement('div');
    const isProg = sceneName === currentProgram;
    const isPrev = !!(obsStatus.studioMode && sceneName === obsStatus.currentPreviewScene);

    tile.className = `scene-tile ${isProg ? 'program' : ''} ${isPrev ? 'preview' : ''}`;
    tile.dataset.scene = sceneName;

    tile.innerHTML = `
      <span class="scene-icon">🎬</span>
      <span class="scene-name">${sceneName}</span>
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
  if (active) {
    btn.classList.add('active');
    btn.innerHTML = `<span class="status-dot live"></span> STREAM EN VIVO`;
  } else {
    btn.classList.remove('active');
    btn.innerHTML = `<span class="status-dot"></span> INICIAR STREAM`;
  }
}

function updateRecordButton(active) {
  const btn = document.getElementById('btn-record-toggle');
  if (active) {
    btn.classList.add('active');
    btn.innerHTML = `<span class="status-dot live"></span> GRABANDO`;
  } else {
    btn.classList.remove('active');
    btn.innerHTML = `<span class="status-dot"></span> GRABAR`;
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
    titleEl.textContent = 'Sin Torneo Cargado';
    titleEl.title = 'No hay datos de torneo activos';
    if (clearBtn) clearBtn.style.display = 'none';

    document.getElementById('event-chips-bar').innerHTML =
      '<div style="color:var(--text-muted);font-size:var(--type-xs);padding:10px 0;grid-column:1/-1;">No hay torneo cargado. Descarga uno desde la pestaña <b>🌐 API WCA</b> o sube un archivo en <b>📂 Archivos</b>.</div>';

    document.getElementById('competitors-scroll-list').innerHTML =
      '<div style="color:var(--text-muted);font-size:var(--type-xs);padding:18px 12px;text-align:center;">Sin datos de torneo.<br>Ingresa un ID de competencia o carga un archivo JSON para listar competidores.</div>';

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
        ${roundCount ? `<span class="event-chip-rounds">${roundCount}</span>` : ''}
      </div>
      <span class="event-chip-title">${getCleanEventName(ev.event_id, ev.name)}</span>
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

  updateTickerLogoPreview();
  renderTickerNewsList();
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
      <button type="button" class="btn-tactile btn-secondary btn-sm remove-news-btn" title="Quitar este aviso" style="height:30px;width:30px;padding:0;color:var(--danger);display:flex;align-items:center;justify-content:center;font-weight:700;">✕</button>
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
    tournament_logo: tickerTournamentLogo || ''
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

function formatRoundName(rNum, total) {
  if (!rNum) return '';
  if (rNum === 1) return total === 1 ? 'FINAL' : 'FIRST ROUND';
  if (rNum === total) return 'FINAL';
  if (rNum === total - 1) return 'SEMI FINAL';
  return `ROUND ${rNum}`;
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
          <div class="search-result-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${c.name}</div>
          <div class="search-result-meta">${c.wca_id || 'NUEVO COMPETIDOR'} · ${c.country}</div>
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
        <span style="font-size:16px;">🌐</span>
        <div>
          <div class="search-result-name" style="color:var(--accent);">Buscar WCA ID "${q.toUpperCase()}" en vivo</div>
          <div class="search-result-meta">Consultar tiempos y PRs en la base oficial WCA</div>
        </div>
      </div>
      <div>
        <span class="comp-list-badge" style="background:var(--accent);color:#000;font-weight:700;">CONSULTAR</span>
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
    tournament_logo: tickerTournamentLogo || ''
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
  sendWS({ type: 'hide_all' });
  updateVisibilityStates(false, false);
  updateShowcaseUI();
  updateBigLogoUI();
  updateHeadToHeadUI();
  showToast('Todos los overlays ocultados');
}

function updateVisibilityStates(compVis, evVis) {
  competitorVisible = !!compVis;
  eventVisible = !!evVis;

  const btnShowComp = document.getElementById('btn-show-competitor');
  const btnShowEv = document.getElementById('btn-show-event');

  if (competitorVisible) {
    btnShowComp.style.background = 'linear-gradient(135deg, #10B981, #059669)';
    btnShowComp.innerHTML = '<span>✓ EN VIVO EN OBS</span>';
  } else {
    btnShowComp.style.background = 'linear-gradient(135deg, #00C8FF, #0077FF)';
    btnShowComp.innerHTML = '<span>▲ MOSTRAR EN PANTALLA</span>';
  }

  const deckCard = document.getElementById('event-deck-card');

  if (eventVisible) {
    btnShowEv.style.background = 'linear-gradient(135deg, #0d8250, #10a364)';
    btnShowEv.style.borderColor = '#10B981';
    btnShowEv.style.color = '#FFFFFF';
    btnShowEv.innerHTML = '<span>✓ EVENTO EN VIVO EN OBS</span>';
    if (deckCard) deckCard.classList.add('is-live');
  } else {
    btnShowEv.style.background = 'var(--surface-card)';
    btnShowEv.style.borderColor = 'var(--border)';
    btnShowEv.style.color = 'var(--text-main)';
    btnShowEv.innerHTML = '<span>▲ MOSTRAR EVENTO EN OBS</span>';
    if (deckCard) deckCard.classList.remove('is-live');
  }
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
      ? c.events.slice(0, 4).map(ev => `<span style="font-size:10px;background:rgba(255,255,255,0.06);padding:2px 6px;border-radius:3px;color:var(--text-muted);">${ev}</span>`).join(' ')
      : '';
    const moreEvents = eventsCount > 4 ? `<span style="font-size:10px;color:var(--text-dim);font-weight:700;">+${eventsCount - 4}</span>` : '';

    row.innerHTML = `
      <div class="comp-list-info" style="gap:12px;">
        ${flagHtml}
        <div>
          <div class="comp-list-name" style="font-weight:600;">${c.name}</div>
          <div style="font-size:11px;color:var(--text-muted);font-family:'Space Mono',monospace;display:flex;align-items:center;gap:6px;">
            <span>${c.wca_id || 'NUEVO'}</span>
            <span>·</span>
            <span>${c.country || ''}</span>
          </div>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:8px;">
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
    icon.textContent = bannerCompListOpen ? '▼' : '▶';
  }
  if (btnText) {
    btnText.textContent = bannerCompListOpen ? 'Cerrar Lista' : 'Abrir Lista';
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
          <div class="banner-comp-name">${c.name}</div>
          <div class="banner-comp-meta">${c.wca_id || 'NUEVO'} · ${c.country || ''}</div>
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
    text.textContent = 'Servidor Conectado';
  } else {
    dot.className = 'status-dot danger';
    text.textContent = 'Servidor Desconectado';
  }
}

function updateOverlayCount(count) {
  const badge = document.getElementById('overlay-count-badge');
  badge.textContent = `${count} overlay(s) OBS`;
}

function switchMainMenu(menuKey) {
  document.querySelectorAll('.deck-nav-tab').forEach(tab => {
    tab.classList.toggle('active', tab.dataset.nav === menuKey);
  });
  document.querySelectorAll('.main-view-panel').forEach(view => {
    view.classList.toggle('active', view.id === `view-${menuKey}`);
  });
  localStorage.setItem('directoobs_active_menu', menuKey);
}

function switchTab(tabId) {
  if (['database', 'scenes', 'banners'].includes(tabId)) {
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
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    toast.style.transition = 'all 0.25s ease';
    setTimeout(() => toast.remove(), 250);
  }, 3200);
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

    // Atajo '/' para enfocar buscador de competidores
    if (e.key === '/' && targetSearch && document.activeElement !== targetSearch) {
      e.preventDefault();
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
  if (!liveRankingSelectedRoundId) {
    showToast('Selecciona o carga una ronda de WCA Live primero', 'warning');
    return;
  }

  // Si no tenemos datos aún, intentar cargar y luego mostrar
  if (!liveRankingData) {
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
}

function sendHideLiveRanking() {
  sendWS({ type: 'live_ranking_hide' });
  liveRankingVisible = false;
  demoRunning = false;
  const btn = document.getElementById('btn-demo-final');
  if (btn) btn.innerHTML = '<span>⚡ DEMO EN VIVO: FINAL 3X3 (60s)</span>';
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
      if (btn) btn.innerHTML = '<span>⚡ DEMO EN VIVO: FINAL 3X3 (60s)</span>';
      if (statusPill) statusPill.style.display = 'none';
      showToast('Simulación de final detenida', 'info');
    } catch (e) {
      console.error(e);
    }
    return;
  }

  try {
    demoRunning = true;
    if (btn) btn.innerHTML = '<span>⏹ DETENER SIMULACIÓN</span>';
    if (statusPill) {
      statusPill.style.display = 'block';
      statusPill.innerHTML = '⚡ <em>Iniciando simulación de Final 3x3 (60s)...</em>';
    }
    showToast('Iniciando demostración en vivo de Final 3x3...', 'success');
    await fetch('/api/demo/start-final-simulation', { method: 'POST' });
  } catch (err) {
    showToast('Error al iniciar simulación: ' + err.message, 'error');
    demoRunning = false;
    if (btn) btn.innerHTML = '<span>⚡ DEMO EN VIVO: FINAL 3X3 (60s)</span>';
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
    const recTag = r.recordTag ? `<span class="live-record-badge">${r.recordTag}</span>` : '';
    const displayTime = r.displayTime || (r.solvesCompleted > 0 ? (r.averageFormatted !== '—' ? r.averageFormatted : r.bestFormatted) : '—');

    let targetsBadges = '';
    if (r.podiumTargets && Array.isArray(r.podiumTargets) && r.podiumTargets.length > 0) {
      targetsBadges = '<div style="display:flex;gap:4px;margin-top:3px;font-size:10px;">' + r.podiumTargets.map(t => {
        const color = t.color === 'gold' ? '#ffd000' : t.color === 'bronze' ? '#fb923c' : '#e2e8f0';
        return `<span style="background:rgba(0,0,0,0.5);border:1px solid ${color};color:${color};padding:1px 5px;border-radius:3px;font-weight:700;font-family:\'Space Mono\',monospace;">${t.label}: ${t.maxSolveFormatted}</span>`;
      }).join('') + '</div>';
    }

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
        <td style="text-align:right;font-family:'Space Mono',monospace;font-weight:700;">
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
  if (btnShow) {
    if (liveRankingVisible) {
      btnShow.classList.add('active');
      btnShow.innerHTML = '<span>● AL AIRE EN OBS</span>';
    } else {
      btnShow.classList.remove('active');
      btnShow.innerHTML = liveRankingViewMode === 'fullscreen' ? '<span>▲ MOSTRAR PANTALLA COMPLETA</span>' : '<span>▲ MOSTRAR EN OBS</span>';
    }
  }

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
  colorCycle: false,
  animation: 'none',
  animSpeed: 'slow'
};

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
  const cycleCheck = document.getElementById('fs-color-cycle-check');
  const animSelect = document.getElementById('fs-anim-select');
  const speedSelect = document.getElementById('fs-speed-select');
  const statusLabel = document.getElementById('fs-image-status');
  const previewBox = document.getElementById('fs-image-preview-container');
  const previewImg = document.getElementById('fs-image-preview');
  const btnRemove = document.getElementById('btn-fs-remove-image');

  const curColor = (currentFsTheme.bgColor || '#0c4ea8').toLowerCase();
  const curOpacity = currentFsTheme.opacity !== undefined ? currentFsTheme.opacity : 100;
  const curBlur = currentFsTheme.blur !== undefined ? currentFsTheme.blur : 0;
  const curCycle = !!currentFsTheme.colorCycle;
  const curAnim = currentFsTheme.animation || 'none';
  const curSpeed = currentFsTheme.animSpeed || 'slow';

  if (picker) picker.value = curColor;
  if (valLabel) valLabel.textContent = curColor;
  if (slider) slider.value = curOpacity;
  if (opLabel) opLabel.textContent = `${curOpacity}%`;
  if (blurSlider) blurSlider.value = curBlur;
  if (blurLabel) blurLabel.textContent = `${curBlur}px`;
  if (cycleCheck) cycleCheck.checked = curCycle;
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

function onFsColorCycleChange(checked) {
  currentFsTheme.colorCycle = !!checked;
  sendWS({
    type: 'set_fs_theme',
    data: { colorCycle: currentFsTheme.colorCycle }
  });
  showToast(`Transición de degradé: ${checked ? 'Activada' : 'Desactivada'}`, 'info');
}

function onFsAnimationChange(anim) {
  currentFsTheme.animation = anim;
  sendWS({
    type: 'set_fs_theme',
    data: { animation: anim }
  });
  const labelMap = {
    'none': 'Estático (Sin movimiento)',
    'ken-burns': 'Cinemático Ken Burns',
    'scroll-left': 'Flujo Izquierda ⬅️',
    'scroll-right': 'Flujo Derecha ➡️',
    'scroll-up': 'Flujo Arriba ⬆️',
    'scroll-down': 'Flujo Abajo ⬇️',
    'diagonal': 'Flujo Diagonal ↗️'
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
  currentFsTheme = {
    bgColor: '#0c4ea8',
    bgImage: null,
    opacity: 100,
    blur: 0,
    colorCycle: false,
    animation: 'none',
    animSpeed: 'slow'
  };
  fetch('/api/fs-background/delete', { method: 'POST' }).catch(() => {});
  sendWS({
    type: 'set_fs_theme',
    data: {
      bgColor: '#0c4ea8',
      bgImage: null,
      opacity: 100,
      blur: 0,
      colorCycle: false,
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
  if (comp.avatar_url !== undefined && comp.avatar_url !== null) return;
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
  const btnHide = document.getElementById('btn-hide-showcase');

  // 1. Estado en Vivo
  if (badge) {
    if (showcaseVisible) {
      badge.textContent = 'AL AIRE';
      badge.className = 'live-status-pill online';
    } else {
      badge.textContent = 'EN ESPERA';
      badge.className = 'live-status-pill offline';
    }
  }

  if (btnShow) {
    if (showcaseVisible) {
      btnShow.classList.remove('btn-primary');
      btnShow.classList.add('btn-tactile-active');
      btnShow.innerHTML = '● AL AIRE EN OBS';
    } else {
      btnShow.classList.add('btn-primary');
      btnShow.classList.remove('btn-tactile-active');
      btnShow.innerHTML = '▲ MOSTRAR EN OBS';
    }
  }

  // 2. Previsualización de la tarjeta
  const elFlag = document.getElementById('panel-showcase-bg-flag');
  const elAvatar = document.getElementById('panel-showcase-avatar');
  const elEmpty = document.getElementById('panel-showcase-empty');
  const elName = document.getElementById('panel-showcase-name');
  const elSingle = document.getElementById('panel-showcase-single');
  const elAvg = document.getElementById('panel-showcase-average');

  if (!elName) return;

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
  const eid = selectedEventId || (currentEvent && currentEvent.event_id) || '333';
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
        ${isWcaId ? `<button type="button" class="btn-tactile btn-primary" style="margin-top:6px;width:100%;font-size:11px;padding:4px;" onclick="fetchAndSelectShowcaseWCA('${q.toUpperCase()}')">🔍 Buscar WCA ID ${q.toUpperCase()}</button>` : ''}
      </div>
    `;
    resultsDropdown.style.display = 'block';
    return;
  }

  resultsDropdown.innerHTML = filtered.map(c => `
    <div class="search-item" style="display:flex;align-items:center;justify-content:space-between;padding:8px 12px;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);transition:background 0.15s;" onmouseover="this.style.background='rgba(255,255,255,0.08)'" onmouseout="this.style.background='transparent'" onclick="selectShowcaseFromSearch('${escapeHtml(c.wca_id || c.name)}')">
      <div style="display:flex;align-items:center;gap:8px;">
        ${c.country ? `<img src="https://flagcdn.com/w40/${c.country.toLowerCase()}.png" style="width:20px;height:14px;border-radius:2px;" onerror="this.style.display='none'">` : ''}
        <span style="font-size:12px;font-weight:700;color:var(--text-main);">${escapeHtml(c.name)}</span>
      </div>
      <span style="font-family:'Space Mono',monospace;font-size:10px;color:var(--text-dim);">${escapeHtml(c.wca_id || 'NUEVO')}</span>
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
    if (bigLogoVisible) {
      badge.textContent = 'EN VIVO';
      badge.className = 'live-status-pill online';
    } else {
      badge.textContent = 'EN ESPERA';
      badge.className = 'live-status-pill offline';
    }
  }

  if (btnShow && btnHide) {
    if (bigLogoVisible) {
      btnShow.style.boxShadow = '0 0 12px rgba(22, 163, 74, 0.6)';
      btnShow.style.borderColor = '#22c55e';
      btnHide.style.boxShadow = 'none';
      btnHide.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    } else {
      btnShow.style.boxShadow = 'none';
      btnShow.style.borderColor = 'transparent';
      btnHide.style.boxShadow = 'none';
      btnHide.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    }
  }

  const effectiveUrl = bigLogoUrl || tickerTournamentLogo || null;
  if (imgPreview && emptyPlaceholder) {
    if (effectiveUrl) {
      imgPreview.src = effectiveUrl;
      imgPreview.style.display = 'block';
      emptyPlaceholder.style.display = 'none';
    } else {
      imgPreview.src = '';
      imgPreview.style.display = 'none';
      emptyPlaceholder.style.display = 'block';
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
    if (headToHeadVisible) {
      badge.textContent = 'EN VIVO';
      badge.className = 'live-status-pill online';
    } else {
      badge.textContent = 'EN ESPERA';
      badge.className = 'live-status-pill offline';
    }
  }

  if (btnShow && btnHide) {
    if (headToHeadVisible) {
      btnShow.style.boxShadow = '0 0 12px rgba(22, 163, 74, 0.6)';
      btnShow.style.borderColor = '#22c55e';
      btnHide.style.boxShadow = 'none';
      btnHide.style.borderColor = 'rgba(239, 68, 68, 0.4)';
    } else {
      btnShow.style.boxShadow = 'none';
      btnShow.style.borderColor = 'transparent';
      btnHide.style.boxShadow = 'none';
      btnHide.style.borderColor = 'rgba(239, 68, 68, 0.3)';
    }
  }

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

  if (pr1El) {
    if (h2hComp1) {
      const pr = h2hComp1.prs && h2hComp1.prs[currentEid];
      const s = (pr && pr.single_fmt) ? pr.single_fmt : '—';
      const a = (pr && pr.average_fmt) ? pr.average_fmt : '—';
      pr1El.textContent = `${s} / ${a}`;
    } else {
      pr1El.textContent = '— / —';
    }
  }

  if (pr2El) {
    if (h2hComp2) {
      const pr = h2hComp2.prs && h2hComp2.prs[currentEid];
      const s = (pr && pr.single_fmt) ? pr.single_fmt : '—';
      const a = (pr && pr.average_fmt) ? pr.average_fmt : '—';
      pr2El.textContent = `${s} / ${a}`;
    } else {
      pr2El.textContent = '— / —';
    }
  }

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
         onclick="selectH2HCompetitor(${slot}, '${escapeHtml(c.wca_id || c.name)}')">
      <span style="font-weight:700;font-size:12px;color:#fff;">${escapeHtml(c.name)}</span>
      <span style="font-size:11px;color:var(--text-dim);font-family:'Space Mono',monospace;">${escapeHtml(c.wca_id || 'NUEVO')}</span>
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

  if (h2hComp1 && h2hComp1.wca_id) {
    try {
      const res = await fetch(`/api/wca/podiums/${h2hComp1.wca_id}?eventId=${eid}`);
      const data = await res.json();
      if (data.ok) {
        h2hPodiums1 = { gold: data.gold, silver: data.silver, bronze: data.bronze };
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
    const res = await fetch(`/api/live/rounds/${roundId}`);
    const data = await res.json();
    if (data.ok && data.ranking && data.ranking.results) {
      populateVersusCompetitors(data.ranking.results);
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
  if (!versusRoundId) {
    showToast('Selecciona primero una ronda de WCA Live para la final', 'warning');
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
      badge.textContent = `EN VIVO (${versusPollInterval}s)`;
    } else {
      badge.className = 'live-status-pill offline';
      badge.textContent = 'EN ESPERA';
    }
  }

  if (btnShow) {
    if (versusBannerVisible) {
      btnShow.classList.add('active');
      btnShow.innerHTML = '<span>● AL AIRE EN OBS</span>';
    } else {
      btnShow.classList.remove('active');
      btnShow.innerHTML = '<span>▲ MOSTRAR EN OBS</span>';
    }
  }

  const pollSel = document.getElementById('versus-poll-select');
  if (pollSel && versusPollInterval) {
    pollSel.value = String(versusPollInterval);
  }
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



