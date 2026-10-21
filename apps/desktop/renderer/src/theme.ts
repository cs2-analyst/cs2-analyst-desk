import { makeStaticStyles, webDarkTheme } from '@fluentui/react-components';
import type { Theme } from '@fluentui/react-components';

/**
 * P5.4 presentation palette: a restrained deep blue-grey system.
 *
 * This is the single place where the report page defines fixed colours. Components read
 * them either through the Fluent UI tokens below (`tokens.colorNeutral*`) or through
 * `palette` inside `makeStyles`, so the renderer never scatters magic colour values.
 * No Analytics / Findings / DTO semantics are involved — this file is presentation only.
 */
export const palette = {
  /** Page background: deep blue-grey, slightly lighter at the top. */
  pageTop: '#161d26',
  pageBottom: '#111821',
  pageGradient: 'linear-gradient(180deg, #161d26 0%, #111821 100%)',
  /** Cards sit one level above the page; inputs and overlays one level above cards. */
  card: '#1d242e',
  cardHover: '#222b36',
  raised: '#232c38',
  raisedHover: '#28313e',
  /** Very weak blue-grey borders: cards, dividers and rows share one family. */
  border: 'rgba(148, 163, 184, 0.12)',
  borderStrong: 'rgba(148, 163, 184, 0.22)',
  rowDivider: 'rgba(148, 163, 184, 0.08)',
  /** Text stays white / neutral grey. */
  text: '#e8eef6',
  textSecondary: '#c5cfdc',
  textMuted: '#8f9db0',
  /** Scrollbar thumbs use the same blue-grey as muted text. */
  scrollbarThumb: 'rgba(143, 157, 176, 0.28)',
  scrollbarThumbHover: 'rgba(143, 157, 176, 0.46)',
  scrollbarThumbActive: 'rgba(143, 157, 176, 0.62)',
  scrollbarThumbFallback: 'rgba(143, 157, 176, 0.36)',
  currentPlayer: '#62abf5',
  performance: { win: '#78c99a', loss: '#ef8d96', strong: '#39d6bb', weak: '#f0788b' },
  heatmap: { positions: '#54c8f0', kills: '#f8c45a', deaths: '#f27896' },
  replay: { ct: '#62abf5', t: '#ffb13b', unknown: '#8f9db0', selection: '#ffffff', bomb: '#ffe08a', surface: '#111821' },
  /** Colours reserved for the utility icons; every one is a visual anchor, not a data encoding. */
  utility: {
    flashbang: '#4DB6FF',
    smoke: '#B9C7D9',
    he: '#FF5A36',
    incendiary: '#FF8A1F',
    molotov: '#FFB13B',
    decoy: '#57D68D',
  },
} as const;

/** Global selectors cover page, nested scroll regions and Fluent portals alike. */
export const useScrollbarStyles = makeStaticStyles({
  '::-webkit-scrollbar': { width: '10px', height: '10px' },
  '::-webkit-scrollbar-track': { backgroundColor: 'transparent' },
  '::-webkit-scrollbar-thumb': {
    backgroundColor: palette.scrollbarThumb,
    border: '2px solid transparent',
    backgroundClip: 'padding-box',
    borderRadius: '999px',
  },
  '::-webkit-scrollbar-thumb:hover': { backgroundColor: palette.scrollbarThumbHover },
  '::-webkit-scrollbar-thumb:active': { backgroundColor: palette.scrollbarThumbActive },
  '::-webkit-scrollbar-corner': { backgroundColor: 'transparent' },
  '::-webkit-scrollbar-button': { display: 'none', width: 0, height: 0 },
  // Non-auto standard properties override WebKit styling in Chromium. Keep the
  // Firefox fallback isolated so Electron retains the 10px hit area and states.
  '@supports not selector(::-webkit-scrollbar)': {
    '*': { scrollbarWidth: 'thin', scrollbarColor: `${palette.scrollbarThumbFallback} transparent` },
  },
});

/**
 * Desktop shell lock: the document itself never scrolls. The titlebar, sidebar and
 * main view fill the window exactly; every scrollable region lives inside a panel.
 */
export const useAppShellStyles = makeStaticStyles({
  'html, body, #root': { height: '100%' },
  'html, body': { overflow: 'hidden', overscrollBehavior: 'none' },
});

/**
 * Fluent UI neutral tokens re-pointed at the blue-grey palette so every Fluent component
 * (Card, Divider, Badge, Dropdown, Tooltip, MessageBar, Spinner) inherits the same system.
 * Brand and status ramps stay as `webDarkTheme` defines them: colour appears only on the
 * utility icons, severity / clutch badges and a few interaction states.
 */
export const coachTheme: Theme = {
  ...webDarkTheme,
  colorNeutralBackground1: palette.card,
  colorNeutralBackground1Hover: palette.cardHover,
  colorNeutralBackground1Pressed: palette.pageTop,
  colorNeutralBackground1Selected: palette.cardHover,
  colorNeutralBackground2: palette.pageBottom,
  colorNeutralBackground2Hover: palette.raised,
  colorNeutralBackground2Pressed: palette.pageTop,
  colorNeutralBackground3: palette.raised,
  colorNeutralBackground3Hover: palette.raisedHover,
  colorNeutralBackground3Pressed: palette.pageTop,
  colorNeutralBackground4: palette.raised,
  colorNeutralBackground4Hover: palette.raisedHover,
  colorNeutralBackground4Pressed: palette.pageTop,
  colorNeutralStroke1: palette.borderStrong,
  colorNeutralStroke1Hover: 'rgba(148, 163, 184, 0.32)',
  colorNeutralStroke2: palette.border,
  colorNeutralStroke3: palette.rowDivider,
  colorNeutralStrokeAccessible: palette.textSecondary,
  colorNeutralForeground1: palette.text,
  colorNeutralForeground1Hover: palette.text,
  colorNeutralForeground2: palette.textSecondary,
  colorNeutralForeground2Hover: palette.text,
  colorNeutralForeground2Pressed: palette.text,
  colorNeutralForeground3: palette.textMuted,
  colorNeutralForeground3Hover: palette.textSecondary,
  colorNeutralForeground3Pressed: palette.textSecondary,
  colorNeutralForeground4: '#7b8a9d',
  colorNeutralForegroundDisabled: '#5f6c7c',
  colorNeutralBackgroundDisabled: palette.pageTop,
  colorNeutralStrokeDisabled: palette.rowDivider,
  colorSubtleBackground: 'transparent',
  colorSubtleBackgroundHover: 'rgba(148, 163, 184, 0.10)',
  colorSubtleBackgroundPressed: 'rgba(148, 163, 184, 0.16)',
  colorSubtleBackgroundSelected: 'rgba(148, 163, 184, 0.14)',
  colorTransparentBackground: 'transparent',
  colorTransparentStroke: 'transparent',
};
