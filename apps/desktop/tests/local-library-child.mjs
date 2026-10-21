// Real process interruption harness. No DEM, environment injection, or product seam.
import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalMatchLibrary } from '../electron/local-library.ts';

const [root, template, phase] = process.argv.slice(2);
let library;
try {
  library = await LocalMatchLibrary.open(root, { phase: async name => {
    if (name !== phase) return;
    process.send?.({ kind: 'checkpoint', phase: name, pid: process.pid });
    await new Promise(() => { setInterval(() => {}, 1000); });
  } });
  if (phase === 'hold-lock') {
    process.send?.({ kind: 'checkpoint', phase, pid: process.pid });
    await new Promise(() => { setInterval(() => {}, 1000); });
  }
  const stage = await library.createStaging();
  for (const name of await readdir(template)) await cp(join(template, name), join(stage.directory, name), { recursive: true, force: false, errorOnExist: true });
  await library.commitStaging(stage.id);
  throw new Error('The requested interruption checkpoint was not reached');
} catch (error) {
  process.send?.({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
} finally { library?.close(); }
