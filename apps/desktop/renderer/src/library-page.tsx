import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  Body1,
  Button,
  Caption1,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  MessageBar,
  MessageBarBody,
  Menu,
  MenuItem,
  MenuList,
  MenuPopover,
  MenuTrigger,
  ProgressBar,
  SkeletonItem,
  Subtitle1,
  Title1,
  Table,
  TableHeader,
  TableHeaderCell,
  TableBody,
  TableRow,
  TableCell,
  Tooltip,
  makeStyles,
  mergeClasses,
  tokens,
} from "@fluentui/react-components";
import type { MatchLibraryEntry } from "@cs2-analyst/report-contract";
import { useReport } from "./store";
import { formatBytes, formatImportedAt, formatImportedDate, libraryMapOptions, toLibraryListQuery } from "./library-query.ts";
import type { LibraryFilters } from "./library-query.ts";
import { BackIcon, DeleteIcon, ExportIcon, ForwardIcon, ImportIcon, MoreIcon } from "./icons";
import { palette } from "./theme";
import { RatingValue, HighlightTags, formatMetric, formatKast } from "./performance-display";
import { WinSelect } from "./winui-select";
import { LoadingRows, useLoadingFeedback } from './loading-ui';
import './library-loading.css';

const useStyles = makeStyles({
  page: { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
  header: {
    flexShrink: 0,
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "space-between",
    gap: "16px",
    padding: "18px 24px 12px",
  },
  heading: { minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  headerActions: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap", justifyContent: "flex-end" },
  toolbar: {
    flexShrink: 0,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexWrap: "wrap",
    padding: "0 24px 12px",
  },
  select: {
    minWidth: "128px",
    maxWidth: "260px",
    "& button": {
      minWidth: "128px",
      maxWidth: "260px",
      overflow: "hidden",
      textOverflow: "ellipsis",
      whiteSpace: "nowrap",
    },
  },
  rowClickable: { cursor: "pointer", ":focus-visible": { outline: `1px solid ${palette.currentPlayer}`, outlineOffset: "-2px" } },
  status: { padding: "0 24px 8px" },
  scroll: { flex: 1, minHeight: 0, overflow: "auto", padding: "0 24px 16px" },
  list: { width: "100%", tableLayout: "fixed", fontVariantNumeric: "tabular-nums" },
  tableHead: {
    "& .fui-TableHeaderCell__button": { justifyContent: "center" },
    height: "36px",
    color: tokens.colorNeutralForeground3,
    fontSize: "12px",
    fontWeight: 400,
    borderBottom: `1px solid ${palette.border}`,
    backgroundColor: palette.pageTop,
  },
  cell: {
    padding: "0 6px",
    textAlign: "center",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    boxSizing: "border-box",
  },
  mapCell: { textAlign: "left", "& .fui-TableHeaderCell__button": { justifyContent: "flex-start" } },
  row: {
    height: "50px",
    borderBottom: `1px solid ${palette.rowDivider}`,
    fontSize: "13px",
    fontWeight: 600,
    ":hover": { backgroundColor: palette.cardHover },
  },
  result: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    minWidth: "20px",
    height: "20px",
    borderRadius: "2px",
    fontSize: "12px",
    fontWeight: 700,
  },
  rowUnavailable: { opacity: 0.7 },
  stale: { opacity: 0.55 },
  updateStatus: { height: '32px', flexShrink: 0, padding: '0 24px', display: 'flex', alignItems: 'center', gap: '12px', color: tokens.colorNeutralForeground3 },
  skeleton: { padding: '12px 6px' },
  info: { minWidth: 0, display: "flex", flexDirection: "column", gap: "2px" },
  fileName: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  playerLine: { display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  matchTooltip: {
    display: "flex", flexDirection: "column", gap: "4px",
    whiteSpace: "normal", overflowWrap: "anywhere", fontWeight: 400,
  },
  matchTooltipSurface: { maxWidth: "min(320px, calc(100vw - 32px))" },
  tooltipFile: { fontWeight: 600 },
  muted: { color: tokens.colorNeutralForeground3 },
  deleteAction: { color: tokens.colorPaletteRedForeground1 },
  empty: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "10px",
    textAlign: "center",
    padding: "48px 24px",
    backgroundColor: palette.card,
    border: `1px solid ${palette.border}`,
    borderRadius: tokens.borderRadiusLarge,
  },
  emptyIcon: {
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    width: "56px",
    height: "56px",
    borderRadius: "50%",
    backgroundColor: palette.raised,
    color: palette.currentPlayer,
  },
  center: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    padding: "24px",
  },
  storage: {
    flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: "12px", flexWrap: "wrap", margin: "0 24px", padding: "12px 0 16px",
    borderTop: `1px solid ${palette.rowDivider}`,
  },
  storageSummary: { display: "flex", alignItems: "center", gap: "12px", color: tokens.colorNeutralForeground3 },
  pagination: { display: "flex", alignItems: "center", gap: "12px", marginLeft: "auto", fontVariantNumeric: "tabular-nums" },
  pageRange: { color: tokens.colorNeutralForeground3, whiteSpace: "nowrap" },
  pageControls: { display: "flex", alignItems: "center", gap: "4px" },
  pageNumber: {
    minWidth: "56px", height: "32px", boxSizing: "border-box", padding: "0 10px",
    display: "inline-flex", alignItems: "center", justifyContent: "center", gap: "6px",
    backgroundColor: palette.raised, borderRadius: tokens.borderRadiusMedium, fontSize: "13px",
  },
  placeholder: {
    flex: 1,
    minHeight: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: "12px",
    padding: "24px",
    overflowY: "auto",
  },
  placeholderCard: {
    maxWidth: "520px",
    width: "100%",
    boxSizing: "border-box",
    padding: "32px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    backgroundColor: palette.card,
    border: `1px solid ${palette.border}`,
    borderRadius: tokens.borderRadiusLarge,
  },
});

