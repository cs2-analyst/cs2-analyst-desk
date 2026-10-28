/** Explicit local-only prefix evidence API; native bytes and bindings stay inside the provider. */
export { convertNativePrefix } from './providers/prefix-match.js';
export { planPrefixSpatialTicks } from './providers/prefix-ticks.js';
export { joinPrefixNativeRows } from './providers/prefix-rows.js';
export { boundLocalEvidenceInput } from './providers/prefix-input.js';
export type { NativePrefixMatch } from './providers/prefix-match.js';
export type { PrefixTickPlan } from './providers/prefix-ticks.js';
export type { PrefixNativeRows, PrefixRowProvenance } from './providers/prefix-rows.js';
