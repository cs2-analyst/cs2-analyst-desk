import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizeMemory } from './library-storage-electron-qa.mjs';

const memory = (rss, heapUsed = rss / 2) => ({ rss, heapTotal: heapUsed + 1, heapUsed, external: 3, arrayBuffers: 2 });
const process = (pid, type, workingSetSize) => ({ pid, type, serviceName: type === 'Utility' ? 'node.mojom.NodeService' : undefined,
  name: type === 'Utility' ? 'CS2 Saved Match Restore' : undefined,
  memory: { workingSetSize, peakWorkingSetSize: workingSetSize + 5 } });
const main = (at, processes, rss = 100) => ({ at, role: 'Main', pid: 1, memory: memory(rss), lifetimeMaxRssBytes: 200, processes });
const utility = (at, pid, rss) => ({ at, role: 'Utility', pid, memory: memory(rss), lifetimeMaxRssBytes: rss + 10 });

test('phase peaks isolate primary opens from alternate-match switches and retain measured release falloff', () => {
  const rows = [
    main(12, [process(1, 'Browser', 10), process(2, 'Tab', 20), process(3, 'Utility', 30)]),
    utility(13, 3, 300),
    main(22, [process(1, 'Browser', 15), process(2, 'Tab', 18), process(3, 'Utility', 30), process(4, 'Utility', 25)]),
    utility(23, 4, 400),
    main(35, [process(1, 'Browser', 11), process(2, 'Tab', 19), process(4, 'Utility', 90)], 120),
    utility(36, 4, 900),
    main(55, [process(1, 'Browser', 8), process(2, 'Tab', 12)], 80),
  ];
  const renderer = [{ at: 18, usedSize: 40, totalSize: 60 }, { at: 37, usedSize: 100, totalSize: 150 },
    { at: 56, usedSize: 20, totalSize: 50 }];
  const phases = [{ at: 10, label: 'primary-open', matchId: 'primary' }, { at: 30, label: 'switch', matchId: 'alternate' },
    { at: 50, label: 'released', matchId: 'alternate' }, { at: 60, label: 'empty', matchId: 'alternate' }];
  const result = summarizeMemory(rows, renderer, phases), [open, switched, released, empty] = result.phases;
  assert.equal(open.matchId, 'primary'); assert.equal(switched.matchId, 'alternate');
  assert.deepEqual(open.peakWorkingSetBytes, { Main: 15 * 1024, Renderer: 20 * 1024, Utility: 55 * 1024 },
    'simultaneous candidate and active Utilities are summed within a sample');
  assert.equal(open.peakNodeMemory.Utility.rss, 400);
  assert.equal(switched.peakNodeMemory.Utility.rss, 900);
  assert.equal(open.peakRendererHeap.usedSize, 40);
  assert.equal(switched.peakRendererHeap.usedSize, 100);
  assert.equal(open.peakRendererHeap.backingStorageSize, null, 'unavailable CDP field is not zero');
  assert.equal(released.peakWorkingSetBytes.Utility, 0, 'observed absence of a Utility is measured zero');
  assert.equal(released.lastWorkingSetBytes.Main, 8 * 1024);
  assert.equal(released.lastRendererHeap.usedSize, 20);
  assert.equal(released.peakNodeMemory.Utility, null, 'no Utility JS observations is unavailable, not zero');
  assert.equal(empty.peakWorkingSetBytes, null); assert.equal(empty.lastWorkingSetBytes, null);
  assert.deepEqual(empty.peakNodeMemory, { Main: null, Utility: null });
  assert.equal(empty.peakRendererHeap, null); assert.equal(empty.lastRendererHeap, null);
  assert.equal(result.workingSet.Utility.peakConcurrentWorkingSetBytes, 90 * 1024);
  assert.equal(result.node.Utility.peakSingleProcess.rss, 900);
});

test('an imported postprocessor does not run the GUI CLI and missing observer roles fail explicitly', () => {
  assert.throws(() => summarizeMemory([main(1, [])], [], []), /Missing Utility observer/);
});
