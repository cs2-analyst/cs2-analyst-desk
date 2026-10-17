// Reuse the unchanged user-extracted Valve Panorama icons and their provenance manifest.
import smoke from './assets/killfeed/weapons/smokegrenade.svg';
import flashbang from './assets/killfeed/weapons/flashbang.svg';
import hegrenade from './assets/killfeed/weapons/hegrenade.svg';
import molotov from './assets/killfeed/weapons/molotov.svg';
import incendiary from './assets/killfeed/weapons/incgrenade.svg';
import decoy from './assets/killfeed/weapons/decoy.svg';
import fire from './assets/killfeed/weapons/inferno.svg';
import fireAtlas from './assets/replay-effects/fire-atlas.png';

export const replayEffectAssetUrls = { smoke, flashbang, hegrenade, molotov, incendiary, decoy, fire, fireAtlas };
export type ReplayEffectImages = Partial<Record<keyof typeof replayEffectAssetUrls, HTMLImageElement>>;
