import { Option, makeStyles, tokens } from '@fluentui/react-components';
import type { OptionProps } from '@fluentui/react-components';

/**
 * WinUI-inspired single-select Option: use an accent bar instead of Fluent's
 * default leading checkmark. Selection, keyboard navigation, focus and ARIA
 * remain owned by Fluent's original Option/Listbox implementation.
 */
const useStyles = makeStyles({
  option: {
    position: 'relative',
    // Reserve identical space for every row, selected or not.
    paddingLeft: '24px',
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
  },
});

export function WinOption({ className, ...props }: OptionProps) {
  const styles = useStyles();
  return <Option {...props} checkIcon={null} className={[styles.option, className].filter(Boolean).join(' ')} />;
}
