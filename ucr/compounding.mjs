import { BENCHMARK_ARMS } from './benchmark.mjs';
import { sha256 } from './protocol.mjs';

export function createCurriculum({
  tasks = 100,
  seed = 'ucr-curriculum-v1',
} = {}) {
  if (tasks < 100)
    throw new Error(
      'compounding curriculum requires at least 100 linked tasks'
    );
  return Array.from({ length: tasks }, (_, index) => ({
    id: `curriculum-${String(index + 1).padStart(3, '0')}`,
    predecessor: index ? `curriculum-${String(index).padStart(3, '0')}` : null,
    repositoryVersion: Math.floor(index / 10) + 1,
    dependencyVersion: Math.floor(index / 20) + 1,
    interfaceVersion: Math.floor(index / 25) + 1,
    gotchaId: `gotcha-${index % 12}`,
    delayedReuseOf: index >= 12 ? `gotcha-${(index - 12) % 12}` : null,
    hiddenVariant: sha256(`${seed}:${index}`).slice(0, 16),
  }));
}

export function compoundingSchedule(
  curriculum,
  { models, clients, machines, arms = BENCHMARK_ARMS } = {}
) {
  return curriculum.flatMap((task, index) =>
    arms
      .map((arm, armIndex) => ({
        taskId: task.id,
        pairId: task.id,
        order: (armIndex + index) % arms.length,
        arm,
        model: models[index % models.length],
        client: clients[(index + armIndex) % clients.length],
        machine: machines[(index + armIndex) % machines.length],
        sessionId: `${task.id}-${arm}`,
      }))
      .sort((a, b) => a.taskId.localeCompare(b.taskId) || a.order - b.order)
  );
}

export function learningCurve(
  rows,
  { arm = 'runtime', field = 'firstPass' } = {}
) {
  const values = rows
    .filter((row) => row.arm === arm && Number.isFinite(Number(row[field])))
    .map((row, index) => ({ x: row.sequence ?? index, y: Number(row[field]) }));
  if (values.length < 2)
    return { samples: values.length, slope: null, intercept: null };
  const meanX = values.reduce((sum, item) => sum + item.x, 0) / values.length;
  const meanY = values.reduce((sum, item) => sum + item.y, 0) / values.length;
  const denominator = values.reduce(
    (sum, item) => sum + (item.x - meanX) ** 2,
    0
  );
  const slope = denominator
    ? values.reduce(
        (sum, item) => sum + (item.x - meanX) * (item.y - meanY),
        0
      ) / denominator
    : 0;
  return { samples: values.length, slope, intercept: meanY - slope * meanX };
}

export function compoundingMetrics(rows) {
  const armRows = (arm) => rows.filter((row) => row.arm === arm);
  const rate = (items, field) =>
    items.length
      ? items.filter((item) => item[field] === true).length / items.length
      : null;
  const runtime = armRows('runtime');
  const empty = armRows('empty');
  const runtimeRecurrence = rate(runtime, 'mistakeExecuted');
  const emptyRecurrence = rate(empty, 'mistakeExecuted');
  return {
    runtimeRuns: runtime.length,
    emptyRuns: empty.length,
    recurrenceReduction:
      emptyRecurrence && runtimeRecurrence !== null
        ? (emptyRecurrence - runtimeRecurrence) / emptyRecurrence
        : null,
    runtimeCorrectness: rate(runtime, 'correct'),
    emptyCorrectness: rate(empty, 'correct'),
    firstPassCurve: learningCurve(rows),
    reconstructionTokenReduction: (() => {
      const runtimeMean = runtime.length
        ? runtime.reduce((sum, row) => sum + row.reconstructionTokens, 0) /
          runtime.length
        : null;
      const emptyMean = empty.length
        ? empty.reduce((sum, row) => sum + row.reconstructionTokens, 0) /
          empty.length
        : null;
      return emptyMean ? (emptyMean - runtimeMean) / emptyMean : null;
    })(),
    severeUnquarantined: runtime.filter(
      (row) => row.severeHarm && !row.quarantinedBeforeNext
    ).length,
  };
}

export function leaveOneMemoryOut(rows, memories) {
  const full = rows.filter((row) => row.arm === 'runtime');
  const correctness = (items) =>
    items.length
      ? items.filter((row) => row.correct).length / items.length
      : null;
  return memories.map((memoryId) => {
    const without = full.filter(
      (row) => !(row.memoryIds || []).includes(memoryId)
    );
    return {
      memoryId,
      fullCorrectness: correctness(full),
      withoutCorrectness: correctness(without),
      samples: without.length,
    };
  });
}
