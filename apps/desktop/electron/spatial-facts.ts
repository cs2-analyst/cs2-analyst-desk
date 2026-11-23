import { calculateDemDistance, buildPrefixReviewFragment, resolvePrefixRoster } from '@cs2-analyst/analytics';
import { boundLocalEvidenceInput, convertNativePrefix, joinPrefixNativeRows } from '@cs2-analyst/dem-parser/local-evidence';
import type { LocalDemEvidenceAccess } from '@cs2-analyst/dem-parser';
import type { PrefixTickPlan } from '@cs2-analyst/dem-parser/local-evidence';
import type { DemPositionEvidenceV1 } from '@cs2-analyst/match-model';
import { isDesktopSpatialFacts } from '@cs2-analyst/report-contract';
import type { DesktopSpatialFactCard, DesktopSpatialFactsV1 } from '@cs2-analyst/report-contract';

type Raw = Record<string, unknown>;
type EventProbe = { round: number; eventTick: number; sampleTick: number;
  eventIndex: number; killer: string; victim: string; killerSide: 'CT' | 'T'; victimSide: 'CT' | 'T' };
type FormationProbe = { round: number; eventTick: number; startTick: number;
  roster: Extract<ReturnType<typeof resolvePrefixRoster>, { status: 'known' }> };
const object = (value: unknown): value is Raw => !!value && typeof value === 'object' && !Array.isArray(value);
const tick = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const id = (value: unknown): value is string => typeof value === 'string' && /^[1-9]\d*$/.test(value);
const side = (value: unknown): value is 'CT' | 'T' => value === 'CT' || value === 'T';
const maxTicks = 256, maxEventProbes = 32, maxEachCard = 16;

export function unavailableDesktopSpatialFacts(matchId: string,
  reason: 'no-valid-facts' | 'extraction-failed' = 'extraction-failed'): DesktopSpatialFactsV1 {
  return { schemaVersion: 1, methodVersion: 'dem-native-spatial-facts-v1', matchId,
    informationScope: 'server-global', status: 'unavailable', reason,
    coverage: { deathTicks: 0, inspectedTicks: 0, eventProbes: 0, eventCards: 0,
      formationProbes: 0, formationCards: 0, withheld: 0, truncated: false }, cards: [] };
}

function plan(cutTick: number, ticks: number[]): PrefixTickPlan {
  const sorted = [...new Set(ticks)].sort((a, b) => a - b);
  return { schemaVersion: 'dem-prefix-ticks-v1', cutTick, tickBudget: 0, contextOffsetTicks: 0,
    coreTicks: sorted, optionalTicks: [], omittedOptionalTicks: [], requestedTicks: sorted,
    excludedEvents: [], contextOmissions: [] };
}

function query(access: LocalDemEvidenceAccess, ticks: number[], ids: string[]): unknown[] {
  const uniqueTicks = [...new Set(ticks)].sort((a, b) => a - b);
  const uniqueIds = [...new Set(ids)].sort();
  const rows: unknown[] = [];
  for (let i = 0; i < uniqueTicks.length; i += 64) for (let j = 0; j < uniqueIds.length; j += 10) {
    const result = access.queryExactTicks(uniqueTicks.slice(i, i + 64), uniqueIds.slice(j, j + 10));
    if (!Array.isArray(result)) throw new Error('invalid-exact-row-result');
    rows.push(...result);
  }
  return rows;
}

