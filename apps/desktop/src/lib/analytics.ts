/**
 * Product analytics and session replay (PostHog), for watching how judges use the demo. Only
 * a build with VITE_POSTHOG_KEY loads it; without the key every call here is a no-op and the
 * SDK is never even downloaded, so local development stays clean. No call site can throw.
 *
 * Identity is the demo persona (`demo:ananya`), never an email. Text inputs are masked in
 * recordings.
 */
type Env = Record<string, string | undefined> | undefined;

export type AnalyticsEvent = 'demo_self_serve_started' | 'workspace_signed_in' | 'tour_started' | 'tour_completed' | 'source_uploaded' | 'teacher_turn_sent';

type Properties = Record<string, string | number | boolean | null | undefined>;

interface Client {
  capture: (event: string, properties?: Properties) => void;
  identify: (distinctId: string) => void;
}

export const DEFAULT_POSTHOG_HOST = 'https://us.i.posthog.com';

/** The PostHog settings a build carries, or null without a key. Pure over the env, for tests. */
export function analyticsConfig(env: Env): { key: string; host: string } | null {
  const key = env?.VITE_POSTHOG_KEY?.trim();
  if (!key) return null;
  return { key, host: env?.VITE_POSTHOG_HOST?.trim().replace(/\/+$/, '') || DEFAULT_POSTHOG_HOST };
}

/** The distinct id for a demo persona. Anything that is not a plain persona id identifies nobody. */
export const demoDistinctId = (personaId: string | null | undefined): string | null => (personaId && /^[a-z0-9-]{1,40}$/.test(personaId) ? `demo:${personaId}` : null);

/** A URL without its query and fragment: links can carry single-use tokens or a workspace address. */
export function stripUrl(value: string): string {
  const cut = value.search(/[?#]/);
  return cut === -1 ? value : value.slice(0, cut);
}

/** Every URL-valued property of an outgoing event, reduced to origin and path. */
export function scrubUrls<T extends Record<string, unknown> | undefined>(properties: T): T {
  if (!properties) return properties;
  for (const [key, value] of Object.entries(properties)) {
    if (typeof value === 'string' && /(url|referrer|href)$/i.test(key)) (properties as Record<string, unknown>)[key] = stripUrl(value);
  }
  return properties;
}

let client: Client | null = null;
let started = false;
/** Calls made while the SDK is still loading, replayed once it is up. Bounded: a page that never loads it keeps nothing. */
const queue: Array<(c: Client) => void> = [];
const QUEUE_MAX = 50;

function run(call: (c: Client) => void): void {
  if (!started) return;
  try {
    if (client) call(client);
    else if (queue.length < QUEUE_MAX) queue.push(call);
  } catch {
    // Analytics must never break the page.
  }
}

/** Starts PostHog once, when this build has a key. Safe to call more than once. */
export function initAnalytics(env: Env = import.meta.env as Env): void {
  if (started) return;
  const config = analyticsConfig(env);
  if (!config || typeof window === 'undefined') return;
  started = true;
  void Promise.all([import('posthog-js'), import('posthog-js/dist/recorder')])
    .then(([{ default: posthog }]) => {
      posthog.init(config.key, {
        api_host: config.host,
        capture_pageview: true,
        autocapture: true,
        persistence: 'localStorage+cookie',
        disable_session_recording: false,
        // The recorder is bundled above: the portal's CSP allows scripts from its own origin only.
        disable_external_dependency_loading: true,
        session_recording: { maskAllInputs: true },
        before_send: (event) => {
          if (event) {
            scrubUrls(event.properties);
            scrubUrls(event.$set);
            scrubUrls(event.$set_once);
          }
          return event;
        },
      });
      client = posthog;
      for (const call of queue.splice(0)) {
        try {
          call(posthog);
        } catch {
          // Next.
        }
      }
    })
    .catch(() => {
      started = false;
      queue.length = 0;
    });
}

export function capture(event: AnalyticsEvent, properties?: Properties): void {
  run((c) => c.capture(event, properties));
}

/** Ties this browser's recording to a demo persona. Never pass an email. */
export function identifyDemo(personaId: string | null | undefined): void {
  const id = demoDistinctId(personaId);
  if (id) run((c) => c.identify(id));
}
