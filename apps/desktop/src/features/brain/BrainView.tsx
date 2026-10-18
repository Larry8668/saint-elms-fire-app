import type { BrainLogEntry, LearningEvent, PageRecordSummary } from '@sef/shared';
import { AlertTriangle, Brain, Search, FilePlus2, GraduationCap, History, Lightbulb, Link2, MessageCircleQuestion, Network, PenLine, RefreshCw, Sparkles, Waypoints, Wrench } from 'lucide-react';
import { motion } from 'motion/react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tabs } from '@/components/ui/overlays';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui/primitives';
import { CardGridSkeleton, RowListSkeleton, TimelineSkeleton } from '@/components/ui/skeletons';
import { ProposalReviewDialog } from '@/features/contribute/ProposalReviewDialog';
import { KIND_STYLE, STATUS_STYLE } from '@/lib/brain-style';
import { markdownToPlainText } from '@/lib/markdown-text';
import { useNav } from '@/lib/nav';
import { useBrainLog, useEvents, useGraph, useJobBoard, useLint, useMaintenance, useRecords, useWikiGraph, useWikiIndex } from '@/lib/queries';
import { shortDate } from '@/lib/time';
import { AskBrainPanel, type AskRequest } from './ask/AskBrainPanel';
import { BrainMapHero } from './brain-map/BrainMapHero';
import { buildSearchIndex, searchPages } from './brain-map/search';
import { ConceptSheet } from './ConceptSheet';
import { ACTOR_LABEL, EVENT_LABEL } from './GrowthTrail';
import { MaintenancePanel } from './MaintenancePanel';
import { RecordSheet } from './RecordSheet';
import { SourceDetailDialog } from './SourceDetail';
import { SourcesPanel } from './SourcesPanel';
import { Contradictions } from './story/Contradictions';
import { LearnedTimeline } from './story/LearnedTimeline';
import { WikiIndexPanel } from './WikiIndex';
import { WikiPageDialog } from './WikiPageDialog';

const LOG_ICON: Record<string, typeof Brain> = { session: MessageCircleQuestion, capture: FilePlus2, quiz: GraduationCap, wiki: History, source: History, migrate: History, remove: History, erase: History };
const EVENT_ICON: Record<LearningEvent['kind'], typeof Brain> = {
  encounter: Sparkles,
  explanation: PenLine,
  struggle: AlertTriangle,
  correction: RefreshCw,
  connection: Link2,
  application: Waypoints,
  review: GraduationCap,
};

type TimelineRow = { at: string; event: LearningEvent } | { at: string; entry: BrainLogEntry };

