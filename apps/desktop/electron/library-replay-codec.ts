import type { MatchReplay } from '@cs2-analyst/match-model';

/** Storage-only encoding. Domain objects and the UI replay contract stay unchanged. */
export const STORED_REPLAY_ENCODING = 'replay-tuples-v1' as const;
/** Same per-component ceiling as ordinary archive JSON, applied after tuple expansion too. */
export const STORED_REPLAY_MAX_CANONICAL_BYTES = 256 * 1024 * 1024;
const limits = Object.freeze({ rounds: 1024, frames: 60000, samples: 600000, players: 64,
  schemas: 4096, fields: 128, keyLength: 512, depth: 64 });
type ObjectValue = Record<string, unknown>;
interface Envelope { encoding: typeof STORED_REPLAY_ENCODING; schemas: string[][]; source: ObjectValue | null }
const dangerous = new Set(['__proto__', 'prototype', 'constructor']);
function fail(reason: string): never { throw new Error(`Invalid stored Replay: ${reason}`); }
function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function key(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= limits.keyLength && !dangerous.has(value);
}
function record(value: unknown): asserts value is ObjectValue {
  if (!object(value) || Object.keys(value).some(name => !key(name))) fail('object or unsafe key');
}
function array(value: unknown, maximum: number): asserts value is unknown[] {
  if (!Array.isArray(value) || value.length > maximum) fail('array budget or shape');
  for (let index = 0; index < value.length; index++) if (!Object.hasOwn(value, index)) fail('sparse array');
}
/** Values are never coerced. Undefined/non-finite/custom objects cannot be losslessly JSON stored. */
function storedValue(value: unknown, depth = 0): void {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') { if (!Number.isFinite(value)) fail('non-finite value'); return; }
  if (depth >= limits.depth) fail('value nesting budget or cycle');
  if (Array.isArray(value)) {
    if (value.length > limits.samples) fail('value array budget');
    for (let index = 0; index < value.length; index++) storedValue(value[index], depth + 1);
    return;
  }
  record(value);
  for (const child of Object.values(value)) storedValue(child, depth + 1);
}

/** Replaces only frame.players samples; all other source fields and their order are retained. */
function transform(source: unknown, sample: (value: unknown) => unknown,
  mode: 'copy' | 'inspect' | 'consume' = 'copy'): ObjectValue | null {
  if (source === null) return null;
  record(source);
  if (source.schemaVersion !== 1) fail('source schema');
  array(source.players, limits.players);
  if (source.players.some(player => typeof player !== 'string')) fail('player identity');
  array(source.rounds, limits.rounds);
  let frames = 0, samples = 0;
  const rounds: ObjectValue[] | null = mode === 'copy' ? [] : null;
  for (const round of source.rounds) {
    record(round); array(round.frames, limits.frames);
    frames += round.frames.length;
    if (frames > limits.frames) fail('frame budget');
    const transformedFrames: ObjectValue[] | null = mode === 'copy' ? [] : null;
    for (const frame of round.frames) {
      record(frame); array(frame.players, limits.players);
      samples += frame.players.length;
      if (samples > limits.samples) fail('sample budget');
      if (transformedFrames) transformedFrames.push({ ...frame, players: frame.players.map(sample) });
      else for (let index = 0; index < frame.players.length; index++) {
        const transformed = sample(frame.players[index]);
        if (mode === 'consume') frame.players[index] = transformed;
      }
    }
    if (rounds) rounds.push({ ...round, frames: transformedFrames });
  }
  return rounds ? { ...source, rounds } : source;
}

/** Exact JSON.stringify string byte count, without allocating an escaped copy of a large string. */
function stringBytes(value: string): number {
  let bytes = Buffer.byteLength(value, 'utf8') + 2;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 0x22 || code === 0x5c) bytes++;
    else if (code < 0x20) bytes += [8, 9, 10, 12, 13].includes(code) ? 1 : 5;
    else if (code >= 0xd800 && code <= 0xdbff && value.charCodeAt(index + 1) >= 0xdc00
      && value.charCodeAt(index + 1) <= 0xdfff) index++;
    else if (code >= 0xd800 && code <= 0xdfff) bytes += 3; // JSON escapes lone surrogates.
  }
  return bytes;
}

