// Run outside Jest's VM, before workers are created. setupFiles only changes the
// VM's process.env copy: native os.homedir() can still resolve the real user.
const { mkdtempSync, mkdirSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');

module.exports = () => {
  const directory = mkdtempSync(join(tmpdir(), 'token-optimizer-jest-home-'));
  const values = {
    HOME: directory,
    USERPROFILE: directory,
    APPDATA: join(directory, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(directory, 'AppData', 'Local'),
    CODEX_HOME: join(directory, '.codex'),
    CLAUDE_CONFIG_DIR: join(directory, '.claude'),
    TOKEN_OPTIMIZER_HOME: join(directory, '.token-optimizer'),
    TOKEN_OPTIMIZER_LOG_DIR: join(directory, '.token-optimizer', 'logs'),
  };
  const previous = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    mkdirSync(value, { recursive: true });
    process.env[key] = value;
  }
  // An inherited settings override is also a path to the developer's files.
  previous.TOKEN_OPTIMIZER_SETTINGS = process.env.TOKEN_OPTIMIZER_SETTINGS;
  delete process.env.TOKEN_OPTIMIZER_SETTINGS;
  previous.TOKEN_OPTIMIZER_TEST_HOME = process.env.TOKEN_OPTIMIZER_TEST_HOME;
  process.env.TOKEN_OPTIMIZER_TEST_HOME = directory;
  previous.TOKEN_OPTIMIZER_SHELL_PROFILES =
    process.env.TOKEN_OPTIMIZER_SHELL_PROFILES;
  process.env.TOKEN_OPTIMIZER_SHELL_PROFILES = '[]';
  globalThis.__tokenOptimizerTestHome = { directory, previous };
};
