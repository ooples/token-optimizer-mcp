import { parentPort, workerData } from 'node:worker_threads';
import { SqliteCoordinationStore } from '../ucr/index.mjs';

const store = new SqliteCoordinationStore(workerData.databasePath, {
  leaseMs: workerData.leaseMs,
});
try {
  const results = workerData.claims.map((claim) =>
    store.claim(claim.taskId, claim.agentId, {
      expectedVersion: 0,
      now: claim.now,
    })
  );
  parentPort.postMessage({ results });
} finally {
  store.close();
}
