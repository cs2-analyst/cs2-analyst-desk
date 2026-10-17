/** Replay display names only. Native/domain/DTO identifiers remain unchanged. */
export const replayUtilityNames = {
  smoke: '烟雾弹', flashbang: '闪光弹', hegrenade: '手雷', molotov: '燃烧瓶',
  incendiary: '燃烧弹', decoy: '诱饵弹', fire: '火焰',
} as const;
export type ReplayUtilityName = keyof typeof replayUtilityNames;
export const replayUtilityLabel = (kind: ReplayUtilityName): string => replayUtilityNames[kind];

/** Only exact native grenade weapon identifiers qualify as observed release events. */
export function replayThrownUtility(weapon: string): Exclude<ReplayUtilityName, 'fire'> | null {
  switch (weapon) {
    case 'weapon_smokegrenade': return 'smoke';
    case 'weapon_flashbang': return 'flashbang';
    case 'weapon_hegrenade': return 'hegrenade';
    case 'weapon_molotov': return 'molotov';
    case 'weapon_incgrenade': return 'incendiary';
    case 'weapon_decoy': return 'decoy';
    default: return null;
  }
}
