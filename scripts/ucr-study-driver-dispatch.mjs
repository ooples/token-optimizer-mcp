#!/usr/bin/env node
/** Dispatch one standard study request to its configured cross-CLI driver. */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  STUDY_DRIVER_PROTOCOL,
  studyDirectionEnvironmentKey,
} from '../ucr/index.mjs';

const chunks = [];
let size = 0;
for await (const chunk of process.stdin) {
  size += chunk.length;
  if (size > 1024 * 1024)
    throw new Error('study driver request exceeds 1 MiB');
  chunks.push(chunk);
}
const raw = Buffer.concat(chunks).toString('utf8');
const request = JSON.parse(raw);
const trial = request?.trial;
const key = studyDirectionEnvironmentKey(
  trial?.producerClient,
  trial?.consumerClient
);
const command = process.env[key] || process.env.UCR_STUDY_DIRECTION_DRIVER;
if (!command || !existsSync(command)) {
  process.stderr.write(
    `${key} or UCR_STUDY_DIRECTION_DRIVER must identify an executable ${STUDY_DRIVER_PROTOCOL} driver\n`
  );
  process.exit(2);
}
const child = spawnSync(command, [], {
  cwd: process.cwd(),
  env: process.env,
  input: raw,
  encoding: 'utf8',
  timeout: Number(process.env.UCR_STUDY_DRIVER_TIMEOUT_MS) || 600_000,
  windowsHide: true,
  shell: false,
});
process.stdout.write(String(child.stdout || ''));
process.stderr.write(String(child.stderr || child.error?.message || ''));
process.exit(child.status ?? 1);
