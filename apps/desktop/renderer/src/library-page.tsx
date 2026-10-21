import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Body1, Button, Caption1, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface,
  DialogTitle, MessageBar, MessageBarBody, SearchBox, Select, Spinner, Subtitle1, Title1, makeStyles, tokens,
} from '@fluentui/react-components';
import type { MatchLibraryEntry } from '@cs2-analyst/report-contract';
import { useReport } from './store';
import { formatBytes, formatImportedAt, toLibraryListQuery } from './library-query.ts';
import type { LibraryFilters } from './library-query.ts';
import { ImportIcon } from './icons';
import { palette } from './theme';

const useStyles = makeStyles({
  page: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
  header: { flexShrink: 0, display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', gap: '16px', padding: '18px 24px 12px' },
  heading: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  headerActions: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', justifyContent: 'flex-end' },
  toolbar: { flexShrink: 0, display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '0 24px 12px' },
  search: { width: 'min(260px, 100%)' },
  select: { minWidth: '128px' },
  status: { padding: '0 24px 8px' },
  scroll: { flex: 1, minHeight: 0, overflowY: 'auto', padding: '0 24px 20px' },
  list: { display: 'flex', flexDirection: 'column', gap: '8px' },
  row: {
    display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto', alignItems: 'center', gap: '16px',
    padding: '12px 16px', backgroundColor: palette.card, border: `1px solid ${palette.border}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  rowUnavailable: { opacity: 0.7 },
  info: { minWidth: 0, display: 'flex', flexDirection: 'column', gap: '2px' },
  fileName: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  muted: { color: tokens.colorNeutralForeground3 },
  actions: { display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' },
  empty: {
    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px',
    textAlign: 'center', padding: '48px 24px', backgroundColor: palette.card,
    border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge,
  },
  emptyIcon: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: '56px', height: '56px', borderRadius: '50%', backgroundColor: palette.raised, color: palette.currentPlayer },
  center: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '24px' },
  storage: { flexShrink: 0, display: 'flex', justifyContent: 'flex-end', padding: '0 24px 16px' },
  placeholder: { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '12px', padding: '24px', overflowY: 'auto' },
  placeholderCard: { maxWidth: '520px', width: '100%', boxSizing: 'border-box', padding: '32px', display: 'flex', flexDirection: 'column', gap: '10px', backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge },
});

/** Honest placeholder: no personal statistics exist yet, so none are invented. */
export function PersonalSection() {
  const s = useStyles();
  const selectSection = useReport(state => state.selectSection);
  return <section id="personal-panel" role="tabpanel" aria-labelledby="global-personal-tab" data-personal-section className={s.placeholder}>
    <div className={s.placeholderCard}>
      <Title1>个人数据</Title1>
      <Body1>个人数据视图尚未实现，本版本不会生成或展示任何个人统计。</Body1>
      <Caption1 className={s.muted}>目前可用的本地数据是「比赛数据」中的已保存比赛。个人跨比赛汇总将在后续版本单独设计。</Caption1>
      <div><Button appearance="secondary" onClick={() => selectSection('library')}>前往比赛数据</Button></div>
    </div>
  </section>;
}

/** Pure list surface, also rendered by DOM tests without IPC. */
export function LibraryList({ entries, busy, onOpen, onExport, onDelete }: {
  entries: MatchLibraryEntry[]; busy: boolean;
  onOpen: (matchId: string) => void; onExport: (matchId: string) => void; onDelete: (entry: MatchLibraryEntry) => void;
}) {
  const s = useStyles();
  return <div className={s.list} role="list" data-library-list data-library-visible={entries.length}>
    {entries.map(entry => <LibraryRow key={entry.matchId} entry={entry} busy={busy}
      onOpen={onOpen} onExport={onExport} onDelete={onDelete} />)}
  </div>;
}

/** One saved match row: lightweight catalogue data only, no Replay chunk is fetched for the list. */
function LibraryRow({ entry, busy, onOpen, onExport, onDelete }: {
  entry: MatchLibraryEntry; busy: boolean;
  onOpen: (matchId: string) => void; onExport: (matchId: string) => void; onDelete: (entry: MatchLibraryEntry) => void;
}) {
  const s = useStyles();
  const score = entry.score ? `${entry.score.initialCT} : ${entry.score.initialT}` : '比分不可用';
  return <div className={`${s.row}${entry.state === 'ready' ? '' : ` ${s.rowUnavailable}`}`} role="listitem"
    data-library-entry={entry.matchId} data-library-state={entry.state}>
    <div className={s.info}>
      <Body1 className={s.fileName} title={entry.fileName}>{entry.fileName}</Body1>
      <Caption1 className={s.muted}>{entry.map} · {score} · {entry.rounds} 回合 · {entry.players.length} 名玩家 · {formatBytes(entry.storedBytes)} · {formatImportedAt(entry.importedAt)}</Caption1>
      {entry.state === 'ready' ? null : <Caption1 className={s.muted}>{entry.state === 'invalid' ? '当前档案不可读，只能删除或导出尝试。' : '档案版本不受支持，无法在本版本打开。'}</Caption1>}
    </div>
    <div className={s.actions}>
      <Button size="small" appearance="primary" data-library-open aria-label={`打开 ${entry.fileName}`}
        disabled={busy || entry.state !== 'ready'} onClick={() => onOpen(entry.matchId)}>打开</Button>
      <Button size="small" data-library-export aria-label={`导出 ${entry.fileName}`}
        disabled={busy || entry.state !== 'ready'} onClick={() => onExport(entry.matchId)}>导出</Button>
      <Button size="small" appearance="subtle" data-library-delete aria-label={`删除 ${entry.fileName}`}
        disabled={busy} onClick={() => onDelete(entry)}>删除</Button>
    </div>
  </div>;
}

export function LibraryPage() {
  const s = useStyles();
  const status = useReport(state => state.status);
  const libraryBusy = useReport(state => state.libraryBusy);
  const libraryError = useReport(state => state.libraryError);
  const libraryNotice = useReport(state => state.libraryNotice);
  const libraryRevision = useReport(state => state.libraryRevision);
  const openMatch = useReport(state => state.openMatch);
  const removeMatches = useReport(state => state.removeMatches);
  const exportMatch = useReport(state => state.exportMatch);
  const importArchive = useReport(state => state.importArchive);
  const importDemo = useReport(state => state.importDemo);
  const importDroppedFile = useReport(state => state.importDroppedFile);
  const clearLibraryMessage = useReport(state => state.clearLibraryMessage);
  const filters = useReport(state => state.libraryFilters);
  const setFilters = useReport(state => state.setLibraryFilters);
  const importBusy = status === 'selecting' || status === 'parsing' || status === 'analyzing' || status === 'opening';
  const busy = importBusy || libraryBusy !== null;

  const [entries, setEntries] = useState<MatchLibraryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [unreadable, setUnreadable] = useState(0);
  const [mapOptions, setMapOptions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ matchCount: number; totalBytes: number } | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MatchLibraryEntry | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const requestRef = useRef(0);

  const query = useMemo(() => toLibraryListQuery(filters), [filters]);
  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setListError(null);
    void window.cs2Analyst.library.list(query).then(result => {
      if (requestId !== requestRef.current) return;
      if (result.kind === 'error') { setListError(result.message); setEntries([]); setTotal(0); setUnreadable(0); return; }
      setEntries(result.entries);
      setTotal(result.total);
      setUnreadable(result.unreadableCount);
      setMapOptions(previous => Array.from(new Set([...previous, ...result.entries.map(entry => entry.map)])).sort());
    }).catch(() => {
      if (requestId !== requestRef.current) return;
      setListError('无法读取本地比赛库。请检查磁盘权限或重启应用。');
      setEntries([]);
    }).finally(() => {
      if (requestId === requestRef.current) setLoading(false);
    });
  }, [query, libraryRevision]);

  useEffect(() => {
    let alive = true;
    void window.cs2Analyst.library.storage().then(result => {
      if (!alive) return;
      if (result.kind === 'success') { setStorage({ matchCount: result.matchCount, totalBytes: result.totalBytes }); setStorageError(false); }
      else setStorageError(true);
    }).catch(() => { if (alive) setStorageError(true); });
    return () => { alive = false; };
  }, [libraryRevision]);

  const filtering = filters.search.trim().length > 0 || filters.map !== 'all';
  const update = (patch: Partial<LibraryFilters>) => setFilters(patch);
  const confirmDelete = () => {
    const entry = pendingDelete;
    setPendingDelete(null);
    if (entry) void removeMatches([entry.matchId]);
  };

  return <section id="library-panel" role="tabpanel" aria-labelledby="global-library-tab"
    data-library-page data-library-busy={busy ? 'true' : 'false'} className={s.page}>
    <div className={s.header}>
      <div className={s.heading}>
        <Title1>比赛数据</Title1>
        <Caption1 className={s.muted}>本机保存的比赛历史 · 无源 DEM 也可重开</Caption1>
      </div>
      <div className={s.headerActions}>
        <Button appearance="secondary" icon={<ImportIcon size={18} />} data-library-import-archive disabled={busy} onClick={() => void importArchive()}>
          导入 .cs2a
        </Button>
        <Button appearance="primary" icon={<ImportIcon size={18} />} data-library-import-dem disabled={busy} onClick={() => void importDemo()}>
          选择 DEM
        </Button>
      </div>
    </div>

    <div className={s.toolbar} data-library-toolbar>
      <SearchBox className={s.search} aria-label="搜索比赛" placeholder="搜索文件名或地图" value={filters.search}
        onChange={(_, data) => update({ search: data.value })} />
      <Select className={s.select} aria-label="按地图筛选" value={filters.map} onChange={(_, data) => update({ map: data.value })}>
        <option value="all">全部地图</option>
        {mapOptions.map(map => <option key={map} value={map}>{map}</option>)}
      </Select>
      <Select className={s.select} aria-label="排序方式" value={filters.sort}
        onChange={(_, data) => update({ sort: data.value as LibraryFilters['sort'], direction: data.value === 'map' ? 'asc' : 'desc' })}>
        <option value="importedAt">按导入时间</option>
        <option value="map">按地图</option>
        <option value="storedBytes">按占用空间</option>
      </Select>
      <Button size="small" appearance="subtle" data-library-direction
        aria-label={filters.direction === 'desc' ? '当前降序，切换为升序' : '当前升序，切换为降序'}
        onClick={() => update({ direction: filters.direction === 'desc' ? 'asc' : 'desc' })}>
        {filters.direction === 'desc' ? '降序 ↓' : '升序 ↑'}
      </Button>
    </div>

    {libraryError ? <div className={s.status}><MessageBar intent="error" data-library-error>
      <MessageBarBody>{libraryError}<Button size="small" appearance="transparent" onClick={clearLibraryMessage}>关闭</Button></MessageBarBody>
    </MessageBar></div> : null}
    {libraryNotice ? <div className={s.status}><MessageBar intent="success" data-library-notice>
      <MessageBarBody>{libraryNotice}<Button size="small" appearance="transparent" onClick={clearLibraryMessage}>关闭</Button></MessageBarBody>
    </MessageBar></div> : null}
    {listError ? <div className={s.status}><MessageBar intent="error" data-library-list-error>
      <MessageBarBody>{listError}<Button size="small" appearance="transparent" onClick={() => setFilters({})}>重试</Button></MessageBarBody>
    </MessageBar></div> : null}
    {unreadable > 0 ? <div className={s.status}><MessageBar intent="warning" data-library-unreadable>
      <MessageBarBody>有 {unreadable} 条索引记录无法读取，已从列表隐藏；磁盘文件未自动删除。</MessageBarBody>
    </MessageBar></div> : null}

    <div className={s.scroll}>
      {loading && entries.length === 0 ? <div className={s.center} role="status" data-library-loading>
        <Spinner size="large" label="正在读取本地比赛库…" />
      </div> : entries.length === 0 ? <div className={s.empty} data-library-empty data-import-card data-drag-over={dragOver ? 'true' : 'false'}
        onDragOver={event => { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; if (!dragOver) setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={event => {
          event.preventDefault(); setDragOver(false);
          if (busy) return;
          const file = event.dataTransfer?.files?.[0];
          if (file) void importDroppedFile(file);
        }}>
        <span className={s.emptyIcon}><ImportIcon size={28} /></span>
        <Subtitle1>{filtering ? '没有匹配的比赛' : '还没有保存的比赛'}</Subtitle1>
        <Body1>{filtering ? '调整搜索词或地图筛选后再试。' : '选择一份 CS2 .dem 开始分析，或把 .dem 文件直接拖放到这里；分析完成后会自动保存到本机比赛库。'}</Body1>
        <Caption1 className={s.muted}>导入 .cs2a 可恢复另一台本机导出的比赛；文件只在本机处理。</Caption1>
      </div> : <LibraryList entries={entries} busy={busy}
        onOpen={matchId => void openMatch(matchId)} onExport={matchId => void exportMatch(matchId)} onDelete={setPendingDelete} />}
    </div>

    <div className={s.storage} data-library-storage>
      <Caption1 className={s.muted}>
        {storage ? `本机占用 ${formatBytes(storage.totalBytes)} · ${storage.matchCount} 场比赛 · 当前显示 ${entries.length} / ${total}` : storageError ? '暂时无法读取本机占用' : '正在读取本机占用…'}
      </Caption1>
    </div>

    <Dialog open={pendingDelete !== null} onOpenChange={(_, data) => { if (!data.open) setPendingDelete(null); }}>
      <DialogSurface data-library-delete-dialog>
        <DialogBody>
          <DialogTitle>删除这场比赛？</DialogTitle>
          <DialogContent>
            <Body1>{pendingDelete?.fileName}</Body1>
            <Caption1 className={s.muted}>将从本机比赛库永久删除该归档与索引，无法撤销。源 DEM 文件不受影响。</Caption1>
          </DialogContent>
          <DialogActions>
            <Button appearance="secondary" onClick={() => setPendingDelete(null)}>取消</Button>
            <Button appearance="primary" data-library-delete-confirm disabled={busy} onClick={confirmDelete}>删除</Button>
          </DialogActions>
        </DialogBody>
      </DialogSurface>
    </Dialog>
  </section>;
}