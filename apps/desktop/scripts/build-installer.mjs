import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertOwnedPath, createOwnedTempDirectory, removeOwnedDirectory } from '../../../scripts/owned-qa-run.mjs';

/**
 * Builds a Windows x64 NSIS installer.
 *
 *   node scripts/build-installer.mjs production   release/<version>/CS2-Analyst-Setup-<version>.exe
 *   node scripts/build-installer.mjs test-seam    .tmp/test-output/<version>/… — a
 *                                                 test-only build that accepts
 *                                                 CS2_ANALYST_TEST_DEM_PATH so the
 *                                                 installed-app E2E can import a
 *                                                 DEM without the native dialog.
 *
 * The production build must not expose any path-injection capability, so the
 * test seam is compiled out and asserted absent below.
 */

const { checkReplayAssets } = await import('../../../scripts/check-replay-map-assets.mjs');
console.log('Replay asset preflight:', await checkReplayAssets());
const variant = process.argv[2] ?? 'production';
if (variant !== 'production' && variant !== 'test-seam') {
  throw new Error(`unknown packaging variant "${variant}"; expected production or test-seam`);
}
const testSeam = variant === 'test-seam';

const desktopDir = fileURLToPath(new URL('../', import.meta.url));
const projectRoot = join(desktopDir, '..', '..');
const { version } = JSON.parse(readFileSync(join(desktopDir, 'package.json'), 'utf8'));
const require = createRequire(import.meta.url);
// Each build owns a new directory outside the workspace. The builder may reset its
// output child, but cannot remove another worktree's output or the ownership marker.
const staging = createOwnedTempDirectory(`pack-${variant}`);
const stagingDir = assertOwnedPath(staging, join(staging.directory, 'output'));
mkdirSync(stagingDir);
console.log('packaging staging: ' + staging.directory);
// Production installers are archived under release/<version>/. The test seam build is a
// test artifact, so it stays out of the release tree.
const releaseDir = testSeam
  ? join(projectRoot, '.tmp', 'test-output', version)
  : join(projectRoot, 'release', version);
const env = {
  ...process.env,
  CS2_ANALYST_TEST_SEAM: testSeam ? '1' : '0',
  CS2_ANALYST_PACK: '1',
  CS2_ANALYST_PACK_OUTPUT: stagingDir,
};

function run(command, args) {
  const result = spawnSync(command, args, { cwd: desktopDir, env, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed with exit code ${result.status}`);
}

function buildAndCopy() {
  const electronVite = join(dirname(require.resolve('electron-vite/package.json')), 'bin', 'electron-vite.js');
  run(process.execPath, [electronVite, 'build']);
  run(process.execPath, [fileURLToPath(new URL('./prepare-pack.mjs', import.meta.url))]);

  const mainBundle = readFileSync(join(desktopDir, 'dist/electron/main.js'), 'utf8');
  const workerBundle = readFileSync(join(desktopDir, 'dist/electron/report-worker.js'), 'utf8');

  // The worker must be self-contained JavaScript: workspace packages bundled in,
  // native parser external so prepare-pack.mjs can provide it at runtime.
  for (const pkg of ['dem-parser', 'match-model', 'analytics', 'findings', 'deep-review', 'report-contract']) {
    if (workerBundle.includes(`"@cs2-analyst/${pkg}"`)) {
      throw new Error(`report-worker.js still imports @cs2-analyst/${pkg}; workspace packages must be bundled`);
    }
  }
  if (!workerBundle.includes('@cs2-analyst/demoparser-native')) {
    throw new Error('report-worker.js does not reference the native parser; prepare-pack staging would be unused');
  }

  const seamMarker = 'CS2_ANALYST_TEST_DEM_PATH';
  if (testSeam) {
    if (!mainBundle.includes(seamMarker)) throw new Error('test-seam build is missing the packaged import seam');
  } else if (mainBundle.includes(seamMarker)) {
    throw new Error(`production main.js contains ${seamMarker}; the packaged app must not accept injected DEM paths`);
  }

  const electronBuilder = require.resolve('electron-builder/cli.js');
  run(process.execPath, [electronBuilder, '--win', 'nsis', '--x64', '--config', 'electron-builder.config.cjs']);

  const installer = readdirSync(stagingDir).find(name => name.endsWith('.exe') && !name.includes('__uninstaller'));
  if (!installer) throw new Error(`electron-builder produced no installer in ${stagingDir}`);
  mkdirSync(releaseDir, { recursive: true });
  const artifact = join(releaseDir, installer);
  copyFileSync(join(stagingDir, installer), artifact);
  return { artifact, sizeMb: (statSync(artifact).size / 1024 / 1024).toFixed(1) };
}

let result;
try { result = buildAndCopy(); }
catch (error) {
  console.error('Failed build staging preserved for diagnosis: ' + staging.directory);
  throw error;
}
removeOwnedDirectory(staging);
console.log(`installer (${variant}): ${result.artifact} (${result.sizeMb} MB)`);
