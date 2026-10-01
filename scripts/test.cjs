const { spawnSync } = require('node:child_process');
const { readdirSync } = require('node:fs');
const files = readdirSync('tests')
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => 'tests/' + f);
const result = spawnSync(require('electron'), ['--test', ...files], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
process.exit(result.status ?? 1);
