import { UNKNOWN_DEVICE } from '../profiles/sessions';

const BROWSERS: Array<[RegExp, string]> = [
  [/\bEdg(e|A|iOS)?\//, 'Edge'],
  [/\b(OPR|Opera)\//, 'Opera'],
  [/\bFirefox\/|\bFxiOS\//, 'Firefox'],
  [/\bChrome\/|\bCriOS\//, 'Chrome'],
  [/\bSafari\//, 'Safari'],
  [/\bcurl\//, 'curl'],
];

const SYSTEMS: Array<[RegExp, string]> = [
  [/\biPhone|iPad|iPod/, 'iOS'],
  [/\bAndroid\b/, 'Android'],
  [/\bWindows\b/, 'Windows'],
  [/\bMac OS X|Macintosh/, 'macOS'],
  [/\bCrOS\b/, 'ChromeOS'],
  [/\bLinux\b/, 'Linux'],
];

/**
 * A coarse "Browser on OS" hint for a session the client did not name. Only well-known
 * words are ever emitted, so a crafted User-Agent cannot inject text into the list.
 */
export function deviceLabelFor(userAgent: string | undefined): string {
  if (!userAgent) return UNKNOWN_DEVICE;
  const browser = BROWSERS.find(([pattern]) => pattern.test(userAgent))?.[1];
  const system = SYSTEMS.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && system) return `${browser} on ${system}`;
  return browser ?? system ?? UNKNOWN_DEVICE;
}
