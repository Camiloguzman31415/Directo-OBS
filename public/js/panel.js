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
let bannerMode = 'dual';        // 'single' | 'dual'
let bannerPosition = 'top';     // 'top' | 'bottom'
let bannerAlign = 'center';     // siempre 'center' por defecto
let bannerFont = 'barlow_slim'; // 'barlow_slim' | 'barlow_bold' | 'inter' | 'roboto'
let selectedEventId = '333';
let currentRound = 1;
let totalRounds = 3;

let competitorVisible = false;
let eventVisible = false;

// ── Estado de Ranking en Vivo (WCA Live) ──
let liveRankingData = null;
let liveRankingVisible = false;
let liveRankingCompId = '';
let liveRankingRounds = [];
let liveRankingSelectedRoundId = '';
let liveRankingTop = 16;
let liveRankingCutoff = 16;
let liveRankingPollInterval = 15;
let liveRankingDynamicPaging = true;
let liveRankingAutoBalance = true;
let liveRankingPageDuration = 10;

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
  connectWebSocket();
  setupEventListeners();
  setupKeyboardShortcuts();
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
      updatePreviewUI();
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
      updatePreviewUI();
      if (msg.competitorVisible !== undefined || msg.eventVisible !== undefined) {
        updateVisibilityStates(msg.competitorVisible, msg.eventVisible);
      }
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

  // Renderizar chips de eventos
  renderEventChips(data.events || []);

  // Renderizar selector de filtro de eventos
  renderEventFilterOptions(data.events || []);

  // Renderizar lista de competidores en el panel derecho
  filterCompetitorList();

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

function sendShowEvent() {
  const ev = (tournamentData?.events || []).find(e => e.event_id === selectedEventId);
  const cleanName = getCleanEventName(selectedEventId, ev ? ev.name : selectedEventId);
  const data = {
    event_id: selectedEventId,
    event_name: cleanName,
    round_number: currentRound,
    total_rounds: totalRounds,
    tournament_name: tournamentData?.name || 'Regionales Santander 2026',
    city: tournamentData?.city || 'Floridablanca, Santander'
  };

  currentEvent = data;
  eventVisible = true;
  sendWS({ type: 'event', data });
  updateVisibilityStates(competitorVisible, true);
  showToast(`Evento en OBS: ${data.event_name} (${formatRoundName(currentRound, totalRounds)})`, 'success');
}

function sendHideEvent() {
  eventVisible = false;
  sendWS({ type: 'hide_event' });
  updateVisibilityStates(competitorVisible, false);
  showToast('Badge de evento ocultado de OBS');
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
  if (slot === 1) {
    currentCompetitor = c;
    showToast(`Mesa 1: ${c.name}`);
  } else if (slot === 2) {
    currentCompetitor2 = c;
    showToast(`Mesa 2: ${c.name}`);
  }
  updatePreviewUI();
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
}

