import type { ModelRole, ProviderConfig } from '@sef/shared';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Cpu, Eye, KeyRound, Plus, Search, Server, ShieldCheck, Trash2, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/overlays';
import { Badge, Eyebrow, Input, Label, PageHeader, Panel } from '@/components/ui/primitives';
import { FormSkeleton } from '@/components/ui/skeletons';
import { api, type StoredSettings } from '@/lib/api';
import { useCapability, useHealth, useSaveSettings, useSettings } from '@/lib/queries';
import { FeedsPanel } from './FeedsPanel';
import { ProactivityPanel } from './ProactivityPanel';
import { ProfilePanel } from './ProfilePanel';
import { RecommendationCard } from './RecommendationCard';
import { TeacherMetricsCard } from './TeacherMetricsCard';
import { applySuggestions, suggestionFor } from './recommendation';
import { VaultPanel } from './VaultPanel';

const ROLE_INFO: Record<ModelRole, { label: string; hint: string; icon: typeof Cpu }> = {
  tutor: { label: 'Teachers', hint: 'Chat for the Friend, Guide and Philosopher. Needs tool calling.', icon: Cpu },
  brain: { label: 'Brain keeper', hint: 'Structured proposals and quizzes. Needs JSON-schema output.', icon: Cpu },
  vision: { label: 'Vision', hint: 'Reads photos of notes and diagrams. Needs image input.', icon: Eye },
  embed: { label: 'Embeddings', hint: 'Meaning-based search over your pages and lessons. Optional — search works without it.', icon: Search },
  safety: { label: 'Safety screening', hint: 'Screens peer shares before import and drafts before publish. Advisory — it never blocks.', icon: ShieldCheck },
};

const KIND_LABEL: Record<ProviderConfig['kind'], string> = {
  ollama: 'Ollama',
  'openai-compatible': 'OpenAI-compatible (vLLM, LM Studio, uni server)',
  openai: 'OpenAI',
  anthropic: 'Anthropic',
};

