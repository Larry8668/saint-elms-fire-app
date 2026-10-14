/** Returns the URL only if it is http(s). Model and tool output is untrusted, so `javascript:` / `data:` links never become clickable. */
export function safeHref(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? url : undefined;
  } catch {
    return undefined;
  }
}
