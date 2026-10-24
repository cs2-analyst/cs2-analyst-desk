import type { ComponentProps, CSSProperties, ReactNode } from 'react';
import { Dropdown, OptionGroup, makeStyles, mergeClasses, resolveShorthand } from '@fluentui/react-components';
import { WinOption } from './winui-option';

/** One row of a WinSelect list. `text` is the plain label used for the trigger and type-ahead. */
export type WinSelectItem = { value: string; text: string; label?: ReactNode };

/** Group of WinSelect items with an optional header label. */
export type WinSelectGroup = { label?: string; items: readonly WinSelectItem[] };

const useStyles = makeStyles({
  root: {
    width: '190px',
    minWidth: 0,
    flexShrink: 0,
  },
  button: {
    minWidth: 0,
    gridTemplateColumns: '[content] minmax(0, 1fr) [icon] auto [end]',
  },
  value: {
    display: 'block',
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  listbox: {
    // Fluent positioning writes inline max-height; keep our cap in CSS and customize its variable.
    maxHeight: 'var(--winselect-max-height, min(320px, calc(100vh - 96px))) !important',
    overflowY: 'auto',
  },
});

export type WinSelectProps = Omit<ComponentProps<typeof Dropdown>, 'children' | 'value' | 'selectedOptions' | 'onOptionSelect' | 'defaultValue' | 'defaultSelectedOptions' | 'listbox'> & {
  /** Flat list of items, or grouped items with optional group labels. */
  items: readonly WinSelectItem[] | readonly WinSelectGroup[];
  /** Selected option value. Every rendered item must be findable by its value. */
  value: string;
  onValueChange: (value: string) => void;
  /** Custom max height for the listbox. Defaults to 'min(320px, calc(100vh - 96px))'. */
  maxHeight?: string;
  /** Listbox slot props; style.maxHeight takes precedence over maxHeight. */
  listbox?: ComponentProps<typeof Dropdown>['listbox'];
};

/**
 * The application's single-select control: Fluent's Dropdown behaviour (focus, keyboard, ARIA,
 * portalled listbox) with the shared WinUI option styling. Use this instead of Fluent's native
 * `Select` so every selector in the app opens the same in-app listbox.
 */
export function WinSelect({ items, value, onValueChange, maxHeight, listbox, className, button, ...rest }: WinSelectProps) {
  const styles = useStyles();
  const isGrouped = items.length > 0 && 'items' in items[0];
  const allItems = isGrouped
    ? (items as readonly WinSelectGroup[]).flatMap(group => group.items)
    : items as readonly WinSelectItem[];
  const selected = allItems.find(item => item.value === value);
  const customButton = resolveShorthand(button, { required: true });

  const customListbox = resolveShorthand(listbox, { required: true });
  const height = customListbox?.style?.maxHeight ?? maxHeight;
  const listboxProps = listbox === null ? null : {
    ...customListbox,
    className: mergeClasses(styles.listbox, customListbox?.className),
    style: {
      ...customListbox?.style,
      '--winselect-max-height': typeof height === 'number' ? `${height}px` : height,
    } as CSSProperties,
  };

  return <Dropdown {...rest}
    className={mergeClasses(styles.root, className)}
    button={{
      ...customButton,
      className: mergeClasses(styles.button, customButton?.className),
      children: customButton?.children ?? <span className={styles.value}>{selected?.text || rest.placeholder}</span>,
    }}
    value={selected?.text ?? ''}
    selectedOptions={[value]}
    listbox={listboxProps}
    onOptionSelect={(_, data) => {
      if (data.optionValue !== undefined && data.optionValue !== value) onValueChange(data.optionValue);
    }}>
    {isGrouped
      ? (items as readonly WinSelectGroup[]).map((group, groupIndex) =>
          group.label
            ? <OptionGroup key={groupIndex} label={group.label}>
                {group.items.map(item => <WinOption key={item.value} value={item.value} text={item.text} data-value={item.value}>
                  {item.label ?? item.text}
                </WinOption>)}
              </OptionGroup>
            : group.items.map(item => <WinOption key={item.value} value={item.value} text={item.text} data-value={item.value}>
                {item.label ?? item.text}
              </WinOption>)
        )
      : allItems.map(item => <WinOption key={item.value} value={item.value} text={item.text} data-value={item.value}>
          {item.label ?? item.text}
        </WinOption>)
    }
  </Dropdown>;
}