/** Bounded counting pass over parsed JSON; no expanded objects or whole-source JSON string. */
function countJsonBytes(value: unknown, add: (bytes: number) => void, depth = 0): void {
  if (value === null) { add(4); return; }
  if (typeof value === 'string') { add(stringBytes(value)); return; }
  if (typeof value === 'boolean') { add(value ? 4 : 5); return; }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('non-finite value');
    add(JSON.stringify(value).length); return;
  }
  if (depth >= limits.depth) fail('value nesting budget or cycle');
  if (Array.isArray(value)) {
    array(value, limits.samples);
    add(value.length ? value.length + 1 : 2);
    for (const child of value) countJsonBytes(child, add, depth + 1);
    return;
  }
  record(value);
  const names = Object.keys(value);
  add(names.length ? names.length + 1 : 2);
  for (const name of names) { add(stringBytes(name) + 1); countJsonBytes(value[name], add, depth + 1); }
}

/** Call on the canonical JSON source; no mutation, rounding, normalization or field whitelist. */
export function encodeStoredReplay(value: MatchReplay | null): unknown {
  const schemas: string[][] = [], ids = new Map<string, number>();
  const source = transform(value, sample => {
    record(sample);
    const names = Object.keys(sample);
    if (!names.length || names.length > limits.fields) fail('sample fields budget');
    const identity = JSON.stringify(names);
    let id = ids.get(identity);
    if (id === undefined) {
      if (schemas.length >= limits.schemas) fail('schema budget');
      id = schemas.length; ids.set(identity, id); schemas.push(names);
    }
    const values = names.map(name => { storedValue(sample[name]); return sample[name]; });
    return [id, ...values];
  });
  return { encoding: STORED_REPLAY_ENCODING, schemas, source } satisfies Envelope;
}

/**
 * A malformed tuple is rejected before building a domain object; unknown codecs are never guessed.
 * consume is only for a freshly JSON-parsed envelope exclusively owned by the archive reader:
 * after complete preflight it replaces tuple slots in place, releasing their references as it goes.
 */
export function decodeStoredReplay(value: unknown, options: { maxCanonicalBytes?: number; consume?: boolean } = {}): MatchReplay | null {
  const maximum = options.maxCanonicalBytes ?? STORED_REPLAY_MAX_CANONICAL_BYTES;
  if (!Number.isSafeInteger(maximum) || maximum < 4 || maximum > STORED_REPLAY_MAX_CANONICAL_BYTES) fail('canonical byte budget');
  record(value);
  if (Object.keys(value).length !== 3 || value.encoding !== STORED_REPLAY_ENCODING
    || !Object.hasOwn(value, 'schemas') || !Object.hasOwn(value, 'source')) fail('encoding envelope');
  array(value.schemas, limits.schemas);
  const schemas: string[][] = [], identities = new Set<string>();
  for (const schema of value.schemas) {
    array(schema, limits.fields);
    if (!schema.length || !schema.every(key) || new Set(schema).size !== schema.length) fail('schema keys');
    const identity = JSON.stringify(schema);
    if (identities.has(identity)) fail('duplicate schema');
    identities.add(identity); schemas.push(schema as string[]);
  }
  const expansion = schemas.map((schema, id) => schema.reduce((sum, name) => sum + stringBytes(name), 0)
    + schema.length - 1 - String(id).length);
  let canonicalBytes = 0;
  const add = (bytes: number) => { canonicalBytes += bytes; if (canonicalBytes > maximum) fail('canonical byte budget'); };
  const used = new Set<number>();
  // Preflight all references and their key expansion before allocating a single output sample.
  transform(value.source, row => {
    array(row, limits.fields + 1);
    const id = row[0];
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= schemas.length) fail('tuple schema reference');
    const names = schemas[id];
    if (row.length !== names.length + 1) fail('tuple arity');
    used.add(id); add(expansion[id]);
    return row;
  }, 'inspect');
  if (used.size !== schemas.length) fail('unused schema');
  // Object = tuple bytes + per-reference key expansion. This counts every unchanged field too.
  countJsonBytes(value.source, add);
  const source = transform(value.source, row => {
    const tuple = row as unknown[], names = schemas[tuple[0] as number];
    // fromEntries defines own properties; it never invokes a prototype setter.
    return Object.fromEntries(names.map((name, index) => [name, tuple[index + 1]]));
  }, options.consume ? 'consume' : 'copy');
  return source as unknown as MatchReplay | null;
}
