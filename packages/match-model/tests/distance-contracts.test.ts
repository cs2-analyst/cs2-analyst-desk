import type {
  DemDistanceResultV1, DemPositionEvidenceV1, MapResourceRecordV1, Match, SpatialSample,
} from "../src/index.js";

function consume(result: DemDistanceResultV1) {
  if (result.valid) {
    const value: number = result.value;
    const tick: number = result.actualTick;
    const server: "server-global" = result.informationScope;
    return [value, tick, server];
  }
  const value: null = result.value;
  return [value, result.reason];
}
// @ts-expect-error New evidence is never silently persisted in old Match contracts.
type Injected = Match["distance"];
// @ts-expect-error Old SpatialSample is not silently assigned new provenance.
type OldProvenance = SpatialSample["demoSha256"];
// @ts-expect-error Unknown/meters units cannot be represented as valid native DEM evidence.
const wrongUnit: DemPositionEvidenceV1["coordinateSpace"]["unit"] = "meters";
// @ts-expect-error No inferred player knowledge field exists.
type Knowledge = DemDistanceResultV1["playerKnown"];
// @ts-expect-error Records cannot silently omit their schema version.
const unversioned: MapResourceRecordV1 = { identity: {}, capabilities: {} };
void [consume, wrongUnit, unversioned];
