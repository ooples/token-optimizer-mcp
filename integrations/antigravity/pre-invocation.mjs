#!/usr/bin/env node
// Execute this entry from the installed package; its shared core remains package-relative.
import { run } from '../../hooks-core/adapter.mjs';

await run('antigravity', 'pre-invocation');
