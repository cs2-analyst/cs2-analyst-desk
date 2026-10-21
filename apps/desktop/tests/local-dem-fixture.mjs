// Test-only path selection for isolated worktrees. Never copies, downloads, or links DEM files.
import { basename, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const allowed = /^(?:dust2|nuke|inferno|mirage|ancient|anubis|overpass|vertigo|cache|demo|demo1|demo2)\.dem$/;
export function allowedDemFile(file) {
  if (typeof file !== 'string' || !isAbsolute(file) || !allowed.test(basename(file))) throw new Error('A local whitelisted DEM fixture is required; no legacy or downloaded replacement.');
  return resolve(file);
}
export function localDemFixture(name) {
  if (typeof name !== 'string' || !allowed.test(name)) throw new Error('Fixture name is outside the current-stage whitelist.');
  const root = process.env.CS2_ANALYST_FIXTURE_ROOT ?? fileURLToPath(new URL('../../../.demo/', import.meta.url));
  if (!isAbsolute(root)) throw new Error('CS2_ANALYST_FIXTURE_ROOT must be an absolute local directory.');
  return allowedDemFile(join(root, name));
}
