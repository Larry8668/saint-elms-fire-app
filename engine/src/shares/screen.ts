import type { ProviderConfig, SharePayload, ShareScreening } from '@sef/shared';
import { errorFields, log } from '../config';
import type { SettingsReader } from '../settings/store';

/**
 * On-device screening of a peer share's payload before it is imported, and of a
 * student's own draft before it publishes. This is a single-shot model pass — not
 * a teacher, not an agent — and it is advisory by construction: `flagged` still
 * imports, `unavailable` never blocks. Code carries the verdict into the source's
 * extraction note and the review surface; the model never writes or decides
 * anything itself.
 *
 * The screened text is only the payload's own words: title, markdown body and
 * attachment *names* (a name can carry content). Sender, cohort, programme and
 * share identity never enter the prompt — the screen judges the text, not who
 * sent it.
 *
 * ShieldGemma is trained to judge one policy per prompt, and Google scores it by the
 * probability of a "Yes" first token rather than by reading its prose. So each policy
 * is its own call, and a category is flagged when P(Yes) reaches the threshold.
 */

/** Per call; four run one after another per screen. The larger tier's first call also loads the model. */
const SCREEN_TIMEOUT_MS = 90_000;
/** The model only judges a bounded excerpt — the payload caps already keep this small. */
const SCREEN_TEXT_MAX_CHARS = 8_000;
/** Google's suggested cut-off on P(Yes). */
export const FLAG_THRESHOLD = 0.5;
const TOP_LOGPROBS = 10;

/**
 * Google's published ShieldGemma policy wording. The names double as the labels surfaced
 * in the UI, so keep them short and plain.
 */
export const POLICIES: ReadonlyArray<{ name: string; rule: string }> = [
  {
    name: 'dangerous',
    rule: '"No Dangerous Content": The prompt shall not contain or seek generation of content that harming oneself and/or others (e.g., accessing or building firearms and explosive devices, promotion of terrorism, instructions for suicide).',
  },
  {
    name: 'harassment',
    rule: '"No Harassment": The prompt shall not contain or seek generation of content that is malicious, intimidating, bullying, or abusive content targeting another individual (e.g., physical threats, denial of tragic events, disparaging victims of violence).',
  },
  {
    name: 'hate speech',
    rule: '"No Hate Speech": The prompt shall not contain or seek generation of content that targeting identity and/or protected attributes (e.g., racial slurs, promotion of discrimination, calls to violence against protected groups) or dehumanizing/belittling/vilifying on the bases of race, ethnicity, religion, disability, age, nationality, veteran status, sexual orientation, gender, gender identity, caste, or any other protected status.',
  },
  {
    name: 'sexually explicit',
    rule: '"No Sexually Explicit Information": The prompt shall not contain or seek generation of content that contains references to sexual acts or other lewd content (e.g., sexually graphic descriptions, content aimed at causing arousal). Medical or scientific terms related to human anatomy or sex education are permitted.',
  },
];

/**
 * Gemma's turn and sequence markers. A payload that spelled them out could close the
 * "Human Question" turn early and write its own verdict, so they never reach the prompt.
 */
const CONTROL_MARKERS = /<\/?(?:start_of_turn|end_of_turn|bos|eos|pad)>/gi;

/** What the model is asked to judge. Attachment names are text too, so they ride along. */
export function screeningText(payload: SharePayload): string {
  const names = payload.attachments.map((a) => a.name).join('\n');
  return [payload.title, payload.markdown, names].filter(Boolean).join('\n').replace(CONTROL_MARKERS, ' ').slice(0, SCREEN_TEXT_MAX_CHARS);
}

/** ShieldGemma's trained prompt-classification template, one policy at a time. */
export function screeningPrompt(text: string, rule: string): string {
  return [
    'You are a policy expert trying to help determine whether a user prompt is in violation of the defined safety policies.',
    '',
    '<start_of_turn>',
    `Human Question: ${text}`,
    '<end_of_turn>',
    '',
    'Our safety principle is defined in the below:',
    '',
    `* ${rule}`,
    '',
    '===',
    '',
    "Does the human question violate the above principle? Your answer must start with 'Yes' or 'No'. And then walk through step by step to be sure we answer correctly.",
  ].join('\n');
}

export interface TokenLogprob {
  token: string;
  logprob: number;
}

/** P(Yes) normalised over the Yes/No pair; null when neither token is among the candidates. */
export function yesProbability(top: readonly TokenLogprob[]): number | null {
  const weight = (word: string) => top.filter((t) => t.token.trim().toLowerCase() === word).reduce((sum, t) => sum + Math.exp(t.logprob), 0);
  const yes = weight('yes');
  const no = weight('no');
  return yes + no > 0 ? yes / (yes + no) : null;
}

/** Fallback for providers without logprobs: the answer's first word, as certainty. */
export function verdictFromText(answer: string): number | null {
  const trimmed = answer.trim();
  return /^yes\b/i.test(trimmed) ? 1 : /^no\b/i.test(trimmed) ? 0 : null;
}

/** P(Yes) for one policy prompt, or null when the answer could not be read. */
export type SafetyScore = (provider: ProviderConfig, model: string, prompt: string) => Promise<number | null>;

const trimSlash = (url: string) => url.replace(/\/+$/, '');

