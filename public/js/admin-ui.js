/**
 * DirectoOBS Admin Console — Controladores de UI Modular
 * Componentes: AppShell, Sidebar/Drawer, TopBar, LiveNowPanel,
 * OverlayCard colapsable, CollapsibleSection y SliderField presets.
 * Preserva 100% la logica, eventos WebSocket y endpoints de panel.js.
 */

(function () {
  const VIEW_META = {
    mesa: {
      title: 'Mesa y Evento',
      subtitle: 'Operación continua de rondas, competidores en mesa y ticker inferior'
    },
    clasificacion: {
      title: 'Clasificación (WCA Live)',
      subtitle: 'Tabla de posiciones en pantalla completa o mini widget lateral'
    },
    finales: {
      title: 'Finales y Duelos',
      subtitle: 'Presentación pre-duelo histórica (Head to Head) y marcador en vivo (Versus)'
    },
    pantalla: {
      title: 'Pausas y Escenas Web',
      subtitle: 'Logo central de descanso, estados de transición y apariencia fullscreen'
    },
    scenes: {
      title: 'Switcher y Cámaras OBS',
      subtitle: 'Modo estudio dual, cambio de escenas, split-screen y capas activas'
    },
    database: {
      title: 'Torneo y Base de Datos',
      subtitle: 'Sincronización oficial WCA, vinculación WCA Live y directorio de inscritos'
    }
  };

  function normalizeViewKey(menuKey) {
    if (!menuKey || menuKey === 'banners') return 'mesa';
    if (VIEW_META[menuKey]) return menuKey;
    return 'mesa';
  }

  /* ------------------------------------------------------------------------
     Drawer Lateral Responsive (accesible con inert + Escape)
     ------------------------------------------------------------------------ */
  function setSidebarDrawerOpen(open) {
    const sidebar = document.getElementById('admin-sidebar');
    const backdrop = document.getElementById('admin-drawer-backdrop');
    const trigger = document.getElementById('admin-menu-trigger');
    const workspace = document.getElementById('admin-workspace');
    if (!sidebar) return;

    const isMobile = window.matchMedia('(max-width: 1024px)').matches;
    const shouldOpen = Boolean(open && isMobile);

    sidebar.classList.toggle('is-open', shouldOpen);
    if (backdrop) backdrop.classList.toggle('is-open', shouldOpen);
    if (trigger) trigger.setAttribute('aria-expanded', shouldOpen ? 'true' : 'false');

    if (workspace) {
      if (shouldOpen) {
        workspace.setAttribute('inert', '');
        const firstTab = sidebar.querySelector('.deck-nav-tab.active, .deck-nav-tab');
        if (firstTab) firstTab.focus();
      } else {
        workspace.removeAttribute('inert');
      }
    }
  }

  /* ------------------------------------------------------------------------
     Navegacion Agrupada (6 vistas, compatible con switchMainMenu)
     ------------------------------------------------------------------------ */
  function activateAdminView(rawKey) {
    const key = normalizeViewKey(rawKey);
    document.querySelectorAll('#admin-root .deck-nav-tab').forEach((tab) => {
      const isActive = tab.dataset.nav === key;
      tab.classList.toggle('active', isActive);
      if (isActive) {
        tab.setAttribute('aria-current', 'page');
      } else {
        tab.removeAttribute('aria-current');
      }
    });

    document.querySelectorAll('#admin-root .main-view-panel').forEach((panel) => {
      const isActive = panel.id === `view-${key}`;
      panel.classList.toggle('active', isActive);
      panel.hidden = !isActive;
    });

    const heading = document.getElementById('admin-view-title');
    if (heading && VIEW_META[key]) {
      heading.textContent = VIEW_META[key].title;
    }

    document.title = `${VIEW_META[key]?.title || 'Consola'} | DirectoOBS`;
    try {
      localStorage.setItem('directoobs_active_menu', key);
    } catch (_) {}

    setSidebarDrawerOpen(false);
    if ((key === 'clasificacion' || key === 'pantalla') && typeof initRankingMiniMonitors === 'function') {
      setTimeout(initRankingMiniMonitors, 50);
    }
  }

  /* ------------------------------------------------------------------------
     Tarjetas OverlayCard Colapsables + Secciones Avanzadas CollapsibleSection
     ------------------------------------------------------------------------ */
  function initCollapsibleCardsAndSections() {
    // Botones de colapsar tarjeta completa (.admin-card-collapse-btn)
    document.querySelectorAll('#admin-root [data-card-collapse]').forEach((btn) => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        const card = btn.closest('.admin-overlay-card, .admin-panel-card');
        if (!card) return;
        const willCollapse = !card.classList.contains('is-collapsed');
        card.classList.toggle('is-collapsed', willCollapse);
        btn.setAttribute('aria-expanded', willCollapse ? 'false' : 'true');
        btn.setAttribute('aria-label', willCollapse ? 'Expandir tarjeta' : 'Contraer tarjeta');
      });
    });

    // Secciones "Ajustes avanzados" (.admin-collapsible-trigger)
    document.querySelectorAll('#admin-root .admin-collapsible-trigger').forEach((btn) => {
      if (btn.dataset.bound === '1') return;
      btn.dataset.bound = '1';
      btn.addEventListener('click', () => {
        const panelId = btn.getAttribute('aria-controls');
        const panel = panelId ? document.getElementById(panelId) : btn.nextElementSibling;
        if (!panel) return;
        const isExpanded = btn.getAttribute('aria-expanded') === 'true';
        btn.setAttribute('aria-expanded', isExpanded ? 'false' : 'true');
        panel.hidden = isExpanded;
      });
    });

    // Resaltado activo en chips de presets de SliderField
    document.querySelectorAll('#admin-root .admin-slider-field').forEach((field) => {
      const range = field.querySelector('input[type="range"]');
      const presets = field.querySelectorAll('.admin-preset-btn[data-preset-val]');
      if (!range || !presets.length) return;
      const syncPresets = () => {
        const val = String(range.value);
        presets.forEach((p) => {
          p.classList.toggle('is-active', p.dataset.presetVal === val);
        });
      };
      presets.forEach((p) => {
        if (p.dataset.bound === '1') return;
        p.dataset.bound = '1';
        if (!p.getAttribute('onclick')) {
          p.addEventListener('click', () => {
            range.value = p.dataset.presetVal;
            range.dispatchEvent(new Event('input', { bubbles: true }));
            range.dispatchEvent(new Event('change', { bubbles: true }));
            syncPresets();
          });
        } else {
          p.addEventListener('click', () => setTimeout(syncPresets, 0));
        }
      });
      range.addEventListener('input', syncPresets);
      range.addEventListener('change', syncPresets);
      syncPresets();
    });
  }

  /* ------------------------------------------------------------------------
     Sincronizacion en Vivo del Panel "Al aire ahora" (LiveNowPanel) y Badges
     ------------------------------------------------------------------------ */
  function getOverlayLiveDescriptors() {
    const items = [];

    if (typeof competitorVisible !== 'undefined' && competitorVisible) {
      let detail = '';
      if (typeof bannerMode !== 'undefined' && bannerMode === 'dual') {
        const n1 = (typeof currentCompetitor !== 'undefined' && currentCompetitor?.name) ? currentCompetitor.name.split(' ')[0] : 'M1';
        const n2 = (typeof currentCompetitor2 !== 'undefined' && currentCompetitor2?.name) ? currentCompetitor2.name.split(' ')[0] : 'M2';
        detail = `${n1} vs ${n2}`;
      } else if (typeof currentCompetitor !== 'undefined' && currentCompetitor?.name) {
        detail = currentCompetitor.name;
      }
      items.push({
        id: 'competitor',
        view: 'mesa',
        cardId: 'card-competitor-mesa',
        label: 'Mesa',
        detail,
        hideFn: () => typeof sendHideCompetitor === 'function' && sendHideCompetitor()
      });
    }

    if (typeof eventVisible !== 'undefined' && eventVisible) {
      const evName = document.getElementById('active-discipline-badge')?.textContent || '';
      items.push({
        id: 'event',
        view: 'mesa',
        cardId: 'event-deck-card',
        label: 'Ticker Evento',
        detail: evName,
        hideFn: () => typeof sendHideEvent === 'function' && sendHideEvent()
      });
    }

    if (typeof showcaseVisible !== 'undefined' && showcaseVisible) {
      const scName = (typeof showcaseCompetitor !== 'undefined' && showcaseCompetitor?.name) ? showcaseCompetitor.name : '';
      items.push({
        id: 'showcase',
        view: 'mesa',
        cardId: 'panel-competitor-showcase',
        label: 'Tarjeta Competidor',
        detail: scName,
        hideFn: () => typeof sendHideCompetitorShowcase === 'function' && sendHideCompetitorShowcase()
      });
    }

    if (typeof lowerThirdVisible !== 'undefined' && lowerThirdVisible) {
      const ltText = (typeof lowerThirdData !== 'undefined' && lowerThirdData?.text) ? lowerThirdData.text : '';
      items.push({
        id: 'lower-third',
        view: 'mesa',
        cardId: 'card-lower-third',
        label: 'Mini Banner',
        detail: ltText,
        hideFn: () => typeof sendHideLowerThird === 'function' && sendHideLowerThird()
      });
    }

    if (typeof liveRankingVisible !== 'undefined' && liveRankingVisible) {
      const modeTxt = (typeof liveRankingViewMode !== 'undefined' && liveRankingViewMode === 'widget') ? 'Mini Widget' : 'Pantalla completa';
      items.push({
        id: 'ranking',
        view: 'clasificacion',
        cardId: 'card-live-ranking',
        label: 'Clasificación',
        detail: modeTxt,
        hideFn: () => typeof sendHideLiveRanking === 'function' && sendHideLiveRanking()
      });
    }

    if (typeof headToHeadVisible !== 'undefined' && headToHeadVisible) {
      const p1 = (typeof h2hComp1 !== 'undefined' && h2hComp1?.name) ? h2hComp1.name.split(' ')[0] : 'C1';
      const p2 = (typeof h2hComp2 !== 'undefined' && h2hComp2?.name) ? h2hComp2.name.split(' ')[0] : 'C2';
      items.push({
        id: 'h2h',
        view: 'finales',
        cardId: 'panel-head-to-head',
        label: 'Head to Head',
        detail: `${p1} vs ${p2}`,
        hideFn: () => typeof sendHideHeadToHead === 'function' && sendHideHeadToHead()
      });
    }

    if (typeof categoryWinnerVisible !== 'undefined' && categoryWinnerVisible) {
      const cwName = (typeof cwComp !== 'undefined' && cwComp?.name) ? cwComp.name.split(' ')[0] : 'Ganador';
      const cwEv = (typeof getCWCategoryDisplay === 'function') ? getCWCategoryDisplay() : (typeof cwEventId !== 'undefined' ? cwEventId.toUpperCase() : '');
      items.push({
        id: 'category-winner',
        view: 'finales',
        cardId: 'panel-category-winner',
        label: 'Ganador',
        detail: `${cwEv} · ${cwName}`,
        hideFn: () => typeof sendHideCategoryWinner === 'function' && sendHideCategoryWinner()
      });
    }

    if (typeof versusBannerVisible !== 'undefined' && versusBannerVisible) {
      items.push({
        id: 'versus',
        view: 'finales',
        cardId: 'panel-versus-banner',
        label: 'Finales Versus',
        detail: 'WCA Live',
        hideFn: () => typeof sendHideVersusBanner === 'function' && sendHideVersusBanner()
      });
    }

    if (typeof bigLogoVisible !== 'undefined' && bigLogoVisible) {
      items.push({
        id: 'biglogo',
        view: 'pantalla',
        cardId: 'panel-tournament-big-logo',
        label: 'Logo Central',
        detail: `${typeof bigLogoSize !== 'undefined' ? bigLogoSize : 760}px`,
        hideFn: () => typeof sendHideBigLogo === 'function' && sendHideBigLogo()
      });
    }

    return items;
  }

  function setStatusPillElement(el, isLive, liveText = 'Al aire', standbyText = 'En espera') {
    if (!el) return;
    el.className = isLive ? 'admin-status-pill admin-status-pill--live' : 'admin-status-pill admin-status-pill--standby';
    el.textContent = isLive ? liveText : standbyText;
  }

  function syncAdminLiveNowUI() {
    const bar = document.getElementById('admin-live-now-bar');
    const list = document.getElementById('admin-live-now-list');
    const countEl = document.getElementById('admin-live-now-count');
    if (!bar || !list) return;

    const activeItems = getOverlayLiveDescriptors();
    const total = activeItems.length;

    bar.classList.toggle('has-active', total > 0);
    if (countEl) countEl.textContent = String(total);

    // Actualizar pills de tarjetas que antes no tenian badge propio
    setStatusPillElement(
      document.getElementById('competitor-status-badge'),
      typeof competitorVisible !== 'undefined' && competitorVisible
    );
    setStatusPillElement(
      document.getElementById('event-status-badge'),
      typeof eventVisible !== 'undefined' && eventVisible
    );
    setStatusPillElement(
      document.getElementById('ranking-status-badge'),
      typeof liveRankingVisible !== 'undefined' && liveRankingVisible
    );

    // Sincronizar clase .is-live en las 7 OverlayCard
    const cardMap = {
      'card-competitor-mesa': typeof competitorVisible !== 'undefined' && competitorVisible,
      'event-deck-card': typeof eventVisible !== 'undefined' && eventVisible,
      'panel-competitor-showcase': typeof showcaseVisible !== 'undefined' && showcaseVisible,
      'card-lower-third': typeof lowerThirdVisible !== 'undefined' && lowerThirdVisible,
      'card-live-ranking': typeof liveRankingVisible !== 'undefined' && liveRankingVisible,
      'panel-head-to-head': typeof headToHeadVisible !== 'undefined' && headToHeadVisible,
      'panel-category-winner': typeof categoryWinnerVisible !== 'undefined' && categoryWinnerVisible,
      'panel-versus-banner': typeof versusBannerVisible !== 'undefined' && versusBannerVisible,
      'panel-tournament-big-logo': typeof bigLogoVisible !== 'undefined' && bigLogoVisible
    };
    Object.entries(cardMap).forEach(([id, live]) => {
      const card = document.getElementById(id);
      if (card) card.classList.toggle('is-live', Boolean(live));
    });

    // Actualizar contadores de overlays al aire por seccion en la Sidebar
    const viewCounts = { mesa: 0, clasificacion: 0, finales: 0, pantalla: 0 };
    activeItems.forEach((item) => {
      if (viewCounts[item.view] !== undefined) viewCounts[item.view] += 1;
    });
    Object.entries(viewCounts).forEach(([viewKey, c]) => {
      const badge = document.getElementById(`nav-live-count-${viewKey}`);
      if (!badge) return;
      badge.textContent = String(c);
      badge.classList.toggle('is-live', c > 0);
      badge.hidden = c === 0;
    });

    // Sincronizar pills de conexion en TopBar
    const wsPill = document.getElementById('ws-status-pill');
    const wsDot = document.getElementById('ws-status-dot');
    if (wsPill && wsDot) {
      const wsOk = wsDot.classList.contains('active');
      wsPill.className = `admin-status-pill ${wsOk ? 'admin-status-pill--connected' : 'admin-status-pill--error'}`;
    }

    const obsPill = document.getElementById('obs-status-pill');
    if (obsPill && typeof obsStatus !== 'undefined') {
      const simOk = typeof hasActiveSimCameras === 'function' && hasActiveSimCameras() && simCamerasState?.enabled;
      obsPill.className = `admin-status-pill ${(obsStatus.connected || simOk) ? 'admin-status-pill--connected' : 'admin-status-pill--warning'}`;
    }

    // Sincronizar chips .is-active en todos los SliderField cuando llegan cambios por WebSocket
    document.querySelectorAll('#admin-root .admin-slider-field').forEach((field) => {
      const range = field.querySelector('input[type="range"]');
      if (!range) return;
      const val = String(range.value);
      field.querySelectorAll('.admin-preset-btn[data-preset-val]').forEach((btn) => {
        btn.classList.toggle('is-active', btn.dataset.presetVal === val);
      });
    });

    // Renderizar lista de chips "Al aire ahora"
    list.innerHTML = '';

    if (total === 0) {
      const empty = document.createElement('span');
      empty.className = 'admin-live-now-empty';
      empty.textContent = 'Ningún overlay visible en OBS';
      list.appendChild(empty);
      return;
    }

    activeItems.forEach((item) => {
      const chip = document.createElement('div');
      chip.className = 'admin-live-chip';

      const jumpBtn = document.createElement('button');
      jumpBtn.type = 'button';
      jumpBtn.className = 'admin-live-chip-jump';
      jumpBtn.setAttribute('aria-label', `Ir a ${item.label}`);
      jumpBtn.innerHTML = `<span class="admin-live-chip-dot" aria-hidden="true"></span><span>${item.label}</span>`;
      if (item.detail) {
        const det = document.createElement('span');
        det.className = 'admin-live-chip-detail';
        det.textContent = `· ${item.detail}`;
        jumpBtn.appendChild(det);
      }
      jumpBtn.addEventListener('click', () => {
        if (typeof switchMainMenu === 'function') switchMainMenu(item.view);
        const card = document.getElementById(item.cardId);
        if (card) {
          card.classList.remove('is-collapsed');
          card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
      });

      const hideBtn = document.createElement('button');
      hideBtn.type = 'button';
      hideBtn.className = 'admin-live-chip-hide';
      hideBtn.setAttribute('aria-label', `Ocultar ${item.label} de OBS`);
      hideBtn.innerHTML = window.Icon ? window.Icon('x', { size: 14 }) : '×';
      hideBtn.addEventListener('click', () => {
        item.hideFn();
        syncAdminLiveNowUI();
      });

      chip.appendChild(jumpBtn);
      chip.appendChild(hideBtn);
      list.appendChild(chip);
    });
  }

  /* ------------------------------------------------------------------------
     Inicializacion global del Shell Admin
     ------------------------------------------------------------------------ */
  function initAdminConsoleUI() {
    if (typeof window.hydrateAdminIcons === 'function') {
      window.hydrateAdminIcons(document);
    }

    initCollapsibleCardsAndSections();

    const menuTrigger = document.getElementById('admin-menu-trigger');
    const drawerClose = document.getElementById('admin-drawer-close');
    const backdrop = document.getElementById('admin-drawer-backdrop');

    if (menuTrigger) {
      menuTrigger.addEventListener('click', () => {
        const expanded = menuTrigger.getAttribute('aria-expanded') === 'true';
        setSidebarDrawerOpen(!expanded);
      });
    }
    if (drawerClose) {
      drawerClose.addEventListener('click', () => setSidebarDrawerOpen(false));
    }
    if (backdrop) {
      backdrop.addEventListener('click', () => setSidebarDrawerOpen(false));
    }

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        setSidebarDrawerOpen(false);
      }
    });

    window.addEventListener('resize', () => {
      if (!window.matchMedia('(max-width: 1024px)').matches) {
        setSidebarDrawerOpen(false);
      }
    });

    // Sincronizar vista guardada
    let saved = 'mesa';
    try {
      saved = normalizeViewKey(localStorage.getItem('directoobs_active_menu'));
    } catch (_) {}
    activateAdminView(saved);
    syncAdminLiveNowUI();
  }

  window.AdminUI = {
    activateAdminView,
    syncAdminLiveNowUI,
    setSidebarDrawerOpen,
    normalizeViewKey,
    initCollapsibleCardsAndSections
  };

  document.addEventListener('DOMContentLoaded', initAdminConsoleUI);
})();
