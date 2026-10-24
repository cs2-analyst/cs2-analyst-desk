import type { DesktopMatchReport } from '@cs2-analyst/report-contract';
import type { WinSelectGroup, WinSelectItem } from './winui-select';

/** Round 1 is the opening side evidence; later rounds cannot establish it after a side switch. */
export function playerSelectGroups(report: Pick<DesktopMatchReport, 'players' | 'timeline'>): WinSelectGroup[] {
  const openingSides = new Map(report.timeline.map(t => [t.playerId, t.rounds.find(r => r.round === 1)?.side]));
  const ct: WinSelectItem[] = [];
  const t: WinSelectItem[] = [];
  const unknown: WinSelectItem[] = [];
  for (const player of report.players) {
    const side = openingSides.get(player.id);
    const items = side === 'CT' ? ct : side === 'T' ? t : unknown;
    items.push({ value: player.id, text: player.nickname });
  }
  return [
    { label: '开局CT', items: ct },
    { label: '开局T', items: t },
    { items: unknown },
  ].filter(group => group.items.length > 0);
}
