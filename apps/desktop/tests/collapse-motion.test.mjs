import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const css = read('../renderer/src/collapse-motion.css');
// Assertions must target executable rules, never text that happens to appear in a comment.
const cssRules = css.replace(/\/\*[\s\S]*?\*\//g, '');
const main = read('../renderer/src/main.tsx');
const sidebar = read('../renderer/src/sidebar.tsx');

test('collapse stylesheet is progressive and targets the supported Chromium features', () => {
  assert.ok(!css.startsWith('\uFEFF'), 'CSS 不能带 BOM');
  assert.ok(cssRules.includes('@supports (interpolate-size: allow-keywords)'), '缺少 interpolate-size 特性检测');
  assert.ok(cssRules.includes('@supports selector(::details-content)'), '缺少 ::details-content 特性检测');
  assert.ok(cssRules.includes('transition-behavior: allow-discrete'), '缺少 allow-discrete');
  assert.ok(cssRules.includes('details::details-content'), '没有覆盖原生 details 内容');
  assert.ok(cssRules.includes('details[open]::details-content'), '没有声明打开态');
  assert.ok(cssRules.includes('block-size: 0') && cssRules.includes('block-size: auto'), '没有使用自适应高度动画');
  assert.ok(cssRules.includes('content-visibility: hidden') && cssRules.includes('content-visibility: visible'), '没有管理可访问内容可见性');
  assert.ok(cssRules.includes('visibility: hidden') && cssRules.includes('visibility: visible'), '没有把关闭内容移出焦点顺序');
  assert.ok(cssRules.includes('visibility 220ms'), 'visibility 没有随关闭动画一起过渡');
  assert.ok(cssRules.includes('overflow: clip'), '没有裁切动画中的溢出内容');
  assert.match(cssRules, /220ms/, '目标时长应约为 220ms');
});

test('round timeline uses a 0fr -> 1fr grid instead of a fixed height', () => {
  assert.ok(cssRules.includes('.timeline-collapse'), '缺少时间线动画类');
  assert.ok(cssRules.includes('grid-template-rows: 0fr') && cssRules.includes('grid-template-rows: 1fr'), '没有使用 0fr -> 1fr');
  assert.ok(cssRules.includes('.timeline-collapse > .timeline-collapse-inner'), '缺少内部裁切层');
  assert.ok(cssRules.includes('min-height: 0'), '网格子项必须允许收缩到 0');
  assert.ok(!/(^|\n)\s*(height|max-height)\s*:\s*\d/.test(cssRules), '不得使用固定高度/最大高度制造动画');
});

test('reduced motion removes transitions and resets the sidebar transition', () => {
  const reduced = cssRules.slice(cssRules.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(reduced.includes('details::details-content'));
  assert.ok(reduced.includes('transition: none !important'));
  assert.ok(reduced.includes('.timeline-collapse'));
  assert.ok(reduced.includes('[data-app-sidebar]'));
  assert.ok(reduced.includes('transition-duration: 0.01ms !important'));
});

test('forced colours keep state visible without opacity-only signalling', () => {
  const forced = cssRules.slice(cssRules.indexOf('@media (forced-colors: active)'), cssRules.indexOf('@media (prefers-reduced-motion: reduce)'));
  assert.ok(forced.includes('details::details-content'));
  assert.ok(forced.includes('opacity: 1 !important'));
  assert.ok(forced.includes('.timeline-collapse'));
  assert.ok(forced.includes('outline: 2px solid Highlight'));
});

test('timeline disclosure removes focus immediately and unmounts after the transition', () => {
  assert.ok(main.includes("import './collapse-motion.css';"), 'main.tsx 没有导入折叠样式');
  assert.ok(main.includes('function TimelineCollapse('), '缺少时间线 Collapse 组件');
  assert.ok(main.includes('inert={!open || !visible}'), '关闭中或尚未展开的内容必须 inert');
  assert.ok(main.includes('data-timeline-collapse'), '缺少可测试的动画状态');
  assert.ok(main.includes('onTransitionEnd'), '关闭后没有等待过渡结束');
  assert.ok(main.includes('grid-template-rows'), '关闭阶段没有依据过渡事件清理');
  assert.ok(main.includes("prefers-reduced-motion: reduce"), '缺少 reduced-motion 快速路径');
  assert.ok(main.includes('requestAnimationFrame'), '新挂载内容没有先提交收起态');
  assert.ok(main.includes('<TimelineCollapse open={open}>'), '时间线没有使用 Collapse 容器');
  assert.equal(main.includes('{open ? <div className={s.timelineDetail}'), false, '旧的瞬间展开分支仍在');
});

test('sidebar keeps its width transition and gains a reduced-motion aware duration', () => {
  assert.ok(sidebar.includes("transitionProperty: 'width'"));
  assert.ok(sidebar.includes("transitionDuration: '200ms'"));
  assert.ok(sidebar.includes('cubic-bezier(0.2, 0, 0, 1)'));
  assert.ok(cssRules.includes('[data-app-sidebar]'));
});
