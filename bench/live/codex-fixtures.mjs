/** Fixed inputs and independent answer keys for the live Codex campaign. */
export function fixture(task) {
  if (task === 'logs')
    return {
      name: 'service.log',
      expected: {
        request: 'req-0173',
        code: 'E_POOL_EXHAUSTED',
        worker: 'worker-7',
      },
      content: Array.from({ length: 220 }, (_, i) =>
        i === 173
          ? '2026-09-15T12:00:00Z ERROR request=req-0173 code=E_POOL_EXHAUSTED worker=worker-7'
          : '2026-09-15T12:00:00Z INFO heartbeat status=healthy pool=ready worker=worker-2'
      ).join('\n'),
      question:
        'Find the ERROR event and write answer.json containing its request, code, and worker as strings.',
    };
  if (task === 'json')
    return {
      name: 'records.json',
      expected: {
        id: 'record-0173',
        status: 'failed',
        reason: 'checksum_mismatch',
      },
      content: JSON.stringify(
        Array.from({ length: 220 }, (_, i) => ({
          id: `record-${String(i).padStart(4, '0')}`,
          status: i === 173 ? 'failed' : 'ok',
          reason: i === 173 ? 'checksum_mismatch' : null,
          region: 'us-east',
          attempts: 1,
        })),
        null,
        2
      ),
      question:
        'Find the failed record and write answer.json containing its id, status, and reason as strings.',
    };
  if (task !== 'code') throw Error(`Unknown task ${task}`);
  return {
    name: 'search.txt',
    expected: {
      file: 'src/checkout.ts',
      line: 174,
      constant: 'PAYMENT_RETRY_LIMIT',
      value: 7,
    },
    content: Array.from(
      { length: 300 },
      (_, i) =>
        `src/checkout.ts:${i + 1}:${i === 173 ? 'export const PAYMENT_RETRY_LIMIT = 7;' : `export const FEATURE_${i} = false;`}`
    ).join('\n'),
    question:
      'Find PAYMENT_RETRY_LIMIT and write answer.json containing file, line (number), constant, and value (number).',
  };
}
