import { useEffect, useState } from 'react';
import { Button, makeStyles, mergeClasses, Tooltip } from '@fluentui/react-components';
import { palette } from './theme';
import { BackIcon, ForwardIcon } from './icons';
import { CloseIcon, MaximizeIcon, MinimizeIcon, RestoreIcon } from './window-icons';
import { useReport, navigationCanBack, navigationCanForward } from './store';
import appMark from '../../resources/branding/cs2-analyst-mark.png';

const useStyles = makeStyles({
  bar: {
    flexShrink: 0, zIndex: 100, height: '40px', boxSizing: 'border-box', position: 'relative',
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    backgroundColor: palette.pageBottom, borderBottom: `1px solid ${palette.rowDivider}`,
    userSelect: 'none', WebkitAppRegion: 'drag',
  },
  // Left history group: real Fluent buttons, never part of the drag region.
  nav: { display: 'flex', alignItems: 'center', gap: '2px', paddingLeft: '6px', WebkitAppRegion: 'no-drag', zIndex: 1 },
  navButton: {
    WebkitAppRegion: 'no-drag', minWidth: '32px', width: '32px', height: '32px', padding: 0,
    borderRadius: '4px', color: palette.textSecondary, backgroundColor: 'transparent',
    ':hover': { backgroundColor: palette.cardHover, color: palette.text },
    ':active': { backgroundColor: palette.raised },
    ':focus-visible': { outline: `1px solid ${palette.textMuted}`, outlineOffset: '-2px' },
  },
  // Absolutely centred on the full window width, not on the space left by the buttons.
  brand: {
    position: 'absolute', left: '50%', transform: 'translateX(-50%)',
    display: 'flex', alignItems: 'center', gap: '10px', maxWidth: 'calc(100% - 320px)',
    fontSize: '13px', fontWeight: 500, whiteSpace: 'nowrap', pointerEvents: 'none',
    WebkitAppRegion: 'drag', zIndex: 0,
  },
  mark: { width: '20px', height: '20px', objectFit: 'contain', flexShrink: 0 },
  brandText: { overflow: 'hidden', textOverflow: 'ellipsis' },
  controls: { display: 'flex', alignSelf: 'flex-start', height: '40px', WebkitAppRegion: 'no-drag', zIndex: 1 },
  control: {
    WebkitAppRegion: 'no-drag', minWidth: '46px', width: '46px', height: '40px',
    padding: 0, border: 0, borderRadius: 0, color: palette.textSecondary,
    backgroundColor: 'transparent',
    ':hover': { backgroundColor: palette.cardHover, color: palette.text },
    ':active': { backgroundColor: palette.raised },
    ':focus-visible': { outline: `1px solid ${palette.textMuted}`, outlineOffset: '-3px' },
  },
  close: { ':hover': { backgroundColor: '#c42b1c', color: '#ffffff' }, ':active': { backgroundColor: '#a92317', color: '#ffffff' } },
});

/** Presentational titlebar: every interactive state is a prop so it can be asserted without Electron. */
export function TitlebarView({ canBack, canForward, onBack, onForward, maximized, onMinimize, onToggleMaximize, onClose }: {
  canBack: boolean;
  canForward: boolean;
  onBack: () => void;
  onForward: () => void;
  maximized: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}) {
  const s = useStyles();
  return <header data-app-titlebar className={s.bar}>
    <div className={s.nav} data-app-history-nav>
      <Tooltip content={canBack ? '后退' : '没有可返回的页面'} relationship="description">
        <Button appearance="transparent" className={s.navButton} data-nav-action="back"
          aria-label="后退" aria-disabled={!canBack} data-nav-disabled={!canBack ? 'true' : 'false'}
          icon={<BackIcon size={18} />} onClick={() => { if (canBack) onBack(); }} />
      </Tooltip>
      <Tooltip content={canForward ? '前进' : '没有可前进的页面'} relationship="description">
        <Button appearance="transparent" className={s.navButton} data-nav-action="forward"
          aria-label="前进" aria-disabled={!canForward} data-nav-disabled={!canForward ? 'true' : 'false'}
          icon={<ForwardIcon size={18} />} onClick={() => { if (canForward) onForward(); }} />
      </Tooltip>
    </div>
    <div className={s.brand} data-app-brand>
      <img data-app-logo className={s.mark} src={appMark} alt="" draggable={false} />
      <span className={s.brandText}>CS2 Analyst</span>
    </div>
    <div className={s.controls}>
      <Button appearance="transparent" className={s.control} data-window-control="minimize" aria-label="最小化" icon={<MinimizeIcon />} onClick={onMinimize} />
      <Button appearance="transparent" className={s.control} data-window-control="maximize" aria-label={maximized ? '还原' : '最大化'} icon={maximized ? <RestoreIcon /> : <MaximizeIcon />} onClick={onToggleMaximize} />
      <Button appearance="transparent" className={mergeClasses(s.control, s.close)} data-window-control="close" aria-label="关闭" icon={<CloseIcon />} onClick={onClose} />
    </div>
  </header>;
}

export function AppTitlebar() {
  const canBack = useReport(navigationCanBack);
  const canForward = useReport(navigationCanForward);
  const back = useReport(state => state.back);
  const forward = useReport(state => state.forward);
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    let active = true;
    let notified = false;
    const unsubscribe = window.cs2Analyst.window.onMaximizedChange(value => {
      notified = true;
      if (active) setMaximized(value);
    });
    // Subscribe first; a delayed initial response must not overwrite a newer native event.
    void window.cs2Analyst.window.isMaximized().then(value => {
      if (active && !notified) setMaximized(value);
    });
    return () => { active = false; unsubscribe(); };
  }, []);

  // Chromium's native drag region owns dragging and double-click maximize/restore.
  return <TitlebarView canBack={canBack} canForward={canForward} onBack={() => void back()} onForward={() => void forward()}
    maximized={maximized}
    onMinimize={() => void window.cs2Analyst.window.minimize()}
    onToggleMaximize={() => void window.cs2Analyst.window.toggleMaximize()}
    onClose={() => void window.cs2Analyst.window.close()} />;
}