export function SettingsView() {
  const settings = useSettings();
  const health = useHealth();
  const capability = useCapability();
  const save = useSaveSettings();
  const [form, setForm] = useState<StoredSettings | null>(null);

  useEffect(() => {
    if (settings.data) setForm(structuredClone(settings.data));
  }, [settings.data]);

  if (!form) return <FormSkeleton />;

  const set = <K extends keyof StoredSettings>(key: K, value: StoredSettings[K]) => setForm({ ...form, [key]: value });
  const setProvider = (id: string, patch: Partial<ProviderConfig>) => set('providers', form.providers.map((p) => (p.id === id ? { ...p, ...patch } : p)));

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-8 py-8">
        <PageHeader
          eyebrow="Plug and play"
          title="Settings"
          description="Every model role can point at any provider: Gemma on this device, a model your university hosts, or your own API key. Keys stay inside the local engine."
          actions={
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(form)}>
              Save changes
            </Button>
          }
        />

        <div className="space-y-6">
          <ProfilePanel />
          <VaultPanel />

          <Panel className="grid gap-4 p-6 md:grid-cols-2">
            <div>
              <Label>University server</Label>
              <Input value={form.uniServerUrl} onChange={(e) => set('uniServerUrl', e.target.value)} />
            </div>
            <div>
              <Label>Web search (SearXNG)</Label>
              <Input value={form.searxngUrl} onChange={(e) => set('searxngUrl', e.target.value)} />
            </div>
          </Panel>

          <section>
            <Eyebrow className="mb-3">Model roles</Eyebrow>
            {capability.data && (
              <div className="mb-3">
                <RecommendationCard capability={capability.data} settings={form} onApply={(suggestions) => set('roles', applySuggestions(form.roles, suggestions))} />
              </div>
            )}
            <div className="grid gap-3 md:grid-cols-3">
              {(Object.keys(ROLE_INFO) as ModelRole[]).map((role) => (
                <RoleCard
                  key={role}
                  role={role}
                  settings={form}
                  reachable={health.data?.models.find((m) => m.role === role)}
                  recommended={suggestionFor(role, capability.data, form)}
                  onChange={(patch) => set('roles', { ...form.roles, [role]: { ...form.roles[role], ...patch } })}
                />
              ))}
            </div>
            <Panel className="mt-3 flex items-center justify-between gap-4 p-4">
              <div>
                <div className="text-sm font-medium text-night-100">Thinking mode for the brain keeper</div>
                <div className="text-[12.5px] text-night-400">Slower, more careful proposals. Status is computed from evidence either way.</div>
              </div>
              <Switch checked={form.thinking} onCheckedChange={(v) => set('thinking', v)} />
            </Panel>
          </section>

          <ProactivityPanel value={form.proactivity} onChange={(proactivity) => set('proactivity', proactivity)} />

          <TeacherMetricsCard />

          <FeedsPanel />

          <section>
            <div className="mb-3 flex items-center justify-between">
              <Eyebrow>Providers</Eyebrow>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => set('providers', [...form.providers, { id: `provider-${form.providers.length + 1}`, kind: 'openai-compatible', label: 'New provider', baseUrl: '' }])}
              >
                <Plus /> Add provider
              </Button>
            </div>
            <div className="space-y-3">
              {form.providers.map((p) => (
                <Panel key={p.id} className="grid gap-3 p-5 md:grid-cols-[1fr_1fr_auto]">
                  <div>
                    <Label>Name</Label>
                    <Input value={p.label} onChange={(e) => setProvider(p.id, { label: e.target.value })} />
                  </div>
                  <div>
                    <Label>Type</Label>
                    <select
                      value={p.kind}
                      onChange={(e) => setProvider(p.id, { kind: e.target.value as ProviderConfig['kind'] })}
                      className="h-10 w-full rounded-xl border border-white/[0.09] bg-black/25 px-3 text-sm text-night-100 focus:border-beacon-400/60 focus:outline-none"
                    >
                      {Object.entries(KIND_LABEL).map(([k, label]) => (
                        <option key={k} value={k} className="bg-night-900">
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-end">
                    <Button variant="ghost" size="icon" disabled={form.providers.length <= 1} onClick={() => set('providers', form.providers.filter((x) => x.id !== p.id))} aria-label="Remove provider">
                      <Trash2 />
                    </Button>
                  </div>
                  <div>
                    <Label>
                      <Server className="mr-1 inline size-3" /> Base URL
                    </Label>
                    <Input value={p.baseUrl ?? ''} placeholder={p.kind === 'ollama' ? 'http://localhost:11434' : 'https://…/v1'} onChange={(e) => setProvider(p.id, { baseUrl: e.target.value })} />
                  </div>
                  <div>
                    <Label>
                      <KeyRound className="mr-1 inline size-3" /> API key {p.hasApiKey && <Badge tone="aurora" className="ml-1">saved</Badge>}
                    </Label>
                    <Input type="password" placeholder={p.hasApiKey ? '•••••••• (leave blank to keep)' : p.kind === 'ollama' ? 'not needed' : 'sk-…'} onChange={(e) => setProvider(p.id, { apiKey: e.target.value })} />
                  </div>
                </Panel>
              ))}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function RoleCard({
  role,
  settings,
  reachable,
  recommended,
  onChange,
}: {
  role: ModelRole;
  settings: StoredSettings;
  reachable?: { reachable: boolean; detail?: string };
  recommended?: string;
  onChange: (patch: { provider?: string; model?: string }) => void;
}) {
  const info = ROLE_INFO[role];
  const current = settings.roles[role];
  const models = useQuery({ queryKey: ['provider-models', current.provider], queryFn: () => api.providerModels(current.provider), retry: false });

  return (
    <Panel className="flex flex-col gap-3 p-5">
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-night-100">
            <info.icon className="size-4 text-beacon-300" /> {info.label}
          </div>
          <p className="mt-1 text-[12px] leading-5 text-night-400">{info.hint}</p>
        </div>
        {reachable &&
          (reachable.reachable ? <CheckCircle2 className="size-4 shrink-0 text-aurora-400" /> : <XCircle className="size-4 shrink-0 text-rose-400" aria-label={reachable.detail} />)}
      </div>
      <select
        value={current.provider}
        onChange={(e) => onChange({ provider: e.target.value })}
        className="h-9 rounded-lg border border-white/[0.09] bg-black/25 px-2.5 text-[13px] text-night-100 focus:outline-none"
      >
        {settings.providers.map((p) => (
          <option key={p.id} value={p.id} className="bg-night-900">
            {p.label}
          </option>
        ))}
      </select>
      <Input list={`models-${role}`} value={current.model} onChange={(e) => onChange({ model: e.target.value })} className="h-9 text-[13px]" />
      <datalist id={`models-${role}`}>
        {models.data?.models.map((m) => <option key={m} value={m} />)}
      </datalist>
      {recommended && recommended !== current.model && (
        <button type="button" className="self-start text-[11.5px] text-beacon-300 hover:text-beacon-200" onClick={() => onChange({ model: recommended })}>
          Recommended here: {recommended}
        </button>
      )}
      {reachable && !reachable.reachable && <p className="text-[11.5px] text-rose-400">{reachable.detail}</p>}
    </Panel>
  );
}
