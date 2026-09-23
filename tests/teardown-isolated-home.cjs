const { rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { dirname, basename, resolve } = require('node:path');

module.exports = () => {
  const state = globalThis.__tokenOptimizerTestHome;
  if (!state) return;
  for (const [key, value] of Object.entries(state.previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const target = resolve(state.directory);
  if (
    dirname(target) !== resolve(tmpdir()) ||
    !basename(target).startsWith('token-optimizer-jest-home-')
  )
    throw new Error('Refusing to remove an unexpected test home');
  rmSync(target, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  });
  delete globalThis.__tokenOptimizerTestHome;
};
