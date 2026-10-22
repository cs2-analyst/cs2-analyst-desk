// L0-only six-view restoration experiment, using unchanged production Renderer/preload.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync } from 'node:zlib';
import { closeApp, connectCdp, waitFor } from './smoke-runtime.mjs';
import { ProcessScope } from './installed-smoke-lifecycle.mjs';
import { digest, hashJson, withoutSession } from './library-spike-core.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const [snapshotArg = '.tmp/l0/evidence', fixtureArg = 'E:/cs2-analyst/.demo', outArg = '.tmp/l0/offline-electron'] = process.argv.slice(2);
const snapshots = resolve(snapshotArg), fixtures = resolve(fixtureArg), out = resolve(outArg);
mkdirSync(out, { recursive: true });
const esbuild = createRequire(import.meta.url)(join(root, 'node_modules/.pnpm/node_modules/esbuild'));
const bundle = join(out, 'heatmap-bundle.cjs');
await esbuild.build({ stdin: { contents: `export { createHeatmapSession } from './apps/desktop/electron/heatmap-session.ts'; export { validateHeatmapRequest, validateHeatmapResult } from './apps/desktop/shared/heatmap-ipc.ts';`, resolveDir: root, sourcefile: 'l0-heatmap-experiment.ts', loader: 'ts' },
  bundle: true, platform: 'node', target: 'node24', format: 'cjs', outfile: bundle });
const require = createRequire(new URL('../apps/desktop/package.json', import.meta.url));
const samples = ['dust2', 'nuke'], held = [], hold = join(fixtures, '.l0-electron-offline-' + randomUUID());
const report = { experiment: 'L0 unchanged production six-view Renderer with disposable snapshot host',
  startedAt: new Date().toISOString(), samples: [], fixtureMoves: [], limitations: [
    'Experimental Main/Utility bridge; not the production L2 persistence IPC implementation or its security acceptance.',
    'Built Renderer/preload; NSIS and Windows installed application NOT RUN.',
    'Native BrowserWindow shown without activation for compositor screenshots; titlebar geometry/physical DPI/human walkthrough NOT RUN.',
    'Two real matches; no claim of broader real-fixture coverage.' ] };
