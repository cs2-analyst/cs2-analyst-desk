import { useEffect, useRef, useState } from 'react';
import { Body1, Caption1, ProgressBar, Skeleton, SkeletonItem, makeStyles, tokens } from '@fluentui/react-components';
import { palette } from './theme';

/** Feedback timers never hold a result, a session, or an operation lock. */
export function useLoadingFeedback(active: boolean, delay = 200, minimum = 400) {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef(0);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    if (active) {
      if (!shownAt.current) timer = setTimeout(() => { shownAt.current = Date.now(); setVisible(true); }, delay);
    } else {
      timer = setTimeout(() => { shownAt.current = 0; setVisible(false); }, Math.max(0, minimum - (Date.now() - shownAt.current)));
    }
    return () => clearTimeout(timer);
  }, [active, delay, minimum]);
  return visible;
}

export function useElapsedSeconds(active: boolean, startedAt: number) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    if (!active || !startedAt) { setSeconds(0); return; }
    const update = () => setSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [active, startedAt]);
  return seconds;
}

const useStyles = makeStyles({
  rows: { display: 'flex', flexDirection: 'column', gap: '14px', minWidth: 0 },
  row: { display: 'flex', alignItems: 'center', gap: '20px', minHeight: '36px' },
  notice: { display: 'flex', flexDirection: 'column', gap: '10px', minWidth: 0 },
  hint: { color: tokens.colorNeutralForeground3 },
  overlay: {
    position: 'absolute', inset: 0, zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'center',
    backgroundColor: 'rgba(15, 22, 31, 0.72)', pointerEvents: 'none', padding: '24px', boxSizing: 'border-box',
  },
  panel: { width: 'min(280px, 100%)', display: 'flex', flexDirection: 'column', gap: '12px', padding: '18px',
    backgroundColor: palette.card, border: `1px solid ${palette.border}`, borderRadius: tokens.borderRadiusLarge },
  map: { position: 'absolute', inset: 0, zIndex: 2, padding: '8px', boxSizing: 'border-box',
    backgroundColor: palette.replay.surface, pointerEvents: 'none',
    '--colorNeutralStencil1': 'rgba(148, 163, 184, 0.08)', '--colorNeutralStencil2': 'rgba(148, 163, 184, 0.18)',
    '@media (prefers-reduced-motion: reduce)': { '& *, & *::after': { animationName: 'none' } },
  },
});

/** Full-size placeholder for a map surface; its label is available without visual copy. */
export function MapSkeleton({ label }: { label: string }) {
  const s = useStyles();
  return <div className={s.map} role="status" aria-label={label} data-map-skeleton>
    <Skeleton animation="wave" aria-hidden="true" style={{ width: '100%', height: '100%' }}>
      <SkeletonItem style={{ width: '100%', height: '100%', borderRadius: tokens.borderRadiusLarge }} />
    </Skeleton>
  </div>;
}

export function LoadingRows({ rows = 3, label = '正在读取数据…' }: { rows?: number; label?: string }) {
  const s = useStyles();
  return <div className={s.notice} role="status" aria-label={label} data-loading-skeleton>
    <Caption1 className={s.hint}>{label}</Caption1>
    <Skeleton animation="wave" className={s.rows} aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => <div className={s.row} key={i}>
        <SkeletonItem style={{ width: '18%', height: 12 }} />
        <SkeletonItem style={{ width: '36%', height: 12 }} />
        <SkeletonItem style={{ width: '24%', height: 12 }} />
      </div>)}
    </Skeleton>
  </div>;
}

export function LoadingOverlay({ label, hint }: { label: string; hint?: string }) {
  const s = useStyles();
  return <div className={s.overlay} role="status" data-loading-overlay><div className={s.panel}>
    <Body1>{label}</Body1><ProgressBar aria-label={label} />
    {hint ? <Caption1 className={s.hint}>{hint}</Caption1> : null}
  </div></div>;
}
