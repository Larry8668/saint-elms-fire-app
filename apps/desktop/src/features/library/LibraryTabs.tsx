import { useRef } from 'react';
import { cn } from '@/lib/cn';

export type LibraryTab = 'released' | 'programme';

const TABS: Array<{ id: LibraryTab; label: string }> = [
  { id: 'released', label: 'Released courses' },
  { id: 'programme', label: 'Programme' },
];

/**
 * A real tablist: one tab stop, arrow keys move between tabs, Home/End jump to the ends.
 * Without the roving tabindex a keyboard user would have to tab past every tab to leave.
 */
export function LibraryTabs({ active, onChange }: { active: LibraryTab; onChange: (tab: LibraryTab) => void }) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);

  const move = (from: number, delta: number) => {
    const next = (from + delta + TABS.length) % TABS.length;
    onChange(TABS[next]!.id);
    buttons.current[next]?.focus();
  };

  const onKeyDown = (event: React.KeyboardEvent, index: number) => {
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      move(index, -index);
    } else if (event.key === 'End') {
      event.preventDefault();
      move(index, TABS.length - 1 - index);
    }
  };

  return (
    <div role="tablist" aria-label="Library sections" className="mb-6 flex gap-1 border-b border-white/[0.07]">
      {TABS.map((tab, index) => {
        const selected = tab.id === active;
        return (
          <button
            key={tab.id}
            ref={(node) => {
              buttons.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`library-tab-${tab.id}`}
            aria-selected={selected}
            aria-controls={`library-panel-${tab.id}`}
            tabIndex={selected ? 0 : -1}
            onClick={() => onChange(tab.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            className={cn(
              '-mb-px cursor-pointer border-b-2 px-4 py-2.5 text-[13.5px] font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-beacon-400/60',
              selected
                ? 'border-beacon-400 text-night-100'
                : 'border-transparent text-night-400 hover:border-white/15 hover:text-night-200',
            )}
          >
            {tab.label}
          </button>
        );
      })}
    </div>
  );
}