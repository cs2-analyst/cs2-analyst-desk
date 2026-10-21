/** JSON presentation contracts. The algorithms stay in Analytics; Renderer only formats. */
export interface DesktopPlayerRating {
  value: number | null;
  algorithm: string;
  status: 'available' | 'unavailable';
  reason: string | null;
}
export interface DesktopPlayerHighlight {
  type: 'clutch' | 'multi-kill' | 'opening' | 'trade' | 'assists' | 'headshot' | 'flash' | 'utility';
  label: string;
  color: 'gold' | 'cyan' | 'blue' | 'pink' | 'green' | 'yellow' | 'purple' | 'orange';
  tooltip: string;
  evidence: Record<string, number>;
}
export interface DesktopPlayerPerformance {
  rating: DesktopPlayerRating;
  highlights: DesktopPlayerHighlight[];
}
export interface LibraryPlayerSummary {
  playerId: string;
  kills: number | null;
  deaths: number | null;
  assists: number | null;
  adr: number | null;
  kastPercentage: number | null;
  outcome: 'win' | 'loss' | 'draw' | 'unknown';
  performance: DesktopPlayerPerformance;
}
