import { create } from 'zustand';
import type { DesktopMatchReport, ImportPhase } from '@cs2-analyst/report-contract';
import type { ViewId } from './sidebar';
import {
  backTarget, canBack, canForward, currentRoute, degradeToLibrary, forwardTarget, initialNavigation,
  matchRoute, pushRoute, replaceRoute, viewForMatch,
} from './navigation.ts';
import type { GlobalSection, MatchViews, NavigationState, Route } from './navigation.ts';
import { defaultLibraryFilters } from './library-query.ts';
import type { LibraryFilters } from './library-query.ts';

type Status = 'idle' | ImportPhase | 'opening' | 'success' | 'error';
export type LibraryOperation = 'remove' | 'export' | 'importArchive';
const IN_FLIGHT: Status[] = ['selecting', 'parsing', 'analyzing', 'opening'];
const isInFlight = (status: Status) => IN_FLIGHT.includes(status);

export interface ReportState {
  status: Status;
  report: DesktopMatchReport | null;
  reportRevision: number;
  playerId: string;
  error: string | null;
  /**
   * Explicit "the current report's Replay/Heatmap IPC session is usable" signal.
   * It is deliberately independent of `status`: a failed open/delete/export/import
   * keeps the previous Main session alive and its controls interactive, while an
   * actual leave/release flips this to false.
   */
  sessionActive: boolean;
  navigation: NavigationState;
  matchViews: MatchViews;
  libraryRevision: number;
  /** Kept in the store so leaving a match and returning preserves search/map/sort. */
  libraryFilters: LibraryFilters;
  libraryBusy: LibraryOperation | null;
  libraryError: string | null;
  libraryNotice: string | null;
  setPhase(phase: ImportPhase): void;
  selectPlayer(id: string): void;
  selectSection(section: GlobalSection): void;
  setMatchView(view: ViewId): void;
  setLibraryFilters(patch: Partial<LibraryFilters>): void;
  back(): Promise<void>;
  forward(): Promise<void>;
  importDemo(): Promise<void>;
  importDroppedFile(file: File): Promise<void>;
  openMatch(matchId: string, navigationOverride?: NavigationState): Promise<void>;
  cancelImport(): Promise<void>;
  removeMatches(matchIds: string[]): Promise<void>;
  exportMatch(matchId: string): Promise<void>;
  importArchive(): Promise<void>;
  clearLibraryMessage(): void;
}

type Getter = () => ReportState;
type Setter = (partial: Partial<ReportState> | ((state: ReportState) => Partial<ReportState>)) => void;

const busyState = (state: ReportState) => isInFlight(state.status) || state.libraryBusy !== null;
const reportSessionId = (report: DesktopMatchReport | null) =>
  report?.replay?.sessionId ?? report?.heatmap?.sessionId ?? null;

/** Release only the exact session that belongs to the current report; stale/failed paths stay untouched. */
async function releaseSession(report: DesktopMatchReport | null): Promise<void> {
  const sessionId = reportSessionId(report);
  if (!sessionId) return;
  try { await window.cs2Analyst.session.release(sessionId); }
  catch { /* Closing/releasing is best effort; Main also retires the worker on the next activation. */ }
}

const matchIdOf = (report: DesktopMatchReport | null): string | null => report?.match?.id ?? null;

/** Leave the match workspace for a global page without leaving a stale IPC session behind. */
async function leaveMatch(get: Getter, set: Setter, navigation: NavigationState): Promise<void> {
  const report = get().report;
  set({
    report: null, sessionActive: false, status: 'idle', playerId: '', error: null,
    navigation,
  });
  await releaseSession(report);
}

/** Common tail of every successful report activation. */
function activatedReport(state: ReportState, report: DesktopMatchReport, navigation: NavigationState, resetView: boolean): Partial<ReportState> {
  const matchId = matchIdOf(report);
  const views = resetView && matchId
    ? { ...state.matchViews, [matchId]: 'report' as ViewId }
    : state.matchViews;
  return {
    status: 'success', report, reportRevision: state.reportRevision + 1, playerId: report.selectedPlayer,
    error: null, sessionActive: true, navigation, matchViews: views,
  };
}

