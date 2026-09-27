/**
 * DirectoOBS - Módulo de Simulación en Vivo (Demo Final de 3x3)
 * Simula una final de 10 competidores durante ~60 segundos con actualización solve a solve,
 * demostrando casos reales de WPA/BPA, DNF, proyección de podio en 4/5 ("What He Needs")
 * y cambios de liderazgo en tiempo real.
 */

import { calculateAo5Stats, calculateProjectedAverage, calculatePodiumTargets, formatWcaTime } from './wcaLiveService.js';

let demoTimer = null;
let currentStepIndex = 0;
let isRunning = false;

const COMPETITORS_BASE = [
  { id: 'c1', name: 'Max Park', countryIso2: 'us', wcaId: '2012PARK03', plannedSolves: [452, 495, 430, 520, 462], finalRecord: 'WR' },
  { id: 'c2', name: 'Tymon Kolasiński', countryIso2: 'pl', wcaId: '2016KOLA02', plannedSolves: [482, 475, 490, 470, 500], finalRecord: 'ER' },
  { id: 'c3', name: 'Yiheng Wang', countryIso2: 'cn', wcaId: '2019WANG65', plannedSolves: [485, 492, 475, 510, 488], finalRecord: 'AsR' },
  { id: 'c4', name: 'Nahm Sung-Hyuk', countryIso2: 'kr', wcaId: '2017NAHM01', plannedSolves: [515, -1, 520, 535, 525], finalRecord: 'NR' },
  { id: 'c5', name: 'Matty Hiroto Inaba', countryIso2: 'us', wcaId: '2016INAB01', plannedSolves: [535, 520, 510, 560, 528], finalRecord: null },
  { id: 'c6', name: 'Luke Garrett', countryIso2: 'us', wcaId: '2017GARR05', plannedSolves: [545, 530, 540, 555, 530], finalRecord: null },
  { id: 'c7', name: 'Ruihang Xu', countryIso2: 'cn', wcaId: '2017XUHA01', plannedSolves: [510, 520, 530, 540, 532], finalRecord: null },
  { id: 'c8', name: 'Sean Patrick Sanchez', countryIso2: 'ph', wcaId: '2018SANC08', plannedSolves: [580, 560, 575, 590, 565], finalRecord: null },
  { id: 'c9', name: 'David Leonardo Quintero', countryIso2: 'co', wcaId: '2021QUIN01', plannedSolves: [654, 632, 640, 680, 650], finalRecord: 'NR' },
  { id: 'c10', name: 'Camilo Guzmán', countryIso2: 'co', wcaId: '2017GUZM05', plannedSolves: [680, 660, 675, 710, 670], finalRecord: null }
];

