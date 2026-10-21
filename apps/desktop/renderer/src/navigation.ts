import type { ViewId } from './sidebar';

/**
 * Page identity for the two-level shell.
 *
 * A route is either a global first-level page (个人数据 / 比赛数据) or one
 * concrete saved match. The six match views are deliberately NOT routes:
 * switching report / replay / heatmap tabs is workspace-local state and must
 * never add a history entry, otherwise "back" would have to be pressed once
 * per tab before the match list could be reached.
 */
export type GlobalSection = 'personal' | 'library';
export type Route = { kind: 'global'; section: GlobalSection } | { kind: 'match'; matchId: string };

export interface NavigationState {
  /** Oldest first; `history[index]` is the current page. */
  history: Route[];
  index: number;
}

/** Bounded so a long session cannot grow the in-memory back stack without limit. */
export const MAX_HISTORY_ENTRIES = 50;

export const globalRoute = (section: GlobalSection): Route => ({ kind: 'global', section });
export const matchRoute = (matchId: string): Route => ({ kind: 'match', matchId });

export const isSameRoute = (a: Route, b: Route): boolean =>
  a.kind === 'global' && b.kind === 'global' ? a.section === b.section
    : a.kind === 'match' && b.kind === 'match' && a.matchId === b.matchId;

/** The app boots on 比赛数据; personal data is reachable from the global rail. */
export const initialNavigation = (): NavigationState => ({ history: [globalRoute('library')], index: 0 });

export const currentRoute = (navigation: NavigationState): Route => navigation.history[navigation.index];
export const canBack = (navigation: NavigationState): boolean => navigation.index > 0;
export const canForward = (navigation: NavigationState): boolean => navigation.index < navigation.history.length - 1;

const bounded = (history: Route[], index: number): NavigationState => {
  if (history.length <= MAX_HISTORY_ENTRIES) return { history, index };
  const drop = history.length - MAX_HISTORY_ENTRIES;
  return { history: history.slice(drop), index: Math.max(0, index - drop) };
};

/**
 * Push a new page. Re-selecting the current page is a no-op (no duplicate
 * entries). Opening another match while a match is already current replaces
 * that match entry: one back must always leave the match workspace for the
 * global list, never for the previous match.
 */
export function pushRoute(navigation: NavigationState, route: Route): NavigationState {
  const current = currentRoute(navigation);
  if (isSameRoute(current, route)) return navigation;
  const kept = navigation.history.slice(0, navigation.index + 1);
  if (current.kind === 'match' && route.kind === 'match') {
    return bounded([...kept.slice(0, -1), route], kept.length - 1);
  }
  return bounded([...kept, route], kept.length);
}

export function backTarget(navigation: NavigationState): { navigation: NavigationState; route: Route } | null {
  if (!canBack(navigation)) return null;
  const index = navigation.index - 1;
  return { navigation: { history: navigation.history, index }, route: navigation.history[index] };
}

export function forwardTarget(navigation: NavigationState): { navigation: NavigationState; route: Route } | null {
  if (!canForward(navigation)) return null;
  const index = navigation.index + 1;
  return { navigation: { history: navigation.history, index }, route: navigation.history[index] };
}

/**
 * Degrade a stale/deleted match target to the global library page while
 * clearing the unusable forward branch. When the browser is already on the
 * library page only the forward entries are dropped.
 */
/** Replace the current page without leaving a back entry to the abandoned page. */
export function replaceRoute(navigation: NavigationState, route: Route): NavigationState {
  const history = navigation.history.slice(0, navigation.index);
  // Replacing a match with the page directly before it must not duplicate that page.
  if (history.length && isSameRoute(history[history.length - 1], route)) {
    return { history, index: history.length - 1 };
  }
  history.push(route);
  return { history, index: history.length - 1 };
}

export function degradeToLibrary(navigation: NavigationState): NavigationState {
  const current = currentRoute(navigation);
  if (current.kind === 'global' && current.section === 'library') {
    return { history: navigation.history.slice(0, navigation.index + 1), index: navigation.index };
  }
  // A deleted/broken match must not remain one back-step away; replace it instead of
  // appending the library page after it.
  if (current.kind === 'match') return replaceRoute(navigation, globalRoute('library'));
  return bounded([...navigation.history.slice(0, navigation.index + 1), globalRoute('library')], navigation.index + 1);
}

/** Which saved workspace view is selected, remembered per match for forward re-entry. */
export const defaultMatchView: ViewId = 'report';
export type MatchViews = Record<string, ViewId>;
export const viewForMatch = (views: MatchViews, matchId: string): ViewId => views[matchId] ?? defaultMatchView;
