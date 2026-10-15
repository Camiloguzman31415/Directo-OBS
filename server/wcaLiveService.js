/**
 * DirectoOBS - Servicio de WCA Live para Ranking en Tiempo Real
 * Extrae y formatea resultados en vivo desde WCA Live (GraphQL) y Live WCA Oficial.
 */

const WCA_LIVE_URL = 'https://live.worldcubeassociation.org/api';
const WCA_BASE_API = 'https://www.worldcubeassociation.org/api/v0';

/**
 * Consulta a la API GraphQL de WCA Live
 */
async function graphql(query, variables = {}) {
  const resp = await fetch(WCA_LIVE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'User-Agent': 'DirectoOBS/2.0'
    },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(8000)
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`WCA Live respondió HTTP ${resp.status}: ${text.slice(0, 200)}`);
  }

  const json = await resp.json();
  if (json.errors && json.errors.length > 0) {
    console.warn('[wcaLive] GraphQL errors:', json.errors[0]?.message);
  }
  return json;
}

/**
 * Formatea centisegundos WCA a formato legible (ej: 513 -> "5.13", 6451 -> "1:04.51")
 */
function formatWcaTime(centiseconds, eventId = '333') {
  if (centiseconds === null || centiseconds === undefined || centiseconds === 0) return '—';
  if (centiseconds === -1) return 'DNF';
  if (centiseconds === -2) return 'DNS';

  if (eventId === '333fm') {
    return String(centiseconds);
  }

  const totalCs = parseInt(centiseconds, 10);
  const minutes = Math.floor(totalCs / 6000);
  const seconds = Math.floor((totalCs % 6000) / 100);
  const cs = totalCs % 100;

  const csStr = String(cs).padStart(2, '0');
  if (minutes > 0) {
    const sStr = String(seconds).padStart(2, '0');
    return `${minutes}:${sStr}.${csStr}`;
  }
  return `${seconds}.${csStr}`;
}

/**
 * Resuelve el ID numérico de una competencia en WCA Live a partir de su ID o WCA ID.
 */
async function resolveWcaLiveId(inputId) {
  if (!inputId) return null;
  const id = String(inputId).trim();
  if (/^\d+$/.test(id)) return id;

  // 1. Buscar en WCA Live por texto / filtro
  try {
    const q = `query($filter: String!) { competitions(filter: $filter, limit: 15) { id name wcaId } }`;
    const res = await graphql(q, { filter: id });
    const comps = res.data?.competitions || [];
    const match = comps.find(c => c.wcaId && c.wcaId.toLowerCase() === id.toLowerCase());
    if (match) return match.id;
    if (comps.length > 0) return comps[0].id;
  } catch (err) {
    console.warn('[wcaLive] Error buscando por filtro:', err.message);
  }

  // 2. Buscar por nombre oficial desde API WCA v0
  try {
    const metaRes = await fetch(`${WCA_BASE_API}/competitions/${encodeURIComponent(id)}`, {
      headers: { 'User-Agent': 'DirectoOBS/2.0' }
    });
    if (metaRes.ok) {
      const meta = await metaRes.json();
      if (meta.name) {
        const q = `query($filter: String!) { competitions(filter: $filter, limit: 15) { id name wcaId } }`;
        const res = await graphql(q, { filter: meta.name });
        const comps = res.data?.competitions || [];
        const match = comps.find(c => c.wcaId && c.wcaId.toLowerCase() === id.toLowerCase()) || comps[0];
        if (match) return match.id;
      }
    }
  } catch (err) {
    console.warn('[wcaLive] Error resolviendo vía WCA v0:', err.message);
  }

  return null;
}

/**
 * Obtiene la lista de eventos y rondas de una competencia en WCA Live
 */
