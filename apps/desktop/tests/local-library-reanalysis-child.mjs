// Real process interruption for replacement. Templates are owned analysis archives, never DEMs.
import { cp, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { LocalMatchLibrary } from '../electron/local-library.ts';

const [root, template, matchId, phase] = process.argv.slice(2);
let library;
try {
  library = await LocalMatchLibrary.open(root, { phase: async name => {
    if (name !== phase) return;
    process.send?.({ kind: 'checkpoint', phase: name, pid: process.pid });
    await new Promise(() => { setInterval(() => {}, 1000); });
  } });
  const staged = await library.createStaging();
  for (const name of await readdir(template)) await cp(join(template, name), join(staged.directory, name), { recursive: true, force: false, errorOnExist: true });
  await library.replaceStaging(staged.id, matchId);
  throw new Error('Replacement did not reach its requested checkpoint');
} catch (error) { process.send?.({ kind: 'error', message: String(error.message ?? error) }); process.exitCode = 1; }
finally { library?.close(); }
