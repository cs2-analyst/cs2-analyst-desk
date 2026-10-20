import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkReportLayout } from './report-ux-checks.mjs';
import { assertNoPageScroll, settleUi, waitForUi } from './window-shell-checks.mjs';
import { waitFor, withCleanup } from './smoke-runtime.mjs';

/** Installed binaries, real imported demo1 report/IPC only. Never replaces report DTOs. */
export async function checkInstalledP7Real(session, qaDir) {
  const { evaluate, send } = session;
  const evidence = { source: 'real DEM: demo1.dem', runtime: 'installed Electron', status: 'RUNNING', cases: [], screenshots: [] };
  const save = () => writeFileSync(join(qaDir, 'real-dem.json'), JSON.stringify(evidence, null, 2));
  const record = (name, details) => { evidence.cases.push({ name, source: 'real DEM', status: 'PASS', details }); save(); };
  const navigate = async name => {
    await evaluate(`document.getElementById(${JSON.stringify(name + '-tab')}).click()`);
    await waitForUi(evaluate, `!document.getElementById(${JSON.stringify(name + '-panel')}).hidden`, name + ' visible');
    await settleUi(evaluate);
  };
  const shot = async name => {
    await settleUi(evaluate);
    const capture = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(qaDir, name + '.png'), Buffer.from(capture.data, 'base64'));
    evidence.screenshots.push(name + '.png'); save();
  };
  const tabs = async (kind, keys) => {
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('[data-${kind}-tab]')].map(t=>t.dataset[${JSON.stringify(kind === 'deep' ? 'deepTab' : 'analysisTab')}])`), keys);
    for (const key of keys) {
      await evaluate(`document.querySelector('[data-${kind}-tab="${key}"]').click()`);
      await settleUi(evaluate);
      assert.equal(await evaluate(`document.querySelector('[data-${kind}-tab="${key}"]').getAttribute('aria-selected')`), 'true');
      assert.equal(await evaluate(`document.querySelector('[data-${kind}-panel="${key}"]').checkVisibility()`), true);
      await assertNoPageScroll(evaluate, 'installed real ' + kind + ' ' + key);
    }
  };
  const tick = () => evaluate(`Number(document.querySelector('#replay-panel canvas[role=img]')?.dataset.tick)`);
  const seek = async target => {
    await evaluate(`(() => {const input=document.querySelector('[aria-label="回放进度"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${target});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await waitFor(() => evaluate(`Math.abs(Number(document.querySelector('#replay-panel canvas[role=img]')?.dataset.tick)-${target})<.01`), 15_000, 'installed real seek ' + target);
  };
  save();
  try {
    await withCleanup(async () => {
      await navigate('report');
      assert.ok(await evaluate(`document.getElementById('report-panel').textContent.includes('25 / 20 / 4')`));
      assert.equal(await evaluate(`document.querySelectorAll('[data-rule]').length`), 5);
      record('report real KPI and Findings', { kda: '25 / 20 / 4', findings: 5 });
      await navigate('analysis');
      await tabs('analysis', ['comparison', 'trend', 'sides']);
      assert.equal(await evaluate(`document.querySelectorAll('[data-comparison-player]').length`), 10);
      assert.equal(await evaluate(`document.querySelectorAll('[data-trend-round]').length`), 24);
      assert.ok(await evaluate(`document.querySelector('[data-analysis-side="CT"]').textContent.includes('68.25')&&document.querySelector('[data-analysis-side="T"]').textContent.includes('114.50')`));
      await navigate('report'); await navigate('analysis');
      assert.equal(await evaluate(`document.querySelector('[data-analysis-tab="sides"]').getAttribute('aria-selected')`), 'true');
      record('analysis three tabs and navigation state', { players: 10, rounds: 24 });
      await navigate('deep-review');
      await tabs('deep', ['reviews', 'highlights', 'contexts']);
      assert.ok(await evaluate(`document.querySelectorAll('#deep-review-panel [data-deep-kind]').length>0`), 'real imported Deep Review must contain findings');
      const deepCounts = await evaluate(`Object.fromEntries([...document.querySelectorAll('[data-deep-panel]')].map(p=>[p.dataset.deepPanel,{cards:p.querySelectorAll('[data-deep-kind]').length,empty:p.querySelector('[data-deep-empty]')!==null}]))`);
      await navigate('report'); await navigate('deep-review');
      assert.equal(await evaluate(`document.querySelector('[data-deep-tab="contexts"]').getAttribute('aria-selected')`), 'true');
      record('deep review three tabs and real content/empty states', deepCounts);
      const related = await evaluate(`(() => {const b=document.querySelector('#deep-review-panel [data-deep-rounds]');return b?{tab:b.closest('[data-deep-panel]').dataset.deepPanel,round:Number(b.dataset.deepRounds.split(',')[0])}:null;})()`);
      assert.ok(related?.round, 'real Deep Review has a related-round link');
      await evaluate(`document.querySelector('[data-deep-tab="${related.tab}"]').click()`);
      await settleUi(evaluate);
      await evaluate(`document.querySelector('[data-deep-panel="${related.tab}"] [data-deep-rounds]').click()`);
      await waitForUi(evaluate, `!document.getElementById('timeline-panel').hidden&&document.querySelector('[data-round-summary="${related.round}"]').getAttribute('aria-expanded')==='true'`, 'real Deep Review Timeline link');
      await navigate('deep-review');
      await evaluate(`[...document.querySelectorAll('[data-deep-panel="${related.tab}"] button')].find(b=>b.textContent.trim()===${JSON.stringify('比赛回放 R' + related.round)}).click()`);
      await waitFor(() => evaluate(`!document.getElementById('replay-panel').hidden&&document.querySelector('[data-replay-session]')?.dataset.replayRound===${JSON.stringify(String(related.round))}`), 15_000, 'real Deep Review Replay link');
      record('real Deep Review links to Timeline and Replay', related);
      await navigate('timeline');
      assert.equal(await evaluate(`document.querySelectorAll('[data-round-summary]').length`), 24);
      await evaluate(`(() => {const b=document.querySelector('[data-round-summary="24"]');if(b.getAttribute('aria-expanded')!=='true')b.click();})()`);
      await waitForUi(evaluate, `document.querySelector('[data-round-detail="24"]')?.textContent.includes('8888888888888888888888')`, 'real Timeline round detail');
      record('timeline real round expansion', { rounds: 24, expanded: 24 });
      await navigate('replay');
      await evaluate(`document.querySelector('[aria-label="回放回合"]').click()`);
      await waitForUi(evaluate, `[...document.querySelectorAll('[role=option]')].some(o=>o.textContent.trim()==='R1')`, 'installed replay round menu');
      await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()==='R1').click()`);
      await waitForUi(evaluate, `document.querySelector('[data-replay-session]')?.dataset.replayRound==='1'`, 'installed R1');
      await waitFor(() => evaluate(`document.querySelector('[data-replay-session]')?.dataset.replayMapReady==='true'&&Number(document.querySelector('#replay-panel canvas[role=img]')?.dataset.playerCount)>0`), 15_000, 'installed real Replay first frame');
      assert.ok(await evaluate(`(() => {const c=document.querySelector('#replay-panel canvas[aria-hidden=true]');return c.width>0&&c.getContext('2d').getImageData(0,0,c.width,c.height).data.some((v,i)=>i%4===3&&v>0);})()`), 'real radar base pixels');
      const range = await evaluate(`(() => {const s=document.querySelector('[aria-label="回放进度"]');return {min:Number(s.min),max:Number(s.max)};})()`);
      assert.ok(range.max - range.min > 256, 'real replay window supports seek/play');
      for (const fraction of [.4, .1, .4, 0]) await seek(Math.round(range.min + (range.max - range.min) * fraction));
      record('Replay forward/reverse/repeated seek and map', range);
      for (const speed of [1, 1.5, 2, 4]) {
        await seek(range.min);
        await evaluate(`document.querySelector('[aria-label="回放倍速"]').click()`);
        await waitForUi(evaluate, `[...document.querySelectorAll('[role=option]')].some(o=>o.textContent.trim()===${JSON.stringify(speed + '×')})`, 'installed speed option');
        await evaluate(`[...document.querySelectorAll('[role=option]')].find(o=>o.textContent.trim()===${JSON.stringify(speed + '×')}).click()`);
        assert.equal(await evaluate(`document.querySelector('[aria-label="回放倍速"]').textContent`), speed + '×');
        const before = await tick();
        await evaluate(`document.querySelector('[aria-label="播放回放"]').click()`);
        await waitFor(async () => (await tick()) > before + 32, 10_000, 'installed playback ' + speed + 'x advances');
        await evaluate(`document.querySelector('[aria-label="暂停回放"]').click()`);
        await waitForUi(evaluate, `Boolean(document.querySelector('[aria-label="播放回放"]'))&&document.querySelector('#replay-panel canvas[role=img]').dataset.tick===document.querySelector('[data-replay-session]').dataset.replayTick`, 'installed paused frame');
        const paused = await tick();
        await evaluate(`new Promise(resolve=>setTimeout(resolve,250))`);
        assert.equal(await tick(), paused, 'paused Canvas must not advance');
        record('Replay playback and pause ' + speed + 'x', { before, paused });
      }
      const replayState = await evaluate(`({session:document.querySelector('[data-replay-session]').dataset.replaySession,round:document.querySelector('[data-replay-session]').dataset.replayRound,tick:document.querySelector('[data-replay-session]').dataset.replayTick})`);
      await navigate('report'); await navigate('replay');
      assert.deepEqual(await evaluate(`({session:document.querySelector('[data-replay-session]').dataset.replaySession,round:document.querySelector('[data-replay-session]').dataset.replayRound,tick:document.querySelector('[data-replay-session]').dataset.replayTick})`), replayState);
      record('Replay navigation preserves paused state', replayState);
      for (const [width, height] of [[1024, 640], [1920, 1032]]) {
        await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        for (const view of ['report', 'analysis', 'deep-review', 'timeline', 'replay']) {
          await navigate(view);
          if (view === 'report') await checkReportLayout(evaluate, 'installed real ' + width);
          await assertNoPageScroll(evaluate, 'installed real ' + view + ' ' + width);
          await shot(`${view}-${width}x${height}`);
          if (view === 'analysis' || view === 'deep-review') {
            const kind = view === 'analysis' ? 'analysis' : 'deep';
            const keys = kind === 'analysis' ? ['comparison', 'trend', 'sides'] : ['reviews', 'highlights', 'contexts'];
            for (const key of keys) {
              await evaluate(`document.querySelector('[data-${kind}-tab="${key}"]').click()`);
              await settleUi(evaluate);
              await assertNoPageScroll(evaluate, 'installed real ' + view + ' ' + key + ' ' + width);
              await shot(`${view}-${key}-${width}x${height}`);
            }
          }
        }
        record('real view geometry/screenshots ' + width + 'x' + height, { width, height, views: 5 });
      }
      // Leave the shared legacy UX checks at their original report/default-tab entry.
      await navigate('analysis');
      await evaluate(`document.querySelector('[data-analysis-tab="comparison"]').click()`);
      await navigate('deep-review');
      await evaluate(`document.querySelector('[data-deep-tab="reviews"]').click()`);
      await navigate('report');
    }, [() => send('Emulation.clearDeviceMetricsOverride')]);
    evidence.status = 'PASS';
    return evidence;
  } catch (error) {
    evidence.status = 'FAIL'; evidence.error = { message: error.message, stack: error.stack };
    throw error;
  } finally { save(); }
}