async function fetchLiveCompetitionRounds(compId) {
  const liveId = (await resolveWcaLiveId(compId)) || compId;
  const q = `query($id: ID!) {
    competition(id: $id) {
      id
      name
      wcaId
      startDate
      endDate
      venues { name country { iso2 } }
      competitionEvents {
        id
        event { id name }
        rounds {
          id
          number
          name
          open
          finished
          format { id numberOfAttempts }
        }
      }
    }
  }`;

  const json = await graphql(q, { id: String(liveId) });
  const comp = json.data?.competition;
  if (!comp) {
    throw new Error(`Torneo no encontrado en WCA Live con ID: ${compId}`);
  }

  const roundsList = [];
  for (const ev of comp.competitionEvents || []) {
    for (const r of ev.rounds || []) {
      roundsList.push({
        roundId: r.id,
        roundNumber: r.number,
        roundName: r.name,
        eventId: ev.event.id,
        eventName: ev.event.name,
        isOpen: !!r.open,
        isFinished: !!r.finished,
        totalAttempts: r.format?.numberOfAttempts || 5,
        advancingLevel: 16
      });
    }
  }

  return {
    liveId: comp.id,
    wcaId: comp.wcaId,
    name: comp.name,
    rounds: roundsList
  };
}

/**
 * Calcula el detalle de cada intento incluyendo los tiempos recortados (mejor y peor con paréntesis)
 * e indicando cuál intento específico obtuvo el récord single si aplica
 */
function getAttemptsDetail(attempts, eventId, totalAttempts, recordIndex = -1, singleRecordTag = null) {
  const count = totalAttempts || 5;
  const rawList = [];
  for (let i = 0; i < count; i++) {
    const a = attempts && attempts[i];
    const raw = (a && typeof a.result === 'number') ? a.result : 0;
    rawList.push(raw);
  }

  const formattedList = rawList.map(r => formatWcaTime(r, eventId));
  const trimmedIndices = new Set();

  // En formato Ao5 (5 intentos), si se han completado los 5 intentos se recortan el mejor y peor
  const completedSolves = rawList.filter(r => r !== 0).length;
  if (count === 5 && completedSolves === 5) {
    // 1. Encontrar peor tiempo (DNF = -1, DNS = -2 se consideran infinitamente peores)
    let worstIdx = -1;
    let worstVal = -Infinity;
    for (let i = 0; i < 5; i++) {
      const r = rawList[i];
      const val = (r === -1 || r === -2) ? Infinity : r;
      if (val > worstVal) {
        worstVal = val;
        worstIdx = i;
      }
    }

    // 2. Encontrar mejor tiempo entre los demás
    let bestIdx = -1;
    let bestVal = Infinity;
    for (let i = 0; i < 5; i++) {
      if (i === worstIdx) continue;
      const r = rawList[i];
      if (r > 0 && r < bestVal) {
        bestVal = r;
        bestIdx = i;
      }
    }

    if (worstIdx !== -1) trimmedIndices.add(worstIdx);
    if (bestIdx !== -1) trimmedIndices.add(bestIdx);
  }

  return rawList.map((raw, idx) => {
    const formatted = formattedList[idx];
    const isTrimmed = trimmedIndices.has(idx);
    let displayText = formatted;
    if (isTrimmed && formatted !== '—') {
      displayText = `(${formatted})`;
    }
    const isRecord = (recordIndex >= 0 && idx === recordIndex);
    return {
      raw,
      formatted,
      isTrimmed,
      displayText,
      isRecord,
      recordTag: isRecord ? singleRecordTag : null
    };
  });
}

/**
 * Obtiene los resultados y ranking en tiempo real de una ronda específica en WCA Live
 */