export const useReport = create<ReportState>((set, get) => ({
  status: 'idle', report: null, reportRevision: 0, playerId: '', error: null,
  sessionActive: false,
  navigation: initialNavigation(),
  matchViews: {},
  libraryRevision: 0,
  libraryFilters: defaultLibraryFilters,
  libraryBusy: null,
  libraryError: null,
  libraryNotice: null,
  // Progress only moves an in-flight import forward; a late event must not re-enter busy after success/error.
  setPhase: phase => set(state => ['selecting', 'parsing', 'analyzing'].includes(state.status) ? {
    status: phase,
  } : {}),
  selectPlayer: id => { if (get().report?.players.some(p => p.id === id)) set({ playerId: id }); },
  selectSection: section => {
    const state = get();
    if (busyState(state)) return;
    const route: Route = { kind: 'global', section };
    const active = currentRoute(state.navigation);
    if (active.kind === 'global' && active.section === section) return;
    // Leaving a match (including the report-error fallback) must release its IPC
    // session and replace the match history node, so back cannot re-enter it.
    if (active.kind === 'match') {
      void leaveMatch(get, set, replaceRoute(state.navigation, route));
      return;
    }
    set({ navigation: pushRoute(state.navigation, route), error: null, libraryError: null, libraryNotice: null });
  },
  // Tab selection is workspace-local: it must never push a history node.
  setMatchView: view => {
    const state = get();
    const route = currentRoute(state.navigation);
    if (route.kind !== 'match') return;
    set({ matchViews: { ...state.matchViews, [route.matchId]: view } });
  },
  setLibraryFilters: patch => set(state => ({ libraryFilters: { ...state.libraryFilters, ...patch } })),
  cancelImport: async () => { await window.cs2Analyst.cancelImport(); },
  back: async () => {
    const state = get();
    if (busyState(state) || !canBack(state.navigation)) return;
    const target = backTarget(state.navigation)!;
    if (target.route.kind === 'match') {
      // Not reachable through the shipped UI (matches are only entered from the list),
      // but keep the same "fresh session" rule if a fixture builds such a stack.
      await get().openMatch(target.route.matchId, target.navigation);
      return;
    }
    if (currentRoute(state.navigation).kind === 'match') {
      await leaveMatch(get, set, target.navigation);
      return;
    }
    set({ navigation: target.navigation, error: null, libraryError: null });
  },
  forward: async () => {
    const state = get();
    if (busyState(state) || !canForward(state.navigation)) return;
    const target = forwardTarget(state.navigation)!;
    if (target.route.kind === 'global') {
      if (currentRoute(state.navigation).kind === 'match') {
        await leaveMatch(get, set, target.navigation);
        return;
      }
      set({ navigation: target.navigation, error: null, libraryError: null });
      return;
    }
    const matchId = target.route.matchId;
    set({ status: 'opening', error: null, sessionActive: false, libraryError: null });
    try {
      const result = await window.cs2Analyst.library.open(matchId);
      if (result.kind === 'success') {
        set(current => activatedReport(current, result.report, target.navigation, false));
        return;
      }
      // Deleted/invalid/missing target: drop the forward branch and land on the list.
      const current = get();
      const degraded = degradeToLibrary(current.navigation);
      const message = result.kind === 'error' ? result.message : '该比赛当前不可用。';
      set({ status: current.report ? 'success' : 'idle', error: null, libraryError: `${message} 已返回比赛数据列表。`, sessionActive: Boolean(current.report) });
      if (currentRoute(current.navigation).kind === 'match') await leaveMatch(get, set, degraded);
      else set({ navigation: degraded });
    } catch {
      const current = get();
      const degraded = degradeToLibrary(current.navigation);
      set({ status: current.report ? 'success' : 'idle', error: null, libraryError: '无法重新打开该比赛，已返回比赛数据列表。', sessionActive: Boolean(current.report) });
      if (currentRoute(current.navigation).kind === 'match') await leaveMatch(get, set, degraded);
      else set({ navigation: degraded });
    }
  },
  importDemo: async () => {
    const state = get();
    if (busyState(state)) return;
    const hadReport = Boolean(state.report);
    set({ status: 'selecting', error: null, libraryError: null, libraryNotice: null, sessionActive: false });
    try {
      const result = await window.cs2Analyst.importDemo();
      if (result.kind === 'cancelled') set({ status: hadReport ? 'success' : 'idle', sessionActive: hadReport });
      else if (result.kind === 'error') set({ status: 'error', error: result.message, sessionActive: hadReport });
      else set(current => {
        const matchId = matchIdOf(result.report);
        const navigation = matchId ? pushRoute(current.navigation, matchRoute(matchId)) : current.navigation;
        return activatedReport(current, result.report, navigation, true);
      });
    } catch {
      set({ status: 'error', error: '桌面分析连接失败。请重新选择 DEM；若仍失败，请重启应用。', sessionActive: hadReport });
    }
  },
  // Preload owns the disk path; Main progress invalidates old replay only when analysis starts.
  importDroppedFile: async file => {
    const state = get();
    if (busyState(state)) return;
    const hadReport = Boolean(state.report);
    set({ status: 'selecting', error: null, libraryError: null, libraryNotice: null, sessionActive: false });
    try {
      const result = await window.cs2Analyst.importDroppedFile(file);
      if (result.kind === 'cancelled') set({ status: hadReport ? 'success' : 'idle', sessionActive: hadReport });
      else if (result.kind === 'error') set({ status: 'error', error: result.message, sessionActive: hadReport });
      else set(current => {
        const matchId = matchIdOf(result.report);
        const navigation = matchId ? pushRoute(current.navigation, matchRoute(matchId)) : current.navigation;
        return activatedReport(current, result.report, navigation, true);
      });
    } catch {
      set({ status: 'error', error: '桌面分析连接失败。请重新选择 DEM；若仍失败，请重启应用。', sessionActive: hadReport });
    }
  },
  openMatch: async (matchId, navigationOverride) => {
    const state = get();
    if (busyState(state)) return;
    const hadReport = Boolean(state.report);
    set({ status: 'opening', error: null, libraryError: null, libraryNotice: null, sessionActive: false });
    try {
      const result = await window.cs2Analyst.library.open(matchId);
      if (result.kind === 'success') {
        set(current => {
          const navigation = navigationOverride ?? pushRoute(current.navigation, matchRoute(result.report.match?.id ?? matchId));
          return activatedReport(current, result.report, navigation, true);
        });
      } else if (result.kind === 'error') {
        set({ status: 'error', error: result.message, sessionActive: hadReport });
      } else set({ status: hadReport ? 'success' : 'idle', sessionActive: hadReport });
    } catch {
      set({ status: 'error', error: '无法打开已保存的比赛。请检查比赛库完整性或重启应用。', sessionActive: hadReport });
    }
  },
  removeMatches: async matchIds => {
    const state = get();
    if (busyState(state) || matchIds.length === 0) return;
    set({ libraryBusy: 'remove', libraryError: null, libraryNotice: null });
    let result;
    try { result = await window.cs2Analyst.library.remove([...matchIds]); }
    catch {
      set({ libraryBusy: null, libraryError: '无法删除已保存比赛。请检查比赛库是否被占用后重试。' });
      return;
    }
    if (result.kind === 'error') { set({ libraryBusy: null, libraryError: result.message }); return; }
    const removed = new Set(result.removed);
    const failed = result.failed.map(entry => entry.message).join('；');
    const activeId = matchIdOf(get().report);
    if (activeId && removed.has(activeId)) {
      const navigation = degradeToLibrary(get().navigation);
      set({
        libraryBusy: null, libraryRevision: get().libraryRevision + 1,
        libraryError: failed || null, libraryNotice: result.removed.length ? `已删除 ${result.removed.length} 场比赛。` : null,
      });
      await leaveMatch(get, set, navigation);
      return;
    }
    set({
      libraryBusy: null, libraryRevision: get().libraryRevision + 1,
      libraryError: failed || null,
      libraryNotice: result.removed.length ? `已删除 ${result.removed.length} 场比赛。` : null,
    });
  },
  exportMatch: async matchId => {
    if (busyState(get())) return;
    set({ libraryBusy: 'export', libraryError: null, libraryNotice: null });
    try {
      const result = await window.cs2Analyst.library.exportMatch(matchId);
      if (result.kind === 'success') set({ libraryBusy: null, libraryNotice: `已导出 ${result.fileName}（${result.bytes} 字节）。` });
      else if (result.kind === 'cancelled') set({ libraryBusy: null });
      else set({ libraryBusy: null, libraryError: result.message });
    } catch {
      set({ libraryBusy: null, libraryError: '无法导出该比赛。请检查保存位置权限后重试。' });
    }
  },
  importArchive: async () => {
    if (busyState(get())) return;
    set({ libraryBusy: 'importArchive', libraryError: null, libraryNotice: null });
    try {
      const result = await window.cs2Analyst.library.importArchive();
      if (result.kind === 'cancelled') { set({ libraryBusy: null }); return; }
      if (result.kind === 'error') { set({ libraryBusy: null, libraryError: result.message }); return; }
      // The archive is committed; open its fresh IPC session next. A failed open keeps
      // the current page/report intact and reports the error instead of half-entering a match.
      set({ libraryBusy: null, libraryRevision: get().libraryRevision + 1 });
      await get().openMatch(result.entry.matchId);
    } catch {
      set({ libraryBusy: null, libraryError: '无法导入 .cs2a。请检查文件是否完整、版本是否兼容后重试。' });
    }
  },
  clearLibraryMessage: () => set({ libraryError: null, libraryNotice: null }),
}));

/** Derived selectors shared by the shell and tests. */
export const matchSessionActive = (state: ReportState): boolean => Boolean(state.report && state.sessionActive);
export const currentSection = (state: ReportState): GlobalSection | null => {
  const route = currentRoute(state.navigation);
  return route.kind === 'global' ? route.section : null;
};
export const activeMatchId = (state: ReportState): string | null => {
  const route = currentRoute(state.navigation);
  return route.kind === 'match' ? route.matchId : null;
};
export const activeMatchView = (state: ReportState): ViewId => {
  const route = currentRoute(state.navigation);
  return route.kind === 'match' ? viewForMatch(state.matchViews, route.matchId) : 'report';
};
export const navigationCanBack = (state: ReportState): boolean => canBack(state.navigation) && !busyState(state);
export const navigationCanForward = (state: ReportState): boolean => canForward(state.navigation) && !busyState(state);