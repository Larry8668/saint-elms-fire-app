import { X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { Button, type ButtonProps } from './button';

/**
 * An irreversible action asks twice: the first click arms the confirm chip, the second
 * commits. Nothing destructive — a withdraw, an erase — sits one accidental click away.
 */
export function ConfirmButton({
  confirmLabel,
  onConfirm,
  children,
  ...props
}: ButtonProps & { confirmLabel: string; onConfirm: () => void; children: ReactNode }) {
  const [confirming, setConfirming] = useState(false);
  if (confirming) {
    return (
      <span className="inline-flex items-center gap-1">
        <Button
          {...props}
          variant="danger"
          onClick={() => {
            setConfirming(false);
            onConfirm();
          }}
        >
          {confirmLabel}
        </Button>
        <Button variant="ghost" size={props.size} aria-label="Cancel" onClick={() => setConfirming(false)}>
          <X />
        </Button>
      </span>
    );
  }
  return (
    <Button {...props} onClick={() => setConfirming(true)}>
      {children}
    </Button>
  );
}