// Pasos de la simulación cronometrada (progreso de solves completados por cada competidor)
// [c1: Max, c2: Tymon, c3: Yiheng, c4: Nahm, c5: Matty, c6: Luke, c7: Ruihang, c8: Sean, c9: David, c10: Camilo]
const TIMELINE_STEPS = [
  // Paso 0 (0s): Inicio - Ronda en espera
  { delay: 2600, progress: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], note: 'Inicio de la Final de 3x3' },
  // Paso 1 (3s): Primeros solves
  { delay: 2800, progress: [0, 0, 0, 0, 0, 1, 1, 1, 1, 1], note: 'Primeros intentos registrados en mesa' },
  // Paso 2 (6s): Progresión de intentos
  { delay: 3000, progress: [0, 0, 0, 0, 2, 2, 2, 2, 3, 3], note: 'Competidores intermedios en marcha' },
  // Paso 3 (9s): David Quintero y Camilo Guzmán completan 5/5
  { delay: 3400, progress: [0, 0, 0, 1, 3, 3, 3, 3, 5, 5], note: 'David Quintero (CO) fija 6.48 (NR)' },
  // Paso 4 (12s): Sean Patrick en 4/5
  { delay: 3500, progress: [0, 0, 0, 1, 4, 3, 3, 4, 5, 5], note: 'Sean Patrick en 4/5 -> Proyección activa para 1st' },
  // Paso 5 (16s): Sean Patrick termina con 5.73 y toma el 1er lugar
  { delay: 3200, progress: [0, 0, 0, 1, 4, 4, 3, 5, 5, 5], note: 'Sean Patrick 5.73 -> Toma el liderato' },
  // Paso 6 (19s): Matty Inaba termina con 5.28 y arrebata la punta
  { delay: 3400, progress: [0, 0, 0, 2, 5, 5, 3, 5, 5, 5], note: 'Matty Inaba 5.28 -> Nuevo líder de la final' },
  // Paso 7 (23s): Nahm en 4/5 CON UN DNF en solve 2 (Caso de rescate de podio)
  // Aquí se muestran 3 metas: FOR 1st (5.30), FOR 2nd (5.42), FOR 3rd (5.60)
  { delay: 4200, progress: [0, 0, 0, 4, 5, 5, 3, 5, 5, 5], note: 'Nahm (KR) 4/5 con DNF en solve 2 -> 3 metas activas (Oro, Plata, Bronce)' },
  // Paso 8 (27s): Nahm clava 5.25 y salva promedio con 5.27 -> ¡Pasa a 1er lugar!
  { delay: 3500, progress: [0, 0, 0, 5, 5, 5, 3, 5, 5, 5], note: 'Nahm salva su promedio con 5.27 -> ¡1er lugar!' },
  // Paso 9 (31s): Tymon Kolasiński completa con 4.82 (ER)! Líder europeo
  { delay: 3800, progress: [0, 5, 0, 5, 5, 5, 3, 5, 5, 5], note: 'Tymon Kolasiński 4.82 (ER) -> Nuevo líder mundial' },
  // Paso 10 (35s): Ruihang Xu en 4/5 (5.10, 5.20, 5.30, 5.40)
  // CASO IMAGEN REFERENCIA: 1st es imposible (BPA 5.20 > 4.82) -> Muestra exactamente FOR 2nd (5.32) y FOR 3rd (5.35)
  { delay: 4500, progress: [0, 5, 0, 5, 5, 5, 4, 5, 5, 5], note: 'Ruihang Xu en 4/5 (BPA > 1st) -> Metas para 2nd (5.32) y 3rd (5.35)' },
  // Paso 11 (39s): Ruihang termina con 5.32 -> Asegura podio
  { delay: 3200, progress: [0, 5, 0, 5, 5, 5, 5, 5, 5, 5], note: 'Ruihang Xu registra 5.32 en solve final' },
  // Paso 12 (42s): Yiheng Wang completa con 4.88 (AsR)! Pasa a 2º lugar
  { delay: 3800, progress: [0, 5, 5, 5, 5, 5, 5, 5, 5, 5], note: 'Yiheng Wang 4.88 (AsR) -> Subcampeón provisional' },
  // Paso 13 (46s): Max Park en la mesa (primeros 3 solves espectaculares)
  { delay: 3000, progress: [3, 5, 5, 5, 5, 5, 5, 5, 5, 5], note: 'Max Park en mesa (3 solves sub-5)' },
  // Paso 14 (49s): ¡CLÍMAX DE LA FINAL! Max Park hace solve 4 -> 4/5 disputando el Oro
  // Metas en pantalla: FOR 1st (5.00), FOR 2nd (5.18)
  { delay: 5500, progress: [4, 5, 5, 5, 5, 5, 5, 5, 5, 5], note: '¡CLÍMAX! Max Park 4/5 -> Metas para Oro mundial: FOR 1st (5.00), FOR 2nd (5.18)' },
  // Paso 15 (55s): Max Park hace 4.62 -> ¡Promedio 4.70 (WR)! CAMPEÓN MUNDIAL
  { delay: 4000, progress: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], note: '¡MAX PARK 4.70 RÉCORD MUNDIAL! Campeón del Mundo 3x3' },
  // Paso 16 (59s): Podio consolidado y fin de simulación
  { delay: 1000, progress: [5, 5, 5, 5, 5, 5, 5, 5, 5, 5], note: 'Podio oficial definido: 1º Max Park (WR), 2º Tymon (ER), 3º Yiheng (AsR)' }
];

