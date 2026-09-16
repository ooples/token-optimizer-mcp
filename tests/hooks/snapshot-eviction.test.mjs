import { test, expect } from '@jest/globals';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { putNode, nodeId } from '../../hooks-core/wiki.mjs';

test('snapshot budget is allocated only after evicting dead graph nodes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'snapshot-eviction-'));
  const saved = { ...process.env };
  try {
    process.env.TOKEN_OPTIMIZER_GRAPH_COMPACT_BYTES = '20000';
    process.env.TOKEN_OPTIMIZER_GRAPH_SNAPSHOT_BYTES = '2000';
    process.env.TOKEN_OPTIMIZER_GRAPH_MAX_NODES = '1';
    const old = nodeId('file', '/old'), live = nodeId('file', '/live');
    writeFileSync(join(dir, 'graph.jsonl'), [
      {t:'n',v:1,id:old,kind:'file',key:'/old',at:1,pad:'x'.repeat(50000)},
      {t:'n',v:1,id:live,kind:'file',key:'/live',at:2},
    ].map(JSON.stringify).join('\n')+'\n');
    writeFileSync(join(dir, 'snapshots.jsonl'), [
      {v:1,id:old,at:100,snapshot:'old'.repeat(500)},
      {v:1,id:live,at:1,snapshot:'live'.repeat(250)},
    ].map(JSON.stringify).join('\n')+'\n');
    putNode(dir, {kind:'file',key:'/live'});
    const retained = readFileSync(join(dir, 'snapshots.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    expect(retained.map(r=>r.id)).toEqual([live]);
    expect(retained[0].snapshot).toBe('live'.repeat(250));
  } finally {
    for (const key of ['TOKEN_OPTIMIZER_GRAPH_COMPACT_BYTES','TOKEN_OPTIMIZER_GRAPH_SNAPSHOT_BYTES','TOKEN_OPTIMIZER_GRAPH_MAX_NODES']) {
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    rmSync(dir, {recursive:true,force:true});
  }
});
