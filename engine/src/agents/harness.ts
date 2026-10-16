import { can, conceptKey, TEACHERS, teacherPolicy, type CapabilityId, type ChatRequest, type ChatStreamEvent, type SourceRef, type Verification, type VerificationCheck } from '@sef/shared';
import type { ClaimReader } from '../brain/claim-evidence';
import { WikiQuery, type WikiReader } from '../brain/query';
import type { BrainService } from '../brain/service';
import { errorFields, log } from '../config';
import { searchLessons, type LessonHit } from '../content/search';
import type { ContentStore } from '../content/store';
import { logisticsContext } from '../logistics/context';
import { extractLogistics } from '../logistics/extract';
import type { LogisticsAccess } from '../logistics/store';
import { resolveModel, type ResolvedModel } from '../models/registry';
import type { SessionStore } from '../sessions/store';
import type { SettingsReader } from '../settings/store';
import { webSearch, type WebResult } from '../web/searxng';
import { ANCHOR_FAILURE_COPY, unresolvableAnchors, type AnchorResolver, type AnchorTarget } from './anchor';
import { attributeLessons } from './attribution';
import { TurnContext } from './context';
import { buildEvidenceSet } from './evidence';
import { makeAgent } from './factory';
import { ACADEMIC_REDIRECT, classifyFriendInput, declaredAttachmentText, extractedTextLane, PRIVACY_REFUSAL } from './lanes';
import { toModelMessages } from './messages';
import { teacherInstructions } from './prompts';
import { buildTools, claimBlock } from './tools';
import { assessAnswer } from './validators';

export interface HarnessDeps {
  settings: SettingsReader;
  content: ContentStore;
  brain: BrainService;
  sessions: SessionStore;
  studentName: string;
  /** The student's wiki, so wiki claims can be filtered claim by claim. */
  claims?: ClaimReader;
  /** The same wiki under the compiled-page view the query tools and the up-front hits use. */
  wiki?: WikiReader;
  /** Defaults to the seam that resolves nothing: the Philosopher fails closed until PR-21. */
  anchors?: AnchorResolver;
  /** Committed, course-linked pages the anchor resolver may choose from. */
  committedAnchors?: Map<string, AnchorTarget>;
  /** Injectable so tests can prove a refusal happened before any model was built. */
  makeAgent?: typeof makeAgent;
  /** Injectable so tests can prove no web call was made on a refused turn. */
  searchWeb?: typeof webSearch;
  /** The student's private logistics ledger — read only under the declared capability. */
  logistics?: LogisticsAccess;
  /** Injectable so tests can drive the extraction seam without a vision model. */
  extractImage?: typeof extractLogistics;
}

const MAX_STEPS = 4;

export function anchorRefusal(reason: keyof typeof ANCHOR_FAILURE_COPY): string {
  return `${ANCHOR_FAILURE_COPY[reason]} I won't invent a starting point: take it to the Guide, or write the idea into your own wiki and I can explore from there.`;
}

function lessonBlock(title: string, hits: LessonHit[]): string {
  if (!hits.length) return `${title}: none matched this question.`;
  return `${title}:\n${hits.map((h) => `### ${h.lesson.title} (id: ${h.lesson.id}, course: ${h.lesson.courseName})\n${h.excerpt}`).join('\n\n')}`;
}

function webBlock(results: WebResult[] | null): string {
  if (results === null) return 'WEB RESULTS: web search is unavailable right now — use [course] lines only and say the web was unreachable.';
  if (!results.length) return 'WEB RESULTS: no results.';
  return `WEB RESULTS:\n${results.map((r, i) => `${i + 1}. ${r.title} — ${r.url}\n${r.snippet}`).join('\n')}`;
}

function capabilityChecks(denied: CapabilityId[]): VerificationCheck[] {
  return [
    {
      id: 'capabilities',
      label: 'Reached only what this teacher’s policy declares',
      passed: true,
      detail: denied.length ? `refused and recorded: ${denied.join(', ')}` : undefined,
    },
  ];
}

/**
 * One chat turn, end to end. Deterministic steps (policy, lanes, anchors, retrieval, validation)
 * wrap the model so the teachers' contracts hold regardless of which model is plugged in.
 *
 * Order is the safety property. Policy, capability and lane refusals are decided synchronously
 * before the first await, so nothing reaches a model — and no image bytes are handed to one —
 * until the deterministic checks have passed.
 */
