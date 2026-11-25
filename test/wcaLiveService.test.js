import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  formatWcaTime,
  calculateAo5Stats,
  calculateProjectedAverage,
  calculatePodiumTargets
} from '../server/wcaLiveService.js';

describe('formatWcaTime', () => {
  it('formatea tiempos menores a un minuto en segundos y centésimas', () => {
    assert.equal(formatWcaTime(513), '5.13');
    assert.equal(formatWcaTime(980), '9.80');
    assert.equal(formatWcaTime(120), '1.20');
  });

  it('formatea tiempos mayores a un minuto con minutos, segundos con cero a la izquierda y centésimas', () => {
    assert.equal(formatWcaTime(6451), '1:04.51');
    assert.equal(formatWcaTime(12530), '2:05.30');
  });

  it('formatea DNF (-1) y DNS (-2) correctamente', () => {
    assert.equal(formatWcaTime(-1), 'DNF');
    assert.equal(formatWcaTime(-2), 'DNS');
  });

  it('formatea nulo o cero con guion largo', () => {
    assert.equal(formatWcaTime(0), '—');
    assert.equal(formatWcaTime(null), '—');
    assert.equal(formatWcaTime(undefined), '—');
  });

  it('formatea movimientos en FMC (333fm)', () => {
    assert.equal(formatWcaTime(28, '333fm'), '28');
  });

  it('decodifica y formatea resultados de Multi-Blind (333mbf)', () => {
    assert.equal(formatWcaTime(810360008, '333mbf'), '26/34 60:00');
    assert.equal(formatWcaTime(850315804, '333mbf'), '18/22 52:38');
    assert.equal(formatWcaTime(940305402, '333mbf'), '7/9 50:54');
    assert.equal(formatWcaTime(970012500, '333mbf'), '2/2 2:05');
    assert.equal(formatWcaTime(979999900, '333mbf'), '2/2');
    assert.equal(formatWcaTime(-1, '333mbf'), 'DNF');
  });
});

describe('calculateAo5Stats', () => {
  it('calcula promedio oficial Ao5 recortando el mejor y el peor solve', () => {
    // Solves: [5.00, 6.00, 7.00, 8.00, 9.00] en centésimas
    // Descarta 500 y 900. Promedio de 600, 700, 800 = 700 (7.00)
    const stats = calculateAo5Stats([500, 600, 700, 800, 900]);
    assert.equal(stats.numDone, 5);
    assert.equal(stats.avg, 700);
    assert.equal(stats.avgFormatted, '7.00');
    assert.equal(stats.attempts[0].isTrimmed, true);
    assert.equal(stats.attempts[4].isTrimmed, true);
    assert.equal(stats.attempts[1].isTrimmed, false);
  });

  it('retorna DNF si hay 2 o más DNFs en 5 solves', () => {
    const stats = calculateAo5Stats([500, -1, 700, -1, 900]);
    assert.equal(stats.avg, -1);
    assert.equal(stats.avgFormatted, 'DNF');
  });

  it('calcula BPA y WPA correctamente con 4 solves completados sin DNF', () => {
    // Solves: [120, 149, 149, 200]
    // BPA: descarta mejor (solve 5 < 120) y peor (200) -> promedio(120, 149, 149) = 139 (1.39)
    // WPA: descarta mejor (120) y peor (solve 5 > 200) -> promedio(149, 149, 200) = 166 (1.66)
    const stats = calculateAo5Stats([120, 149, 149, 200]);
    assert.equal(stats.numDone, 4);
    assert.equal(stats.bpa, 139);
    assert.equal(stats.bpaFormatted, '1.39');
    assert.equal(stats.wpa, 166);
    assert.equal(stats.wpaFormatted, '1.66');
  });

  it('calcula BPA y WPA correctamente con 1 DNF en 4 solves', () => {
    // Solves: [500, 600, 700, -1]
    // BPA: solve 5 es el mejor -> descarta solve 5 y el DNF -> promedio(500, 600, 700) = 600 (6.00)
    // WPA: solve 5 es malo o DNF -> dos DNFs -> DNF (-1)
    const stats = calculateAo5Stats([500, 600, 700, -1]);
    assert.equal(stats.numDone, 4);
    assert.equal(stats.bpa, 600);
    assert.equal(stats.wpa, -1);
    assert.equal(stats.wpaFormatted, 'DNF');
  });

  it('retorna BPA y WPA como DNF si ya tiene 2 DNFs en 4 solves', () => {
    const stats = calculateAo5Stats([500, -1, 700, -1]);
    assert.equal(stats.bpa, -1);
    assert.equal(stats.wpa, -1);
  });
});

