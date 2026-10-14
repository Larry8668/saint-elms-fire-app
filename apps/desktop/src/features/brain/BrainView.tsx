import type { ConceptPage } from '@sef/shared';
import { AlertTriangle, Brain, Camera, GraduationCap, History, Lightbulb, MessageCircleQuestion, Network } from 'lucide-react';
import { motion } from 'motion/react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs } from '@/components/ui/overlays';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui/primitives';
import { CardGridSkeleton, RowListSkeleton, TimelineSkeleton } from '@/components/ui/skeletons';
import { STATUS_STYLE } from '@/lib/brain-style';
import { useNav } from '@/lib/nav';
import { useBrainLog, useGraph, useLint, usePages } from '@/lib/queries';
import { ConceptSheet } from './ConceptSheet';

const LOG_ICON: Record<string, typeof Brain> = { session: MessageCircleQuestion, capture: Camera, quiz: GraduationCap };

export function BrainView() {
  const { go } = useNav();
  const [tab, setTab] = useState('pages');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const pages = usePages();
  const log = useBrainLog();
  const lint = useLint();
  const graph = useGraph();

  const selectedNode = useMemo(() => (selectedKey && graph.data ? graph.data.nodes.find((n) => n.key === selectedKey) ?? null : null), [selectedKey, graph.data]);
  const openFindings = lint.data?.length ?? 0;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-6xl px-8 py-8">
        <PageHeader
          eyebrow="Plain markdown, on this device"
          title="Your brain"
          description="One page per concept, written in your voice from what you actually showed. The model only proposes; a deterministic validator decides what gets written, and status comes from evidence."
          actions={
            <Tabs
              value={tab}
              onValueChange={setTab}
              items={[
                { value: 'pages', label: `Pages${pages.data ? ` · ${pages.data.length}` : ''}` },
                { value: 'questions', label: `Open questions${openFindings ? ` · ${openFindings}` : ''}` },
                { value: 'timeline', label: 'Timeline' },
              ]}
            />
          }
        />

        {tab === 'pages' && (
          <>
            {pages.isLoading && <CardGridSkeleton />}
            {pages.data?.length === 0 && (
              <EmptyState
                icon={<Brain />}
                title="Nothing written yet"
                body="Talk something through with the Guide and press “Reflect into brain”, or snap a photo of your notes. Pages appear here as you learn."
                action={
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => go('teachers', { teacher: 'guide' })}>
                      <MessageCircleQuestion /> Talk to the Guide
                    </Button>
                    <Button onClick={() => go('capture')}>
                      <Camera /> Capture notes
                    </Button>
                  </div>
                }
              />
            )}
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {pages.data?.map((page, i) => <PageCard key={page.key} page={page} index={i} onOpen={() => setSelectedKey(page.key)} />)}
            </div>
          </>
        )}

        {tab === 'questions' && (
          <div className="space-y-3">
            {lint.isLoading && <RowListSkeleton />}
            {lint.data?.length === 0 && <EmptyState icon={<Lightbulb />} title="No open questions" body="No unresolved misconceptions or shaky foundations right now. Keep going." />}
            {lint.data?.map((f, i) => (
              <motion.div key={`${f.key}-${i}`} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: i * 0.04 }}>
                <Panel className="flex flex-col gap-3 p-5 md:flex-row md:items-center md:justify-between">
                  <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                      {f.kind === 'misconception' ? <AlertTriangle className="size-4 text-ember-400" /> : <Network className="size-4 text-beacon-300" />}
                      <span className="text-sm font-semibold text-night-100">{f.concept}</span>
                      <Badge tone={f.kind === 'misconception' ? 'ember' : 'beacon'}>{f.kind.replace('_', ' ')}</Badge>
                    </div>
                    <p className="text-[13.5px] leading-6 text-night-400">{f.message}</p>
                  </div>
                  <Button variant="primary" size="sm" className="shrink-0" onClick={() => go('teachers', { teacher: 'guide', draft: f.prompt })}>
                    <MessageCircleQuestion /> Work through it
                  </Button>
                </Panel>
              </motion.div>
            ))}
          </div>
        )}

        {tab === 'timeline' && log.isLoading && <TimelineSkeleton />}
        {tab === 'timeline' && !log.isLoading && (
          <div className="relative ml-3 border-l border-white/[0.08] pl-8">
            {log.data?.length === 0 && <p className="text-sm text-night-400">Your learning log is empty.</p>}
            {log.data?.map((entry, i) => {
              const Icon = LOG_ICON[entry.kind] ?? History;
              return (
                <motion.div key={`${entry.at}-${i}`} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }} className="relative pb-7">
                  <span className="absolute top-0.5 -left-[45px] grid size-7 place-items-center rounded-full border border-white/10 bg-night-900 text-beacon-300">
                    <Icon className="size-3.5" />
                  </span>
                  <div className="text-[11.5px] text-night-500">{entry.at}</div>
                  <div className="mt-0.5 text-[14.5px] font-medium text-night-100">{entry.title}</div>
                  {entry.detail && <p className="mt-1 text-[13px] leading-6 text-night-400">{entry.detail}</p>}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
      {graph.data && <ConceptSheet node={selectedNode} graph={graph.data} onSelect={(id) => setSelectedKey(id ? graph.data!.nodes.find((n) => n.id === id)?.key ?? null : null)} />}
    </div>
  );
}

function PageCard({ page, index, onOpen }: { page: ConceptPage; index: number; onOpen: () => void }) {
  const status = STATUS_STYLE[page.status];
  const open = page.misconceptions.filter((m) => !m.resolved).length;
  return (
    <motion.button initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }} onClick={onOpen} className="text-left">
      <Panel className="flex h-full cursor-pointer flex-col p-5 transition hover:border-white/[0.14]">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="size-2.5 rounded-full" style={{ background: status.hex, boxShadow: `0 0 10px ${status.hex}` }} />
          <div className="flex gap-1.5">
            {open > 0 && <Badge tone="ember">{open} open</Badge>}
            <Badge tone={status.tone}>{status.label}</Badge>
          </div>
        </div>
        <h3 className="font-display text-[22px] leading-tight text-night-100">{page.concept}</h3>
        <p className="mt-2 line-clamp-3 text-[13px] leading-6 text-night-400">{page.sections.in_my_words || 'No notes in your own words yet.'}</p>
        <div className="mt-auto flex gap-3 pt-4 text-[11.5px] text-night-500">
          <span>{page.evidence.length} evidence</span>
          <span>{page.links.length} links</span>
        </div>
      </Panel>
    </motion.button>
  );
}
