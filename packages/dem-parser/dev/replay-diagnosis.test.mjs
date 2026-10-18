import assert from 'node:assert/strict';
import test from 'node:test';
import { scanDemoCommandTicks } from './replay-diagnosis.mjs';

const varint = value => { const out=[]; do { const b=value&127; value>>>=7; out.push(b|(value?128:0)); } while(value); return out; };
const fixture = (...commands) => Buffer.concat([Buffer.from('PBDEMS2\0'), Buffer.alloc(8), ...commands.map(([command,tick,payload=[]])=>Buffer.from([...varint(command),...varint(tick),...varint(payload.length),...payload]))]);
test('S0 command-header scanner handles compression flags, duplicate ticks, payloads and explicit stop', () => {
  const result = scanDemoCommandTicks(fixture([7|64,128,[0,0,0]], [13,128], [7,130], [0,131], [7,132]), [128,129,130,132]);
  assert.equal(result.stopped, true);
  assert.deepEqual(result.missingTickCommands, [{tick:128,commands:[7,13]},{tick:129,commands:[]},{tick:130,commands:[7]},{tick:132,commands:[]}]);
});
test('S0 command-header scanner rejects truncated evidence instead of treating it as missing ticks', () => {
  const bytes=fixture([7,128,[1,2]]);
  assert.throws(()=>scanDemoCommandTicks(bytes.subarray(0,-1),[128]),/Truncated/);
  assert.throws(()=>scanDemoCommandTicks(Buffer.alloc(20),[128]));
});