async function fetchLiveRoundRanking(roundId, topLimit = 16, cutoffLevel = 0) {
  const q = `query($id: ID!) {
    round(id: $id) {
      id
      name
      open
      finished
      competitionEvent {
        event { id name }
        competition { id name wcaId }
      }
      format { id numberOfAttempts }
      results {
        ranking
        best
        average
        singleRecordTag
        averageRecordTag
        attempts { result }
        person {
          id
          wcaId
          name
          registrantId
          country { iso2 }
        }
      }
    }
  }`;

  const json = await graphql(q, { id: String(roundId) });
  const round = json.data?.round;
  if (!round) {
    throw new Error(`Ronda no encontrada en WCA Live con ID: ${roundId}`);
  }

  const eventId = round.competitionEvent?.event?.id || '333';
  const eventName = round.competitionEvent?.event?.name || '3x3';
  const compName = round.competitionEvent?.competition?.name || '';
  const totalAttempts = round.format?.numberOfAttempts || 5;
  const advancingCutoff = cutoffLevel !== undefined && cutoffLevel !== null ? Math.max(0, parseInt(cutoffLevel, 10) || 0) : 0;

  // Formatear resultados
  const rawResults = round.results || [];

  // Mapear cada competidor al formato estándar de broadcast
  const rankingList = rawResults.map((r, idx) => {
    const attempts = r.attempts || [];
    // Contar intentos completados (distintos de 0 y null)
    const validAttempts = attempts.filter(a => a && typeof a.result === 'number' && a.result !== 0);
    const completedSolves = validAttempts.length;

    // Calcular si está avanzando a la siguiente ronda (solo si hay corte positivo)
    const rankPos = r.ranking !== null && r.ranking !== undefined ? r.ranking : (idx + 1);
    const isAdvancing = advancingCutoff > 0 ? (rankPos <= advancingCutoff) : false;

    // Determinar si el promedio o mejor tiempo aplica según el tipo de evento
    const isAverageRanked = !['333bf', '444bf', '555bf', '333mbf'].includes(eventId);
    const mainScoreCs = isAverageRanked ? (r.average > 0 ? r.average : r.best) : r.best;
    const mainScoreFormatted = formatWcaTime(mainScoreCs, eventId);

    // Formatear mejores tiempos y promedio
    const avgFormatted = formatWcaTime(r.average, eventId);
    const bestFormatted = formatWcaTime(r.best, eventId);

    const inProgress = completedSolves > 0 && completedSolves < totalAttempts;
    const rawAttemptsList = attempts.map(a => (a && typeof a.result === 'number') ? a.result : 0);
    const projAvg = completedSolves === totalAttempts ? r.average : calculateProjectedAverage(rawAttemptsList, eventId);
    const projAvgFormatted = projAvg !== null ? (projAvg === -1 ? 'DNF' : formatWcaTime(projAvg, eventId)) : '—';

    return {
      ranking: rankPos,
      isAdvancing,
      name: r.person?.name || 'Desconocido',
      wcaId: r.person?.wcaId || null,
      countryIso2: r.person?.country?.iso2?.toLowerCase() || '',
      solvesCompleted: completedSolves,
      totalSolves: totalAttempts,
      solvesText: `${completedSolves}/${totalAttempts}`,
      inProgress,
      isFinalSolve: totalAttempts === 5 && completedSolves === 4,
      isProjected: inProgress,
      projectedAverage: projAvg,
      projectedAverageFormatted: projAvgFormatted,
      average: r.average,
      averageFormatted: avgFormatted,
      best: r.best,
      bestFormatted: bestFormatted,
      displayTime: isAverageRanked ? (inProgress ? projAvgFormatted : avgFormatted) : bestFormatted,
      singleRecordTag: r.singleRecordTag || null,
      averageRecordTag: r.averageRecordTag || null,
      recordTag: r.averageRecordTag || r.singleRecordTag || null,
      attempts: attempts.map(a => formatWcaTime(a?.result, eventId)),
      attemptsDetail: (() => {
        let singleRecordIdx = -1;
        if (r.singleRecordTag && typeof r.best === 'number' && r.best > 0) {
          singleRecordIdx = attempts.findIndex(a => a && typeof a.result === 'number' && a.result === r.best);
        }
        return getAttemptsDetail(attempts, eventId, totalAttempts, singleRecordIdx, r.singleRecordTag);
      })(),
      _rawAttempts: attempts,
      podiumTargets: null
    };
  });

  // Si la ronda está en curso, ordenar según el estándar oficial de WCA Live Forecast View
  if (!round.finished) {
    function toMonotonic(val) {
      if (typeof val === 'number' && val > 0) return val;
      return Infinity;
    }

    rankingList.sort((a, b) => {
      if (a.solvesCompleted === 0 && b.solvesCompleted === 0) return (a.ranking || 999) - (b.ranking || 999);
      if (a.solvesCompleted > 0 && b.solvesCompleted === 0) return -1;
      if (a.solvesCompleted === 0 && b.solvesCompleted > 0) return 1;

      const projA = toMonotonic(a.projectedAverage);
      const projB = toMonotonic(b.projectedAverage);
      if (projA !== projB) return projA - projB;

      const bestA = toMonotonic(a.best);
      const bestB = toMonotonic(b.best);
      if (bestA !== bestB) return bestA - bestB;

      return (b.solvesCompleted || 0) - (a.solvesCompleted || 0);
    });

    // Reasignar posiciones proyectadas
    rankingList.forEach((r, idx) => {
      r.ranking = idx + 1;
      r.isAdvancing = advancingCutoff > 0 ? (r.ranking <= advancingCutoff) : false;
    });
  }

  // Segunda pasada: Calcular objetivos de podio teniendo en cuenta los promedios proyectados de los rivales
  rankingList.forEach((r, idx) => {
    if (totalAttempts === 5 && r.solvesCompleted === 4) {
      const otherCompetitors = rankingList.filter((_, oIdx) => oIdx !== idx);
      r.podiumTargets = calculatePodiumTargets(r._rawAttempts, otherCompetitors, eventId);
    }
    delete r._rawAttempts;
  });

  return {
    roundId: round.id,
    roundName: round.name,
    eventId,
    eventName,
    competitionName: compName,
    isOpen: !!round.open,
    isFinished: !!round.finished,
    advancingCutoff,
    totalCompetitors: rankingList.length,
    ranking: rankingList.slice(0, topLimit > 0 ? topLimit : undefined)
  };
}

