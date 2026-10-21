import { create } from 'zustand';
import type { DesktopMatchReport, ImportPhase } from '@cs2-analyst/report-contract';

type Status = 'idle' | ImportPhase | 'opening' | 'success' | 'error';
interface ReportState {
  status: Status;
  report: DesktopMatchReport | null;
  reportRevision: number;
  playerId: string;
  error: string | null;
  setPhase(phase: ImportPhase): void;
  selectPlayer(id: string): void;
  importDemo(): Promise<void>;
  importDroppedFile(file: File): Promise<void>;
  openMatch(matchId: string): Promise<void>;
  cancelImport(): Promise<void>;
}
export const useReport = create<ReportState>((set, get) => ({
  status: 'idle', report: null, reportRevision: 0, playerId: '', error: null,
  // Progress only moves an in-flight import forward; a late event must not re-enter busy after success/error.
  setPhase: phase => set(state => ['selecting', 'parsing', 'analyzing'].includes(state.status) ? {
    status: phase,
  } : {}),
  selectPlayer: id => { if (get().report?.players.some(p => p.id === id)) set({ playerId: id }); },
  cancelImport: async () => { await window.cs2Analyst.cancelImport(); },
  importDemo: async () => {
    if (['selecting', 'parsing', 'analyzing', 'opening'].includes(get().status)) return;
    set({ status: 'selecting', error: null });
    try {
      const result = await window.cs2Analyst.importDemo();
      if (result.kind === 'cancelled') set({ status: get().report ? 'success' : 'idle' });
      else if (result.kind === 'error') set({ status: 'error', error: result.message });
      else set(state => ({ status: 'success', report: result.report, reportRevision: state.reportRevision + 1, playerId: result.report.selectedPlayer }));
    } catch {
      set({ status: 'error', error: '桌面分析连接失败。请重新选择 DEM；若仍失败，请重启应用。' });
    }
  },
  // Preload owns the disk path; Main progress invalidates old replay only when analysis starts.
  importDroppedFile: async file => {
    if (['selecting', 'parsing', 'analyzing', 'opening'].includes(get().status)) return;
    set({ status: 'selecting', error: null });
    try {
      const result = await window.cs2Analyst.importDroppedFile(file);
      if (result.kind === 'cancelled') set({ status: get().report ? 'success' : 'idle' });
      else if (result.kind === 'error') set({ status: 'error', error: result.message });
      else set(state => ({ status: 'success', report: result.report, reportRevision: state.reportRevision + 1, playerId: result.report.selectedPlayer }));
    } catch {
      set({ status: 'error', error: '桌面分析连接失败。请重新选择 DEM；若仍失败，请重启应用。' });
    }
  },
  openMatch: async matchId => {
    if (['selecting', 'parsing', 'analyzing', 'opening'].includes(get().status)) return;
    set({ status: 'opening', error: null });
    try {
      const result = await window.cs2Analyst.library.open(matchId);
      if (result.kind === 'success') set(state => ({
        status: 'success', report: result.report, reportRevision: state.reportRevision + 1, playerId: result.report.selectedPlayer,
      }));
      else if (result.kind === 'error') set({ status: 'error', error: result.message });
      else set({ status: get().report ? 'success' : 'idle' });
    } catch {
      set({ status: 'error', error: '无法打开已保存的比赛。请检查比赛库完整性或重启应用。' });
    }
  },
}));
