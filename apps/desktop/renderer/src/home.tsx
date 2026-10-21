import React from 'react';
import { Body1, Button, Caption1, Subtitle1, Title1, makeStyles, mergeClasses, tokens } from '@fluentui/react-components';
import type { MatchLibraryEntry } from '@cs2-analyst/report-contract';
import { ImportIcon } from './icons';
import { palette } from './theme';

const useStyles = makeStyles({
  center: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '16px', padding: '24px', overflowY: 'auto' },
  importCard: {
    backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge, boxShadow: 'none',
    width: 'min(520px, 100%)', padding: '48px 44px', boxSizing: 'border-box',
    display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center', gap: '14px',
    transitionProperty: 'border-color, background-color', transitionDuration: '160ms',
  },
  importCardActive: { border: `1px solid ${tokens.colorBrandStroke1}`, backgroundColor: palette.raised },
  importIcon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '72px', height: '72px', borderRadius: '50%', backgroundColor: palette.raised, color: palette.currentPlayer },
  muted: { color: tokens.colorNeutralForeground3 },
  libraryCard: {
    backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge, boxShadow: 'none',
    width: 'min(520px, 100%)', padding: '16px 20px', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: '8px',
  },
  libraryRow: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: '12px',
    padding: '8px 0', borderTop: `1px solid ${palette.rowDivider}`, ':first-of-type': { borderTopStyle: 'none', paddingTop: 0 },
  },
  libraryText: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  fileName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
});

/** Home: import a DEM or reopen an already saved match without its source file. */
export function Home({ busy, onImport, onImportFile, onOpenMatch }: {
  busy: boolean; onImport: () => void; onImportFile: (file: File) => void; onOpenMatch: (matchId: string) => void;
}) {
  const s = useStyles();
  const [dragOver, setDragOver] = React.useState(false);
  const [entries, setEntries] = React.useState<MatchLibraryEntry[]>([]);
  React.useEffect(() => {
    let alive = true;
    void window.cs2Analyst.library.list({ limit: 20 }).then(result => {
      if (!alive || result.kind !== 'success') return;
      setEntries(result.entries);
    }).catch(() => { /* The import path stays available when the catalogue cannot be read. */ });
    return () => { alive = false; };
  }, []);
  const drop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);
    if (busy) return;
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    onImportFile(file);
  };
  return <div className={s.center}>
    <div className={mergeClasses(s.importCard, dragOver && s.importCardActive)} data-import-card
      data-drag-over={dragOver ? 'true' : 'false'}
      onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; if (!dragOver) setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={drop}>
      <span className={s.importIcon}><ImportIcon size={36} /></span>
      <Title1>从一场比赛开始</Title1>
      <Body1>选择一份 CS2 .dem 赛后录像，生成有证据的玩家表现报告与复盘重点。</Body1>
      <Button appearance="primary" size="large" icon={<ImportIcon size={18} />} disabled={busy} onClick={onImport}>选择 DEM 文件</Button>
      <Caption1 className={s.muted}>也可以把 .dem 文件直接拖放到这张卡片上 · 文件只在本机处理</Caption1>
    </div>
    {entries.length ? <div className={s.libraryCard} data-library-list>
      <Subtitle1>本地比赛</Subtitle1>
      {entries.map(entry => <div key={entry.matchId} className={s.libraryRow} data-library-entry={entry.matchId}>
        <div className={s.libraryText}>
          <Body1 className={s.fileName}>{entry.fileName}</Body1>
          <Caption1 className={s.muted}>{entry.map} · {entry.rounds} 回合 · {entry.players.length} 名玩家{entry.state === 'ready' ? '' : ' · 当前不可用'}</Caption1>
        </div>
        <Button disabled={busy || entry.state !== 'ready'} onClick={() => onOpenMatch(entry.matchId)}>打开</Button>
      </div>)}
    </div> : null}
  </div>;
}
