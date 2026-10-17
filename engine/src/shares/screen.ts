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
 */

const SCREEN_TIMEOUT_MS = 30_000;
/** The model only judges a bounded excerpt — the payload caps already keep this small. */
const SCREEN_TEXT_MAX_CHARS = 8_000;

/**
 * Harm categories, worded as ShieldGemma policies. The names double as the labels
 * surfaced in the UI, so keep them short and plain.
 */
const POLICIES: ReadonlyArray<{ name: string; rule: string }> = [
  { name: 'harassment', rule: 'content that is malicious, intimidating, bullying, or abusive toward a person or group' },
  { name: 'hate speech', rule: 'content that expresses, incites, or promotes hate based on race, gender, ethnicity, religion, nationality, sexual orientation, disability, or caste' },
  { name: 'sexually explicit', rule: 'sexually explicit or pornographic content' },
  { name: 'dangerous', rule: 'content that promotes, facilitates, or instructs in dangerous, illegal, or self-harming activities' },
];

/** What the model is asked to judge. Attachment names are text too, so they ride along. */
export function screeningText(payload: SharePayload): string {
  const names = payload.attachments.map((a) => a.name).join('\n');
  return [payload.title, payload.markdown, names].filter(Boolean).join('\n').slice(0, SCREEN_TEXT_MAX_CHARS);
}

/** ShieldGemma's trained contract: the policy list goes in the prompt, the answer starts "Yes" or "No". */
export function screeningPrompt(text: string): string {
  const policies = POLICIES.map((p, i) => `${i + 1}. "${p.name}": ${p.rule}`).join('\n');
  return [
    'You are a policy expert trying to help determine whether the content below violates the defined safety policies.',
    '',
    '<start_of_turn>',
    text,
    '<end_of_turn>',
    '',
    'Our safety policies are:',
    policies,
    '',
    'Does the content violate any of the policies above? Your answer must start with "Yes" or "No". If "Yes", then name every policy it violates.',
  ].join('\n');
}

/** First token decides the verdict; policy names claimed affirmatively become the categories. */
export function readScreeningAnswer(answer: string, model: string): ShareScreening {
  const trimmed = answer.trim();
  const verdict = /^yes\b/i.test(trimmed) ? 'flagged' : /^no\b/i.test(trimmed) ? 'clean' : null;
  if (!verdict) {
    log.warn('share_screen_unparseable', { head: trimmed.slice(0, 80) });
    return { status: 'unavailable', categories: [], model };
  }
  if (verdict === 'clean') return { status: 'clean', categories: [], model };
  const categories = POLICIES.filter((p) => claimsViolation(trimmed, p.name)).map((p) => p.name);
  return { status: 'flagged', categories, model };
}

const NEGATION = /\b(no|not|nor|never|neither|without|doesn'?t|don'?t|isn'?t|aren'?t|didn'?t|won'?t|wasn'?t|lack\w*|free\s+of)\b/;
const VERB = /\b(violat\w*|contain\w*|is|are|was|were|be|been|being|has|have|had|promot\w*|includ\w*|breach\w*|target\w*|express\w*|incit\w*|facilitat\w*|instruct\w*|constitut\w*|qualif\w*|fall\w*|count\w*|amount\w*|warrant\w*)\b/;
const RESTATEMENT = /polic|guideline|categor|definition/;

/**
 * A policy is attributed only when its name is *claimed*, not merely mentioned:
 * a clause that negates it ("no hate speech"), a bare list item trailing a
 * negated verb ("does not contain harassment, dangerous content"), a restated
 * policy list ("our policies are …"), or a `name:` definition head (the prompt's
 * own `"harassment": <rule>` shape, quoted or not) does not count — so a chatty
 * or echoing model cannot flag every category at once. Contrast markers
 * ("but", "however") reopen the claim ("not X but Y" attributes Y). A bare name
 * — bullet, heading or otherwise — still counts as a claim; anything ambiguous
 * drops to a flagged verdict with no categories rather than a wrong one.
 */
function claimsViolation(answer: string, name: string): boolean {
  // Contrast words are kept as split delimiters so "not A but B" re-evaluates B.
  const parts = answer.toLowerCase().split(/([,;.!?\n]+|\bbut\b|\bhowever\b|\byet\b)/);
  let carriedNegation = false;
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i]!.trim();
    if (!clause) continue;
    if (i > 0 && /^(but|however|yet)$/.test(parts[i - 1]!.trim())) carriedNegation = false;
    const hasVerb = VERB.test(clause);
    const ownNegation = NEGATION.test(clause);
    const negated = hasVerb ? ownNegation : ownNegation || carriedNegation;
    if (hasVerb || ownNegation) carriedNegation = ownNegation;
    if (!clause.includes(name) || negated || RESTATEMENT.test(clause)) continue;
    if (new RegExp(`"?${name}"?\\s*:`).test(clause)) continue; // a restated `"name": rule` definition head
    return true;
  }
  return false;
}

