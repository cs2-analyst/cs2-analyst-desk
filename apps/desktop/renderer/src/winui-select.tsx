import type { ComponentProps, ReactNode } from 'react';
import { Dropdown } from '@fluentui/react-components';
import { WinOption } from './winui-option';

/** One row of a WinSelect list. `text` is the plain label used for the trigger and type-ahead. */
export type WinSelectItem = { value: string; text: string; label?: ReactNode };

export type WinSelectProps = Omit<ComponentProps<typeof Dropdown>, 'children' | 'value' | 'selectedOptions' | 'onOptionSelect' | 'defaultValue' | 'defaultSelectedOptions'> & {
  items: readonly WinSelectItem[];
  /** Selected option value. Every rendered item must be findable by its value. */
  value: string;
  onValueChange: (value: string) => void;
};

/**
 * The application's single-select control: Fluent's Dropdown behaviour (focus, keyboard, ARIA,
 * portalled listbox) with the shared WinUI option styling. Use this instead of Fluent's native
 * `Select` so every selector in the app opens the same in-app listbox.
 */
export function WinSelect({ items, value, onValueChange, ...rest }: WinSelectProps) {
  const selected = items.find(item => item.value === value);
  return <Dropdown {...rest}
    value={selected?.text ?? ''}
    selectedOptions={[value]}
    onOptionSelect={(_, data) => {
      if (data.optionValue !== undefined && data.optionValue !== value) onValueChange(data.optionValue);
    }}>
    {items.map(item => <WinOption key={item.value} value={item.value} text={item.text} data-value={item.value}>
      {item.label ?? item.text}
    </WinOption>)}
  </Dropdown>;
}
