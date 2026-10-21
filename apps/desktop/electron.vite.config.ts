import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

const resolvePath = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const packageVersion = (path: string) => JSON.parse(readFileSync(resolvePath(path), 'utf8')).version as string;
const sourceRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: resolvePath('../../'), encoding: 'utf8', windowsHide: true }).trim();
const sourceDirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: resolvePath('../../'), encoding: 'utf8', windowsHide: true }).trim() !== '';
const archiveVersions = {
  application: packageVersion('./package.json'), archive: 1, report: 2, replay: 1,
  analysis: `analytics:${packageVersion('../../packages/analytics/package.json')};findings:${packageVersion('../../packages/findings/package.json')};deep-review:${packageVersion('../../packages/deep-review/package.json')};heatmap:p7.1-v1;source:${sourceRevision}${sourceDirty ? ':dirty' : ''}`,
  parser: packageVersion('../../packages/dem-parser/package.json'),
  native: packageVersion('../../packages/demoparser-native/package.json'),
  sourceRevision,
};

/**
 * Workspace packages are bundled into the Main / Utility Process output. A packaged
 * app then never resolves them through pnpm workspace symlinks, which do not exist
 * in an installed build.
 */
const WORKSPACE_PACKAGES = [
  '@cs2-analyst/dem-parser',
  '@cs2-analyst/match-model',
  '@cs2-analyst/analytics',
  '@cs2-analyst/findings',
  '@cs2-analyst/deep-review',
  '@cs2-analyst/report-contract',
];

/**
 * The native parser must stay external. Its `.node` binding is loaded at runtime from
 * the `node_modules` staged next to the worker bundle by scripts/prepare-pack.mjs,
 * so the bundle stays JavaScript-only.
 */
const NATIVE_PACKAGES = ['@cs2-analyst/demoparser-native'];

/** Packaged test seam. Off unless the test-seam installer is explicitly built. */
const testSeam = process.env.CS2_ANALYST_TEST_SEAM === '1';

/**
 * Packaging build (build-installer.mjs). The dev and preview builds keep workspace
 * packages external so they run straight from the pnpm workspace; the packaging
 * build inlines them so the installed app never resolves through workspace symlinks.
 */
const packaging = process.env.CS2_ANALYST_PACK === '1';

export default defineConfig({
  main: {
    define: { __CS2_ANALYST_TEST_SEAM__: JSON.stringify(testSeam), __CS2_ANALYST_ARCHIVE_VERSIONS__: JSON.stringify(archiveVersions) },
    build: {
      outDir: 'dist/electron',
      externalizeDeps: packaging ? { exclude: WORKSPACE_PACKAGES, include: NATIVE_PACKAGES } : true,
      rollupOptions: {
        input: { main: resolvePath('./electron/main.ts'), 'report-worker': resolvePath('./electron/report-worker.ts') },
      },
    },
  },
  preload: {
    build: {
      outDir: 'dist/preload',
      rollupOptions: {
        input: resolvePath('./preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    root: resolvePath('./renderer'),
    base: './',
    plugins: [react()],
    build: {
      outDir: resolvePath('./dist/renderer'),
      // Keep official SVGs as inspectable files in the installer ASAR.
      assetsInlineLimit: 0,
      rollupOptions: {
        input: resolvePath('./renderer/index.html'),
      },
    },
  },
});