/**
 * Calcula BPA (Best Possible Average), WPA (Worst Possible Average) y AVG oficial para formato Ao5
 */
function calculateAo5Stats(attemptsRaw, eventId = '333') {
  const count = 5;
  const rawList = [];
  for (let i = 0; i < count; i++) {
    const raw = (attemptsRaw && typeof attemptsRaw[i] === 'number') ? attemptsRaw[i] : 0;
    rawList.push(raw);
  }

  const completedSolves = rawList.map((r, idx) => ({ raw: r, idx })).filter(x => x.raw !== 0);
  const numDone = completedSolves.length;

  let bpa = null;
  let wpa = null;
  let avg = null;
  const trimmedIndices = new Set();

  if (numDone === 5) {
    // 5 intentos completados: se calcula el promedio oficial WCA (descarta mejor y peor)
    const dnfCount = completedSolves.filter(x => x.raw < 0).length;
    if (dnfCount >= 2) {
      avg = -1; // DNF
    } else {
      const sorted = [...completedSolves].sort((a, b) => {
        const va = a.raw < 0 ? Infinity : a.raw;
        const vb = b.raw < 0 ? Infinity : b.raw;
        return va - vb;
      });
      trimmedIndices.add(sorted[0].idx);
      trimmedIndices.add(sorted[4].idx);

      const middle = [sorted[1].raw, sorted[2].raw, sorted[3].raw];
      if (middle.some(r => r < 0)) {
        avg = -1;
      } else {
        const sum = middle.reduce((acc, c) => acc + c, 0);
        avg = Math.round(sum / 3);
      }
    }
  } else if (numDone === 4) {
    // 4 intentos completados: cálculo oficial WCA de BPA y WPA
    const dnfCount = completedSolves.filter(x => x.raw < 0).length;
    if (dnfCount >= 2) {
      // 2 o más DNFs -> el average final será DNF inevitablemente
      bpa = -1;
      wpa = -1;
    } else if (dnfCount === 1) {
      // 1 DNF y 3 tiempos válidos
      const valid = completedSolves.filter(x => x.raw > 0).map(x => x.raw).sort((a, b) => a - b);
      // BPA: el 5to solve es óptimo (se descarta junto con el DNF). Promedian los 3 válidos:
      bpa = Math.round((valid[0] + valid[1] + valid[2]) / 3);
      // WPA: el 5to solve es DNF o el peor -> habrían 2 DNFs -> DNF
      wpa = -1;
    } else {
      // 0 DNFs (4 tiempos válidos)
      const sorted = completedSolves.map(x => x.raw).sort((a, b) => a - b);
      // sorted = [x1, x2, x3, x4] con x1 <= x2 <= x3 <= x4
      // BPA: solve 5 es el mejor (menor a x1) -> se descarta solve 5 (mejor) y x4 (peor) -> promedian x1, x2, x3
      bpa = Math.round((sorted[0] + sorted[1] + sorted[2]) / 3);
      // WPA: solve 5 es el peor (mayor a x4 o DNF) -> se descarta x1 (mejor) y solve 5 (peor) -> promedian x2, x3, x4
      wpa = Math.round((sorted[1] + sorted[2] + sorted[3]) / 3);
    }
  }

  // Formatear cada intento individual con indicador de recorte
  const attemptsFormatted = rawList.map((raw, idx) => {
    const text = formatWcaTime(raw, eventId);
    const isTrimmed = trimmedIndices.has(idx);
    return {
      raw,
      text: (isTrimmed && text !== '—') ? `(${text})` : text,
      isTrimmed
    };
  });

  return {
    numDone,
    bpa,
    bpaFormatted: bpa !== null ? (bpa === -1 ? 'DNF' : formatWcaTime(bpa, eventId)) : '—',
    wpa,
    wpaFormatted: wpa !== null ? (wpa === -1 ? 'DNF' : formatWcaTime(wpa, eventId)) : '—',
    avg,
    avgFormatted: avg !== null ? (avg === -1 ? 'DNF' : formatWcaTime(avg, eventId)) : '—',
    attempts: attemptsFormatted
  };
}

