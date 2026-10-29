import { useEffect, useRef, useState, type ComponentProps, type ReactNode } from 'react';
import { Button, MessageBar, MessageBarActions, MessageBarBody } from '@fluentui/react-components';
import { CloseIcon } from './window-icons';

/** Remount with a new key when the message changes; timers never outlive the message. */
export function DismissibleMessageBar({ children, wrapperClassName, onDismiss, ...props }: Omit<ComponentProps<typeof MessageBar>, 'children'> & {
  children: ReactNode;
  wrapperClassName?: string;
  onDismiss?: () => void;
}) {
  const [visible, setVisible] = useState(true);
  const onDismissRef = useRef(onDismiss);
  onDismissRef.current = onDismiss;
  useEffect(() => {
    if (!visible) return;
    const timer = window.setTimeout(() => { setVisible(false); onDismissRef.current?.(); }, 5000);
    return () => window.clearTimeout(timer);
  }, [visible]);
  if (!visible) return null;
  const bar = <MessageBar {...props}>
    <MessageBarBody>{children}</MessageBarBody>
    <MessageBarActions><Button appearance="transparent" size="small" icon={<CloseIcon />}
      aria-label="关闭提示" onClick={() => { setVisible(false); onDismissRef.current?.(); }} /></MessageBarActions>
  </MessageBar>;
  return wrapperClassName ? <div className={wrapperClassName}>{bar}</div> : bar;
}
