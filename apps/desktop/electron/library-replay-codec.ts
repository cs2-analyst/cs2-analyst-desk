import type { MatchReplay } from '@cs2-analyst/match-model';

/** Storage-only encoding. Domain objects and the UI replay contract stay unchanged. */
export const STORED_REPLAY_ENCODING = 'replay-tuples-v1' as const;
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
function transform(source: unknown, sample: (value: unknown) => unknown): ObjectValue | null {
  if (source === null) return null;
  record(source);
  if (source.schemaVersion !== 1) fail('source schema');
  array(source.players, limits.players);
  if (source.players.some(player => typeof player !== 'string')) fail('player identity');
  array(source.rounds, limits.rounds);
  let frames = 0, samples = 0;
  const rounds = source.rounds.map(round => {
    record(round); array(round.frames, limits.frames);
    frames += round.frames.length;
    if (frames > limits.frames) fail('frame budget');
    return { ...round, frames: round.frames.map(frame => {
      record(frame); array(frame.players, limits.players);
      samples += frame.players.length;
      if (samples > limits.samples) fail('sample budget');
      return { ...frame, players: frame.players.map(sample) };
    }) };
  });
  return { ...source, rounds };
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

/** A malformed tuple is rejected before building a domain object; unknown codecs are never guessed. */
export function decodeStoredReplay(value: unknown): MatchReplay | null {
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
  const used = new Set<number>();
  const source = transform(value.source, row => {
    array(row, limits.fields + 1);
    const id = row[0];
    if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0 || id >= schemas.length) fail('tuple schema reference');
    const names = schemas[id];
    if (row.length !== names.length + 1) fail('tuple arity');
    const entries = names.map((name, index) => {
      storedValue(row[index + 1]); return [name, row[index + 1]];
    });
    used.add(id);
    // fromEntries defines own properties; it never invokes a prototype setter.
    return Object.fromEntries(entries);
  });
  if (used.size !== schemas.length) fail('unused schema');
  return source as unknown as MatchReplay | null;
}