/** Local post-match composition. It never uses full-match optional spatial sampling. */
export async function buildDesktopSpatialFacts(access: LocalDemEvidenceAccess): Promise<DesktopSpatialFactsV1> {
  const input = access.rawInput;
  if (!object(input) || typeof input.id !== 'string' || !/^[a-f0-9]{64}$/.test(input.id)) return unavailableDesktopSpatialFacts('');
  const matchId = input.id;
  try {
    const raw = boundLocalEvidenceInput(input), mapName = raw.header.map_name;
    const groups = new Map<number, Raw[]>();
    for (const event of raw.events) {
      if (!object(event) || !tick(event.tick)) throw new Error('unlocatable-event');
      if (event.event_name !== 'player_death' || event.is_warmup_period === true || event.tick === 0) continue;
      const group = groups.get(event.tick) ?? [];group.push(event);groups.set(event.tick, group);
    }
    const deathTicks = [...groups.keys()].sort((a, b) => a - b);
    const inspected = deathTicks.slice(0, maxTicks);
    const roundStarts = [...new Set(raw.events.filter(event => object(event)
      && event.event_name === 'round_start' && event.is_warmup_period !== true && tick(event.tick))
      .map(event => (event as Raw).tick as number))].sort((a, b) => a - b);
    const knownIds = new Set(access.playerIds.filter(id));
    const events: EventProbe[] = [], formations: FormationProbe[] = [];
    let withheld = 0, formationProbes = 0, truncated = raw.truncated || deathTicks.length > inspected.length;
    let nextStart = 0, lastStart: number | null = null, deathsSinceStart = 0;
    for (const eventTick of inspected) {
      if (eventTick === Number.MAX_SAFE_INTEGER) { withheld++;continue; }
      const deaths = groups.get(eventTick)!;
      while (nextStart < roundStarts.length && roundStarts[nextStart] <= eventTick) {
        if (lastStart !== roundStarts[nextStart]) { lastStart = roundStarts[nextStart];deathsSinceStart = 0; }
        nextStart++;
      }
      if (lastStart !== null) deathsSinceStart += deaths.length;
      // A standard 5v5 1v1 cannot form before eight deaths since the latest
      // round start. Missing starts fall back to the full prefix check.
      const needsFormation = lastStart === null || deathsSinceStart >= 8;
      const death = deaths.length === 1 ? deaths[0] : null;
      const eligibleIdentity = !!death && id(death.attacker_steamid) && id(death.user_steamid)
        && death.attacker_steamid !== death.user_steamid
        && knownIds.has(death.attacker_steamid) && knownIds.has(death.user_steamid);
      const needsEvent = events.length < maxEventProbes && eligibleIdentity;
      if (events.length >= maxEventProbes) truncated = true;
      else if (!eligibleIdentity && events.length < maxEventProbes) withheld++;
      if (!needsEvent && !needsFormation) continue;
      const prefix = convertNativePrefix(raw, eventTick + 1);
      const rounds = prefix.match.rounds.filter(round => round.events.some(event =>
        event.type === 'kill' && event.tick === eventTick));
      if (rounds.length !== 1 || deaths.some(event => !tick(event.total_rounds_played)
        || (event.total_rounds_played as number) + 1 !== rounds[0].number)) { withheld++;continue; }
      const round = rounds[0];
      if (!tick(round.startTick) || !tick(round.freezeEndTick) || round.startTick > round.freezeEndTick
        || round.freezeEndTick > eventTick - 1
        || (round.endTick !== undefined && (!tick(round.endTick) || eventTick > round.endTick))
        || prefix.match.rounds.some(other => other !== round && tick(other.startTick)
          && other.startTick >= round.startTick! && other.startTick <= eventTick)) { withheld++;continue; }
      if (needsEvent && death) {
        if (id(death.attacker_steamid) && id(death.user_steamid)) {
          const matches = round.events.flatMap((event, index) => event.type === 'kill'
            && event.tick === eventTick && event.killer === death.attacker_steamid
            && event.victim === death.user_steamid ? [{ event, index }] : []);
          if (matches.length === 1 && side(matches[0].event.killerSide)
            && side(matches[0].event.victimSide)
            && matches[0].event.killerSide !== matches[0].event.victimSide)
            events.push({ round: round.number, eventTick, sampleTick: eventTick - 1,
              eventIndex: matches[0].index, killer: death.attacker_steamid, victim: death.user_steamid,
              killerSide: matches[0].event.killerSide, victimSide: matches[0].event.victimSide });
          else withheld++;
        } else withheld++;
      }
      if (needsFormation) formationProbes++;
      const roster = needsFormation ? resolvePrefixRoster(prefix, round.number) : null;
      if (roster?.status === 'unknown') withheld++;
      if (roster?.status === 'known' && roster.eligibleOneVsOne && roster.oneVsOneFormedAtTick === eventTick) {
        let startTick = roster.baselineTick;
        for (const event of round.events) if (event.tick >= roster.baselineTick && event.tick < eventTick)
          startTick = Math.max(startTick, event.tick);
        if (startTick < eventTick && roster.survivors.every(player => knownIds.has(player.playerId))) {
          if (formations.length < maxEachCard) formations.push({ round: round.number,
            eventTick, startTick, roster });
          else truncated = true;
        } else withheld++;
      }
    }
    const provenance = { matchId, demoSha256: matchId, mapName, parserVersion: access.parserVersion };
    const cards: DesktopSpatialFactCard[] = [];
    let eventRows: unknown[] = [], formationRows: unknown[] = [];
    let eventQueryFailed = false, formationQueryFailed = false;
    try {
      if (events.length || formations.length) {
        const shared = query(access, [...events.map(item => item.sampleTick),
          ...formations.flatMap(item => [item.startTick, item.eventTick])],
        [...events.flatMap(item => [item.killer, item.victim]),
          ...formations.flatMap(item => item.roster.survivors.map(player => player.playerId))]);
        eventRows = shared;formationRows = shared;
      }
    } catch {
      // Separate retries preserve one fact class if the combined native query fails.
      try { if (events.length) eventRows = query(access, events.map(item => item.sampleTick),
        events.flatMap(item => [item.killer, item.victim])); } catch { eventQueryFailed = true; }
      try { if (formations.length) formationRows = query(access,
        formations.flatMap(item => [item.startTick, item.eventTick]),
        formations.flatMap(item => item.roster.survivors.map(player => player.playerId))); }
      catch { formationQueryFailed = true; }
    }
    if (events.length && (eventQueryFailed || !eventRows.length)) withheld += events.length;
    for (const item of events) {
      if (!eventRows.length) break;
      const rows = joinPrefixNativeRows(plan(item.eventTick + 1, [item.sampleTick]),
        [item.killer, item.victim], eventRows, provenance);
      const picked = [item.killer, item.victim].map(playerId =>
        rows.observations.find(row => row.playerId === playerId && row.requestedTick === item.sampleTick));
      if (picked.some((row, index) => !row || row.actualTick !== item.sampleTick || row.alive !== true
        || row.coverage.status !== 'complete' || !row.position || !row.evidenceRef
        || row.side !== (index === 0 ? item.killerSide : item.victimSide))) { withheld++;continue; }
      const points = picked.map(row => ({ schemaVersion: 'dem-position-v1' as const,
        matchId, demoSha256: matchId, mapName, parserVersion: access.parserVersion,
        coordinateSpace: { system: 'dem-server-xyz' as const, unit: 'DEM-world-unit' as const,
          normalization: 'native-unmodified-v1' as const }, actualTick: item.sampleTick,
        evidenceRef: row!.evidenceRef!, playerId: row!.playerId, position: row!.position })) as
        [DemPositionEvidenceV1, DemPositionEvidenceV1];
      const xy = calculateDemDistance(points[0], points[1], 'horizontal');
      const xyz = calculateDemDistance(points[0], points[1], 'three-dimensional');
      if (!xy.valid || !xyz.valid) { withheld++;continue; }
      if (cards.filter(card => card.kind === 'event-prestate').length >= maxEachCard) { truncated = true;continue; }
      cards.push({ kind: 'event-prestate', round: item.round, eventTick: item.eventTick,
        sampleTick: item.sampleTick, eventIndex: item.eventIndex, retrospectiveSelection: true,
        participants: [
          { role: 'killer', playerId: item.killer, side: item.killerSide,
            position: { ...picked[0]!.position! }, rowRef: picked[0]!.evidenceRef! },
          { role: 'victim', playerId: item.victim, side: item.victimSide,
            position: { ...picked[1]!.position! }, rowRef: picked[1]!.evidenceRef! },
        ], horizontal: xy.value, threeDimensional: xyz.value, unit: 'DEM-world-unit' });
    }
    if (formations.length && (formationQueryFailed || !formationRows.length)) withheld += formations.length;
    for (const item of formations) {
      if (!formationRows.length) break;
      const rows = joinPrefixNativeRows(plan(item.eventTick + 1, [item.startTick, item.eventTick]),
        item.roster.survivors.map(player => player.playerId), formationRows, provenance);
      const prefix = convertNativePrefix(raw, item.eventTick + 1);
      const fragment = await buildPrefixReviewFragment(prefix, item.roster, rows, item.eventTick);
      if (fragment.status !== 'eligible-for-fact-review'
        || fragment.selection.formationEventIndices.length > 8) { withheld++;continue; }
      cards.push({ kind: 'one-vs-one-formation', round: item.round, eventTick: item.eventTick,
        startTick: fragment.startTick, eventIndices: [...fragment.selection.formationEventIndices],
        retrospectiveSelection: true, participants: fragment.participants.map(player => ({
          playerId: player.playerId, side: player.side, startRef: player.startEvidenceRef,
          endRef: player.endEvidenceRef,
          startPosition: { ...rows.observations.find(row => row.playerId === player.playerId
            && row.actualTick === item.startTick)!.position! },
          endPosition: { ...rows.observations.find(row => row.playerId === player.playerId
            && row.actualTick === item.eventTick)!.position! },
          horizontalDisplacement: player.horizontalDisplacement,
          threeDimensionalDisplacement: player.threeDimensionalDisplacement })),
        separation: { startHorizontal: fragment.separation.startHorizontal,
          startThreeDimensional: fragment.separation.startThreeDimensional,
          formationHorizontal: fragment.separation.formationHorizontal,
          formationThreeDimensional: fragment.separation.formationThreeDimensional,
          horizontalChange: fragment.separation.horizontalChange,
          threeDimensionalChange: fragment.separation.threeDimensionalChange },
        interiorNotEvaluatedTicks: fragment.coverage.interiorNotEvaluatedTicks,
        unit: 'DEM-world-unit' });
    }
    cards.sort((a, b) => a.eventTick - b.eventTick || a.kind.localeCompare(b.kind));
    const eventCards = cards.filter(card => card.kind === 'event-prestate').length;
    const formationCards = cards.length - eventCards;
    const result: DesktopSpatialFactsV1 = { schemaVersion: 1, methodVersion: 'dem-native-spatial-facts-v1',
      matchId, informationScope: 'server-global', status: cards.length ? withheld || truncated ? 'partial' : 'available' : 'unavailable',
      reason: cards.length ? null : eventQueryFailed || formationQueryFailed ? 'extraction-failed' : 'no-valid-facts', coverage: { deathTicks: deathTicks.length,
        inspectedTicks: inspected.length, eventProbes: events.length, eventCards,
        formationProbes, formationCards, withheld, truncated }, cards };
    return isDesktopSpatialFacts(result, matchId, access.playerIds) ? result : unavailableDesktopSpatialFacts(matchId);
  } catch { return unavailableDesktopSpatialFacts(matchId); }
}
