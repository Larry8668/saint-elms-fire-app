/**
 * Standalone device confirmation page.
 *
 * The uni serves this itself so the better-auth session cookie is same-origin and can be
 * sent with the approval call. Nothing secret is embedded: the page holds no token and no
 * user data, it only echoes back the short code the person already typed. The code is read
 * from the query string in script and written with `textContent`, so it never reaches the
 * HTML as markup.
 */

const DEVICE_PATH = '/v1/auth/device';

export interface DevicePageOptions {
  /** Per-response CSP nonce for the inline style and script blocks. */
  nonce: string;
  /** Public origin of this server, shown so the person can confirm where they are. */
  publicUrl: string;
}

const escape = (value: string): string =>
  value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

export function devicePageHtml({ nonce, publicUrl }: DevicePageOptions): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="strict-origin">
<title>Confirm this device · Saint Elms</title>
<style nonce="${nonce}">
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    background: #07080d; color: #e8ecf5;
    font: 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  .card { width: 100%; max-width: 420px; }
  h1 { font-size: 21px; font-weight: 600; margin: 0 0 6px; letter-spacing: -0.01em; }
  p { margin: 0 0 18px; color: #98a2b8; font-size: 14px; }
  .label { display: block; margin: 0 0 6px; font-size: 12.5px; color: #98a2b8; }
  .input {
    display: block; width: 100%; margin: 0 0 18px; padding: 14px; text-align: center;
    font: 600 20px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: 0.14em;
    color: #e8ecf5; background: #10131c; border: 1px solid #1e2430; border-radius: 12px;
  }
  .input:focus { outline: none; border-color: #3f6ae0; box-shadow: 0 0 0 2px rgba(63,106,224,0.35); }
  .row { display: flex; gap: 10px; }
  button {
    flex: 1; padding: 11px 16px; font: 600 14px inherit; color: #e8ecf5; cursor: pointer;
    background: #161b26; border: 1px solid #262d3b; border-radius: 11px;
  }
  button:hover:not(:disabled) { border-color: #3a4459; }
  button.primary { background: #2f5bd0; border-color: #3f6ae0; }
  button.primary:hover:not(:disabled) { background: #3a67dd; }
  button:disabled { opacity: 0.55; cursor: default; }
  .status { margin: 16px 0 0; font-size: 13.5px; min-height: 20px; }
  .status[data-tone="bad"] { color: #f28b82; }
  .status[data-tone="good"] { color: #6ee7b7; }
  .origin { margin-top: 22px; font-size: 11.5px; color: #5b6478; word-break: break-all; }
  a { color: #8ab4f8; }
</style>
</head>
<body>
<main class="card">
  <h1>Confirm this device</h1>
  <p>A Saint Elms Fire student device is asking to sign in as you. Only continue if you started this yourself.</p>
  <label class="label" for="user-code">Code from your device</label>
  <input class="input" id="user-code" name="user_code" autocomplete="off" autocapitalize="characters"
         spellcheck="false" inputmode="latin" placeholder="XXXX-XXXX">
  <div class="row">
    <button id="deny" type="button">Deny</button>
    <button id="approve" type="button" class="primary">Approve</button>
  </div>
  <p class="status" id="status" role="status" aria-live="polite"></p>
  <p class="origin">${escape(publicUrl)}</p>
</main>
<script nonce="${nonce}">
(function () {
  var params = new URLSearchParams(location.search);
  var fromLink = (params.get('user_code') || '').trim();
  var inputEl = document.getElementById('user-code');
  var statusEl = document.getElementById('status');
  var approveEl = document.getElementById('approve');
  var denyEl = document.getElementById('deny');

  function say(message, tone) {
    statusEl.textContent = message;
    if (tone) statusEl.setAttribute('data-tone', tone); else statusEl.removeAttribute('data-tone');
  }

  // Keep the short-lived code out of the address bar, history and any copied URL.
  if (location.search) history.replaceState(null, '', location.pathname);

  function currentCode() { return inputEl.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase(); }

  // The link normally prefills this; it is editable so a code can also be typed by hand.
  if (fromLink) inputEl.value = fromLink;

  // Only gates the buttons; it must never clear a message the server just sent.
  function refresh() {
    var ready = currentCode().length > 0;
    approveEl.disabled = !ready;
    denyEl.disabled = !ready;
  }

  inputEl.addEventListener('input', refresh);
  refresh();

  if (!fromLink) say('Open the link shown on your device, or type the code it shows.');

  function describe(payload, fallback) {
    if (!payload) return fallback;
    if (payload.error_description) return String(payload.error_description);
    if (payload.message) return String(payload.message);
    if (payload.error) return String(payload.error).replace(/_/g, ' ');
    return fallback;
  }

  function decide(action, busyMessage, goodMessage) {
    return function () {
      var code = currentCode();
      if (!code) return;
      approveEl.disabled = true; denyEl.disabled = true;
      say(busyMessage);
      fetch('${DEVICE_PATH}/' + action, {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userCode: code })
      })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (payload) {
            return { ok: res.ok, payload: payload };
          });
        })
        .then(function (outcome) {
          if (!outcome.ok) {
            say(describe(outcome.payload, 'That did not work. The code may have expired.'), 'bad');
            refresh();
            return;
          }
          say(goodMessage, 'good');
        })
        .catch(function () {
          say('Could not reach the university server.', 'bad');
          refresh();
        });
    };
  }

  approveEl.addEventListener('click', decide('approve', 'Approving…', 'Approved. You can return to your device.'));
  denyEl.addEventListener('click', decide('deny', 'Denying…', 'Denied. That device was not signed in.'));
})();
</script>
</body>
</html>
`;
}
