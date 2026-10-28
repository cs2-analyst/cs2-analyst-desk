/** Bounded local server facts. Distances do not establish visibility or reachability. */
export interface DesktopSpatialFactsV1 {
  schemaVersion: 1;
  methodVersion: 'dem-native-spatial-facts-v1';
  matchId: string;
  informationScope: 'server-global';
  status: 'available' | 'partial' | 'unavailable';
  reason: 'no-valid-facts' | 'extraction-failed' | null;
  coverage: { deathTicks: number; inspectedTicks: number; eventProbes: number;
    eventCards: number; formationProbes: number; formationCards: number;
    withheld: number; truncated: boolean };
  cards: DesktopSpatialFactCard[];
}

export type DesktopSpatialFactCard =
  /** Event indices locate records in the reconstructed prefix; they do not order same-tick events. */
  | { kind: 'event-prestate'; round: number; eventTick: number; sampleTick: number;
      eventIndex: number; retrospectiveSelection: true;
      participants: [{ role: 'killer'; playerId: string; side: 'CT' | 'T';
        position: { x: number; y: number; z: number }; rowRef: string },
      { role: 'victim'; playerId: string; side: 'CT' | 'T';
        position: { x: number; y: number; z: number }; rowRef: string }];
      horizontal: number; threeDimensional: number; unit: 'DEM-world-unit' }
  | { kind: 'one-vs-one-formation'; round: number; eventTick: number; startTick: number;
      eventIndices: number[]; retrospectiveSelection: true;
      participants: { playerId: string; side: 'CT' | 'T'; startRef: string; endRef: string;
        startPosition: { x: number; y: number; z: number }; endPosition: { x: number; y: number; z: number };
        horizontalDisplacement: number; threeDimensionalDisplacement: number }[];
      separation: { startHorizontal: number; startThreeDimensional: number;
        formationHorizontal: number; formationThreeDimensional: number;
        horizontalChange: number; threeDimensionalChange: number };
      interiorNotEvaluatedTicks: number; unit: 'DEM-world-unit' };

const plain = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object'
  && !Array.isArray(v) && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const keys = (v: Record<string, unknown>, expected: string[]) =>
  JSON.stringify(Object.keys(v).sort()) === JSON.stringify([...expected].sort());
const integer = (v: unknown, min = 0, max = Number.MAX_SAFE_INTEGER): v is number =>
  Number.isSafeInteger(v) && (v as number) >= min && (v as number) <= max;
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const distance = (v: unknown): v is number => finite(v) && v >= 0;
const rowRef = (v: unknown): v is string => typeof v === 'string' && /^native-exact:[a-f0-9]{64}$/.test(v);
const side = (v: unknown): v is 'CT' | 'T' => v === 'CT' || v === 'T';

