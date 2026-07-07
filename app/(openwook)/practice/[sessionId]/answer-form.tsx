'use client';
import { Loader2 } from 'lucide-react';
import { useFormStatus } from 'react-dom';

import { useEffect, useRef, type ReactNode } from 'react';
import { Button } from '@heroui/react/button';

type AnswerFormProps = {
  action: (formData: FormData) => void | Promise<void>;
  disabled: boolean;
  children: ReactNode;
};

export function AnswerForm({ action, disabled, children }: AnswerFormProps) {
  const startedAt = useRef<number | null>(null);
  const fieldsetRef = useRef<HTMLFieldSetElement>(null);
  const durationInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    startedAt.current = Date.now();
  }, []);

  useEffect(() => {
    const fieldset = fieldsetRef.current;
    if (!fieldset) return;

    fieldset.querySelectorAll<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | HTMLButtonElement>('input, textarea, select, button')
      .forEach((element) => {
        element.disabled = disabled;
      });
  }, [disabled]);


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
      <fieldset ref={fieldsetRef} disabled={disabled} className="contents">
        {children}
        <SubmitButton disabled={disabled} />
      </fieldset>
      <input ref={durationInputRef} type="hidden" name="durationMs" defaultValue="0" />
    </form>
  );
}


function SubmitButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus();

  return (
    <Button type="submit" isDisabled={disabled || pending} aria-busy={pending}>
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
