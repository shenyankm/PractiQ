'use client';

import React, { useEffect, useRef } from 'react';
import { useFormStatus } from 'react-dom';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

type AnswerFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  disabled: boolean;
  children: React.ReactNode;
};

export function AnswerForm({ action, disabled, children }: AnswerFormProps) {
  const startedAt = useRef<number | null>(null);
  const durationInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  return (
    <form
      action={action}
      className="flex flex-col gap-3"
      onSubmit={() => {
        if (durationInputRef.current) {
          durationInputRef.current.value = String(Date.now() - (startedAt.current ?? Date.now()));
        }
      }}
    >
      {disableNativeControls(children, disabled)}
      <input ref={durationInputRef} type="hidden" name="durationMs" defaultValue="0" />
      <SubmitButton disabled={disabled} />
    </form>
  );
}

function disableNativeControls(children: React.ReactNode, disabled: boolean): React.ReactNode {
  if (!disabled) return children;

  return React.Children.map(children, (child) => {
    if (!React.isValidElement(child)) return child;

    const props = child.props as { children?: React.ReactNode };
    const shouldDisable = typeof child.type === 'string'
      && ['button', 'input', 'select', 'textarea'].includes(child.type);

    return React.cloneElement(
      child as React.ReactElement<Record<string, unknown>>,
      {
        ...(shouldDisable ? { disabled: true } : {}),
        ...(props.children ? { children: disableNativeControls(props.children, disabled) } : {})
      }
    );
  });
}

function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" disabled={disabled || pending} aria-busy={pending}>
      {pending ? (
        <>
          <Loader2 className="animate-spin" />
          提交中...
        </>
      ) : (
        '提交答案'
      )}
    </Button>
  );
}