const hashFile = async path => { const hash = createHash('sha256'); for await (const data of createReadStream(path)) hash.update(data); return hash.digest('hex'); };
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
// QA reads the mounted original component state; this does not add a shipped debug API.
const heatmapState = `(() => {
 const node=document.querySelector('[data-heatmap-session]');if(!node)return null;
 let fiber=node[Object.keys(node).find(key=>key.startsWith('__reactFiber$'))];while(fiber?.return)fiber=fiber.return;
 const visit=f=>!f?null:f.memoizedProps?.sessionActive!==undefined&&f.memoizedProps?.players?f:visit(f.child)??visit(f.sibling);
 const target=visit(fiber.stateNode.current);if(!target)return null;
 const hooks=[];for(let hook=target.memoizedState;hook;hook=hook.next)if(hook.queue?.dispatch)hooks.push(hook.memoizedState);
 return {scope:hooks.find(value=>value?.samplingSet),resolution:hooks.find(value=>[16,32,64].includes(value)),results:hooks.find(value=>value&&typeof value.key==='string'&&value.layers)};
})()`;
let failure;
try {
  for (const name of samples) assert.equal(await hashFile(join(fixtures, name + '.dem')), readJson(join(snapshots, name, 'manifest.json')).source.sha256);
  mkdirSync(hold);
  for (const name of samples) {
    renameSync(join(fixtures, name + '.dem'), join(hold, name + '.dem')); held.push(name);
    report.fixtureMoves.push({ fixture: name + '.dem', originalAbsentAfterMove: !existsSync(join(fixtures, name + '.dem')) });
  }
  for (const name of samples) {
    const snapshot = join(snapshots, name), manifest = readJson(join(snapshot, 'manifest.json'));
    const sampleOut = join(out, name); mkdirSync(sampleOut, { recursive: true });
    const server = createServer(); await new Promise(resolvePort => server.listen(0, '127.0.0.1', resolvePort));
    const port = server.address().port; await new Promise(resolvePort => server.close(resolvePort));
    const profile = mkdtempSync(join(sampleOut, 'profile-')), env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL; delete env.CS2_ANALYST_DEM_PATH; delete env.CS2_ANALYST_TEST_DEM_PATH;
    const scope = new ProcessScope(), startedAt = Date.now();
    const child = spawn(require('electron'), [join(root, 'scripts/library-offline-host.cjs'), root, snapshot, bundle, sampleOut,
      `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--disable-backgrounding-occluded-windows'],
    { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const tracked = scope.track(child, 'L0 snapshot Electron', startedAt);
    let page, logs = '';
    child.stdout.on('data', data => { logs = (logs + data).slice(-128_000); });
    child.stderr.on('data', data => { logs = (logs + data).slice(-128_000); });
    const observed = { fixture: manifest.source, oldCaptureProcessExited: true, originalDemAbsent: !existsSync(join(fixtures, name + '.dem')),
      views: [], players: [], replay: [], heatmap: [] };
    const wait = (probe, label, ms = 30_000) => waitFor(async () => {
      if (tracked.error) throw tracked.error;
      if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${logs}`);
      return probe();
    }, ms, label, { diagnostics: () => ({ logs: logs.slice(-2500) }) });
    try {
      await scope.live();
      const target = await wait(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page'); } catch { return null; } }, 'offline experiment CDP');
      page = await connectCdp(target.webSocketDebuggerUrl, 30_000);
      const { evaluate } = page;
      await page.send('Runtime.enable'); await page.send('Network.enable');
      await page.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await wait(() => evaluate('Boolean(window.cs2Analyst && document.querySelector("[data-sidebar-import]"))'), 'original preload/Renderer');
      assert.equal(await evaluate('typeof window.require'), 'undefined');
      const start = performance.now(); await evaluate('document.querySelector("[data-sidebar-import]").click()');
      await wait(() => evaluate('document.querySelector("main")?.dataset.status === "success"'), 'snapshot report', 60_000);
      observed.openMs = performance.now() - start;
      const restored = await evaluate(`(() => {const node=document.getElementById('heatmap-panel');let f=node[Object.keys(node).find(k=>k.startsWith('__reactFiber$'))];while(f&&!f.memoizedProps?.report)f=f.return;return f.memoizedProps.report;})()`);
      assert.equal(hashJson(withoutSession(restored)), manifest.reportHash);
      observed.reportHash = manifest.reportHash; observed.sessionId = restored.replay.sessionId;
      assert.match(restored.replay.sessionId, /^[a-f0-9-]{36}$/);
      for (const view of ['report', 'deep-review', 'timeline', 'analysis', 'replay', 'heatmap']) {
        await evaluate(`document.getElementById('${view}-tab').click()`);
        await wait(() => evaluate(`document.getElementById('${view}-tab').getAttribute('aria-selected')==='true'&&!document.getElementById('${view}-panel').hidden`), view + ' visible');
        const content = await evaluate(`document.getElementById('${view}-panel').innerText`);
        assert.ok(content.length > 20, `${name} ${view}: real content required`);
        observed.views.push({ view, contentBytes: Buffer.byteLength(content), hash: hashJson(content) });
        const screenshot = await page.send('Page.captureScreenshot', { format: 'png' });
        writeFileSync(join(sampleOut, view + '.png'), Buffer.from(screenshot.data, 'base64'));
      }
      for (const player of restored.players.filter(player => player.id !== restored.selectedPlayer).slice(0, 2)) {
        await evaluate('document.querySelector("[aria-label=目标玩家]").click()');
        await wait(() => evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(option=>option.getAttribute('data-value')===${JSON.stringify(player.id)}||option.innerText.trim()===${JSON.stringify(player.nickname.trim())}))`), 'player option');
        await evaluate(`[...document.querySelectorAll('[role=option]')].find(option=>option.getAttribute('data-value')===${JSON.stringify(player.id)}||option.innerText.trim()===${JSON.stringify(player.nickname.trim())}).click()`);
        await wait(() => evaluate(`document.querySelector('[aria-label=目标玩家]').innerText.trim()===${JSON.stringify(player.nickname.trim())}`), 'player selected');
        const views = [];
        for (const view of ['report', 'deep-review', 'timeline', 'analysis', 'replay', 'heatmap']) {
          await evaluate(`document.getElementById('${view}-tab').click()`);
          await wait(() => evaluate(`!document.getElementById('${view}-panel').hidden`), 'changed-player ' + view);
          const text = await evaluate(`document.getElementById('${view}-panel').innerText`);
          assert.ok(text.length > 20); views.push({ view, textHash: hashJson(text) });
        }
        observed.players.push({ id: player.id, views });
      }
      await evaluate('document.getElementById("replay-tab").click()');
      const replayRound = async round => {
        if (await evaluate(`Number(document.querySelector('[data-replay-session]').dataset.replayRound)===${round}`)) return;
        await evaluate('document.querySelector("[aria-label=回放回合]").click()');
        await wait(() => evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.innerText.trim()==='R${round}'))`), 'Replay round option');
        await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.innerText.trim()==='R${round}').click()`);
        await wait(() => evaluate(`Number(document.querySelector('[data-replay-session]').dataset.replayRound)===${round}`), 'Replay round');
      };
      const seek = async (round, tick, label) => {
        await replayRound(round);
        await evaluate(`(() => {const slider=document.querySelector('[aria-label="回放进度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(slider,${tick});slider.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await wait(() => evaluate(`Math.abs(Number(document.querySelector('#replay-panel canvas[role=img]')?.dataset.tick)-${tick})<.01&&Number(document.querySelector('[data-replay-session]')?.dataset.replayRevision)>0`), 'Replay seek ' + label);
        const state = await evaluate(`({...document.querySelector('#replay-panel canvas[role=img]').dataset})`);
        observed.replay.push({ label, round, tick, state }); return state;
      };
      for (const info of manifest.chunkIndex.filter((_, index) => index % Math.max(1, Math.floor(manifest.chunkIndex.length / 3)) === 0).slice(0, 3)) await seek(info.round, info.sample.tick, 'exact-sampled-tick');
      const effects = new Map();
      for (const info of manifest.chunkIndex) {
        const chunk = JSON.parse(gunzipSync(readFileSync(join(snapshot, info.path))));
        for (const utility of chunk.utilities ?? []) {
          const kind = utility.kind === 'smoke' ? 'smoke' : utility.kind === 'fire' ? 'fire' : utility.kind === 'flashbang' ? 'flashes' : utility.kind === 'hegrenade' ? 'explosions' : null;
          if (kind && !effects.has(kind)) effects.set(kind, { round: chunk.round, tick: Math.max(chunk.startTick, utility.tick), endTick: utility.endTick });
          if (utility.trajectory && !effects.has('flying')) effects.set('flying', { round: chunk.round,
            tick: Math.max(chunk.startTick, utility.trajectory.startTick + 1), endTick: utility.trajectory.endTick });
        }
        for (const [key, values] of [['blind', chunk.blinds], ['burn', chunk.burns]]) for (const window of values ?? [])
          if (!effects.has(key)) effects.set(key, { round: chunk.round, tick: Math.max(chunk.startTick, window.startTick), endTick: window.endTick });
      }
      const requiredEffects = ['smoke', 'fire', 'flashes', 'explosions', 'flying', 'blind', 'burn'];
      assert.deepEqual(requiredEffects.filter(kind => !effects.has(kind)), [], `${name}: required real effect-source coverage cannot be skipped`);
      for (const [kind, point] of effects) {
        assert.ok(point.tick < point.endTick, `${name}: ${kind} source must provide a nonempty visible window`);
        const state = await seek(point.round, point.tick, 'effect-' + kind);
        assert.ok(Number(state[kind]) > 0, `${name}: restored real ${kind} effect must render at its actual source tick`);
      }
      const tickBeforePlay = await evaluate('Number(document.querySelector("[data-replay-session]").dataset.replayTick)');
      await evaluate('document.querySelector("[aria-label=播放回放]").click()');
      await wait(() => evaluate(`Number(document.querySelector('[data-replay-session]').dataset.replayTick)>${tickBeforePlay + 1}`), 'restored animation advances');
      await evaluate('document.querySelector("[aria-label=暂停回放]").click()');
      observed.animation = { advanced: true, resumedFromActualTick: tickBeforePlay };
      await evaluate('document.getElementById("heatmap-tab").click()');
      await wait(() => evaluate('Boolean(document.querySelector("#heatmap-panel canvas"))'), 'Heatmap canvas');
      // All canonical-scope combinations are checked by the fresh-process L0 benchmark.
      // This experiment checks representative requests through the unchanged preload and rendered controls.
      const comparisons = manifest.heatmapComparisons.filter((_, index) => index % Math.max(1, Math.floor(manifest.heatmapComparisons.length / 12)) === 0).slice(0, 12);
      for (const comparison of comparisons) {
        const request = { ...comparison.request, sessionId: restored.heatmap.sessionId };
        const result = await evaluate(`window.cs2Analyst.heatmap.getGrid(${JSON.stringify(request)})`);
        assert.equal(result.kind, 'success'); assert.equal(hashJson(withoutSession(result)), comparison.sha256);
        observed.heatmap.push({ request: comparison.request, hash: comparison.sha256 });
      }
      observed.uiFilters = [];
      let expectedResolution = 32, expectedSide = 'all', expectedSampling = 'all-valid';
      for (const [label, value] of [['热力图分辨率', '64'], ['热力图阵营', 'CT'], ['热力图采样集', 'uniform-8hz']]) {
        await evaluate(`document.querySelector('[aria-label="${label}"]').click()`);
        await wait(() => evaluate(`Boolean([...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.getAttribute('data-value')===${JSON.stringify(value)}))`), label + ' option');
        await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.checkVisibility()&&o.getAttribute('data-value')===${JSON.stringify(value)}).click()`);
        assert.equal(await evaluate(`document.querySelector('[aria-label="${label}"]').textContent.includes(${JSON.stringify(value)})`), true);
        if (label === '热力图分辨率') expectedResolution = Number(value);
        if (label === '热力图阵营') expectedSide = value;
        if (label === '热力图采样集') expectedSampling = value;
        await wait(async () => {
          const state = await evaluate(heatmapState), projection = state?.results?.layers?.positions;
          return projection?.status === 'ready' && projection.projection.grid.resolution === expectedResolution
            && projection.projection.scope.side === expectedSide && projection.projection.scope.samplingSet === expectedSampling;
        }, 'actual filtered Heatmap response ' + label);
        const state = await evaluate(heatmapState), projection = state.results.layers.positions.projection;
        const expected = manifest.heatmapComparisons.find(item => item.request.layer === 'positions'
          && item.request.resolution === expectedResolution && item.request.scope.side === expectedSide
          && item.request.scope.samplingSet === expectedSampling && item.request.scope.floor === null
          && item.request.scope.playerIds === null && item.request.scope.rounds === null && !item.request.scope.includeFreezeTime);
        assert.ok(expected, 'Measured source baseline exists for filtered UI response');
        assert.equal(hashJson({ kind: 'success', projection }), expected.sha256);
        observed.uiFilters.push({ label, value, responseHash: expected.sha256 });
      }
      observed.processes = (await scope.live()).map(process => ({ pid: process.pid, name: process.name, workingSet: process.workingSet, peakWorkingSet: process.peakWorkingSet }));
      assert.ok(observed.processes.some(process => process.pid !== child.pid), 'New Electron children observed');
      await closeApp({ child, evaluate, socket: page.socket });
      page = null;
      observed.hostAudit = readJson(join(sampleOut, 'host-audit.json'));
      assert.equal(observed.hostAudit.imports.length, 1);
      assert.equal(observed.hostAudit.imports[0].sessionId, observed.sessionId);
      observed.exitCode = child.exitCode; observed.status = 'PASS';
      report.samples.push(observed);
    } finally {
      page?.socket.close();
      await scope.cleanup();
      writeFileSync(join(sampleOut, 'electron.log'), logs);
    }
  }
} catch (error) { failure = error; report.error = { message: error.message, stack: error.stack }; }
finally {
  for (const name of held) {
    assert.ok(!existsSync(join(fixtures, name + '.dem')), 'Do not replace a newly created fixture');
    renameSync(join(hold, name + '.dem'), join(fixtures, name + '.dem'));
    const restoredSha = await hashFile(join(fixtures, name + '.dem'));
    assert.equal(restoredSha, readJson(join(snapshots, name, 'manifest.json')).source.sha256);
    report.fixtureMoves.find(item => item.fixture === name + '.dem').restoredWithSameSha = restoredSha;
  }
  if (existsSync(hold)) rmdirSync(hold);
  report.status = failure ? 'FAIL' : 'PASS';
  writeFileSync(join(out, 'acceptance.json'), JSON.stringify(report, null, 2) + '\n');
}
if (failure) throw failure;
console.log(JSON.stringify({ status: report.status, evidence: join(out, 'acceptance.json'), samples: report.samples.map(sample => ({ fixture: sample.fixture, views: sample.views.length, players: sample.players.length, replayChecks: sample.replay.length, heatmapChecks: sample.heatmap.length, openMs: sample.openMs })) }, null, 2));
