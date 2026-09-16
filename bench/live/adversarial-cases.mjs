/** Seeded boundary workloads. Development and confirmation seeds are disjoint. */
import { createHash } from 'node:crypto';
import { heldoutFixture } from './heldout-cases.mjs';
export const adversarialTasks = ['tiny', 'entropy', 'numeric', 'nullable'];
export function adversarialFixture(task, seed) {
  if (!adversarialTasks.includes(task)) return heldoutFixture(task, seed);
  const hash = (s) =>
    createHash('sha256').update(`adversarial-v1:${seed}:${s}`).digest('hex');
  const tag = hash('tag').slice(0, 8);
  if (task === 'tiny')
    return {
      name: 'tiny.txt',
      content: `service=${tag}\nstatus=ready\n`,
      expected: { service: tag, status: 'ready' },
      question: 'Write answer.json containing service and status as strings.',
    };
  if (task === 'entropy') {
    const content = Array.from({ length: 90 }, (_, i) => hash(i)).join('\n');
    return {
      name: 'digests.txt',
      content,
      expected: { digest: hash(57) },
      question:
        'Write answer.json containing digest as the complete string on line 58 (one-based). Preserve every character.',
    };
  }
  if (task === 'numeric') {
    const rows = Array.from({ length: 240 }, (_, i) => ({
      id: `sensor-${tag}-${i}`,
      latency: 20 + (i % 17),
      samples: 5,
    }));
    const index = 50 + (parseInt(tag.slice(0, 2), 16) % 130);
    const max = 500 + parseInt(tag.slice(2, 4), 16);
    rows[index].latency = max;
    rows[223].latency = -7;
    return {
      name: 'metrics.json',
      content: JSON.stringify(rows, null, 2),
      expected: { id: rows[index].id, maximum: max, minimum: -7 },
      question:
        'Find the maximum and minimum numeric latency over ALL rows. Write answer.json containing id of the maximum row, maximum, and minimum. Do not infer extrema from a partial sample.',
    };
  }
  const rowCount = 140 + (parseInt(tag.slice(0, 2), 16) % 81);
  const nullPeriod = 2 + (parseInt(tag.slice(2, 4), 16) % 3);
  const missingPeriod = 7 + (parseInt(tag.slice(4, 6), 16) % 11);
  const rows = Array.from({ length: rowCount }, (_, i) => ({
    id: `item-${tag}-${i}`,
    value: i % nullPeriod ? null : 'ready',
    nested: { explicit: null },
  }));
  for (let i = 0; i < rows.length; i += missingPeriod) delete rows[i].value;
  return {
    name: 'nullable.json',
    content: JSON.stringify(rows, null, 2),
    expected: {
      nulls: rows.filter((r) => r.value === null).length,
      missing: rows.filter((r) => !Object.hasOwn(r, 'value')).length,
    },
    question:
      'Count records with an explicitly null value separately from records lacking the value key. Write answer.json containing nulls and missing as numbers. These categories are different. Use the complete data or exact complete counts.',
  };
}
