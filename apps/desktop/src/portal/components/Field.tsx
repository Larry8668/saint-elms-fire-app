import { useId, type InputHTMLAttributes } from 'react';
import { Input, Label } from '@/components/ui/primitives';

/**
 * A real label bound to its input, with the error wired through `aria-describedby` so screen
 * readers announce why the submit failed rather than just refusing.
 */
export function Field({ label, error, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | null; hint?: string }) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const describedBy = [error ? errorId : null, hint ? hintId : null].filter(Boolean).join(' ') || undefined;

  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={error ? 'border-rose-400/50' : undefined}
        {...props}
      />
      {hint && (
        <p id={hintId} className="mt-1.5 text-[12px] leading-5 text-night-500">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="mt-1.5 text-[12px] leading-5 text-rose-300">
          {error}
        </p>
      )}
    </div>
  );
}