import assert from 'node:assert/strict';
import test from 'node:test';
import { useReport } from '../renderer/src/store.ts';

const report = id => ({ match: { id }, selectedPlayer: '1', players: [{ id: '1', nickname: 'p' }], analytics: [], replay: { available: true, sessionId: 'session-' + id } });

test('openMatch exposes an opening phase, ignores imports, and preserves the old report on failure', async () => {
  const previous = globalThis.window;
  let resolveOpen, resolveNext;
  try {
    globalThis.window = { cs2Analyst: { library: { open: () => new Promise(resolve => { resolveOpen = resolve; }) }, importDemo: async () => ({ kind: 'error', message: 'must not run' }) } };
    const old = report('old');
    useReport.setState({ status: 'success', report: old, playerId: '1', reportRevision: 4, error: null });
    const opening = useReport.getState().openMatch('a'.repeat(64));
    assert.equal(useReport.getState().status, 'opening');
    await useReport.getState().importDemo();
    assert.equal(useReport.getState().status, 'opening', 'import must not race an open');
    resolveOpen({ kind: 'success', report: report('new') });
    await opening;
    assert.equal(useReport.getState().status, 'success');
    assert.equal(useReport.getState().report.match.id, 'new');
    assert.equal(useReport.getState().reportRevision, 5);

    globalThis.window.cs2Analyst.library.open = () => new Promise(resolve => { resolveNext = resolve; });
    const failing = useReport.getState().openMatch('b'.repeat(64));
    resolveNext({ kind: 'error', message: 'archive broken' });
    await failing;
    assert.equal(useReport.getState().status, 'error');
    assert.equal(useReport.getState().report.match.id, 'new', 'failed open must keep the previous report');
    assert.equal(useReport.getState().error, 'archive broken');
  } finally {
    globalThis.window = previous;
    useReport.setState({ status: 'idle', report: null, playerId: '', error: null });
  }
});
