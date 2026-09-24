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
    body: JSON.stringify({ query, variables })
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
async function fetchLiveRoundRanking(roundId, topLimit = 16, cutoffLevel = 16) {
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
  const advancingCutoff = cutoffLevel > 0 ? cutoffLevel : 16;

  // Formatear resultados
  const rawResults = round.results || [];

  // Mapear cada competidor al formato estándar de broadcast
  const rankingList = rawResults.map((r, idx) => {
    const attempts = r.attempts || [];
    // Contar intentos completados (distintos de 0 y null)
    const validAttempts = attempts.filter(a => a && typeof a.result === 'number' && a.result !== 0);
    const completedSolves = validAttempts.length;

    // Calcular si está avanzando a la siguiente ronda
    const rankPos = r.ranking !== null && r.ranking !== undefined ? r.ranking : (idx + 1);
    const isAdvancing = advancingCutoff > 0 ? (rankPos <= advancingCutoff) : true;

    // Determinar si el promedio o mejor tiempo aplica según el tipo de evento
    const isAverageRanked = !['333bf', '444bf', '555bf', '333mbf'].includes(eventId);
    const mainScoreCs = isAverageRanked ? (r.average > 0 ? r.average : r.best) : r.best;
    const mainScoreFormatted = formatWcaTime(mainScoreCs, eventId);

    // Formatear mejores tiempos y promedio
    const avgFormatted = formatWcaTime(r.average, eventId);
    const bestFormatted = formatWcaTime(r.best, eventId);

    return {
      ranking: rankPos,
      isAdvancing,
      name: r.person?.name || 'Desconocido',
      wcaId: r.person?.wcaId || null,
      countryIso2: r.person?.country?.iso2?.toLowerCase() || '',
      solvesCompleted: completedSolves,
      totalSolves: totalAttempts,
      solvesText: `${completedSolves}/${totalAttempts}`,
      inProgress: completedSolves > 0 && completedSolves < totalAttempts,
      average: r.average,
      averageFormatted: avgFormatted,
      best: r.best,
      bestFormatted: bestFormatted,
      displayTime: isAverageRanked ? avgFormatted : bestFormatted,
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
      })()
    };
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

export {
  graphql,
  formatWcaTime,
  resolveWcaLiveId,
  fetchLiveCompetitionRounds,
  fetchLiveRoundRanking
};