describe('calculateProjectedAverage', () => {
  it('para eventos Ao5 con 3 solves devuelve la mediana', () => {
    assert.equal(calculateProjectedAverage([500, 700, 600], '333'), 600);
  });

  it('para eventos Ao5 con 4 solves devuelve la media de los dos centrales', () => {
    // 400, 500, 600, 900 -> media de 500 y 600 = 550
    assert.equal(calculateProjectedAverage([400, 500, 600, 900], '333'), 550);
  });

  it('para eventos Mo3 (666, 777, 333fm) calcula la media exacta de los 3 solves', () => {
    // 600, 700, 800 -> media = 700
    assert.equal(calculateProjectedAverage([600, 700, 800], '666'), 700);
    // Si uno es DNF, el promedio Mo3 es DNF
    assert.equal(calculateProjectedAverage([600, -1, 800], '666'), -1);
  });

  it('para eventos Bo3 (333bf, 444bf, 555bf) devuelve el mejor solve válido', () => {
    assert.equal(calculateProjectedAverage([-1, 4500, -1], '333bf'), 4500);
    assert.equal(calculateProjectedAverage([-1, -1, -1], '333bf'), -1);
  });
});

describe('calculatePodiumTargets', () => {
  it('calcula correctamente qué necesita el competidor en 4/5 para hacer podio', () => {
    const alanAttempts = [{ result: 120 }, { result: 149 }, { result: 149 }, { result: 200 }];
    const otherCompetitors = [
      { name: 'Sujan F.', ranking: 1, average: 131 },
      { name: 'Zayn K.', ranking: 2, average: 151 },
      { name: 'Luke G.', ranking: 3, average: 152 }
    ];

    const targets = calculatePodiumTargets(alanAttempts, otherCompetitors, '222');
    assert.ok(Array.isArray(targets));
    // Sujan (1.31) es inalcanzable porque el BPA de Alan es 1.39
    // Pero 2nd (1.51) y 3rd (1.52) sí son alcanzables
    assert.equal(targets.length, 2);
    assert.equal(targets[0].place, 2);
    assert.equal(targets[0].label, 'FOR 2nd');
    assert.equal(targets[1].place, 3);
    assert.equal(targets[1].label, 'FOR 3rd');
  });

  it('tiene en cuenta el promedio proyectado de rivales que aún no han terminado', () => {
    const compAttempts = [{ result: 500 }, { result: 550 }, { result: 600 }, { result: 650 }];
    // Rival 1 completó 5/5 con 520
    // Rival 2 lleva 3/5 pero su projectedAverage es 580
    // Rival 3 completó 5/5 con 620
    const otherCompetitors = [
      { name: 'Rival 1', average: 520, projectedAverage: 520 },
      { name: 'Rival 2', average: 0, projectedAverage: 580 },
      { name: 'Rival 3', average: 620, projectedAverage: 620 }
    ];

    const targets = calculatePodiumTargets(compAttempts, otherCompetitors, '333');
    assert.ok(Array.isArray(targets));
    // Debe incluir objetivos contra los 3 rivales
    const places = targets.map(t => t.place);
    assert.ok(places.includes(2) || places.includes(3));
  });
});