export function BrainView() {
  const { go, page: navPage, grown: navGrown } = useNav();
  const [tab, setTab] = useState('pages');
  const [selectedPageId, setSelectedPageId] = useState<string | null>(null);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [proposalId, setProposalId] = useState<string | null>(null);
  const records = useRecords();
  const [wikiPageId, setWikiPageId] = useState<string | null>(null);
  const log = useBrainLog();
  const events = useEvents();
  const lint = useLint();
  const maintenance = useMaintenance();
  const graph = useGraph();
  const board = useJobBoard();
  const wiki = useWikiIndex();
  const wikiGraph = useWikiGraph();
  const listRef = useRef<HTMLDivElement>(null);

  // Search: typed text echoes at once; the filter runs 150 ms after the last keystroke.
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(query), query ? 150 : 0);
    return () => clearTimeout(t);
  }, [query]);
  const searchIndex = useMemo(() => buildSearchIndex(records.data ?? [], wikiGraph.data), [records.data, wikiGraph.data]);
  // Ask your brain: the same box, switched to "Ask"; the visualization lights the cited pages.
  const [askOn, setAskOn] = useState(false);
  const [askRequest, setAskRequest] = useState<AskRequest | null>(null);
  const [askLit, setAskLit] = useState<string[]>([]);
  const closeAsk = () => {
    setAskRequest(null);
    setAskLit([]);
  };
  const askResult = useMemo(() => (askLit.length ? { ids: askLit, set: new Set(askLit) } : null), [askLit]);
  const searchResult = useMemo(() => (askOn ? null : searchPages(searchIndex, debounced)), [askOn, searchIndex, debounced]);
  // Arriving from an accepted proposal: the pages it wrote stay lit until the student searches.
  const [grown, setGrown] = useState<NonNullable<typeof navGrown> | null>(null);
  useEffect(() => {
    if (navGrown?.ids.length) setGrown(navGrown);
  }, [navGrown]);
  const grownResult = useMemo(() => (grown ? { ids: grown.ids, set: new Set(grown.ids) } : null), [grown]);
  const shownRecords = useMemo(() => (searchResult ? (records.data ?? []).filter((r) => searchResult.set.has(r.id)) : records.data), [records.data, searchResult]);

  // A node-backed page opens the sky sheet; everything else (source summaries, orphans) opens the record sheet.
  const selectedNode = useMemo(() => (selectedPageId && graph.data ? (graph.data.nodes.find((n) => n.pageId === selectedPageId) ?? null) : null), [selectedPageId, graph.data]);
  const openPage = (id: string | null) => setSelectedPageId(id);

  // The stable page anchor: #/brain?page=<pageId> opens that page's sheet.
  useEffect(() => {
    if (navPage) setSelectedPageId(navPage);
  }, [navPage]);

  const openFindings = lint.data?.length ?? 0;
  const maintenanceCount = maintenance.data?.findings.length ?? 0;
  const sourceCount = board.data?.sources.length ?? 0;

  const timeline = useMemo(() => {
    const rows: TimelineRow[] = [
      ...(events.data ?? []).map((event) => ({ at: event.at, event })),
      ...(log.data ?? []).map((entry) => ({ at: entry.at, entry })),
    ];
    return rows.sort((a, b) => b.at.localeCompare(a.at));
  }, [events.data, log.data]);

  const titleById = useMemo(() => new Map((records.data ?? []).map((r) => [r.id, r.title])), [records.data]);

  return (
    <div className="h-full overflow-y-auto">
      {/* The brain is the page: a full-screen map first, the pages themselves on scroll. */}
      <div className="relative">
        <BrainMapHero
          records={records.data}
          graph={graph.data}
          wiki={wikiGraph.data}
          loading={graph.isLoading || wikiGraph.isLoading}
          onOpen={openPage}
          onScrollToList={() => listRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
          spotlight={!askOn && !searchResult && grown ? { ...grown, onClear: () => setGrown(null) } : undefined}
          search={{
            query,
            onQuery: (q) => {
              if (q) setGrown(null);
              setQuery(q);
            },
            result: askOn ? askResult : (searchResult ?? grownResult),
            ask: {
              on: askOn,
              onToggle: (on) => {
                setAskOn(on);
                if (!on) closeAsk();
              },
              onSubmit: (question) => setAskRequest({ question, nonce: Date.now() }),
              panel: <AskBrainPanel request={askRequest} onOpenPage={openPage} onHighlight={setAskLit} onClose={closeAsk} />,
            },
          }}
        />
      </div>
      <div className="mx-auto max-w-6xl px-8 py-8">
        <div className="mt-6 mb-10 grid items-start gap-4 lg:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]">
          <LearnedTimeline onOpenPage={openPage} />
          <Contradictions onOpenPage={openPage} onOpenSource={setSourceId} />
        </div>
        <div ref={listRef} className="scroll-mt-6" />
        <PageHeader
          eyebrow="Plain markdown, on this device"
          title="Your brain"
          description="Pages for your concepts, syntheses and open questions, written in your voice from what you actually showed. The model only proposes; a deterministic validator decides what gets written, and status comes from evidence — collected material never counts as yours."
          actions={
            <Tabs
              value={tab}
              onValueChange={setTab}
              items={[
                { value: 'pages', label: `Pages${records.data ? ` · ${records.data.length}` : ''}` },
                { value: 'wiki', label: `Wiki${wiki.data ? ` · ${wiki.data.counts.pages}` : ''}` },
                { value: 'sources', label: `Sources${sourceCount ? ` · ${sourceCount}` : ''}` },
                { value: 'questions', label: `Open questions${openFindings ? ` · ${openFindings}` : ''}` },
                { value: 'maintenance', label: `Maintenance${maintenanceCount ? ` · ${maintenanceCount}` : ''}` },
                { value: 'timeline', label: 'Timeline' },
              ]}
            />
          }
        />

        {tab === 'pages' && (
          <>
            {records.isLoading && <CardGridSkeleton />}
            {records.data?.length === 0 && (
              <EmptyState
                icon={<Brain />}
                title="Nothing written yet"
                body="Talk something through with the Guide and press “Reflect into brain”, or file a note, a photo or a document — it lands here once you accept the proposal."
                action={
                  <div className="flex gap-2">
                    <Button variant="primary" onClick={() => go('teachers', { teacher: 'guide' })}>
                      <MessageCircleQuestion /> Talk to the Guide
                    </Button>
                    <Button onClick={() => go('contribute')}>
                      <FilePlus2 /> Add to my wiki
                    </Button>
                  </div>
                }
              />
            )}
            {searchResult && searchResult.ids.length === 0 && (
              <EmptyState icon={<Search />} title="Nothing matches" body={`No page's title, summary or claims mention “${debounced.trim()}”. Press Esc in the search to clear it.`} />
            )}
            <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
              {shownRecords?.map((record, i) => <PageCard key={record.id} record={record} index={i} onOpen={() => openPage(record.id)} />)}
            </div>
          </>
        )}

        {tab === 'wiki' && <WikiIndexPanel index={wiki.data} loading={wiki.isLoading} onOpen={setWikiPageId} matchIds={searchResult?.set ?? null} />}

        {tab === 'sources' && (
          <div className="max-w-2xl">
            <p className="mb-4 text-[13px] leading-6 text-night-400">
              Everything you filed, kept byte-for-byte under <code className="text-night-300">raw/</code>. Open one to see what the
              engine read from it, fix the reading, or watch its job move.
            </p>
            <SourcesPanel board={board.data} loading={board.isLoading} onOpen={setSourceId} />
          </div>
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

        {tab === 'maintenance' && (
          <div>
            {maintenance.isLoading && <RowListSkeleton />}
            {maintenance.isError && (
              <Panel className="flex items-center gap-3 p-5 text-sm text-night-300">
                <Wrench className="size-4 text-ember-400" />
                {(maintenance.error as Error).message}
              </Panel>
            )}
            {maintenance.data && (
              <MaintenancePanel
                findings={maintenance.data.findings}
                semantic={maintenance.data.semantic}
                dismissed={maintenance.data.dismissed}
                onProposal={setProposalId}
              />
            )}
          </div>
        )}

        {tab === 'timeline' && (events.isLoading || log.isLoading) && <TimelineSkeleton />}
        {tab === 'timeline' && !events.isLoading && !log.isLoading && (
          <div className="relative ml-3 border-l border-white/[0.08] pl-8">
            {timeline.length === 0 && <p className="text-sm text-night-400">Your learning log is empty.</p>}
            {timeline.map((row, i) => {
              const Icon = 'event' in row ? EVENT_ICON[row.event.kind] : (LOG_ICON[row.entry.kind] ?? History);
              return (
                <motion.div key={row.at + i} initial={{ opacity: 0, x: -6 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.03 }} className="relative pb-7">
                  <span className="absolute top-0.5 -left-[45px] grid size-7 place-items-center rounded-full border border-white/10 bg-night-900 text-beacon-300">
                    <Icon className="size-3.5" />
                  </span>
                  {'event' in row ? (
                    <>
                      <div className="text-[11.5px] text-night-500">
                        {row.event.at.slice(0, 10)} · {ACTOR_LABEL[row.event.actor]}
                        {row.event.knowledgeOnly && ' · collected, not shown'}
                      </div>
                      <button onClick={() => openPage(row.event.pageId)} className="mt-0.5 cursor-pointer text-left text-[14.5px] font-medium text-night-100 hover:text-beacon-200">
                        {EVENT_LABEL[row.event.kind]} — {titleById.get(row.event.pageId) ?? row.event.pageId}
                      </button>
                      {row.event.note && <p className="mt-1 text-[13px] leading-6 text-night-400">{row.event.note}</p>}
                    </>
                  ) : (
                    <>
                      <div className="text-[11.5px] text-night-500">{row.entry.at}</div>
                      <div className="mt-0.5 text-[14.5px] font-medium text-night-100">{row.entry.title}</div>
                      {row.entry.detail && <p className="mt-1 text-[13px] leading-6 text-night-400">{row.entry.detail}</p>}
                    </>
                  )}
                </motion.div>
              );
            })}
          </div>
        )}
      </div>
      {graph.data && (
        <ConceptSheet
          node={selectedNode}
          graph={graph.data}
          onSelect={(id) => openPage(id ? (graph.data!.nodes.find((n) => n.id === id)?.pageId ?? null) : null)}
        />
      )}
      <RecordSheet pageId={selectedPageId && !selectedNode ? selectedPageId : null} onClose={() => openPage(null)} />
      <SourceDetailDialog sourceId={sourceId} onClose={() => setSourceId(null)} onReviewProposal={setProposalId} />
      <WikiPageDialog pageId={wikiPageId} onClose={() => setWikiPageId(null)} onOpenSource={setSourceId} onOpenPage={setWikiPageId} />
      <ProposalReviewDialog proposalId={proposalId} onClose={() => setProposalId(null)} />
    </div>
  );
}

function PageCard({ record, index, onOpen }: { record: PageRecordSummary; index: number; onOpen: () => void }) {
  const status = record.status ? STATUS_STYLE[record.status] : null;
  const kindHex = record.kind === 'synthesis' || record.kind === 'question' ? KIND_STYLE[record.kind].hex : status?.hex;
  return (
    <motion.button initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ delay: index * 0.03 }} onClick={onOpen} className="text-left">
      <Panel className="flex h-full cursor-pointer flex-col p-5 transition hover:border-white/[0.14]">
        <div className="mb-3 flex items-center justify-between gap-2">
          <span className="size-2.5 rounded-full" style={{ background: kindHex ?? '#5d6a8a', boxShadow: `0 0 10px ${kindHex ?? '#5d6a8a'}` }} />
          <div className="flex gap-1.5">
            {(record.openMisconceptions ?? 0) > 0 && <Badge tone="ember">{record.openMisconceptions} open</Badge>}
            {status && <Badge tone={status.tone}>{status.label}</Badge>}
            <Badge>{record.kind === 'source_summary' ? 'source' : KIND_STYLE[record.kind].label}</Badge>
            {record.origin === 'peer' && <Badge>peer</Badge>}
          </div>
        </div>
        <h3 className="font-display text-[22px] leading-tight text-night-100">{record.title}</h3>
        <p className="mt-2 line-clamp-3 text-[13px] leading-6 text-night-400">{record.summary ? markdownToPlainText(record.summary) : 'No summary yet.'}</p>
        <div className="mt-auto pt-4 text-[11.5px] text-night-500">{shortDate(record.updatedAt)}</div>
      </Panel>
    </motion.button>
  );
}