/**
 * Calcula el promedio proyectado según la especificación oficial de WCA Live (Forecast View):
 * - 1 o 2 solves: media aritmética de los intentos.
 * - 3 solves: mediana (el intento intermedio).
 * - 4 solves: media de los dos intentos centrales (descartando el mejor y el peor hasta ahora).
 * - 5 solves: promedio oficial Ao5.
 */
function calculateProjectedAverage(rawAttempts, eventId = '333') {
  const completeAttempts = (rawAttempts || []).filter(r => typeof r === 'number' && r !== 0);
  if (completeAttempts.length === 0) return null;

  const count = completeAttempts.length;

  // Eventos Bo3 (clasifican por single)
  if (['333bf', '444bf', '555bf', '333mbf'].includes(eventId)) {
    const valid = completeAttempts.filter(x => x > 0);
    return valid.length > 0 ? Math.min(...valid) : -1;
  }

  // Eventos Mo3 (Mean of 3: 6x6, 7x7, FMC)
  if (['666', '777', '333fm'].includes(eventId)) {
    if (completeAttempts.some(x => x < 0)) return -1;
    const sum = completeAttempts.reduce((acc, v) => acc + v, 0);
    return Math.round(sum / count);
  }

  // Formato Ao5 estándar (Forecast View oficial de WCA Live)
  const sorted = [...completeAttempts].sort((a, b) => {
    const isCompA = a > 0;
    const isCompB = b > 0;
    if (!isCompA && !isCompB) return 0;
    if (!isCompA && isCompB) return 1;
    if (isCompA && !isCompB) return -1;
    return a - b;
  });

  if (count < 3) {
    if (completeAttempts.some(x => x < 0)) return -1;
    const sum = completeAttempts.reduce((acc, v) => acc + v, 0);
    return Math.round(sum / count);
  }

  if (count === 3) {
    return sorted[1];
  }

  if (count === 4) {
    if (sorted[1] < 0 || sorted[2] < 0) return -1;
    return Math.round((sorted[1] + sorted[2]) / 2);
  }

  if (count >= 5) {
    const [, x, y, z] = sorted;
    if (x < 0 || y < 0 || z < 0) return -1;
    return Math.round((x + y + z) / 3);
  }

  return null;
}

