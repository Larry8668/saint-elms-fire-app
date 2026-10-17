import type { DeviceCapability, TieredRole } from '@sef/shared';
import { Gauge, X } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Panel } from '@/components/ui/primitives';
import type { StoredSettings } from '@/lib/api';
import { describeDevice, dismissCard, isCardDismissed, pendingSuggestions, type RoleSuggestion } from './recommendation';

const ROLE_NAME: Record<TieredRole, string> = { tutor: 'Teachers', brain: 'Brain keeper', vision: 'Vision' };

const browserStorage = (): Storage | undefined => {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
};

/** Advisory: "Use these" fills the form; nothing changes until the student saves. */
export function RecommendationCard({
  capability,
  settings,
  onApply,
}: {
  capability: DeviceCapability;
  settings: StoredSettings;
  onApply: (suggestions: RoleSuggestion[]) => void;
}) {
  const [dismissed, setDismissed] = useState(() => isCardDismissed(browserStorage(), capability));
  const suggestions = pendingSuggestions(capability, settings);
  if (dismissed || suggestions.length === 0) return null;

  return (
    <Panel className="flex flex-col gap-3 border-beacon-400/25 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-night-100">
            <Gauge className="size-4 text-beacon-300" /> Recommended for this device
          </div>
          <p className="mt-1 text-[12px] text-night-400">{describeDevice(capability)}. Bigger brain models write better proposals but take noticeably longer.</p>
        </div>
        <Button
          variant="ghost"
          size="icon"
          aria-label="Dismiss recommendation"
          onClick={() => {
            dismissCard(browserStorage(), capability);
            setDismissed(true);
          }}
        >
          <X />
        </Button>
      </div>
      <ul className="space-y-1.5 text-[12.5px] text-night-300">
        {suggestions.map((s) => (
          <li key={s.role}>
            <span className="text-night-100">{ROLE_NAME[s.role]}</span>: {s.current} → <span className="text-beacon-200">{s.suggested}</span>{' '}
            <code className="ml-1 rounded bg-black/30 px-1.5 py-0.5 text-[11px] text-night-400">ollama pull {s.suggested}</code>
          </li>
        ))}
      </ul>
      <div>
        <Button variant="outline" size="sm" onClick={() => onApply(suggestions)}>
          Use these (then save)
        </Button>
      </div>
    </Panel>
  );
}