/** Honest placeholder: no personal statistics exist yet, so none are invented. */
export function PersonalSection() {
  const s = useStyles();
  const selectSection = useReport((state) => state.selectSection);
  return (
    <section
      id="personal-panel"
      role="tabpanel"
      aria-labelledby="global-personal-tab"
      data-personal-section
      className={s.placeholder}
    >
      <div className={s.placeholderCard}>
        <Title1>个人数据</Title1>
        <Body1>个人数据视图尚未实现，本版本不会生成或展示任何个人统计。</Body1>
        <Caption1 className={s.muted}>
          目前可用的本地数据是「比赛数据」中的已保存比赛。个人跨比赛汇总将在后续版本单独设计。
        </Caption1>
        <div>
          <Button appearance="secondary" onClick={() => selectSection("library")}>
            前往比赛数据
          </Button>
        </div>
      </div>
    </section>
  );
}

/** Pure catalogue surface: all business results arrive precomputed across IPC. */
export function LibraryList({
  entries,
  busy,
  loading = false,
  openingMatchId = null,
  onOpen,
  onExport,
  onReanalyze,
  onDelete,
}: {
  entries: MatchLibraryEntry[];
  busy: boolean;
  loading?: boolean;
  openingMatchId?: string | null;
  onOpen: (matchId: string) => void;
  onExport: (matchId: string) => void;
  onReanalyze?: (matchId: string) => void;
  onDelete: (entry: MatchLibraryEntry) => void;
}) {
  const s = useStyles();
  // Keep metadata compact; the highlights column receives all remaining width.
  const columns = [
    ["日期", 72],
    ["地图", 128],
    ["胜/负", 52],
    ["比分", 72],
    ["K/D/A", 96],
    ["ADR", 64],
    ["Rating", 64],
    ["KAST", 72],
    ["高光", undefined],
    ["操作", 48],
  ] as const;
  return (
    <Table
      size="small"
      aria-label="比赛记录"
      className={s.list}
      data-library-list
      data-library-visible={entries.length}
    >
      <TableHeader>
        <TableRow>
          {columns.map(([label, width]) => (
            <TableHeaderCell
              key={label}
              className={mergeClasses(s.tableHead, s.cell, label === "地图" && s.mapCell)}
              style={width === undefined ? undefined : { width }}
            >
              {label === "日期" ? (
                <Tooltip content="当前 DEM 未提供可信比赛日期，下方日期为本机导入时间。" relationship="description">
                  <span tabIndex={0}>导入日期</span>
                </Tooltip>
              ) : (
                label
              )}
            </TableHeaderCell>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading ? <TableRow><TableCell colSpan={10} className={s.skeleton}><LoadingRows rows={5} label="正在读取本地比赛库…" /></TableCell></TableRow> : null}
        {entries.map((entry) => (
          <LibraryRow
            key={entry.matchId}
            entry={entry}
            busy={busy}
            opening={entry.matchId === openingMatchId}
            onOpen={onOpen}
            onExport={onExport}
            onReanalyze={onReanalyze}
            onDelete={onDelete}
          />
        ))}
      </TableBody>
    </Table>
  );
}

const DASH = "-";

function LibraryRow({
  entry,
  busy,
  opening = false,
  onOpen,
  onExport,
  onReanalyze,
  onDelete,
}: {
  entry: MatchLibraryEntry;
  busy: boolean;
  opening?: boolean;
  onOpen: (matchId: string) => void;
  onExport: (matchId: string) => void;
  onReanalyze?: (matchId: string) => void;
  onDelete: (entry: MatchLibraryEntry) => void;
}) {
  const s = useStyles();
  const selfId = entry.selfPlayerId ?? "";
  const summary = entry.state === "ready" && selfId
    ? entry.playerSummaries?.find((p) => p.playerId === selfId)
    : undefined;
  const player = selfId ? entry.players.find((p) => p.id === selfId) : undefined;
  const outcome = summary?.outcome ?? "unknown";
  const result = {
    win: ["胜", palette.performance.win],
    loss: ["负", palette.performance.loss],
    draw: ["平", palette.textMuted],
    unknown: [DASH, "transparent"],
  }[outcome];
  const ownScore = summary?.team && entry.score
    ? summary.team === "initialCT"
      ? `${entry.score.initialCT} : ${entry.score.initialT}`
      : `${entry.score.initialT} : ${entry.score.initialCT}`
    : null;
  const playerLabel = player ? player.nickname === player.id ? "已选择玩家" : player.nickname
    : selfId ? "本场无此玩家" : "未设置自己";
  const status =
    entry.state === "invalid"
      ? "当前档案不可读，只能删除或导出尝试。"
      : entry.state === "unsupported"
        ? "档案版本不受支持，无法在本版本打开。"
        : null;
  const description = <div className={s.matchTooltip} data-library-match-tooltip>
    <span className={s.tooltipFile}>{entry.fileName}</span>
    <span>{entry.rounds} 回合 · {formatBytes(entry.storedBytes)}</span>
    <span>玩家：{playerLabel}</span>
    {player ? <span>SteamID：{player.id}</span> : null}
    {status ? <span>{status}</span> : null}
  </div>;
  const openable = entry.state === "ready" && !busy;
  const open = () => { if (openable) onOpen(entry.matchId); };
  const stop = (event: React.SyntheticEvent) => event.stopPropagation();
  return (
    <TableRow
      className={mergeClasses(s.row, openable && s.rowClickable, entry.state !== "ready" && s.rowUnavailable)}
      data-library-entry={entry.matchId}
      data-library-state={entry.state}
      data-library-player={selfId}
      aria-busy={opening}
      data-record-opening={opening ? 'true' : 'false'}
      tabIndex={openable ? 0 : undefined}
      aria-label={opening ? `正在打开 ${entry.fileName}` : openable ? `打开 ${entry.fileName}` : undefined}
      onClick={open}
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget) return;
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
    >
      <TableCell className={s.cell}>
        <Tooltip content={`导入时间：${formatImportedAt(entry.importedAt)}。比赛日期未知。`} relationship="description">
          <time tabIndex={0} dateTime={entry.importedAt}>
            {formatImportedDate(entry.importedAt)}
          </time>
        </Tooltip>
      </TableCell>
      <TableCell className={mergeClasses(s.cell, s.mapCell)}>
        <Tooltip content={{ children: description, className: s.matchTooltipSurface }} relationship="description">
          <div className={s.info} tabIndex={0}>
            <span className={s.fileName}>{entry.map}</span>
            <Caption1 className={mergeClasses(s.muted, s.playerLine)}>{playerLabel}</Caption1>
          </div>
        </Tooltip>
      </TableCell>
      <TableCell className={s.cell}>
        <Tooltip content={outcome === "unknown" ? "尚未选择自己或胜负证据不可用" : outcome === "win" ? "胜利" : outcome === "loss" ? "失利" : "平局"} relationship="description"><span
          className={s.result}
          data-library-outcome={outcome}
          style={{ backgroundColor: result[1], color: outcome === "unknown" ? palette.textMuted : "#111821" }}
          tabIndex={0}
        >
          {result[0]}
        </span></Tooltip>
      </TableCell>
      <TableCell className={s.cell} data-library-score>
        {ownScore ?? DASH}
      </TableCell>
      <TableCell className={s.cell} data-library-kda>
        {summary ? `${summary.kills ?? DASH}/${summary.deaths ?? DASH}/${summary.assists ?? DASH}` : DASH}
      </TableCell>
      <TableCell className={s.cell} data-library-adr>
        {summary?.adr !== null && summary?.adr !== undefined ? formatMetric(summary.adr, 1) : DASH}
      </TableCell>
      <TableCell className={s.cell}>
        {summary?.performance.rating.status === "available"
          ? <RatingValue rating={summary.performance.rating} />
          : <Tooltip content={summary?.performance.rating.reason ?? "尚未选择自己"} relationship="description"><span data-rating-empty tabIndex={0}>{DASH}</span></Tooltip>}
      </TableCell>
      <TableCell className={s.cell} data-library-kast>
        {summary?.kastPercentage !== null && summary?.kastPercentage !== undefined ? formatKast(summary.kastPercentage) : DASH}
      </TableCell>
      <TableCell className={s.cell}>
        {summary?.performance.highlights?.length ? <HighlightTags highlights={summary.performance.highlights} /> : DASH}
      </TableCell>
      <TableCell className={s.cell} onClick={stop} onKeyDown={stop}>
        <Menu>
          <MenuTrigger disableButtonEnhancement>
            <Tooltip content="更多操作" relationship="description">
              <Button size="small" appearance="subtle" icon={<MoreIcon size={18} />}
                data-library-more aria-label={`更多操作：${entry.fileName}`} disabled={busy} />
            </Tooltip>
          </MenuTrigger>
          <MenuPopover>
            <MenuList>
              <MenuItem icon={<ImportIcon size={18} />} data-library-reanalyze disabled={busy || entry.state !== "ready"}
                onClick={() => onReanalyze?.(entry.matchId)}>重新分析</MenuItem>
              <MenuItem icon={<ExportIcon size={18} />} data-library-export disabled={busy || entry.state !== "ready"}
                onClick={() => onExport(entry.matchId)}>导出比赛归档</MenuItem>
              <MenuItem icon={<DeleteIcon size={18} />} className={s.deleteAction} data-library-delete disabled={busy}
                onClick={() => onDelete(entry)}>删除比赛</MenuItem>
            </MenuList>
          </MenuPopover>
        </Menu>
      </TableCell>
    </TableRow>
  );
}

export function LibraryPage() {
  const s = useStyles();
  const status = useReport((state) => state.status);
  const libraryBusy = useReport((state) => state.libraryBusy);
  const libraryError = useReport((state) => state.libraryError);
  const libraryNotice = useReport((state) => state.libraryNotice);
  const libraryRevision = useReport((state) => state.libraryRevision);
  const openingMatchId = useReport(state => state.openingMatchId);
  const openMatch = useReport((state) => state.openMatch);
  const removeMatches = useReport((state) => state.removeMatches);
  const exportMatch = useReport((state) => state.exportMatch);
  const reanalyzeMatch = useReport((state) => state.reanalyzeMatch);
  const importArchive = useReport((state) => state.importArchive);
  const importDemo = useReport((state) => state.importDemo);
  const importDroppedFile = useReport((state) => state.importDroppedFile);
  const clearLibraryMessage = useReport((state) => state.clearLibraryMessage);
  const filters = useReport((state) => state.libraryFilters);
  const setFilters = useReport((state) => state.setLibraryFilters);
  const importBusy = status === "selecting" || status === "parsing" || status === "awaiting-player"
    || status === "analyzing" || status === "saving" || status === "opening";
  const busy = importBusy || libraryBusy !== null;

  const [entries, setEntries] = useState<MatchLibraryEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [pageSize, setPageSize] = useState(25);
  const [pageOffsets, setPageOffsets] = useState<number[]>([]);
  const [unreadable, setUnreadable] = useState(0);
  const [loading, setLoading] = useState(true);
  const [hasLoaded, setHasLoaded] = useState(false);
  const [reload, setReload] = useState(0);
  const [loadedKey, setLoadedKey] = useState('');
  const [appliedMap, setAppliedMap] = useState(filters.map);
  const [listError, setListError] = useState<string | null>(null);
  const [storage, setStorage] = useState<{ matchCount: number; totalBytes: number } | null>(null);
  const [storageError, setStorageError] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<MatchLibraryEntry | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const requestRef = useRef(0);

  const query = useMemo(() => ({ ...toLibraryListQuery(filters, 25), offset }), [filters, offset]);
  const queryKey = JSON.stringify([query, libraryRevision, reload]);
  const updating = loading || loadedKey !== queryKey;
  const showUpdating = useLoadingFeedback(updating);
  useEffect(() => {
    const requestId = ++requestRef.current;
    setLoading(true);
    setListError(null);
    void window.cs2Analyst.library
      .list(query)
      .then((result) => {
        if (requestId !== requestRef.current) return;
        if (result.kind === "error") {
          setListError(result.message);
          return;
        }
        if (result.offset > 0 && result.offset >= result.total) {
          setOffset(result.total === 0 ? 0 : pageOffsets.at(-1) ?? 0);
          setPageOffsets(result.total === 0 ? [] : pageOffsets.slice(0, -1));
          return;
        }
        setEntries(result.entries);
        setTotal(result.total);
        setPageSize(result.limit);
        setUnreadable(result.unreadableCount);
        setHasLoaded(true);
        setAppliedMap(query.map ?? 'all');
      })
      .catch(() => {
        if (requestId !== requestRef.current) return;
        setListError("无法读取本地比赛库。请检查磁盘权限或重启应用。");
      })
      .finally(() => {
        if (requestId === requestRef.current) { setLoading(false); setLoadedKey(queryKey); }
      });
    return () => { requestRef.current++; };
  }, [query, libraryRevision, reload]);

  useEffect(() => {
    let alive = true;
    void window.cs2Analyst.library
      .storage()
      .then((result) => {
        if (!alive) return;
        if (result.kind === "success") {
          setStorage({ matchCount: result.matchCount, totalBytes: result.totalBytes });
          setStorageError(false);
        } else setStorageError(true);
      })
      .catch(() => {
        if (alive) setStorageError(true);
      });
    return () => {
      alive = false;
    };
  }, [libraryRevision, reload]);

  const filtering = appliedMap !== "all";
  const update = (patch: Partial<LibraryFilters>) => {
    setOffset(0);
    setPageOffsets([]);
    setFilters(patch);
  };
  const confirmDelete = async () => {
    const entry = pendingDelete;
    if (!entry || deleting || busy || useReport.getState().libraryBusy !== null) return;
    setDeleting(true);
    try {
      await removeMatches([entry.matchId]);
      if (!useReport.getState().libraryError) setPendingDelete(null);
    } finally { setDeleting(false); }
  };

  return (
    <section
      id="library-panel"
      role="tabpanel"
      aria-labelledby="global-library-tab"
      data-library-page
      data-library-busy={busy ? "true" : "false"}
      className={s.page}
    >
      <div className={s.header}>
        <div className={s.heading}>
          <Title1>比赛数据</Title1>
          <Caption1 className={s.muted}>本机保存的比赛历史 · 无源 DEM 也可重开</Caption1>
        </div>
        <div className={s.headerActions}>
          <Button
            appearance="secondary"
            icon={<ImportIcon size={18} />}
            data-library-import-archive
            disabled={busy}
            onClick={() => void importArchive()}
          >
            导入 .cs2a
          </Button>
          <Button
            appearance="primary"
            icon={<ImportIcon size={18} />}
            data-library-import-dem
            disabled={busy}
            onClick={() => void importDemo()}
          >
            选择 DEM
          </Button>
        </div>
      </div>

      <div className={s.toolbar} data-library-toolbar>
        <WinSelect
          className={s.select}
          aria-label="按地图筛选"
          value={filters.map}
          items={[{ value: "all", text: "全部地图" }, ...libraryMapOptions]}
          onValueChange={(map) => update({ map })}
        />
        <WinSelect
          className={s.select}
          aria-label="排序方式"
          value={filters.sort}
          items={[
            { value: "importedAt", text: "按导入时间" },
            { value: "map", text: "按地图" },
            { value: "storedBytes", text: "按占用空间" },
          ]}
          onValueChange={(sort) =>
            update({ sort: sort as LibraryFilters["sort"], direction: sort === "map" ? "asc" : "desc" })
          }
        />
        <Button
          size="small"
          appearance="subtle"
          data-library-direction
          aria-label={filters.direction === "desc" ? "当前降序，切换为升序" : "当前升序，切换为降序"}
          onClick={() => update({ direction: filters.direction === "desc" ? "asc" : "desc" })}
        >
          {filters.direction === "desc" ? "降序 ↓" : "升序 ↑"}
        </Button>
      </div>

      {libraryError ? (
        <div className={s.status}>
          <MessageBar intent="error" data-library-error>
            <MessageBarBody>
              {libraryError}
              <Button size="small" appearance="transparent" onClick={clearLibraryMessage}>
                关闭
              </Button>
            </MessageBarBody>
          </MessageBar>
        </div>
      ) : null}
      {libraryNotice ? (
        <div className={s.status}>
          <MessageBar intent="success" data-library-notice>
            <MessageBarBody>
              {libraryNotice}
              <Button size="small" appearance="transparent" onClick={clearLibraryMessage}>
                关闭
              </Button>
            </MessageBarBody>
          </MessageBar>
        </div>
      ) : null}
      {listError ? (
        <div className={s.status}>
          <MessageBar intent="error" data-library-list-error>
            <MessageBarBody>
              {listError}
              <Button size="small" appearance="transparent" onClick={() => setReload(value => value + 1)}>
                重试
              </Button>
            </MessageBarBody>
          </MessageBar>
        </div>
      ) : null}
      {unreadable > 0 ? (
        <div className={s.status}>
          <MessageBar intent="warning" data-library-unreadable>
            <MessageBarBody>有 {unreadable} 条索引记录无法读取，已从列表隐藏；磁盘文件未自动删除。</MessageBarBody>
          </MessageBar>
        </div>
      ) : null}

      <div className={s.updateStatus} role="status" aria-live="polite" data-library-update>
        {hasLoaded && updating && showUpdating ? <><ProgressBar aria-label="正在更新比赛列表" style={{ width: 100 }} /><Caption1>正在更新列表… 当前为上次结果。</Caption1></>
          : hasLoaded && listError ? <Caption1>更新失败，当前为上次结果；请重试。</Caption1>
          : hasLoaded && showUpdating ? <Caption1>列表已更新。</Caption1> : null}
      </div>
      <div className={mergeClasses(s.scroll, hasLoaded && (updating || Boolean(listError)) && s.stale)} aria-busy={updating}>
        {!hasLoaded && !listError ? <div data-library-loading><LibraryList entries={[]} busy loading onOpen={() => {}} onExport={() => {}} onDelete={() => {}} /></div>
        : !hasLoaded && listError ? <div className={s.center}><Body1>比赛库暂时无法读取，请重试。</Body1></div>
        : entries.length === 0 ? (
          <div
            className={s.empty}
            data-library-empty
            data-import-card
            data-drag-over={dragOver ? "true" : "false"}
            onDragOver={(event) => {
              event.preventDefault();
              event.dataTransfer.dropEffect = "copy";
              if (!dragOver) setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragOver(false);
              if (busy) return;
              const file = event.dataTransfer?.files?.[0];
              if (file) void importDroppedFile(file);
            }}
          >
            <span className={s.emptyIcon}>
              <ImportIcon size={28} />
            </span>
            <Subtitle1>{filtering ? "该地图下没有比赛" : "还没有保存的比赛"}</Subtitle1>
            <Body1>
              {filtering
                ? "调整地图筛选后再试。"
                : "选择一份 CS2 .dem 开始分析，或把 .dem 文件直接拖放到这里；分析完成后会自动保存到本机比赛库。"}
            </Body1>
            <Caption1 className={s.muted}>导入 .cs2a 可恢复另一台本机导出的比赛；文件只在本机处理。</Caption1>
          </div>
        ) : (
          <LibraryList
            entries={entries}
            busy={busy || updating || Boolean(listError)}
            openingMatchId={status === 'opening' ? openingMatchId : null}
            onOpen={(matchId) => void openMatch(matchId)}
            onExport={(matchId) => void exportMatch(matchId)}
            onReanalyze={(matchId) => void reanalyzeMatch(matchId)}
            onDelete={setPendingDelete}
          />
        )}
      </div>

      <div className={s.storage} data-library-storage>
        <Caption1 className={s.storageSummary}>
          {storage
            ? <><span>已保存 {storage.matchCount} 场</span><span>本机占用 {formatBytes(storage.totalBytes)}</span></>
            : storageError
              ? "暂时无法读取本机占用"
              : <span role="status" aria-label="正在读取本机占用" data-storage-loading><SkeletonItem style={{ width: 180, height: 12 }} /></span>}
          {storageError ? <Button size="small" appearance="transparent" onClick={() => setReload(value => value + 1)}>重试</Button> : null}
        </Caption1>
        <nav className={s.pagination} aria-label="比赛列表分页">
          <Caption1 className={s.pageRange} aria-live="polite" data-library-page-range>
            {!hasLoaded ? '—' : total ? `${offset + 1}–${Math.min(offset + pageSize, total)} / ${total} 场` : "0 场比赛"}
          </Caption1>
          <div className={s.pageControls}>
            <Tooltip content="上一页" relationship="description">
              <Button appearance="subtle" icon={<BackIcon size={16} />} aria-label="上一页比赛"
                disabled={updating || busy || Boolean(listError) || offset === 0}
                onClick={() => {
                  setOffset(pageOffsets.at(-1) ?? 0);
                  setPageOffsets(pageOffsets.slice(0, -1));
                }} />
            </Tooltip>
            <span className={s.pageNumber} data-library-page-number>
              {total ? <>第 <strong>{pageOffsets.length + 1}</strong> 页</> : "—"}
            </span>
            <Tooltip content="下一页" relationship="description">
              <Button appearance="subtle" icon={<ForwardIcon size={16} />} aria-label="下一页比赛"
                disabled={updating || busy || Boolean(listError) || offset + pageSize >= total}
                onClick={() => {
                  setPageOffsets([...pageOffsets, offset]);
                  setOffset(offset + pageSize);
                }} />
            </Tooltip>
          </div>
        </nav>
      </div>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(_, data) => {
          if (!data.open && !deleting) setPendingDelete(null);
        }}
      >
        <DialogSurface data-library-delete-dialog>
          <DialogBody>
            <DialogTitle>删除这场比赛？</DialogTitle>
            <DialogContent>
              <Body1>{pendingDelete?.fileName}</Body1>
              <Caption1 className={s.muted}>
                将从本机比赛库永久删除该归档与索引，无法撤销。源 DEM 文件不受影响。
              </Caption1>
              {libraryError ? <MessageBar intent="error"><MessageBarBody>{libraryError}</MessageBarBody></MessageBar> : null}
            </DialogContent>
            <DialogActions>
              <Button appearance="secondary" disabled={deleting} onClick={() => setPendingDelete(null)}>
                取消
              </Button>
              <Button appearance="primary" data-library-delete-confirm disabled={busy || deleting} disabledFocusable={deleting}
                aria-busy={deleting} data-button-loading={deleting ? 'true' : 'false'} style={{ minWidth: 112 }} onClick={() => void confirmDelete()}>
                {deleting ? '正在删除…' : '删除'}
              </Button>
            </DialogActions>
          </DialogBody>
        </DialogSurface>
      </Dialog>
    </section>
  );
}