function buildRankingState(stepProgress) {
  const eventId = '333';

  // 1. Construir estado preliminar de cada competidor según su progreso
  const rawList = COMPETITORS_BASE.map((comp, idx) => {
    const numDone = stepProgress[idx];
    const planned = comp.plannedSolves;
    const attempts = [];

    for (let s = 0; s < 5; s++) {
      if (s < numDone) {
        attempts.push({ result: planned[s] });
      } else {
        attempts.push({ result: 0 });
      }
    }

    const rawAttemptsList = attempts.map(a => a.result);
    const stats = calculateAo5Stats(rawAttemptsList, eventId);

    // Si completó 5 solves, tiene average oficial calculado
    const hasFinished = numDone === 5;
    const inProgress = numDone > 0 && numDone < 5;
    const isFinalSolve = numDone === 4;

    // Promedio proyectado oficial WCA Live Forecast
    const projAvg = hasFinished ? stats.avg : calculateProjectedAverage(rawAttemptsList, eventId);
    const projAvgFormatted = projAvg !== null ? (projAvg === -1 ? 'DNF' : formatWcaTime(projAvg, eventId)) : '—';

    // Mejor single
    const validRaw = rawAttemptsList.filter(r => r > 0);
    const bestRaw = validRaw.length > 0 ? Math.min(...validRaw) : null;

    return {
      id: comp.id,
      name: comp.name,
      countryIso2: comp.countryIso2,
      wcaId: comp.wcaId,
      solvesCompleted: numDone,
      totalSolves: 5,
      solvesText: `${numDone}/5`,
      inProgress,
      isFinalSolve,
      hasFinished,
      isProjected: inProgress,
      projectedAverage: projAvg,
      projectedAverageFormatted: projAvgFormatted,
      average: hasFinished ? stats.avg : null,
      averageFormatted: hasFinished ? stats.avgFormatted : '—',
      bpa: stats.bpa,
      bpaFormatted: stats.bpaFormatted,
      wpa: stats.wpa,
      wpaFormatted: stats.wpaFormatted,
      best: bestRaw,
      bestFormatted: bestRaw ? formatWcaTime(bestRaw, eventId) : '—',
      displayTime: hasFinished ? stats.avgFormatted : (inProgress ? projAvgFormatted : '—'),
      recordTag: hasFinished ? comp.finalRecord : null,
      attempts: attempts.map(a => formatWcaTime(a.result, eventId)),
      rawAttempts: attempts
    };
  });

  // 2. Ordenar ranking según el estándar oficial de WCA Live (Forecast View):
  // - Ordena por promedio proyectado (projectedAverage) ascendente
  // - Desempata por mejor single (best)
  // - Los competidores que no han empezado (0 solves) quedan al final
  function toMonotonic(val) {
    if (typeof val === 'number' && val > 0) return val;
    return Infinity;
  }

  rawList.sort((a, b) => {
    if (a.solvesCompleted === 0 && b.solvesCompleted === 0) return 0;
    if (a.solvesCompleted > 0 && b.solvesCompleted === 0) return -1;
    if (a.solvesCompleted === 0 && b.solvesCompleted > 0) return 1;

    // 1. Promedio proyectado
    const projA = toMonotonic(a.projectedAverage);
    const projB = toMonotonic(b.projectedAverage);
    if (projA !== projB) {
      return projA - projB;
    }

    // 2. Desempate por mejor single
    const bestA = toMonotonic(a.best);
    const bestB = toMonotonic(b.best);
    if (bestA !== bestB) {
      return bestA - bestB;
    }

    // 3. Más solves completados primero
    return (b.solvesCompleted || 0) - (a.solvesCompleted || 0);
  });

  // Asignar puestos numéricos
  rawList.forEach((r, idx) => {
    r.ranking = idx + 1;
  });

  // 3. Calcular targets de podio para cualquier competidor que esté en 4/5 solves
  rawList.forEach((r, idx) => {
    if (r.solvesCompleted === 4) {
      const otherResults = rawList.filter((_, oIdx) => oIdx !== idx);
      r.podiumTargets = calculatePodiumTargets(r.rawAttempts, otherResults, eventId);
    } else {
      r.podiumTargets = null;
    }
  });

  return {
    roundId: 'demo_final_333',
    roundName: 'Final',
    eventId: '333',
    eventName: '3x3x3 Cube',
    competitionName: "Rubik's WCA World Championship 2026",
    isOpen: true,
    isFinished: stepProgress.every(n => n === 5),
    advancingCutoff: 3, // Podio oficial (Oro, Plata, Bronce)
    totalCompetitors: rawList.length,
    ranking: rawList
  };
}

function startFinalsDemo(broadcastOverlays, broadcastPanels, onStepCallback) {
  stopFinalsDemo();
  isRunning = true;
  currentStepIndex = 0;

  console.log('[Demo] Iniciando simulación en vivo de Final 3x3 (60s)...');

  function executeStep() {
    if (!isRunning || currentStepIndex >= TIMELINE_STEPS.length) {
      isRunning = false;
      console.log('[Demo] Simulación de la final completada con éxito.');
      if (onStepCallback) onStepCallback({ finished: true });
      return;
    }

    const currentStep = TIMELINE_STEPS[currentStepIndex];
    const rankingState = buildRankingState(currentStep.progress);

    // Enviar al overlay OBS
    broadcastOverlays({
      type: 'live_ranking_show',
      data: rankingState,
      dynamicPaging: false,
      autoBalance: false,
      pageSize: 16,
      pageDuration: 10,
      viewMode: 'widget'
    });

    // Enviar a los paneles de operador
    broadcastPanels({
      type: 'sync_live_ranking',
      visible: true,
      data: rankingState,
      roundId: rankingState.roundId,
      compId: 'demo_wca_worlds',
      pollInterval: 2,
      top: 16,
      cutoff: 3,
      dynamicPaging: false,
      autoBalance: false,
      pageSize: 16,
      pageDuration: 10,
      viewMode: 'widget',
      demoNote: currentStep.note,
      demoStep: currentStepIndex + 1,
      demoTotalSteps: TIMELINE_STEPS.length
    });

    if (onStepCallback) {
      onStepCallback({
        step: currentStepIndex + 1,
        totalSteps: TIMELINE_STEPS.length,
        note: currentStep.note,
        data: rankingState
      });
    }

    currentStepIndex++;
    if (currentStepIndex < TIMELINE_STEPS.length) {
      demoTimer = setTimeout(executeStep, currentStep.delay);
    } else {
      isRunning = false;
    }
  }

  executeStep();
}

function stopFinalsDemo() {
  if (demoTimer) {
    clearTimeout(demoTimer);
    demoTimer = null;
  }
  isRunning = false;
  currentStepIndex = 0;
}

function isDemoActive() {
  return isRunning;
}

export {
  startFinalsDemo,
  stopFinalsDemo,
  isDemoActive,
  buildRankingState,
  TIMELINE_STEPS
};
