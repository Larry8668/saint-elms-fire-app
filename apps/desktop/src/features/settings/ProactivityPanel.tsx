import { SIGNAL_KINDS, type ProactivitySettings } from '@sef/shared';
import { Switch } from '@/components/ui/overlays';
import { Eyebrow, Input, Label, Panel } from '@/components/ui/primitives';
import { KIND_LABEL } from '@/features/attention/attention';

/** Edits the form only; the page's Save writes it like every other setting. */
export function ProactivityPanel({ value, onChange }: { value: ProactivitySettings; onChange: (next: ProactivitySettings) => void }) {
  const quiet = value.quietHours;
  return (
    <section>
      <Eyebrow className="mb-3">Attention</Eyebrow>
      <Panel className="space-y-5 p-5">
        <Toggle
          title="Nudges"
          hint="Deadlines, course updates, shares and wiki reviews the engine notices on its own. Computed on this device — nothing is sent anywhere."
          checked={value.nudges}
          onChange={(nudges) => onChange({ ...value, nudges })}
        />
        <div className="space-y-3">
          <Toggle
            title="Quiet hours"
            hint="Items are still recorded, just not highlighted. A deadline less than a day away always gets through."
            checked={quiet.enabled}
            onChange={(enabled) => onChange({ ...value, quietHours: { ...quiet, enabled } })}
          />
          {quiet.enabled && (
            <div className="grid max-w-xs grid-cols-2 gap-3">
              <div>
                <Label htmlFor="quiet-start">From</Label>
                <Input id="quiet-start" type="time" value={quiet.start} onChange={(e) => onChange({ ...value, quietHours: { ...quiet, start: e.target.value } })} />
              </div>
              <div>
                <Label htmlFor="quiet-end">Until</Label>
                <Input id="quiet-end" type="time" value={quiet.end} onChange={(e) => onChange({ ...value, quietHours: { ...quiet, end: e.target.value } })} />
              </div>
            </div>
          )}
        </div>
        {value.nudges && (
          <div className="grid gap-2 sm:grid-cols-3">
            {SIGNAL_KINDS.map((kind) => (
              <label key={kind} className="flex items-center justify-between gap-2 rounded-lg border border-white/[0.06] px-3 py-2 text-[12.5px] text-night-200">
                {KIND_LABEL[kind]}
                <Switch checked={value.kinds[kind] !== false} onCheckedChange={(on) => onChange({ ...value, kinds: { ...value.kinds, [kind]: on } })} />
              </label>
            ))}
          </div>
        )}
      </Panel>
    </section>
  );
}

function Toggle({ title, hint, checked, onChange }: { title: string; hint: string; checked: boolean; onChange: (value: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div>
        <div className="text-sm font-medium text-night-100">{title}</div>
        <div className="text-[12.5px] text-night-400">{hint}</div>
      </div>
      <Switch checked={checked} onCheckedChange={onChange} />
    </div>
  );
}
