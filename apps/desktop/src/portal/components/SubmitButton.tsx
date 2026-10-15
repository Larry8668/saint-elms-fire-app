import { Button } from '@/components/ui/button';
import { WorkingLabel } from '@/components/ui/loading';

/**
 * Submit control that shows the repo's working indicator while a request is in flight, so a
 * slow university round-trip never reads as a frozen page. Errors surface beside the form.
 */
export function SubmitButton({ idle, busy, busyLabel = 'Working', disabled }: { idle: string; busy: boolean; busyLabel?: string; disabled?: boolean }) {
  return (
    <Button type="submit" variant="primary" className="w-full" disabled={disabled || busy}>
      {busy ? <WorkingLabel label={busyLabel} /> : idle}
    </Button>
  );
}