import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Demoparser2Provider } from '../packages/dem-parser/dist/index.js';

const file = fileURLToPath(new URL('../.demo/dust2.dem', import.meta.url));
const consumer = process.argv[2] === 'mutate' ? access => {
  access.rawInput.events.length = 0;
  access.rawInput.stateRows.length = 0;
  throw new Error('consumer-failure');
} : undefined;
const parsed = await new Demoparser2Provider().parseWithReplay(file, undefined, consumer);
const digest = createHash('sha256').update(JSON.stringify({ match: parsed.match,
  spatial: parsed.spatial, replay: parsed.replay })).digest('hex');
process.stdout.write(`${digest}\n`);