export async function runChatTurn(req: ChatRequest, deps: HarnessDeps, emit: (event: ChatStreamEvent) => void): Promise<void> {
  const started = Date.now();
  const ctx = new TurnContext(emit);
  const latest = req.messages.at(-1);
  if (!latest || latest.role !== 'user') throw new Error('Last message must be from the user');
  const question = latest.content.trim();
  const attachments = latest.attachments ?? [];
  const hasImage = attachments.length > 0;

  const finish = async (
    text: string,
    resolved: ResolvedModel | null,
    checks: VerificationCheck[],
    lane?: Verification['lane'],
    sources: SourceRef[] = [...ctx.sources.values()],
    extra?: Pick<Verification, 'segments' | 'withheld'>,
  ) => {
    const verification: Verification = {
      model: resolved?.modelId ?? 'rules',
      provider: resolved?.provider.label ?? 'Deterministic lane check',
      providerKind: resolved?.provider.kind,
      sources,
      checks: [...capabilityChecks(ctx.denied), ...checks],
      toolCalls: ctx.toolCalls,
      handoff: ctx.handoff,
      lane,
      ...extra,
    };
    await deps.sessions.appendTurn(req.sessionId, req.teacher, latest, text, verification, [...ctx.lessonIds]);
    emit({ type: 'done', text, verification });
    log.info('chat_turn_done', { teacher: req.teacher, ms: Date.now() - started, sources: verification.sources.length, tools: ctx.toolCalls.length, lane });
  };

  // 1. Attachments are a declared capability, not something every teacher quietly accepts.
  if (hasImage && !can(req.teacher, 'attachment:image')) {
    ctx.recordRefusal('attachment:image');
    return finish(`${TEACHERS[req.teacher].name} cannot open images. Send that to the Guide, who works from your lessons and your notes.`, null, [{ id: 'attachment', label: 'Image attachment refused by policy', passed: true, detail: 'attachment:image not declared' }], 'refused');
  }

  // 2. Friend: deterministic boundaries, over the typed text *and* the text standing next to any
  //    image, before the bytes are ever handed over.
  if (req.teacher === 'friend') {
    const lane = classifyFriendInput({ text: question, attachmentText: declaredAttachmentText(attachments) });
    if (lane === 'privacy') return finish(PRIVACY_REFUSAL, null, [{ id: 'privacy', label: 'Privacy rule applied before the model', passed: true, detail: hasImage ? 'Image attachment checked too' : undefined }], 'refused');
    if (lane === 'academic') {
      ctx.handoff = { to: 'guide', reason: 'Academic question' };
      return finish(ACADEMIC_REDIRECT, null, [{ id: 'lane', label: 'Routed by lane check, no model call', passed: true, detail: hasImage ? 'Image attachment checked too' : undefined }], 'redirected');
    }
  }

  // 3. Anchor seam. A teacher that cannot prove where it starts says so; it does not improvise.
  const policy = teacherPolicy(req.teacher);
  if (policy.anchor !== 'none') {
    const resolution = await (deps.anchors ?? unresolvableAnchors).resolve({
      teacher: req.teacher,
      anchorPageId: req.anchorPageId,
      syllabusConceptKey: req.syllabusConceptKey,
      committed: deps.committedAnchors ?? new Map(),
    });
    if (!resolution.ok) {
      log.warn('exploration_anchor_required', { teacher: req.teacher, reason: resolution.reason });
      return finish(anchorRefusal(resolution.reason), null, [{ id: 'anchor', label: 'Refused without a committed wiki anchor', passed: true, detail: resolution.reason }], 'refused');
    }
  }

  // Context assembly: retrieval happens up front so even models weak at tool use stay grounded.
  ctx.status('Reading your lessons…');
  const pool = can(req.teacher, 'lesson:support_pool') ? await deps.content.supportLessons() : await deps.content.academicLessons();
  const hits = searchLessons(pool, question, 3);
  const sourceKind = can(req.teacher, 'lesson:support_pool') ? 'support' : 'lesson';
  for (const h of hits) ctx.addSource({ kind: sourceKind, id: h.lesson.id, title: h.lesson.title }, `${h.lesson.title}\n${h.excerpt}`);

  const blocks: string[] = [];
  if (req.teacher === 'friend') {
    blocks.push(lessonBlock('UNIVERSITY NOTES', hits));
    // The student's own logistics join only under the declared capability — Guide and
    // Philosopher never reach this store.
    if (can(req.teacher, 'context:logistics') && deps.logistics) await logisticsContext(deps.logistics, ctx);
  } else {
    blocks.push(lessonBlock('RELEASED LESSONS', hits));
    const keys = hits.flatMap((h) => h.lesson.concepts.map(conceptKey));
    if (can(req.teacher, 'context:student_brain')) ctx.contextBlocks.push(await deps.brain.contextFor(keys));
    if (can(req.teacher, 'claim:wiki_claims')) await claimBlock(req.teacher, { claims: deps.claims }, ctx);
    // Wiki-first: the compiled pages are searched before the model improvises an answer —
    // a saved synthesis is a page like any other, so a repeated question reuses it. Only
    // metadata is shown; bodies come through read_wiki_page, which marks generated pages
    // withheld so their model prose can never count as evidence.
    if (can(req.teacher, 'context:wiki_index') && deps.wiki) {
      const wikiHits = await new WikiQuery(deps.wiki).search(question, 3);
      ctx.contextBlocks.push(
        wikiHits.length
          ? `WIKI PAGES THAT ALREADY COVER THIS (read one with read_wiki_page before leaning on it; a source_summary, synthesis or question page is generated text, citable as context but never evidence):\n${wikiHits
              .map((hit) => `- [${hit.kind}] ${hit.id} — ${hit.title}: ${hit.summary}`)
              .join('\n')}`
          : 'WIKI PAGES THAT ALREADY COVER THIS: none matched — the wiki holds no worked answer for this yet.',
      );
    }
  }
  blocks.push(...ctx.contextBlocks, ...ctx.shieldedBlocks);

  let webResults: WebResult[] | null = null;
  const webConsented = req.consent?.web === true;
  if (can(req.teacher, 'tool:web_search') && policy.web === 'explicit_consent' && webConsented) {
    ctx.status('Searching the web…');
    try {
      webResults = await (deps.searchWeb ?? webSearch)((await deps.settings.get()).searxngUrl, question, 4);
      ctx.recordTool('web_search', `"${question.slice(0, 60)}" → ${webResults.length} results`);
      for (const r of webResults) ctx.addSource({ kind: 'web', id: r.url, title: r.title, url: r.url }, `${r.title}\n${r.snippet}`);
    } catch (error) {
      log.warn('web_search_unavailable', errorFields(error));
      ctx.recordTool('web_search', 'unavailable — answering from the course only');
    }
    blocks.push(webBlock(webResults));
  }

  const settings = await deps.settings.get();
  const resolved = resolveModel(settings, hasImage ? 'vision' : 'tutor');
  const instructions = `${teacherInstructions(req.teacher, deps.studentName)}\n\n---\n${blocks.join('\n\n')}`;
  const build = deps.makeAgent ?? makeAgent;
  const agent = build(req.teacher, instructions, resolved, buildTools(req.teacher, { content: deps.content, brain: deps.brain, searxngUrl: settings.searxngUrl, claims: deps.claims, wiki: deps.wiki, webConsented }, ctx));

  /**
   * A Friend image turn also proposes a logistics extraction from the attachment, in
   * parallel with the answer. The capability is declared like any other tool's; the
   * result is proposal-only — nothing it finds can touch a confirmed schedule until
   * the student confirms it. The rejection is caught here so a store failure mid-turn
   * can never crash the answer that was already earned.
   */
  const extraction =
    req.teacher === 'friend' && hasImage && can(req.teacher, 'tool:logistics') && deps.logistics
      ? (deps.extractImage ?? extractLogistics)(attachments.find((a) => a.kind === 'image')!, resolved, deps.logistics).catch((error) => {
          log.warn('logistics_extract_failed', { sessionId: req.sessionId, ...errorFields(error) });
          return null;
        })
      : null;

  ctx.status(`${TEACHERS[req.teacher].name} is thinking…`);
  const prompt = hasImage && !question ? 'What is in this image, and how does it connect to my lessons?' : question;
  const stream = await agent.stream(toModelMessages(req.messages, prompt) as never, {
    maxSteps: MAX_STEPS,
    providerOptions: resolved.providerOptions as never,
    modelSettings: { temperature: 0.4 },
  });

  // Factual content is held back until its checks pass: progress (statuses, tool calls) streams
  // immediately, the model's text does not — it is buffered, checked, then served once.
  let text = '';
  for await (const chunk of stream.textStream) text += chunk;
  text = text.trim() || "I couldn't put an answer together just now. Could you rephrase that?";

  // 4. What the model read out of an image is untrusted input. Re-classified, and never served
  //    if it reads out someone else's details. The parallel extraction judges its own text
  //    the same way; whatever it still files sits behind the student's confirmation.
  if (req.teacher === 'friend' && hasImage && extractedTextLane(text) === 'privacy') {
    log.warn('friend_image_text_refused', { sessionId: req.sessionId });
    void extraction;
    return finish(PRIVACY_REFUSAL, resolved, [{ id: 'privacy', label: 'Text extracted from the image refused by the privacy rule', passed: true }], 'refused');
  }

  ctx.status('Checking every statement against the evidence…');
  const permitted = new Set([...ctx.sources.keys()]);
  const evidence = buildEvidenceSet({
    sources: [...ctx.sources.values()],
    evidenceText: ctx.evidenceText,
    claimVerdicts: ctx.claimVerdicts,
    contextBlocks: ctx.contextBlocks,
    shieldedBlocks: ctx.shieldedBlocks,
    withheldSources: ctx.withheldSourceIds,
    proposedLogistics: ctx.proposedLogistics,
    foreignIds: (await deps.content.allLessons()).map((l) => l.id).filter((id) => !permitted.has(`lesson:${id}`) && !permitted.has(`support:${id}`)),
  });
  const assessed = assessAnswer(text, question, evidence, { teacher: req.teacher, hasImage });

  const sources = await attributeSources(assessed.text, question, [...ctx.sources.values()], deps.content);
  const verified = new Set(assessed.segments.flatMap((s) => s.sources ?? []));
  for (const s of sources) if (verified.has(s.id)) s.cited = true;

  const checks: VerificationCheck[] = [...assessed.checks];
  if (extraction) {
    const outcome = await extraction;
    const detail = !outcome
      ? 'extraction failed — nothing filed'
      : outcome.ok
        ? `${outcome.proposed.length} proposal${outcome.proposed.length === 1 ? '' : 's'} filed — confirm them under Logistics`
        : outcome.reason === 'privacy'
          ? 'image read-out refused by the privacy rule — nothing filed'
          : outcome.reason === 'nothing_found'
            ? 'no schedule entries readable — nothing filed'
            : 'extraction unavailable — nothing filed';
    ctx.recordTool('logistics_extract', detail);
    checks.push({ id: 'logistics', label: 'Notice extraction lands as a proposal until confirmed', passed: true, detail });
  }
  if (req.teacher === 'philosopher') {
    checks.push({
      id: 'web',
      label: 'Web search reachable',
      passed: !webConsented || webResults !== null,
      detail: !webConsented ? 'not consented this turn' : webResults ? `${webResults.length} results` : 'unreachable this turn',
    });
  }
  checks.push({ id: 'released-only', label: 'Only released lessons were searched', passed: true, detail: 'Unreleased lessons are never on this device' });
  if (hasImage) checks.push({ id: 'vision', label: 'Image read on-device', passed: resolved.provider.kind === 'ollama', detail: resolved.label });
  checks.push({
    id: 'provider',
    label: resolved.provider.kind === 'ollama' ? 'Answered by a model on this device' : 'Answered by a hosted provider — the question left this device',
    passed: true,
    detail: resolved.label,
  });

  // Only now does the verified text stream: the delta and the done event carry the same answer.
  emit({ type: 'delta', text: assessed.text });
  await finish(assessed.text, resolved, checks, 'answered', sources, { segments: assessed.segments, withheld: assessed.withheld });
}

/**
 * Re-scores retrieved lesson sources against the finished answer: which ones it actually drew on,
 * and the section to deep-link to. Cited sources come first; other kinds pass through untouched.
 */
async function attributeSources(answer: string, question: string, sources: SourceRef[], content: ContentStore): Promise<SourceRef[]> {
  const lessonRefs = sources.filter((s) => s.kind === 'lesson' || s.kind === 'support');
  if (!lessonRefs.length) return sources;
  try {
    const lessons = (await Promise.all(lessonRefs.map((s) => content.lesson(s.id)))).filter((l): l is NonNullable<typeof l> => Boolean(l));
    const attribution = attributeLessons(answer, question, lessons);
    const enriched = sources.map((s) => {
      const a = attribution.get(s.id);
      return a && (s.kind === 'lesson' || s.kind === 'support') ? { ...s, ...a } : s;
    });
    log.debug('sources_attributed', { cited: enriched.filter((s) => s.cited).length, retrieved: lessonRefs.length });
    return enriched.sort((a, b) => Number(Boolean(b.cited)) - Number(Boolean(a.cited)));
  } catch (error) {
    log.warn('source_attribution_failed', errorFields(error));
    return sources;
  }
}