import { PAGE_SECTIONS, SECTION_TITLES, type GraphNode, type GraphResponse } from '@sef/shared';
import { AlertTriangle, BookOpen, GraduationCap, MessageCircleQuestion, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Markdown } from '@/components/Markdown';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose } from '@/components/ui/overlays';
import { Badge, Eyebrow } from '@/components/ui/primitives';
import { SectionsSkeleton } from '@/components/ui/skeletons';
import { LESSON_HEX, ORIGIN_STYLE, STATUS_STYLE } from '@/lib/brain-style';
import { useNav } from '@/lib/nav';
import { usePage } from '@/lib/queries';
import { QuizDialog } from './QuizDialog';

/** Details for one star: the student's own page, misconceptions, links and next actions. */
export function ConceptSheet({ node, graph, onSelect }: { node: GraphNode | null; graph: GraphResponse; onSelect: (id: string | null) => void }) {
  const { go } = useNav();
  const [quizOpen, setQuizOpen] = useState(false);
  const page = usePage(node?.kind === 'concept' && node.status !== 'unseen' ? (node.key ?? null) : null);

  const links = useMemo(() => {
    if (!node) return [];
    const byId = new Map(graph.nodes.map((n) => [n.id, n]));
    return graph.edges
      .filter((e) => e.source === node.id || e.target === node.id)
      .map((e) => ({ edge: e, other: byId.get(e.source === node.id ? e.target : e.source)! }))
      .filter((l) => l.other)
      .sort((a, b) => (a.edge.origin === 'course' ? 1 : 0) - (b.edge.origin === 'course' ? 1 : 0));
  }, [node, graph]);

  if (!node) return null;
  const status = STATUS_STYLE[node.status];
  const isLesson = node.kind === 'lesson';

  return (
    <>
      <Sheet open={Boolean(node)} onOpenChange={(open) => !open && onSelect(null)}>
        <div className="flex items-start justify-between gap-3 border-b border-white/[0.07] p-5">
          <div className="min-w-0">
            <Eyebrow>{isLesson ? 'Lesson' : 'Concept'} · {node.courseName}</Eyebrow>
            <h2 className="mt-1.5 font-display text-[30px] leading-tight text-night-100">{node.label}</h2>
            <div className="mt-2.5 flex flex-wrap gap-1.5">
              {isLesson ? (
                <Badge style={{ color: LESSON_HEX }}>Lesson hub</Badge>
              ) : (
                <Badge tone={status.tone}>{status.label}</Badge>
              )}
              {node.misconceptions > 0 && (
                <Badge tone="ember">
                  <AlertTriangle className="size-3" /> {node.misconceptions} open
                </Badge>
              )}
              <Badge>Semester {node.semesterNumber}</Badge>
            </div>
          </div>
          <SheetClose className="rounded-lg p-1.5 text-night-400 hover:bg-white/10 hover:text-night-100" aria-label="Close">
            <X className="size-4" />
          </SheetClose>
        </div>

        <div className="flex-1 space-y-6 overflow-y-auto p-5">
          {!isLesson && node.status === 'unseen' && (
            <p className="rounded-xl border border-white/[0.06] bg-white/[0.03] p-4 text-sm leading-6 text-night-300">
              This star is in your released courses but not in your brain yet. Talk it through with the Guide, snap your notes, or take a quick check — it lights up when you engage with it.
            </p>
          )}

          {page.isLoading && <SectionsSkeleton />}
          {page.data && (
            <div className="space-y-5">
              {PAGE_SECTIONS.map((section) =>
                page.data.sections[section] ? (
                  <section key={section}>
                    <Eyebrow className="mb-1.5">{SECTION_TITLES[section]}</Eyebrow>
                    <Markdown variant="chat">{page.data.sections[section]}</Markdown>
                  </section>
                ) : null,
              )}
              {page.data.misconceptions.length > 0 && (
                <section>
                  <Eyebrow className="mb-2">Misconceptions</Eyebrow>
                  <div className="space-y-2">
                    {page.data.misconceptions.map((m, i) => (
                      <div key={i} className={`rounded-xl border p-3 text-sm ${m.resolved ? 'border-white/[0.06] opacity-60' : 'border-ember-400/25 bg-ember-500/[0.07]'}`}>
                        <p className="text-night-200">“{m.claim}”</p>
                        <p className="mt-1 text-night-400">Course: {m.course}</p>
                        {m.resolved && <Badge tone="gold" className="mt-2">Resolved</Badge>}
                      </div>
                    ))}
                  </div>
                </section>
              )}
              <section>
                <Eyebrow className="mb-2">Evidence</Eyebrow>
                <div className="flex flex-wrap gap-1.5">
                  {page.data.evidence.map((e, i) => (
                    <Badge key={i} tone={e.kind === 'quiz' ? ((e.score ?? 0) / (e.outOf ?? 1) >= 0.7 ? 'aurora' : 'ember') : 'neutral'}>
                      {e.kind}
                      {e.kind === 'quiz' ? ` ${e.score}/${e.outOf}` : ''}
                    </Badge>
                  ))}
                </div>
              </section>
            </div>
          )}

          {links.length > 0 && (
            <section>
              <Eyebrow className="mb-2">Connected stars</Eyebrow>
              <ul className="space-y-1">
                {links.slice(0, 24).map(({ edge, other }) => (
                  <li key={edge.id}>
                    <button
                      onClick={() => onSelect(other.id)}
                      className="flex w-full cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 text-left text-sm transition hover:bg-white/[0.05]"
                    >
                      <span className="min-w-0 truncate text-night-200">{other.label}</span>
                      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-night-500">
                        {edge.type.replace('_', ' ')}
                        <span className="size-1.5 rounded-full" style={{ background: ORIGIN_STYLE[edge.origin].hex }} title={ORIGIN_STYLE[edge.origin].label} />
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="grid grid-cols-2 gap-2 border-t border-white/[0.07] p-4">
          <Button variant="primary" onClick={() => go('teachers', { teacher: 'guide', draft: isLesson ? `Walk me through "${node.label}".` : `Help me understand ${node.label}.` })}>
            <MessageCircleQuestion /> Ask the Guide
          </Button>
          {isLesson ? (
            <Button onClick={() => go('library', { lessonId: node.lessonId })}>
              <BookOpen /> Read lesson
            </Button>
          ) : (
            <Button onClick={() => setQuizOpen(true)}>
              <GraduationCap /> Quiz me
            </Button>
          )}
          {!isLesson && node.lessonId && (
            <Button variant="ghost" className="col-span-2" onClick={() => go('library', { lessonId: node.lessonId })}>
              <BookOpen /> Open the lesson that introduces it
            </Button>
          )}
        </div>
      </Sheet>
      {node.kind === 'concept' && node.key && <QuizDialog conceptKey={node.key} conceptLabel={node.label} open={quizOpen} onOpenChange={setQuizOpen} />}
    </>
  );
}