/**
 * Calcula los tiempos de solve necesarios para alcanzar puestos de podio (1st, 2nd, 3rd)
 * en la última solve (cuando el competidor tiene 4/5 intentos completados en formato Ao5).
 */
function calculatePodiumTargets(attemptsRaw, otherResults, eventId = '333') {
  const rawList = (attemptsRaw || []).map(a => (a && typeof a.result === 'number') ? a.result : (typeof a === 'number' ? a : 0));
  const completedSolves = rawList.filter(r => r !== 0);
  if (completedSolves.length !== 4) return null;

  const dnfCount = completedSolves.filter(x => x < 0).length;
  if (dnfCount >= 2) return null; // Si ya tiene 2 DNFs, el promedio final es DNF

  let bpa, wpa, M, x1, x4;
  if (dnfCount === 1) {
    const valid = completedSolves.filter(x => x > 0).sort((a, b) => a - b);
    x1 = valid[0];
    M = valid[1] + valid[2];
    bpa = Math.round((valid[0] + valid[1] + valid[2]) / 3);
    wpa = -1; // DNF
  } else {
    const sorted = [...completedSolves].sort((a, b) => a - b);
    x1 = sorted[0];
    x4 = sorted[3];
    M = sorted[1] + sorted[2];
    bpa = Math.round((sorted[0] + sorted[1] + sorted[2]) / 3);
    wpa = Math.round((sorted[1] + sorted[2] + sorted[3]) / 3);
  }

  // Extraer los promedios válidos (cerrados o proyectados) de otros competidores en la ronda
  const otherAverages = (otherResults || [])
    .map(other => other.projectedAverage || other.average)
    .filter(val => typeof val === 'number' && val > 0)
    .sort((a, b) => a - b);

  function getMaxSolveForTarget(T) {
    if (bpa > T) return null; // Imposible alcanzar el target incluso con el mejor solve posible
    if (wpa > 0 && wpa <= T) return 'SAFE'; // Ya asegurado por WPA

    // Para que round((M + y) / 3) <= T:
    // La suma máxima de los 3 tiempos intermedios es 3 * T + 1
    const Smax = 3 * T + 1;
    const yMax = Smax - M;
    if (yMax <= 0) return null;
    return yMax;
  }

  const targets = [];
  const podiumLabels = [
    { place: 1, label: 'FOR 1st', color: 'gold' },
    { place: 2, label: 'FOR 2nd', color: 'silver' },
    { place: 3, label: 'FOR 3rd', color: 'bronze' }
  ];

  for (let i = 0; i < 3; i++) {
    const T = otherAverages[i];
    if (T === undefined || T === null || T <= 0) continue;
    const yMax = getMaxSolveForTarget(T);
    if (yMax !== null && yMax !== 'SAFE') {
      targets.push({
        place: podiumLabels[i].place,
        label: podiumLabels[i].label,
        color: podiumLabels[i].color,
        targetAvg: T,
        targetAvgFormatted: formatWcaTime(T, eventId),
        maxSolve: yMax,
        maxSolveFormatted: formatWcaTime(yMax, eventId)
      });
    }
  }

  return targets.length > 0 ? targets : null;
}