/**
 * Stand-in for `ollamaHeaders` from `../models/registry` (PR #77): a key on an `ollama`
 * provider goes out as a bearer, which on a hosted session is the gateway token. Once #77 is
 * on main this becomes `import { ollamaHeaders } from '../models/registry'`.
 */
const ollamaHeaders = (provider: Pick<ProviderConfig, 'apiKey'>): Record<string, string> =>
  provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(SCREEN_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Screening endpoint answered HTTP ${res.status}`);
  return res.json();
}

/** Logprobs first; the text verdict only when a provider returns none. */
const scored = (top: readonly TokenLogprob[] | undefined, text: string | undefined) => (top?.length ? yesProbability(top) : null) ?? (typeof text === 'string' ? verdictFromText(text) : null);

export const defaultScore: SafetyScore = async (provider, model, prompt) => {
  const auth: Record<string, string> = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
  switch (provider.kind) {
    case 'ollama': {
      const base = trimSlash(provider.baseUrl ?? 'http://localhost:11434');
      const res = (await postJson(
        `${base}/api/chat`,
        {
          model,
          messages: [{ role: 'user', content: prompt }],
          stream: false,
          logprobs: true,
          top_logprobs: TOP_LOGPROBS,
          options: { temperature: 0, num_predict: 1 },
        },
        ollamaHeaders(provider),
      )) as { message?: { content?: string }; logprobs?: Array<{ top_logprobs?: TokenLogprob[] }> };
      return scored(res.logprobs?.[0]?.top_logprobs, res.message?.content);
    }
    case 'openai-compatible':
    case 'openai': {
      const base = provider.baseUrl ? trimSlash(provider.baseUrl) : 'https://api.openai.com/v1';
      const res = (await postJson(
        `${base}/chat/completions`,
        { model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 1, logprobs: true, top_logprobs: TOP_LOGPROBS },
        auth,
      )) as { choices?: Array<{ message?: { content?: string }; logprobs?: { content?: Array<{ top_logprobs?: TokenLogprob[] }> } }> };
      const choice = res.choices?.[0];
      return scored(choice?.logprobs?.content?.[0]?.top_logprobs, choice?.message?.content);
    }
    case 'anthropic': {
      if (!provider.apiKey) throw new Error('Anthropic providers need an API key');
      const res = (await postJson(
        `${trimSlash(provider.baseUrl ?? 'https://api.anthropic.com/v1')}/messages`,
        { model, max_tokens: 5, messages: [{ role: 'user', content: prompt }] },
        { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
      )) as { content?: Array<{ type?: string; text?: string }> };
      return scored(undefined, res.content?.find((block) => block.type === 'text')?.text);
    }
  }
};

export interface Screener {
  screen(payload: SharePayload): Promise<ShareScreening>;
}

/**
 * Resolves the `safety` role and runs one scored call per policy. Every failure mode —
 * no role, a provider the app can't reach, an unreadable answer — lands as `unavailable`
 * with a logged reason, unless another policy already flagged: the screen is never a
 * silent skip and never a thrown exception.
 */
export class ShareScreener implements Screener {
  constructor(
    private readonly settings: SettingsReader,
    private readonly score: SafetyScore = defaultScore,
  ) {}

  async screen(payload: SharePayload): Promise<ShareScreening> {
    let provider: ProviderConfig | undefined;
    let model = '';
    try {
      const settings = await this.settings.get();
      const role = settings.roles.safety;
      model = role?.model ?? '';
      provider = role ? settings.providers.find((p) => p.id === role.provider) : undefined;
    } catch (error) {
      log.warn('share_screen_settings_failed', errorFields(error));
    }
    if (!provider || !model) return { status: 'unavailable', categories: [], model };

    const started = Date.now();
    const text = screeningText(payload);
    // One policy at a time: a local runtime serves them one after another anyway, so firing all
    // four at once only lets the queued calls' timeouts run out while they wait. In order, each
    // call also reuses the cached prompt prefix (the payload comes before the policy).
    const scores: Array<number | null> = [];
    for (const policy of POLICIES) {
      try {
        scores.push(await this.score(provider, model, screeningPrompt(text, policy.rule)));
      } catch (error) {
        log.warn('share_screen_failed', { model, policy: policy.name, ...errorFields(error) });
        scores.push(null);
      }
    }
    const categories = POLICIES.filter((_, i) => (scores[i] ?? 0) >= FLAG_THRESHOLD).map((p) => p.name);
    const unread = scores.some((s) => s === null);
    const status: ShareScreening['status'] = categories.length ? 'flagged' : unread ? 'unavailable' : 'clean';
    log.info('share_screened', {
      status,
      categories,
      model,
      ms: Date.now() - started,
      scores: Object.fromEntries(POLICIES.map((p, i) => [p.name, scores[i] === null ? null : Math.round(scores[i]! * 1000) / 1000])),
    });
    return { status, categories, model };
  }
}

/** The sentence the source's extraction ledger carries so the record itself says what happened. */
export function screeningNote(screening: ShareScreening): string {
  switch (screening.status) {
    case 'flagged':
      return screening.categories.length
        ? `On-device screening flagged this share for ${screening.categories.join(', ')} — advisory only; it was imported all the same.`
        : 'On-device screening flagged this share — advisory only; it was imported all the same.';
    case 'clean':
      return 'On-device screening found nothing to flag.';
    case 'unavailable':
      return 'On-device screening was unavailable; the share was imported unchecked.';
  }
}
