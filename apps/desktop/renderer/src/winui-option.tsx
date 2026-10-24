import { Option, makeStyles, tokens, Tooltip } from '@fluentui/react-components';
import type { OptionProps } from '@fluentui/react-components';
import { useRef, useState, useEffect } from 'react';

/**
 * WinUI-inspired single-select Option: use an accent bar instead of Fluent's
 * default leading checkmark. Selection, keyboard navigation, focus and ARIA
 * remain owned by Fluent's original Option/Listbox implementation.
 */
const useStyles = makeStyles({
  option: {
    position: 'relative',
    // Ellipsis removes the flex item's intrinsic minimum height; scroll the list instead of shrinking rows.
    flexShrink: 0,
    // Reserve identical space for every row, selected or not.
    paddingLeft: '24px !important',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    '::before': {
      content: '""',
      position: 'absolute',
      left: '6px',
      top: '50%',
      width: '3px',
      height: '16px',
      borderRadius: '999px',
      transform: 'translateY(-50%)',
      backgroundColor: tokens.colorBrandBackground,
      opacity: 0,
      pointerEvents: 'none',
    },
    '&[aria-selected="true"]': {
      backgroundColor: tokens.colorNeutralBackground1Selected,
    },
    '&[aria-selected="true"]::before': {
      opacity: 1,
    },
    '@media (forced-colors: active)': {
      '::before': {
        // Background fills are forced to Canvas; a foreground border stays visible.
        backgroundColor: 'transparent',
        borderLeftColor: 'currentColor',
        borderLeftStyle: 'solid',
        borderLeftWidth: '3px',
        boxSizing: 'border-box',
      },
    },
  },
  content: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    minWidth: 0,
    display: 'block',
  },
});

export function WinOption({ className, children, text, ...props }: OptionProps & { 'data-value'?: string }) {
  const styles = useStyles();
  const contentRef = useRef<HTMLSpanElement>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [tooltipVisible, setTooltipVisible] = useState(false);
  const optionText = text ?? (typeof children === 'string' || typeof children === 'number' ? String(children) : '');

  useEffect(() => {
    const element = contentRef.current;
    if (!element) return;

    const checkOverflow = () => {
      setIsOverflowing(element.scrollWidth > element.clientWidth);
    };

    checkOverflow();
    const observer = new ResizeObserver(checkOverflow);
    observer.observe(element);

    return () => observer.disconnect();
  }, [children, optionText]);

  // Keep the Option mounted when overflow changes, preserving Fluent's option registration.
  return <Tooltip content={optionText ?? ''} relationship="description" withArrow
    visible={isOverflowing && !!optionText && tooltipVisible}
    onVisibleChange={(_, data) => setTooltipVisible(data.visible)}>
    <Option {...props} text={optionText} checkIcon={null} className={[styles.option, className].filter(Boolean).join(' ')}>
      <span ref={contentRef} className={styles.content}>{children}</span>
    </Option>
  </Tooltip>;
}