/**
 * Obtiene los datos del enfrentamiento cara a cara (Versus) de dos competidores en una ronda de WCA Live
 */
async function fetchLiveVersusData(roundId, comp1IdOrName, comp2IdOrName) {
  const q = `query($id: ID!) {
    round(id: $id) {
      id
      name
      open
      finished
      competitionEvent {
        event { id name }
        competition { id name wcaId }
      }
      format { id numberOfAttempts }
      results {
        ranking
        best
        average
        singleRecordTag
        averageRecordTag
        attempts { result }
        person {
          id
          wcaId
          name
          registrantId
          country { iso2 }
        }
      }
    }
  }`;

  const json = await graphql(q, { id: String(roundId) });
  const round = json.data?.round;
  if (!round) {
    throw new Error(`Ronda no encontrada en WCA Live con ID: ${roundId}`);
  }

  const eventId = round.competitionEvent?.event?.id || '333';
  const eventName = round.competitionEvent?.event?.name || '3x3';
  const compName = round.competitionEvent?.competition?.name || '';
  const roundName = round.name || 'Final';
  const rawResults = round.results || [];

  function findResult(target) {
    if (!target) return null;
    const clean = String(target).trim().toLowerCase();
    return rawResults.find(r => {
      const p = r.person || {};
      const wId = (p.wcaId || '').toLowerCase();
      const regId = String(p.registrantId || '');
      const pId = String(p.id || '');
      const name = (p.name || '').toLowerCase();
      return wId === clean || regId === clean || pId === clean || name.includes(clean);
    });
  }

  const res1 = findResult(comp1IdOrName);
  const res2 = findResult(comp2IdOrName);

  function formatCompetitorVersus(r, fallbackName = 'Competidor') {
    if (!r) {
      return {
        name: fallbackName,
        wcaId: '',
        countryIso2: '',
        attempts: Array(5).fill({ raw: 0, text: '—', isTrimmed: false }),
        bpa: null,
        bpaFormatted: '—',
        wpa: null,
        wpaFormatted: '—',
        avg: null,
        avgFormatted: '—'
      };
    }

    const rawAttempts = (r.attempts || []).map(a => (a && typeof a.result === 'number') ? a.result : 0);
    while (rawAttempts.length < 5) rawAttempts.push(0);

    const stats = calculateAo5Stats(rawAttempts, eventId);

    return {
      name: r.person?.name || fallbackName,
      wcaId: r.person?.wcaId || '',
      countryIso2: r.person?.country?.iso2?.toLowerCase() || '',
      registrantId: r.person?.registrantId || null,
      ranking: r.ranking,
      best: r.best,
      bestFormatted: formatWcaTime(r.best, eventId),
      averageOfficial: r.average,
      averageOfficialFormatted: formatWcaTime(r.average, eventId),
      singleRecordTag: r.singleRecordTag || null,
      averageRecordTag: r.averageRecordTag || null,
      ...stats
    };
  }

  return {
    roundId: round.id,
    roundName,
    eventId,
    eventName,
    competitionName: compName,
    competitor1: formatCompetitorVersus(res1, comp1IdOrName || 'Competidor 1'),
    competitor2: formatCompetitorVersus(res2, comp2IdOrName || 'Competidor 2'),
    allCompetitors: rawResults.map(r => ({
      name: r.person?.name || 'Desconocido',
      wcaId: r.person?.wcaId || '',
      countryIso2: r.person?.country?.iso2?.toLowerCase() || '',
      registrantId: r.person?.registrantId
    }))
  };
}

export {
  graphql,
  formatWcaTime,
  resolveWcaLiveId,
  fetchLiveCompetitionRounds,
  fetchLiveRoundRanking,
  calculateAo5Stats,
  calculateProjectedAverage,
  calculatePodiumTargets,
  fetchLiveVersusData
};
