import { useEffect, useState } from 'react';
import { Body1, Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle,
  MessageBar, MessageBarBody, ProgressBar, makeStyles, tokens } from '@fluentui/react-components';
import { useReport } from './store';
import { WinSelect } from './winui-select';
import { useElapsedSeconds, useLoadingFeedback } from './loading-ui';
import { palette } from './theme';

const useStyles = makeStyles({
  backdrop: { position: 'fixed', top: '40px', right: 0, bottom: 0, left: 0, backgroundColor: 'rgba(0, 0, 0, 0.55)', zIndex: 900 },
  surface: { width: 'min(560px, calc(100vw - 48px))', maxHeight: 'calc(100vh - 96px)' },
  content: { display: 'flex', flexDirection: 'column', gap: '20px', paddingTop: '8px', paddingBottom: '12px' },
  file: { display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: tokens.colorNeutralForeground3 },
  steps: { display: 'flex', gap: '12px', margin: 0, padding: 0, listStyleType: 'none', flexWrap: 'wrap' },
  step: { display: 'flex', gap: '8px', alignItems: 'center', color: tokens.colorNeutralForeground3 },
  current: { color: palette.currentPlayer },
  dot: { width: '22px', height: '22px', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', backgroundColor: palette.raised, fontSize: '12px' },
  muted: { color: tokens.colorNeutralForeground3 },
});

/** One persistent dialog owns both processing and the import's user-input step. */
export function TaskDialog() {
  const s = useStyles();
  const status = useReport(state => state.status);
  const players = useReport(state => state.importPlayers);
  const choosing = useReport(state => state.choosingPlayer);
  const cancelling = useReport(state => state.cancelling);
  const outcome = useReport(state => state.taskOutcome);
  const fileName = useReport(state => state.taskFileName);
  const reanalyzing = useReport(state => state.taskOperation === 'reanalyze');
  const startedAt = useReport(state => state.taskStartedAt);
  const libraryBusy = useReport(state => state.libraryBusy);
  const progress = useReport(state => state.libraryProgress);
  const error = useReport(state => state.error);
  const libraryError = useReport(state => state.libraryError);
  const choose = useReport(state => state.chooseImportPlayer);
  const cancel = useReport(state => state.cancelImport);
  const dem = ['parsing', 'awaiting-player', 'analyzing', 'saving'].includes(status);
  const archive = (libraryBusy === 'export' || libraryBusy === 'importArchive') && progress?.operation === libraryBusy;
  const active = dem || archive;
  const waiting = status === 'awaiting-player' && players !== null && !cancelling;
  const visible = useLoadingFeedback(active);
  const seconds = useElapsedSeconds(active && !waiting, startedAt);
  const [selected, setSelected] = useState('');
  useEffect(() => { setSelected(''); }, [players]);
  const stage = status === 'saving' ? 2 : status === 'analyzing' ? 1 : 0;
  const steps = ['解析录像', '生成分析', reanalyzing ? '更新比赛记录' : '保存到比赛库'];
  const title = !active ? outcome === 'cancelled' ? '操作已取消' : error || libraryError ? '处理未完成' : '处理完成'
    : cancelling ? '正在取消…' : waiting ? '选择你自己' : dem ? reanalyzing ? '正在重新分析比赛' : '正在分析比赛'
    : libraryBusy === 'export' ? '正在导出比赛归档' : '正在导入比赛归档';
  const phase = dem ? status === 'saving' ? '正在保存到本机比赛库…' : status === 'analyzing' ? '正在生成指标、深度复盘与回放…' : '正在解析录像…'
    : libraryBusy === 'export' ? '正在写入归档文件…' : progress?.phase === 'writing' ? '正在保存到本机比赛库…' : '正在校验归档内容…';
  if (!active && !visible) return null;
  return <>{active && (waiting || visible) ? <div className={s.backdrop} aria-hidden="true" data-task-backdrop /> : null}<Dialog open={waiting || visible} modalType="non-modal" onOpenChange={(_, data) => {
    // Escape/backdrop never silently answers an identity question or cancels a task.
    if (!data.open) return;
  }}>
    <DialogSurface className={s.surface} data-task-dialog data-import-player-dialog={waiting ? '' : undefined}>
      <DialogBody>
        <DialogTitle action={null}>{title}</DialogTitle>
        <DialogContent className={s.content}>
          {fileName ? <Caption1 className={s.file}>{fileName}</Caption1> : null}
          {active && dem && reanalyzing ? <Caption1>新分析完成后更新原报告，并保留「自己是谁」的选择。</Caption1> : null}
          {!active ? <Body1>{outcome === 'cancelled' ? '后台任务已结束。' : error || libraryError || '操作已完成。'}</Body1> : waiting ? <>
            <Body1>本场记录会保存你所选玩家的赛后数据。也可以稍后选择。</Body1>
            <WinSelect aria-label="选择你自己" placeholder="请选择本场玩家" value={selected} disabled={choosing || !players?.length}
              items={(players ?? []).map(player => ({ value: player.id, text: `${player.nickname} · ${player.id.slice(-6)}`,
                label: <>{player.nickname}<span className={s.muted}> · {player.id.slice(-6)}</span></>,
              }))} onValueChange={setSelected} />
            <Caption1 className={s.muted}>稍后可在比赛首页的「自己是谁」中设置。</Caption1>
          </> : <div role="status" aria-live="polite">
            <Body1>{cancelling ? '正在停止后台任务并清理临时数据，请稍候。' : phase}</Body1>
            <ProgressBar aria-label={cancelling ? '正在取消导入' : phase} style={{ marginTop: 16 }} />
          </div>}
          {active && error ? <MessageBar intent="error"><MessageBarBody>{error}</MessageBarBody></MessageBar> : null}
          {dem && !waiting && !cancelling ? <ol className={s.steps} aria-label="分析阶段">{steps.map((step, i) => <li key={step} className={i === stage ? s.current : s.step} aria-current={i === stage ? 'step' : undefined}>
            <span className={s.dot}>{i < stage ? '✓' : i + 1}</span> {step}
          </li>)}</ol> : null}
          {active && !waiting ? <Caption1 className={s.muted}>{seconds >= 10 ? `已用 ${seconds} 秒 · ${dem ? '较大的录像需要更长时间。' : '耗时取决于归档大小和磁盘速度。'}` : '文件仅在本机处理。'}</Caption1> : null}
        </DialogContent>
        <DialogActions>
          {!active ? null : waiting ? <>
            <Button disabled={choosing} data-import-player-later onClick={() => void choose(null)}>稍后选择</Button>
            <Button appearance="primary" disabled={!selected || choosing} data-import-player-confirm onClick={() => void choose(selected)}>{choosing ? '正在提交…' : '确定'}</Button>
          </> : dem && status !== 'saving' ? <Button data-task-cancel disabled={cancelling} onClick={() => void cancel()}>{cancelling ? '正在取消…' : reanalyzing ? '取消重新分析' : '取消导入'}</Button>
            : <Caption1 className={s.muted}>请保持应用打开，完成后将自动返回。</Caption1>}
        </DialogActions>
      </DialogBody>
    </DialogSurface>
  </Dialog></>;
}

/** The native-window titlebar remains outside the temporarily inert workspace. */
export const taskBlocksWorkspace = (state: ReturnType<typeof useReport.getState>) =>
  ['parsing', 'awaiting-player', 'analyzing', 'saving'].includes(state.status)
  || ((state.libraryBusy === 'export' || state.libraryBusy === 'importArchive') && state.libraryProgress?.operation === state.libraryBusy);