function handleSearchInput(query, targetSlot = 1) {
  const menuId = targetSlot === 1
    ? 'search-results-slot-1'
    : (targetSlot === 2 ? 'search-results-slot-2' : 'search-results-menu');
  const resultsMenu = document.getElementById(menuId);
  if (!resultsMenu) return;

  const q = query.trim().toLowerCase();
  if (!q || !tournamentData) {
    resultsMenu.classList.remove('open');
    return;
  }

  const matches = tournamentData.competitors.filter(c =>
    c.name.toLowerCase().includes(q) || (c.wca_id || '').toLowerCase().includes(q)
  ).slice(0, 8);

  resultsMenu.innerHTML = '';
  matches.forEach((c, idx) => {
    const item = document.createElement('div');
    item.className = `search-result-item ${idx === 0 ? 'highlighted' : ''}`;

    const flagHtml = c.country
      ? `<img src="https://flagcdn.com/w40/${c.country.toLowerCase()}.png" style="width:22px;height:15px;border-radius:2px;" onerror="this.style.display='none'">`
      : '';

    item.innerHTML = `
      <div class="search-result-left">
        ${flagHtml}
        <div>
          <div class="search-result-name">${c.name}</div>
          <div class="search-result-meta">${c.wca_id || 'NUEVO COMPETIDOR'} · ${c.country}</div>
        </div>
      </div>
      <div>
        ${c.is_new ? '<span class="comp-list-badge new">NUEVO</span>' : '<span class="comp-list-badge">WCA</span>'}
      </div>
    `;

    item.onclick = () => {
      selectCompetitor(c, targetSlot);
      resultsMenu.classList.remove('open');
      const inputId = targetSlot === 1 ? 'search-slot-1' : (targetSlot === 2 ? 'search-slot-2' : 'competitor-search-input');
      const inp = document.getElementById(inputId);
      if (inp) inp.value = '';
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
    city: tournamentData?.city || 'Floridablanca, Santander'
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
  sendWS({ type: 'hide_all' });
  updateVisibilityStates(false, false);
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
  sel.innerHTML = '<option value="">Todos los eventos</option>';
  events.forEach(ev => {
    const opt = document.createElement('option');
    opt.value = ev.event_id;
    opt.textContent = ev.name;
    sel.appendChild(opt);
  });
}

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
  const typeF = document.getElementById('competitor-type-filter')?.value || '';

  const isFiltered = !!(searchQ || eventF || typeF);

  const filtered = allComps.filter(c => {
    if (searchQ && !c.name.toLowerCase().includes(searchQ) && !(c.wca_id || '').toLowerCase().includes(searchQ)) return false;
    if (eventF && !c.events.includes(eventF)) return false;
    if (typeF === 'new' && !c.is_new) return false;
    if (typeF === 'veteran' && c.is_new) return false;
    return true;
  });

  if (badgeEl) badgeEl.textContent = allComps.length;
  if (filterTag) filterTag.style.display = isFiltered ? 'inline-block' : 'none';

  if (countTextEl) {
    if (filtered.length === allComps.length) {
      countTextEl.textContent = `${allComps.length} competidores registrados`;
    } else {
      countTextEl.textContent = `Mostrando ${filtered.length} de ${allComps.length} competidores`;
    }
  }

  const listContainer = document.getElementById('competitors-scroll-list');
  listContainer.innerHTML = '';

  if (filtered.length === 0) {
    listContainer.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px;">Sin resultados</div>';
    return;
  }

  filtered.forEach(c => {
    const row = document.createElement('div');
    row.className = 'comp-list-row';

    const flagHtml = c.country
      ? `<img src="https://flagcdn.com/w40/${c.country.toLowerCase()}.png" style="width:20px;height:14px;border-radius:2px;" onerror="this.style.display='none'">`
      : '';

    row.innerHTML = `
      <div class="comp-list-info">
        ${flagHtml}
        <div>
          <div class="comp-list-name">${c.name}</div>
          <div style="font-size:11px;color:var(--text-muted);font-family:'Space Mono',monospace;">${c.wca_id || 'NUEVO'}</div>
        </div>
      </div>
      <div class="comp-list-actions" style="display:flex;gap:6px;align-items:center;">
        <button type="button" class="btn-assign-mini m1" title="Asignar a Mesa 1">M1</button>
        <button type="button" class="btn-assign-mini m2" title="Asignar a Mesa 2">M2</button>
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

    row.onclick = () => {
      if (bannerMode === 'dual') {
        if (!currentCompetitor) selectCompetitor(c, 1);
        else if (!currentCompetitor2) selectCompetitor(c, 2);
        else selectCompetitor(c, 1);
      } else {
        selectCompetitor(c, 1);
      }
      window.scrollTo({ top: 0, behavior: 'smooth' });
    };

    listContainer.appendChild(row);
  });
}

// ── Ingesta WCA Directa ──
async function triggerWCAFetch() {
  const compId = document.getElementById('wca-comp-id-input').value.trim();
  if (!compId) {
    showToast('Ingresa un ID de competencia WCA', 'error');
    return;
  }

  const btn = document.getElementById('btn-wca-fetch');
  btn.disabled = true;
  btn.textContent = 'Descargando...';

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
    }
  } catch (err) {
    showToast(`Error al iniciar descarga: ${err.message}`, 'error');
    btn.disabled = false;
    btn.textContent = 'Descargar desde WCA';
  }
}

function updateWCAProgress(pct, message, status) {
  const container = document.getElementById('wca-progress-box');
  container.style.display = 'flex';

  const fill = document.getElementById('wca-progress-fill');
  const text = document.getElementById('wca-progress-status-text');
  const btn = document.getElementById('btn-wca-fetch');

  fill.style.transform = `scaleX(${Math.min(Math.max(pct, 0), 100) / 100})`;
  text.textContent = `[${pct}%] ${message}`;

  if (status === 'ok' || pct >= 100) {
    btn.disabled = false;
    btn.textContent = 'Descargar desde WCA';
    showToast('¡Datos WCA descargados y listos!', 'success');
  } else if (status === 'error') {
    btn.disabled = false;
    btn.textContent = 'Descargar desde WCA';
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

function switchTab(tabId) {
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
  }
  if (searchInput2) {
    searchInput2.addEventListener('input', (e) => handleSearchInput(e.target.value, 2));
  }
  if (searchInputSingle) {
    searchInputSingle.addEventListener('input', (e) => handleSearchInput(e.target.value, 1));
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
  const cutSel = document.getElementById('live-cutoff-select');
  const modeSel = document.getElementById('live-paging-mode-select');
  const balSel = document.getElementById('live-balance-select');
  const durSel = document.getElementById('live-page-duration-select');

  if (topInput) liveRankingTop = Math.max(1, Math.min(60, parseInt(topInput.value, 10) || 16));
  else if (topSel) liveRankingTop = parseInt(topSel.value, 10) || 16;

  if (cutSel) liveRankingCutoff = parseInt(cutSel.value, 10) || 16;
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
  updateLiveRankingUI();
  showToast('Ranking en Vivo ocultado de OBS', 'info');
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
    const solvesPillClass = r.inProgress ? 'in-progress' : 'completed';
    const flagIso = (r.countryIso2 || 'co').toLowerCase();
    const recTag = r.recordTag ? `<span class="live-record-badge">${r.recordTag}</span>` : '';
    const displayTime = r.displayTime || (r.solvesCompleted > 0 ? (r.averageFormatted !== '—' ? r.averageFormatted : r.bestFormatted) : '—');

    return `
      <tr>
        <td style="text-align:center;">
          <span class="live-pos-badge ${badgeClass}">${r.ranking}</span>
        </td>
        <td style="text-align:center;">
          <img src="https://flagcdn.com/w40/${flagIso}.png" alt="${flagIso}" style="width:18px;height:12px;border-radius:2px;vertical-align:middle;" onerror="this.style.display='none'">
        </td>
        <td style="font-weight:600;max-width:140px;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(r.name)}">
          ${escapeHtml(r.name)}
        </td>
        <td style="text-align:center;">
          <span class="live-solves-pill ${solvesPillClass}">${r.solvesText || `${r.solvesCompleted || 0}/${r.totalSolves || 5}`}</span>
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

  const cutSel = document.getElementById('live-cutoff-select');
  if (cutSel && liveRankingCutoff !== undefined) cutSel.value = String(liveRankingCutoff);

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
  opacity: 100
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
  const statusLabel = document.getElementById('fs-image-status');
  const previewBox = document.getElementById('fs-image-preview-container');
  const previewImg = document.getElementById('fs-image-preview');
  const btnRemove = document.getElementById('btn-fs-remove-image');

  const curColor = (currentFsTheme.bgColor || '#0c4ea8').toLowerCase();
  const curOpacity = currentFsTheme.opacity !== undefined ? currentFsTheme.opacity : 100;

  if (picker) picker.value = curColor;
  if (valLabel) valLabel.textContent = curColor;
  if (slider) slider.value = curOpacity;
  if (opLabel) opLabel.textContent = `${curOpacity}%`;

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
    opacity: 100
  };
  fetch('/api/fs-background/delete', { method: 'POST' }).catch(() => {});
  sendWS({
    type: 'set_fs_theme',
    data: {
      bgColor: '#0c4ea8',
      bgImage: null,
      opacity: 100
    }
  });
  updateFsThemeUI();
  showToast('Fondo restablecido por defecto (Azul WCA, 100%)', 'info');
}