/** The one-shot completion endpoint each provider kind serves — a plain POST, not a chat model. */
export type SafetyComplete = (provider: ProviderConfig, model: string, prompt: string) => Promise<string>;

const trimSlash = (url: string) => url.replace(/\/+$/, '');

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

export const defaultComplete: SafetyComplete = async (provider, model, prompt) => {
  const auth: Record<string, string> = provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {};
  switch (provider.kind) {
    case 'ollama': {
      const base = trimSlash(provider.baseUrl ?? 'http://localhost:11434');
      const res = (await postJson(`${base}/api/chat`, {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream: false,
        options: { temperature: 0, num_predict: 256 },
      })) as { message?: { content?: string } };
      if (typeof res.message?.content !== 'string') throw new Error('Ollama /api/chat returned no message');
      return res.message.content;
    }
    case 'openai-compatible':
    case 'openai': {
      const base = provider.baseUrl ? trimSlash(provider.baseUrl) : 'https://api.openai.com/v1';
      const res = (await postJson(
        `${base}/chat/completions`,
        { model, messages: [{ role: 'user', content: prompt }], temperature: 0, max_tokens: 256 },
        auth,
      )) as { choices?: Array<{ message?: { content?: string } }> };
      const content = res.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('Chat completions returned no message');
      return content;
    }
    case 'anthropic': {
      if (!provider.apiKey) throw new Error('Anthropic providers need an API key');
      const res = (await postJson(
        `${trimSlash(provider.baseUrl ?? 'https://api.anthropic.com/v1')}/messages`,
        { model, max_tokens: 256, messages: [{ role: 'user', content: prompt }] },
        { 'x-api-key': provider.apiKey, 'anthropic-version': '2023-06-01' },
      )) as { content?: Array<{ type?: string; text?: string }> };
      const text = res.content?.find((block) => block.type === 'text')?.text;
      if (typeof text !== 'string') throw new Error('Anthropic /messages returned no text');
      return text;
    }
  }
};

export interface Screener {
  screen(payload: SharePayload): Promise<ShareScreening>;
}

/**
 * Resolves the `safety` role and runs the screen. Every failure mode — no role, a
 * provider the app can't reach, a malformed answer — lands as `unavailable` with a
 * logged reason: the screen is never a silent skip and never a thrown exception.
 */
export class ShareScreener implements Screener {
  constructor(
    private readonly settings: SettingsReader,
    private readonly complete: SafetyComplete = defaultComplete,
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

    try {
      const answer = await this.complete(provider, model, screeningPrompt(screeningText(payload)));
      const screening = readScreeningAnswer(answer, model);
      log.info('share_screened', { status: screening.status, categories: screening.categories, model });
      return screening;
    } catch (error) {
      log.warn('share_screen_failed', { model, ...errorFields(error) });
      return { status: 'unavailable', categories: [], model };
    }
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