/** Validate untrusted archive data before it reaches the Renderer. */
export function isDesktopSpatialFacts(value: unknown, matchId: string, playerIds: readonly string[]): value is DesktopSpatialFactsV1 {
  if (!plain(value) || !keys(value, ['schemaVersion', 'methodVersion', 'matchId', 'informationScope',
    'status', 'reason', 'coverage', 'cards']) || value.schemaVersion !== 1
    || value.methodVersion !== 'dem-native-spatial-facts-v1' || value.matchId !== matchId
    || value.informationScope !== 'server-global' || !['available', 'partial', 'unavailable'].includes(String(value.status))
    || ![null, 'no-valid-facts', 'extraction-failed'].includes(value.reason as null | string)
    || !plain(value.coverage) || !keys(value.coverage, ['deathTicks', 'inspectedTicks', 'eventProbes',
      'eventCards', 'formationProbes', 'formationCards', 'withheld', 'truncated'])
    || !Array.isArray(value.cards) || value.cards.length > 32) return false;
  const c = value.coverage;
  if (!['deathTicks', 'inspectedTicks', 'eventProbes', 'eventCards', 'formationProbes', 'formationCards', 'withheld']
    .every(key => integer(c[key], 0, 100000)) || typeof c.truncated !== 'boolean'
    || (c.inspectedTicks as number) > (c.deathTicks as number)
    || (c.eventProbes as number) > (c.inspectedTicks as number)
    || (c.formationProbes as number) > (c.inspectedTicks as number)
    || (c.eventCards as number) > (c.eventProbes as number)
    || (c.formationCards as number) > (c.formationProbes as number)) return false;
  const knownPlayers = new Set(playerIds);
  let events = 0, formations = 0;
  for (const card of value.cards) {
    if (!plain(card) || !integer(card.round, 1, 1000) || !integer(card.eventTick, 1)
      || card.retrospectiveSelection !== true || card.unit !== 'DEM-world-unit') return false;
    if (card.kind === 'event-prestate') {
      events++;
      if (!keys(card, ['kind', 'round', 'eventTick', 'sampleTick', 'eventIndex', 'retrospectiveSelection',
        'participants', 'horizontal', 'threeDimensional', 'unit'])
        || !integer(card.sampleTick) || card.sampleTick !== card.eventTick - 1
        || !integer(card.eventIndex, 0, 100000) || !Array.isArray(card.participants)
        || card.participants.length !== 2 || !distance(card.horizontal) || !distance(card.threeDimensional)
        || card.threeDimensional < card.horizontal) return false;
      for (const [index, role] of (['killer', 'victim'] as const).entries()) {
        const p = card.participants[index];
        if (!plain(p) || !keys(p, ['role', 'playerId', 'side', 'position', 'rowRef'])
          || p.role !== role || typeof p.playerId !== 'string' || !knownPlayers.has(p.playerId)
          || !side(p.side) || !rowRef(p.rowRef) || !plain(p.position)
          || !keys(p.position, ['x', 'y', 'z']) || ![p.position.x, p.position.y, p.position.z].every(finite)) return false;
      }
      const [a, b] = card.participants as { playerId: string; side: string; position: { x: number; y: number; z: number } }[];
      if (a.playerId === b.playerId || a.side === b.side) return false;
      const xy = Math.hypot(a.position.x - b.position.x, a.position.y - b.position.y);
      if (card.horizontal !== xy || card.threeDimensional !== Math.hypot(xy, Math.abs(a.position.z - b.position.z))) return false;
    } else if (card.kind === 'one-vs-one-formation') {
      formations++;
      if (!keys(card, ['kind', 'round', 'eventTick', 'startTick', 'eventIndices', 'retrospectiveSelection',
        'participants', 'separation', 'interiorNotEvaluatedTicks', 'unit'])
        || !integer(card.startTick) || card.startTick >= card.eventTick
        || card.interiorNotEvaluatedTicks !== card.eventTick - card.startTick - 1
        || !Array.isArray(card.eventIndices) || card.eventIndices.length < 1 || card.eventIndices.length > 8
        || card.eventIndices.some(i => !integer(i, 0, 100000))
        || new Set(card.eventIndices).size !== card.eventIndices.length
        || !Array.isArray(card.participants) || card.participants.length !== 2
        || !plain(card.separation) || !keys(card.separation, ['startHorizontal', 'startThreeDimensional',
          'formationHorizontal', 'formationThreeDimensional', 'horizontalChange', 'threeDimensionalChange'])) return false;
      for (const p of card.participants) if (!plain(p)
        || !keys(p, ['playerId', 'side', 'startRef', 'endRef', 'startPosition', 'endPosition',
          'horizontalDisplacement', 'threeDimensionalDisplacement'])
        || typeof p.playerId !== 'string' || !knownPlayers.has(p.playerId) || !side(p.side)
        || !rowRef(p.startRef) || !rowRef(p.endRef) || !plain(p.startPosition) || !plain(p.endPosition)
        || !keys(p.startPosition, ['x', 'y', 'z']) || !keys(p.endPosition, ['x', 'y', 'z'])
        || ![p.startPosition.x, p.startPosition.y, p.startPosition.z,
          p.endPosition.x, p.endPosition.y, p.endPosition.z].every(finite)
        || !distance(p.horizontalDisplacement) || !distance(p.threeDimensionalDisplacement)
        || p.threeDimensionalDisplacement < p.horizontalDisplacement) return false;
      const [a, b] = card.participants as { playerId: string; side: string;
        startPosition: { x: number; y: number; z: number }; endPosition: { x: number; y: number; z: number };
        horizontalDisplacement: number; threeDimensionalDisplacement: number }[];
      const s = card.separation;
      if (a.playerId === b.playerId || a.side === b.side || !distance(s.startHorizontal)
        || !distance(s.startThreeDimensional) || s.startThreeDimensional < s.startHorizontal
        || !distance(s.formationHorizontal) || !distance(s.formationThreeDimensional)
        || s.formationThreeDimensional < s.formationHorizontal
        || !finite(s.horizontalChange) || !finite(s.threeDimensionalChange)
        || s.horizontalChange !== s.formationHorizontal - s.startHorizontal
        || s.threeDimensionalChange !== s.formationThreeDimensional - s.startThreeDimensional) return false;
      for (const p of [a, b]) {
        const dx = p.endPosition.x - p.startPosition.x, dy = p.endPosition.y - p.startPosition.y;
        const dz = p.endPosition.z - p.startPosition.z;
        if (p.horizontalDisplacement !== Math.hypot(dx, dy)
          || p.threeDimensionalDisplacement !== Math.hypot(dx, dy, dz)) return false;
      }
      const pair = (x: typeof a.startPosition, y: typeof a.startPosition) => {
        const xy = Math.hypot(x.x - y.x, x.y - y.y);
        return { xy, xyz: Math.hypot(xy, Math.abs(x.z - y.z)) };
      };
      const start = pair(a.startPosition, b.startPosition), end = pair(a.endPosition, b.endPosition);
      if (s.startHorizontal !== start.xy || s.startThreeDimensional !== start.xyz
        || s.formationHorizontal !== end.xy || s.formationThreeDimensional !== end.xyz) return false;
    } else return false;
  }
  return c.eventCards === events && c.formationCards === formations
    && ((value.cards.length === 0 && value.status === 'unavailable' && value.reason !== null)
      || (value.cards.length > 0 && value.reason === null
        && value.status === ((c.withheld as number) > 0 || c.truncated ? 'partial' : 'available')));
}
