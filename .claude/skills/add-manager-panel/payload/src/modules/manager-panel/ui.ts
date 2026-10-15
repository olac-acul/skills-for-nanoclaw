/**
 * The browser UI, shipped as three strings so the host needs no build step or
 * asset copy. Same origin only, so the CSP can forbid inline code and remote
 * resources: the page is static markup, the script renders every value with
 * `textContent` (never `innerHTML`), keeps the CSRF token in memory only (no
 * web storage), and sends no request outside `/api/v1`.
 *
 * All user-facing text is in the `T` table at the top of the script so another
 * language can be added in one place.
 */

export const UI_CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; manifest-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="referrer" content="no-referrer" />
    <meta name="theme-color" content="#1f6feb" />
    <meta name="color-scheme" content="light dark" />
    <meta name="mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-capable" content="yes" />
    <meta name="apple-mobile-web-app-title" content="NanoClaw" />
    <link rel="manifest" href="/manifest.webmanifest" />
    <link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png" />
    <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
    <title>NanoClaw Manager</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <div id="banner" role="alert" hidden></div>
    <header id="top" hidden>
      <strong>NanoClaw Manager</strong>
      <nav id="nav"></nav>
      <a id="guide-link" class="help" href="/guide">Guide</a>
      <button id="logout" type="button" class="link"></button>
    </header>
    <main id="main"><p class="muted">Loading…</p></main>
    <dialog id="dialog"></dialog>
    <script src="/app.js" defer></script>
  </body>
</html>
`;

export const APP_CSS = `
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1b1f24; --muted: #5b6672; --line: #d9dee4;
  --accent: #1f6feb; --accent-text: #ffffff; --danger: #b42318; --ok: #1a7f37; --warn-bg: #fff4d6; --warn-text: #5c4300;
  --accent-soft: #e8f0fe; --ok-soft: #e6f4ea; --bad-soft: #fdecea; --hover: #f0f3f7; --shadow: 0 1px 2px rgba(16,24,40,.05), 0 1px 3px rgba(16,24,40,.06);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #12161b; --panel: #1b2128; --text: #e6e9ed; --muted: #9aa5b1; --line: #2c343d;
    --accent: #4c9aff; --accent-text: #08111c; --danger: #ff8a80; --ok: #56d364; --warn-bg: #3a2f08; --warn-text: #f5deb3;
    --accent-soft: #1b2b44; --ok-soft: #14301c; --bad-soft: #3b1d1b; --hover: #222a33; --shadow: 0 1px 2px rgba(0,0,0,.4);
  }
}
:root[data-theme="dark"] {
  --bg: #12161b; --panel: #1b2128; --text: #e6e9ed; --muted: #9aa5b1; --line: #2c343d;
  --accent: #4c9aff; --accent-text: #08111c; --danger: #ff8a80; --ok: #56d364; --warn-bg: #3a2f08; --warn-text: #f5deb3;
    --accent-soft: #1b2b44; --ok-soft: #14301c; --bad-soft: #3b1d1b; --hover: #222a33; --shadow: 0 1px 2px rgba(0,0,0,.4);
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text); font: 15px/1.5 system-ui, sans-serif; }
header { display: flex; gap: 16px; align-items: center; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); flex-wrap: wrap; }
nav { display: flex; gap: 4px; flex: 1; flex-wrap: wrap; }
nav button { background: none; border: 0; padding: 6px 10px; border-radius: 6px; color: var(--muted); cursor: pointer; font: inherit; }
nav button[aria-current="page"] { background: var(--bg); color: var(--text); font-weight: 600; }
main { max-width: 960px; margin: 0 auto; padding: 24px 16px; }
h1 { font-size: 20px; margin: 0 0 16px; } h2 { font-size: 16px; margin: 24px 0 8px; }
.card > h2:first-child { margin-top: 0; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 16px; margin-bottom: 16px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 12px; }
.stat b { display: block; font-size: 22px; } .muted { color: var(--muted); }
table { width: 100%; border-collapse: collapse; } th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { color: var(--muted); font-weight: 500; font-size: 13px; }
form { display: grid; gap: 12px; max-width: 520px; } label { display: grid; gap: 4px; font-weight: 500; }
input, select { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--text); }
button { font: inherit; padding: 8px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
button.primary { background: var(--accent); color: var(--accent-text); border-color: var(--accent); }
button.danger { color: var(--danger); } button:disabled { opacity: .5; cursor: not-allowed; }
button.link { border: 0; background: none; color: var(--muted); }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.pill { display: inline-block; padding: 1px 8px; border-radius: 999px; border: 1px solid var(--line); font-size: 12px; }
.pill.ok { color: var(--ok); } .pill.bad { color: var(--danger); }
.notice { padding: 10px 12px; border-radius: 6px; margin: 12px 0; border: 1px solid var(--line); }
.notice.error { color: var(--danger); border-color: var(--danger); } .notice.ok { color: var(--ok); border-color: var(--ok); }
#banner { background: var(--warn-bg); color: var(--warn-text); padding: 8px 16px; text-align: center; }
dialog { border: 1px solid var(--line); border-radius: 8px; background: var(--panel); color: var(--text); max-width: 520px; width: calc(100% - 32px); }
dialog::backdrop { background: rgba(0,0,0,.45); }
/* sign-in and first-run screens */
.segments { display: inline-flex; flex-wrap: wrap; gap: 4px; padding: 4px; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; margin: 4px 0 8px; }
.segments button { border: 0; background: none; padding: 6px 12px; border-radius: 6px; color: var(--muted); }
.segments button.on { background: var(--panel); color: var(--text); font-weight: 600; box-shadow: 0 0 0 1px var(--line); }
.segments.small button { padding: 4px 10px; font-size: 14px; }
.secret { display: grid; gap: 8px; margin: 12px 0; }
.auth { min-height: calc(100vh - 96px); display: grid; place-items: center; }
.auth-card { width: 100%; max-width: 380px; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 32px 28px; box-shadow: 0 1px 2px rgba(0,0,0,.08), 0 12px 32px rgba(0,0,0,.12); }
.auth-brand { display: flex; align-items: center; gap: 10px; margin-bottom: 20px; font-weight: 600; letter-spacing: .2px; }
.auth-mark { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: var(--accent-text); display: grid; place-items: center; font-weight: 700; }
.auth-card h1 { font-size: 20px; margin: 0 0 4px; }
.auth-card .sub { color: var(--muted); margin: 0 0 22px; }
.auth-card form { max-width: none; gap: 14px; }
.auth-card input { width: 100%; padding: 10px 12px; }
.auth-card button.primary { width: 100%; padding: 10px 14px; margin-top: 4px; }
.auth-card .hint { font-size: 13px; color: var(--muted); }

a.help { color: var(--accent); text-decoration: none; font-size: 13px; }
a.help:hover { text-decoration: underline; }
.links { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 8px 0 0; }
header a.help { margin-left: auto; }
#banner a { color: inherit; text-decoration: underline; margin-left: 6px; }
/* the guide page */
.guide-top { display: flex; gap: 12px; align-items: center; padding: 10px 16px; background: var(--panel); border-bottom: 1px solid var(--line); position: sticky; top: 0; z-index: 2; }
.guide-top .back { margin-left: auto; color: var(--accent); text-decoration: none; }
.guide-wrap { display: grid; grid-template-columns: 240px minmax(0, 1fr); gap: 32px; max-width: 1120px; margin: 0 auto; padding: 24px 16px 80px; }
.guide-toc { position: sticky; top: 64px; align-self: start; max-height: calc(100vh - 84px); overflow: auto; display: grid; gap: 2px; font-size: 14px; }
.guide-toc a { color: var(--muted); text-decoration: none; padding: 3px 8px; border-radius: 6px; }
.guide-toc a:hover { background: var(--panel); color: var(--text); }
.guide-toc a.toc-3 { padding-left: 22px; font-size: 13px; }
.guide { min-width: 0; max-width: 780px; }
.guide h1 { font-size: 28px; margin: 0 0 12px; }
.guide h2 { font-size: 21px; margin: 40px 0 10px; padding-top: 14px; border-top: 1px solid var(--line); }
.guide h3 { font-size: 16px; margin: 26px 0 8px; }
.guide :is(h1, h2, h3, h4) { scroll-margin-top: 72px; }
.guide .anchor { margin-left: 8px; color: var(--muted); text-decoration: none; opacity: 0; }
.guide :is(h1, h2, h3, h4):hover .anchor, .guide .anchor:focus { opacity: 1; }
.guide a { color: var(--accent); }
.guide p, .guide li { line-height: 1.65; }
.guide code { background: var(--panel); border: 1px solid var(--line); padding: 1px 5px; border-radius: 4px; font-size: .92em; }
.guide pre { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px 14px; overflow: auto; }
.guide pre code { background: none; border: 0; padding: 0; font-size: 13px; }
.guide blockquote { margin: 16px 0; padding: 4px 16px; border-left: 3px solid var(--accent); background: var(--panel); border-radius: 0 8px 8px 0; }
.guide .table-wrap { overflow-x: auto; margin: 14px 0; }
.guide table { border: 1px solid var(--line); border-radius: 8px; }
.guide th, .guide td { border-bottom: 1px solid var(--line); vertical-align: top; }
.guide hr { border: 0; border-top: 1px solid var(--line); margin: 28px 0; }
@media (max-width: 820px) { .guide-wrap { grid-template-columns: 1fr; } .guide-toc { position: static; max-height: none; } }
code, .key { font-family: ui-monospace, monospace; word-break: break-all; }
.key { display: block; padding: 10px; background: var(--bg); border: 1px dashed var(--line); border-radius: 6px; margin: 8px 0; user-select: all; }

/* desktop polish: calmer type, softer surfaces, clear focus */
body { font: 15px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif; -webkit-font-smoothing: antialiased; }
header { gap: 20px; padding: 0 24px; min-height: 60px; position: sticky; top: 0; z-index: 4; box-shadow: var(--shadow); }
header strong { display: inline-flex; align-items: center; gap: 10px; font-size: 16px; letter-spacing: .1px; }
header strong::before { content: "N"; width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: var(--accent-text); display: inline-grid; place-items: center; font-weight: 700; font-size: 15px; }
nav { gap: 2px; margin-left: 8px; }
nav button { padding: 8px 14px; border-radius: 8px; font-weight: 500; transition: background .15s, color .15s; }
nav button:hover { background: var(--hover); color: var(--text); }
nav button[aria-current="page"] { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
main { max-width: 980px; padding: 36px 24px 64px; }
h1 { font-size: 26px; letter-spacing: -.2px; margin: 0 0 20px; }
h2 { font-size: 16px; margin: 28px 0 10px; }
.card { border-radius: 14px; padding: 22px 24px; margin-bottom: 20px; box-shadow: var(--shadow); }
.card p { margin: 8px 0; }
.grid { gap: 14px; }
.stat { background: var(--bg); border: 1px solid var(--line); border-radius: 12px; padding: 14px 16px; }
.stat .muted { font-size: 12px; text-transform: uppercase; letter-spacing: .6px; }
.stat b { font-size: 26px; margin-top: 4px; letter-spacing: -.3px; }
table { border-collapse: separate; border-spacing: 0; }
th { font-size: 12px; text-transform: uppercase; letter-spacing: .5px; padding: 8px 12px; }
td { padding: 12px; }
tbody tr { transition: background .12s; } tbody tr:hover { background: var(--hover); }
tbody tr:last-child td { border-bottom: 0; }
label { font-size: 14px; }
input, select { border-radius: 8px; padding: 9px 12px; transition: border-color .15s, box-shadow .15s; }
input:hover, select:hover { border-color: var(--muted); }
:is(input, select, button, nav button, a):focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
input:focus, select:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
button { border-radius: 8px; padding: 8px 16px; font-weight: 500; box-shadow: var(--shadow); transition: background .15s, border-color .15s, filter .15s; }
button:hover:not(:disabled) { background: var(--hover); }
button.primary { box-shadow: none; } button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.08); }
button.danger:hover:not(:disabled) { background: var(--bad-soft); border-color: var(--danger); }
button.link, nav button, .segments button { box-shadow: none; } button.link:hover:not(:disabled) { background: none; color: var(--text); }
.pill { padding: 2px 10px; font-weight: 500; background: var(--bg); }
.pill.ok { background: var(--ok-soft); border-color: transparent; } .pill.bad { background: var(--bad-soft); border-color: transparent; }
.notice { border-radius: 10px; padding: 12px 14px; background: var(--bg); }
.notice.error { background: var(--bad-soft); } .notice.ok { background: var(--ok-soft); }
#banner { font-size: 14px; padding: 10px 24px; }
dialog { border-radius: 16px; padding: 24px; box-shadow: 0 24px 64px rgba(0,0,0,.3); }
dialog h1 { font-size: 20px; }
dialog::backdrop { backdrop-filter: blur(2px); }
.segments { border-radius: 10px; } .segments button:hover { color: var(--text); }
.auth-card { border-radius: 16px; }
.auth-card .hint, .muted { line-height: 1.5; }
.key { border-radius: 8px; padding: 12px; font-size: 13px; }
.row + .card { margin-top: 16px; } .links { margin: 10px 0 16px; } .links a, .links .help { padding: 2px 0; font-size: 14px; }
td { white-space: nowrap; } td:first-child { white-space: normal; }
td .row { flex-wrap: nowrap; gap: 6px; } td button { padding: 5px 12px; font-size: 14px; }
header a.help { font-size: 14px; padding: 8px 10px; border-radius: 8px; } header a.help:hover { background: var(--hover); text-decoration: none; }
.guide-top { padding: 0 24px; min-height: 56px; box-shadow: var(--shadow); }
.guide-top strong::before { content: "N"; display: inline-grid; place-items: center; width: 26px; height: 26px; margin-right: 10px; border-radius: 7px; background: var(--accent); color: var(--accent-text); font-size: 14px; font-weight: 700; }
.guide-toc a { transition: background .12s, color .12s; }
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }

/* phones: bottom tab bar, tables as cards, thumb-sized controls */
.stack-cell::before { content: attr(data-label); display: none; }
@media (max-width: 640px) {
  body { font-size: 16px; -webkit-text-size-adjust: 100%; }
  header { gap: 8px 12px; padding: 10px 16px; padding-top: max(10px, env(safe-area-inset-top)); flex-wrap: nowrap; }
  header strong { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  header a.help { margin-left: 0; font-size: 15px; padding: 10px 4px; }
  header button.link { padding: 10px 4px; }
  nav { margin-left: 0; position: fixed; left: 0; right: 0; bottom: 0; z-index: 5; flex: none; flex-wrap: nowrap; gap: 0; background: var(--panel); border-top: 1px solid var(--line); padding: 0 env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left); }
  nav button { flex: 1; min-height: 56px; border-radius: 0; font-size: 13px; padding: 8px 2px; }
  nav button[aria-current="page"] { background: none; color: var(--accent); box-shadow: inset 0 3px 0 var(--accent); }
  main { padding: 16px 16px calc(88px + env(safe-area-inset-bottom)); }
  h1 { font-size: 22px; }
  .card { padding: 14px; }
  .grid { grid-template-columns: repeat(2, 1fr); }
  .grid > .stat:last-child:nth-child(odd) { grid-column: 1 / -1; }
  td { white-space: normal; } td .row { flex-wrap: wrap; } td button { padding: 10px 16px; font-size: inherit; }
  form { max-width: none; }
  input, select, textarea { font-size: 16px; min-height: 44px; width: 100%; }
  input[type="checkbox"], input[type="radio"] { width: auto; min-height: 0; }
  button { min-height: 44px; padding: 10px 16px; }
  .row { gap: 10px; }
  .row > button { flex: 1 1 auto; }
  .segments { display: flex; width: 100%; }
  .segments button { flex: 1 1 auto; min-height: 40px; }
  dialog { width: 100%; max-width: none; margin: auto 0 0; border-radius: 16px 16px 0 0; max-height: 92vh; padding-bottom: max(16px, env(safe-area-inset-bottom)); }
  .auth { min-height: calc(100vh - 160px); place-items: start center; padding-top: 24px; }
  .auth-card { padding: 24px 20px; box-shadow: none; }
  table.stack, table.stack tbody, table.stack tr, table.stack td { display: block; width: 100%; }
  table.stack thead { display: none; }
  table.stack tr { border: 1px solid var(--line); border-radius: 8px; padding: 6px 12px; margin-bottom: 10px; }
  table.stack td { border: 0; padding: 6px 0; display: flex; gap: 12px; justify-content: space-between; align-items: center; }
  table.stack td.stack-cell::before { display: block; color: var(--muted); font-size: 13px; flex: none; }
  table.stack td.actions { display: block; padding-top: 10px; }
  .key { font-size: 13px; }
  .guide-wrap { padding: 16px 16px 48px; }
  .guide h1 { font-size: 24px; }
}
@media (display-mode: standalone) { header { padding-top: max(10px, env(safe-area-inset-top)); } }
`;

export const APP_JS = `
'use strict';
var T = {
  nav: { overview: 'Overview', agents: 'Agents', model: 'Model', phone: 'Phone', backups: 'Backups' },
  logout: 'Sign out',
  guide: { link: 'Guide', insecureMore: 'How to enable HTTPS' },
  terminal: {
    title: 'Things you do from a terminal', intro: 'The panel keeps these out of the browser on purpose. Each link opens the matching section of the guide.',
    items: [
      ['restoring-a-backup', 'Restore a backup'], ['forgotten-password', 'Forgotten password'], ['api-keys', 'Store an API key'],
      ['channels-and-agents', 'Add channels and agents'], ['https-and-network-access', 'HTTPS and network access'], ['updating-nanoclaw', 'Update NanoClaw'],
      ['rebuilding-agent-images', 'Rebuild agent images'], ['terminal-only-tasks', 'All terminal-only tasks'],
    ],
  },
  insecure: 'This connection is not encrypted: your password and backup keys cross the network in clear text. Use HTTPS (see the setup notes) unless you are on localhost.',
  setup: { title: 'Welcome', sub: 'Create the administrator account for this install.', code: 'Setup code', password: 'Password (at least 12 characters)', submit: 'Create account', hint: 'Get the code by running pnpm exec tsx scripts/manager-panel.ts setup-code on this machine.', help: 'Where do I get the code?' },
  login: { title: 'Sign in', sub: 'Manage your NanoClaw install.', password: 'Password', submit: 'Sign in', forgot: 'Forgot the password?' },
  reauth: { title: 'Confirm your password', body: 'This action needs your password again.', submit: 'Confirm' },
  cancel: 'Cancel', close: 'Close', loading: 'Loading…', none: 'Nothing here yet.',
  overview: { title: 'Overview', release: 'Release', agents: 'Agents', running: 'Running now', sessions: 'Sessions', gateway: 'Credential gateway', channels: 'Channels', providers: 'Providers', backups: 'Backups', latest: 'Latest', never: 'never', up: 'Uptime' },
  agents: { title: 'Agents', terminalNote: 'Adding, wiring and removing agents and channels is done from a terminal.', addHelp: 'How', rebuildHelp: 'Rebuild an agent image', name: 'Name', provider: 'Provider', model: 'Model', state: 'State', restart: 'Restart', running: 'running', idle: 'idle', restarted: 'Restart requested.' },
  provider: {
    in_use: 'Provider in use', choose: 'Choose a provider', moreAbout: 'More',
    names: { compatible: 'OpenAI-compatible endpoint', chatgpt: 'ChatGPT', claude: 'Claude', unknown: 'Not set up yet' },
    auth: { subscription: 'Subscription login', 'api-key': 'API key' },
    blurb: {
      compatible: 'A server that speaks the OpenAI API: a local model server, Ollama, or a hosted service. No key is needed for most local servers.',
      chatgpt: 'OpenAI models through your ChatGPT subscription or an OpenAI API key. Agents use OpenCode.',
      claude: 'Anthropic models through the Claude provider NanoClaw ships with, using an API key or a Claude subscription token.',
    },
    default_model: 'default', credential: 'Credential in the gateway', stored: 'stored', not_stored: 'not stored yet', save: 'Save', saved: 'Saved in the credential gateway.', remove: 'Remove', remove_confirm: 'Click again to remove',
    use_ollama: 'Use Ollama', ollama_hint: 'Fills the address Ollama has on this machine and checks it. For Ollama on another machine, type its address above instead (http://<address>:11434/v1).', models_found: 'Models offered',
    openai_key: 'OpenAI API key', openai_key_help: 'Handed straight to the credential gateway and never shown again.',
    claude_secret: 'Anthropic API key or Claude subscription token', claude_help: 'For a subscription, run claude setup-token in a terminal and paste the token it prints. Handed straight to the credential gateway and never shown again.',
    claude_model: 'Model (optional)', claude_model_hint: 'empty = default, or a full name such as claude-haiku-4-5-20251001', chatgpt_model_hint: 'as named by OpenAI',
    signin: 'Sign in with ChatGPT', signin_help: 'Shows a page and a code; you enter the code there while signed in to ChatGPT.', signin_steps: 'Open this page, sign in, and enter the code:', signin_starting: 'Starting the sign-in…',
    agents_restarted: 'agents restarted.',
  },
  model: {
    title: 'Model and provider', current: 'Current settings', baseUrl: 'Endpoint (OpenAI-compatible, ending in /v1)', model: 'Model', small: 'Small model (optional)', moreAbout: 'More', smallHelp: 'A lighter model OpenCode can use for minor background work. Leave it empty to use the main model for everything, which is right when you run a single model.',
    images: 'The model understands images', imagesHelp: 'Photos sent from the phone app reach the model only when this is on. Turn it off for a model that cannot see images, which would otherwise answer without the photo.',
    imagesDetected: 'The endpoint says this model accepts images.', imagesNone: 'The endpoint says this model does not accept images.', imagesUnknown: 'The endpoint does not say whether the model accepts images: tick it if you know it does.',
    check: 'Check endpoint', apply: 'Apply to all agents', follows: 'Uses the install settings', differs: 'Different from the install settings',
    keyNote: 'API keys are not entered here. An endpoint that needs one gets its key through a terminal.', keyHelp: 'How to store a key', applyHelp: 'What applying does', errorsHelp: 'Endpoint errors explained',
    checked: 'Endpoint checked.', applied: 'Applied.', affected: 'Agents that will be restarted', context: 'Context window', models: 'Models offered',
    interrupted: 'A previous change was interrupted. It is rolled back automatically at the next start.',
  },
  phone: {
    title: 'Phone app', help: 'How the phone app connects', intro: 'The NanoVoice app on your phone reaches this install through the voice channel. This page shows whether it is connected and lets you make a new token.',
    notInstalled: 'The voice channel is not installed on this install. It comes from the add-voice skill.', connection: 'Connection',
    app: 'App', connected: 'Connected', notConnected: 'Not connected', since: 'Connected since', lastSeen: 'Last connected', channel: 'Voice channel', listening: 'Listening', off: 'Off', enabledNotRunning: 'On, not running yet',
    restart: 'The setting and the running channel differ. Restart NanoClaw for the change to take effect.',
    address: 'Address for the app', problem_loopback: 'The channel listens on this machine only. Set the address of a private network or VPN that the phone reaches (VOICE_BIND_HOST), then restart.', problem_all_addresses: 'The channel listens on every address. Use the address the phone reaches this machine on.',
    agent: 'Answers from agent', notWired: 'Not connected to an agent yet: finish the setup from a terminal.', push: 'Wake-up push', pushYes: 'Registered', pushNo: 'Not registered',
    token: 'Token', tokenSet: 'Set', tokenMissing: 'Not set', newToken: 'Make a new token', confirmToken: 'Make a new token? The app is disconnected and has to be given the new one.',
    tokenTitle: 'Give this token to the app', tokenBody: 'This token lets the phone in. It is shown only now and is not kept anywhere you can read it again. Enter it in the app (Settings, NanoClaw server), then close this window.', tokenSaved: 'I have entered it in the app',
    turnOn: 'Turn the channel on', turnOff: 'Turn the channel off', changed: 'Saved. Restart NanoClaw for it to take effect.',
  },
  backups: {
    title: 'Backups', create: 'Create backup', created: 'Created', size: 'Size', release: 'Release', consistency: 'Consistency', actions: 'Actions',
    verify: 'Verify', download: 'Download', del: 'Delete',
    keyTitle: 'Save this key now', keyBody: 'This key is needed to open the backup and is not stored anywhere. Put it in your password manager.', keySaved: 'I have stored the key',
    verifyKey: 'Backup key', verifyOk: 'The backup is intact.', confirmDelete: 'Delete this backup permanently?',
    running: 'Backup in progress', elapsed: 'Elapsed', keepOpen: 'You can leave this page open or come back later: the backup keeps running.',
    phase_waiting: 'Waiting up to {n} seconds for agents to finish their current message, so the copy is consistent. The backup goes ahead either way.',
    phase_snapshot: 'Copying the database…', phase_pack: 'Packing and encrypting: {files} files, {size} so far.',
    doneTitle: 'Backup complete', doneNoKey: 'The last backup finished and its key was already shown. If you did not save it, create a new backup.',
    bestEffort: 'Some agents were still working while the backup ran. Every database file is consistent on its own, but the files were not copied at the same instant. For a perfectly consistent copy, stop NanoClaw first.',
    scheduled: 'Scheduled', consAgentsIdle: 'Agents idle', consAgentsWorking: 'Agents were working', consStopped: 'NanoClaw stopped',
    note: 'Restoring is done from a terminal, with NanoClaw stopped.', restoreHelp: 'How to restore', keyHelp: 'About the key', consistencyHelp: 'Consistency levels', retentionHelp: 'Retention and pruning', moveHelp: 'Moving to another machine',
  },
  errors: {
    invalid_credentials: 'Wrong password.', login_throttled: 'Too many attempts. Wait a moment and try again.', invalid_setup_code: 'That setup code is not valid.',
    password_too_short: 'The password is too short.', password_too_long: 'The password is too long.', already_configured: 'An administrator already exists.',
    not_installed: 'The voice channel is not installed.', token_missing: 'Make a token first.',
    unauthenticated: 'Your session ended. Sign in again.', reauth_required: 'Confirm your password first.', rate_limited: 'Too many requests. Slow down.', login_busy: 'Another sign-in check is running. Try again in a moment.', setup_in_progress: 'Setup is already in progress.', backup_key_pending: 'A backup finished in another session and its key has not been collected yet. Use that session, or wait a few minutes.',
    agents_busy: 'Agents are still running. Try again later or back up anyway.', probe_failed: 'The endpoint did not pass its checks',
    model_not_found: 'The endpoint does not list that model.', credential_missing: 'Store the credential first.', invalid_secret: 'That does not look like a key or token.',
    save_failed: 'The credential gateway did not accept it.', remove_failed: 'The credential could not be removed.', credential_in_use: 'The agents use this credential right now. Switch to another provider first.', login_failed: 'The sign-in did not complete.', login_timeout: 'The sign-in took too long.', login_cancelled: 'The sign-in was cancelled.',
    gateway_unavailable: 'The credential gateway is not reachable.', runtime_unavailable: 'Docker is not available.', script_missing: 'Provider credentials need the OpenCode and OneCLI skills installed.', script_failed: 'The credentials helper failed. Check the NanoClaw log.', small_model_not_found: 'The endpoint does not list the small model.', endpoint_unreachable: 'Could not reach the endpoint.', endpoint_invalid: 'That is not a valid endpoint URL.',
    endpoint_not_allowed: 'That address is not allowed.', endpoint_insecure: 'Plain HTTP is only accepted for local addresses; use HTTPS.',
    endpoint_unauthorized: 'The endpoint wants an API key.', endpoint_unresolvable: 'The name could not be resolved.', endpoint_tls_failed: 'The TLS certificate could not be verified.',
    endpoint_invalid_response: 'The endpoint did not answer like an OpenAI-compatible API.', inference_failed: 'The model did not answer a test request.',
    apply_failed_rolled_back: 'The change failed and the previous settings were restored.', apply_failed_rollback_incomplete: 'The change failed and restoring did not finish. Check the host log.',
    change_in_progress: 'A previous change is still being recovered.', invalid_key: 'That is not a valid key.', key_or_bundle_rejected: 'Wrong key, or the backup is damaged.',
    invalid_request: 'Some of the input is not valid.', not_found: 'Not found.', internal_error: 'Something went wrong.', origin_mismatch: 'Request blocked (origin).', csrf_mismatch: 'Request blocked. Reload the page.',
  },
};

var state = { csrf: null, view: 'overview', insecure: false };
var main = document.getElementById('main');

function h(tag, attrs) {
  var el = document.createElement(tag);
  for (var key in attrs || {}) {
    var v = attrs[key];
    if (key === 'class') el.className = v; else if (key === 'onclick' || key === 'onsubmit' || key === 'onchange') el[key] = v; else if (v !== false && v != null) el.setAttribute(key, v === true ? '' : v);
  }
  for (var i = 2; i < arguments.length; i++) {
    var c = arguments[i];
    if (c == null || c === false) continue;
    el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}
function guide(anchor, label) { return h('a', { class: 'help', href: '/guide#' + anchor }, label); }
function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); }
function show(node) { clear(main); main.appendChild(node); }
function message(kind, text) { return h('div', { class: 'notice ' + kind, role: kind === 'error' ? 'alert' : 'status' }, text); }
function explain(err) {
  var base = T.errors[err.code] || T.errors.internal_error;
  return err.detail && T.errors[err.detail] ? base + ' ' + T.errors[err.detail] : base;
}
function fmtBytes(n) { var u = ['B','KiB','MiB','GiB','TiB'], i = 0; while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; } return (i ? n.toFixed(1) : n) + ' ' + u[i]; }
function fmtDate(s) { try { return new Date(s).toLocaleString(); } catch (e) { return s; } }
function fmtUp(s) { var d = Math.floor(s / 86400), hh = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60); return (d ? d + 'd ' : '') + hh + 'h ' + m + 'm'; }

function api(method, path, body) {
  var headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = state.csrf || '';
  return fetch('/api/v1' + path, { method: method, headers: headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'same-origin', cache: 'no-store' }).then(function (res) {
    if (res.status === 204) return null;
    return res.json().then(function (data) {
      if (res.ok) return data;
      var e = (data && data.error) || {}; var err = new Error(e.code || 'internal_error'); err.code = e.code || 'internal_error'; err.status = res.status; err.detail = e.detail; throw err;
    });
  });
}

/** A table cell that shows its column name beside the value when the table is laid out as a card (phones). */
function cell(label, value) { return h('td', { class: 'stack-cell', 'data-label': label }, value); }

function dialog(build) {
  var d = document.getElementById('dialog'); clear(d);
  var close = function () { if (d.open) d.close(); };
  d.appendChild(build(close));
  if (!d.open) d.showModal();
  return close;
}

function ensureReauth() {
  return new Promise(function (resolve, reject) {
    api('GET', '/session').then(function (s) {
      if (s.reauth_expires_at && Date.parse(s.reauth_expires_at) > Date.now()) return resolve();
      var input = h('input', { type: 'password', autocomplete: 'current-password', required: true });
      var out = h('div');
      dialog(function (close) {
        var form = h('form', { onsubmit: function (ev) {
          ev.preventDefault();
          api('POST', '/session/reauth', { password: input.value }).then(function () { close(); resolve(); }).catch(function (err) { clear(out); out.appendChild(message('error', explain(err))); });
        } }, h('h1', {}, T.reauth.title), h('p', { class: 'muted' }, T.reauth.body), h('label', {}, T.login.password, input), out,
          h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, T.reauth.submit), h('button', { type: 'button', onclick: function () { close(); reject(new Error('cancelled')); } }, T.cancel)));
        setTimeout(function () { input.focus(); }, 0);
        return form;
      });
    }).catch(reject);
  });
}

function fail(container, err) { if (err && err.message === 'cancelled') return; if (err && err.code === 'unauthenticated') return start(); container.appendChild(message('error', explain(err || {}))); }

// ----- views -----
function viewAuth(needSetup) {
  var code = h('input', { autocomplete: 'off', required: true, spellcheck: 'false' });
  var password = h('input', { type: 'password', autocomplete: needSetup ? 'new-password' : 'current-password', required: true });
  var out = h('div');
  var form = h('form', { onsubmit: function (ev) {
    ev.preventDefault(); clear(out);
    var p = needSetup ? api('POST', '/setup', { code: code.value, password: password.value }) : api('POST', '/session', { password: password.value });
    p.then(function (s) { state.csrf = s.csrf_token; state.insecure = s.insecure_http; enter(); }).catch(function (err) { out.appendChild(message('error', explain(err))); });
  } }, needSetup && h('label', {}, T.setup.code, code), needSetup && h('p', { class: 'hint' }, T.setup.hint, ' ', guide('create-the-administrator', T.setup.help)),
    h('label', {}, needSetup ? T.setup.password : T.login.password, password), !needSetup && h('p', { class: 'hint' }, guide('forgotten-password', T.login.forgot)), out,
    h('button', { class: 'primary', type: 'submit' }, needSetup ? T.setup.submit : T.login.submit));
  show(h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('div', { class: 'auth-brand' }, h('span', { class: 'auth-mark', 'aria-hidden': 'true' }, 'N'), 'NanoClaw Manager'),
    h('h1', {}, needSetup ? T.setup.title : T.login.title), h('p', { class: 'sub' }, needSetup ? T.setup.sub : T.login.sub), form)));
  (needSetup ? code : password).focus();
}

function viewOverview() {
  var box = h('div', { class: 'card' }, T.loading); show(h('div', {}, h('h1', {}, T.overview.title), box));
  api('GET', '/overview').then(function (o) {
    clear(box);
    var stat = function (label, value) { return h('div', { class: 'stat' }, h('span', { class: 'muted' }, label), h('b', {}, String(value))); };
    box.appendChild(h('div', { class: 'grid' }, stat(T.overview.release, o.release), stat(T.overview.agents, o.agents), stat(T.overview.running, o.running_agents), stat(T.overview.sessions, o.sessions), stat(T.overview.up, fmtUp(o.uptime_seconds))));
    box.appendChild(h('p', {}, h('span', { class: 'muted' }, T.overview.gateway + ': '), o.gateway || '-'));
    box.appendChild(h('p', {}, h('span', { class: 'muted' }, T.overview.channels + ': '), o.channels.length ? o.channels.join(', ') : '-'));
    box.appendChild(h('p', {}, h('span', { class: 'muted' }, T.overview.providers + ': '), o.providers.length ? o.providers.join(', ') : '-'));
    box.appendChild(h('p', {}, h('span', { class: 'muted' }, T.overview.backups + ': '), o.backups.count + ' (' + T.overview.latest + ': ' + (o.backups.latest ? fmtDate(o.backups.latest) : T.overview.never) + ')'));
    var links = h('div', { class: 'links' });
    T.terminal.items.forEach(function (item) { links.appendChild(guide(item[0], item[1])); });
    main.firstChild.appendChild(h('div', { class: 'card' }, h('h2', {}, T.terminal.title), h('p', { class: 'muted' }, T.terminal.intro), links));
  }).catch(function (err) { clear(box); fail(box, err); });
}

function viewAgents() {
  var box = h('div', { class: 'card' }, T.loading); var out = h('div'); show(h('div', {}, h('h1', {}, T.agents.title), h('p', { class: 'muted' }, T.agents.terminalNote, ' ', guide('channels-and-agents', T.agents.addHelp), ' · ', guide('rebuilding-agent-images', T.agents.rebuildHelp)), out, box));
  function load() {
    api('GET', '/agents').then(function (r) {
      clear(box);
      if (!r.agents.length) return box.appendChild(h('p', { class: 'muted' }, T.none));
      var head = h('tr', {}, h('th', {}, T.agents.name), h('th', {}, T.agents.provider), h('th', {}, T.agents.model), h('th', {}, T.agents.state), h('th'));
      var table = h('table', { class: 'stack' }, h('thead', {}, head));
      var body = h('tbody');
      r.agents.forEach(function (a) {
        var btn = h('button', { type: 'button', onclick: function () {
          btn.disabled = true; clear(out);
          api('POST', '/agents/' + a.id + '/restart').then(function () { out.appendChild(message('ok', T.agents.restarted)); setTimeout(load, 1500); }).catch(function (err) { btn.disabled = false; fail(out, err); });
        } }, T.agents.restart);
        body.appendChild(h('tr', {}, h('td', {}, h('b', {}, a.name)), cell(T.agents.provider, a.provider || '-'), cell(T.agents.model, a.model || '-'), cell(T.agents.state, h('span', { class: 'pill ' + (a.running ? 'ok' : '') }, a.running ? T.agents.running : T.agents.idle)), h('td', { class: 'actions' }, btn)));
      });
      table.appendChild(body); box.appendChild(table);
    }).catch(function (err) { clear(box); fail(box, err); });
  }
  load();
}

function viewModel() {
  var out = h('div'); var box = h('div', { class: 'card' }, T.loading); var chooser = h('div', { class: 'card' }); var panel = h('div');
  show(h('div', {}, h('h1', {}, T.model.title), out, box, chooser, panel));
  var info = { kind: 'unknown', auth: null, bridge: null, images: false };
  var creds = null; // null: not offered (OpenCode / OneCLI skills missing) or not loaded
  var choice = 'compatible';

  function loadCreds() {
    return api('GET', '/credentials').then(function (c) { creds = c; }).catch(function () { creds = null; });
  }
  function removeButton(kind) {
    var btn = h('button', { type: 'button', class: 'danger' }, T.provider.remove); var note = h('span'); var armed = false; var timer = null;
    function disarm() { armed = false; btn.textContent = T.provider.remove; }
    btn.onclick = function () {
      clear(note);
      if (!armed) { armed = true; btn.textContent = T.provider.remove_confirm; timer = setTimeout(disarm, 5000); return; }
      clearTimeout(timer); btn.disabled = true;
      ensureReauth().then(function () { return api('DELETE', '/credentials/' + kind); }).then(loadCreds).then(function () { renderPanel(); })
        .catch(function (err) { btn.disabled = false; disarm(); fail(note, err); });
    };
    return h('span', {}, btn, note);
  }
  function pill(ok, yes, no) { return h('span', { class: 'pill ' + (ok ? 'ok' : 'bad') }, ok ? yes : no); }
  function strip(v) { var o = {}; for (var k in v) if (v[k] !== undefined && v[k] !== '') o[k] = v[k]; return o; }

  function loadStatus() {
    return api('GET', '/model').then(function (m) {
      info = { kind: m.kind, auth: m.auth, bridge: m.bridge_address, images: m.images === true };
      clear(box);
      if (m.interrupted) box.appendChild(message('error', T.model.interrupted));
      box.appendChild(h('h2', {}, T.model.current));
      box.appendChild(h('p', {}, h('span', { class: 'muted' }, T.provider.in_use + ': '), T.provider.names[m.kind] || T.provider.names.unknown, m.auth ? ' (' + T.provider.auth[m.auth] + ')' : ''));
      if (m.kind === 'compatible') box.appendChild(h('p', {}, h('span', { class: 'muted' }, T.model.baseUrl + ': '), m.base_url || '-'));
      box.appendChild(h('p', {}, h('span', { class: 'muted' }, T.model.model + ': '), m.kind === 'claude' ? (m.groups[0] && m.groups[0].model) || T.provider.default_model : m.model || '-'));
      var rows = h('tbody');
      m.groups.forEach(function (g) { rows.appendChild(h('tr', {}, h('td', {}, h('b', {}, g.name)), cell(T.agents.provider, g.provider || 'claude'), cell(T.agents.model, g.model || '-'), h('td', {}, h('span', { class: 'pill ' + (g.follows_settings || m.kind === 'claude' ? 'ok' : 'bad') }, g.follows_settings || m.kind === 'claude' ? T.model.follows : T.model.differs)))); });
      if (m.groups.length) box.appendChild(h('table', { class: 'stack' }, h('thead', {}, h('tr', {}, h('th', {}, T.agents.name), h('th', {}, T.agents.provider), h('th', {}, T.agents.model), h('th'))), rows));
      return m;
    });
  }

  function renderChooser() {
    clear(chooser);
    chooser.appendChild(h('h2', {}, T.provider.choose));
    var row = h('div', { class: 'segments', role: 'tablist' });
    ['compatible', 'chatgpt', 'claude'].forEach(function (kind) {
      row.appendChild(h('button', { type: 'button', role: 'tab', 'aria-selected': choice === kind ? 'true' : 'false', class: choice === kind ? 'on' : '', onclick: function () { choice = kind; renderChooser(); renderPanel(); } }, T.provider.names[kind]));
    });
    chooser.appendChild(row);
    chooser.appendChild(h('p', { class: 'muted' }, T.provider.blurb[choice]));
  }

  // ----- credential widgets -----
  function secretForm(label, help, onSave, guideAnchor) {
    var input = h('input', { type: 'password', autocomplete: 'off', spellcheck: 'false', placeholder: label });
    var note = h('div');
    var btn = h('button', { type: 'button' }, T.provider.save);
    btn.onclick = function () {
      clear(note);
      if (!input.value.trim()) return;
      btn.disabled = true;
      ensureReauth().then(function () { return onSave(input.value.trim()); }).then(function () { input.value = ''; return loadCreds(); }).then(function () { note.appendChild(message('ok', T.provider.saved)); renderPanel(); })
        .catch(function (err) { btn.disabled = false; fail(note, err); });
    };
    return h('div', { class: 'secret' }, h('label', {}, label, input), h('p', { class: 'hint' }, help, ' ', guide(guideAnchor, T.provider.moreAbout)), h('div', { class: 'row' }, btn), note);
  }

  function chatgptLoginWidget() {
    var area = h('div'); var btn = h('button', { type: 'button' }, T.provider.signin);
    var shown = '';
    function show_(state) {
      // Redrawing every poll would drop a text selection (the code being copied), so only redraw on a change.
      var key = state.state + '|' + (state.url || '') + '|' + (state.code || '') + '|' + (state.error || '');
      if (key === shown) return;
      shown = key;
      clear(area);
      if (state.state === 'waiting' && state.url) {
        area.appendChild(h('div', { class: 'notice' }, T.provider.signin_steps, ' ', String(state.url).toLowerCase().indexOf('https://') === 0 ? h('a', { href: state.url, target: '_blank', rel: 'noopener noreferrer' }, state.url) : h('span', {}, state.url),
          h('div', { class: 'key' }, state.code || '')));
        area.appendChild(h('button', { type: 'button', onclick: function () { api('DELETE', '/credentials/chatgpt/login').then(function () { show_({ state: 'idle' }); btn.disabled = false; }).catch(function () {}); } }, T.cancel));
      } else if (state.state === 'waiting') {
        area.appendChild(message('ok', T.provider.signin_starting));
      } else if (state.state === 'error') {
        area.appendChild(message('error', explain({ code: state.error || 'login_failed' })));
        btn.disabled = false;
      }
    }
    function poll() {
      if (!document.body.contains(area)) return;
      api('GET', '/credentials/chatgpt/login').then(function (state) {
        if (state.state === 'done') { return loadCreds().then(function () { renderPanel(); }); }
        show_(state);
        if (state.state === 'waiting') setTimeout(poll, 2000); else btn.disabled = false;
      }).catch(function () { setTimeout(poll, 4000); });
    }
    btn.onclick = function () {
      btn.disabled = true; clear(area); shown = '';
      ensureReauth().then(function () { return api('POST', '/credentials/chatgpt/login'); }).then(function (state) { show_(state); setTimeout(poll, 1500); })
        .catch(function (err) { btn.disabled = false; fail(area, err); });
    };
    return h('div', {}, h('p', { class: 'hint' }, T.provider.signin_help, ' ', guide('chatgpt', T.provider.moreAbout)), h('div', { class: 'row' }, btn), area);
  }

  function modelFields(opts) {
    var model = h('input', { autocomplete: 'off', spellcheck: 'false', placeholder: opts.placeholder || '' });
    var small = opts.small ? h('input', { autocomplete: 'off', spellcheck: 'false' }) : null;
    return { model: model, small: small, nodes: [h('label', {}, opts.label, model)].concat(small ? [h('label', {}, T.model.small, small), h('p', { class: 'hint' }, T.model.smallHelp, ' ', guide('the-small-model', T.model.moreAbout))] : []) };
  }

  function applyRow(result, getBody, ready) {
    var btn = h('button', { class: 'primary', type: 'button', disabled: !ready }, T.model.apply);
    btn.onclick = function () {
      clear(result); btn.disabled = true;
      ensureReauth().then(function () { return api('POST', '/model/apply', getBody()); }).then(function (r) {
        result.appendChild(message('ok', T.model.applied + ' ' + r.restarted + '/' + r.agents + ' ' + T.provider.agents_restarted));
        return loadStatus();
      }).catch(function (err) { btn.disabled = false; fail(result, err); });
    };
    return btn;
  }

  // ----- the three provider forms -----
  function compatibleForm() {
    var url = h('input', { type: 'url', required: true, placeholder: 'http://host:8000/v1', autocomplete: 'off', spellcheck: 'false' });
    var model = h('input', { required: true, list: 'models', autocomplete: 'off', spellcheck: 'false' });
    var small = h('input', { autocomplete: 'off', spellcheck: 'false' });
    var list = h('datalist', { id: 'models' }); var result = h('div'); var checked = false;
    var images = h('input', { type: 'checkbox' }); var imagesNote = h('p', { class: 'hint' }, T.model.imagesHelp); var imagesTouched = false;
    images.checked = info.kind === 'compatible' && info.images; images.onchange = function () { imagesTouched = true; };
    var checkBtn = h('button', { type: 'button' }, T.model.check); var applyBtn = h('button', { class: 'primary', type: 'button', disabled: true }, T.model.apply);
    function body() { return strip({ kind: 'compatible', baseUrl: url.value.trim(), model: model.value.trim(), smallModel: small.value.trim(), images: images.checked }); }
    function invalidate() { checked = false; applyBtn.disabled = true; }
    fillFrom(url, model, small);
    var ollama = h('button', { type: 'button', onclick: function () { url.value = 'http://' + (info.bridge || 'localhost') + ':11434/v1'; model.value = ''; invalidate(); clear(result); checkBtn.click(); } }, T.provider.use_ollama);
    checkBtn.onclick = function () {
      clear(result); invalidate();
      if (!url.reportValidity()) return;
      api('POST', '/model/preflight', Object.assign(body(), model.value.trim() ? {} : { model: 'x' })).then(function (p) {
        clear(list); p.models.forEach(function (id) { list.appendChild(h('option', { value: String(id).slice(0, 200) })); });
        if (!model.value.trim()) { result.appendChild(message('ok', T.provider.models_found + ': ' + (p.models.map(function (id) { return String(id).slice(0, 200); }).join(', ') || '-'))); return; }
        if (!p.ok) return result.appendChild(message('error', (T.errors[p.reason] || p.reason) + ''));
        checked = true; applyBtn.disabled = false;
        if (p.image_support === true || p.image_support === false) {
          if (!imagesTouched) images.checked = p.image_support;
          clear(imagesNote); imagesNote.appendChild(document.createTextNode(p.image_support ? T.model.imagesDetected : T.model.imagesNone));
        } else { clear(imagesNote); imagesNote.appendChild(document.createTextNode(T.model.imagesUnknown)); }
        result.appendChild(message('ok', T.model.checked + ' ' + T.model.affected + ': ' + p.restarts_needed + (p.context_limit ? '. ' + T.model.context + ': ' + p.context_limit : '') + '.'));
      }).catch(function (err) { fail(result, err); });
    };
    applyBtn.onclick = function () {
      if (!checked) return; clear(result); applyBtn.disabled = true;
      ensureReauth().then(function () { return api('POST', '/model/apply', body()); }).then(function (r) { result.appendChild(message('ok', T.model.applied + ' ' + r.restarted + '/' + r.agents + ' ' + T.provider.agents_restarted)); return loadStatus(); })
        .catch(function (err) { applyBtn.disabled = false; fail(result, err); });
    };
    [url, model, small].forEach(function (el) { el.oninput = invalidate; });
    return h('form', { onsubmit: function (ev) { ev.preventDefault(); } },
      h('label', {}, T.model.baseUrl, url), h('div', { class: 'row' }, ollama, h('span', { class: 'hint' }, T.provider.ollama_hint, ' ', guide('ollama', T.model.moreAbout))),
      h('label', {}, T.model.model, model, list), h('label', {}, T.model.small, small), h('p', { class: 'hint' }, T.model.smallHelp, ' ', guide('the-small-model', T.model.moreAbout)),
      h('label', { class: 'row' }, images, T.model.images), imagesNote,
      h('p', { class: 'muted' }, T.model.keyNote, ' ', guide('api-keys', T.model.keyHelp)), result, h('div', { class: 'row' }, checkBtn, applyBtn));
  }
  function fillFrom(url, model, small) {
    api('GET', '/model').then(function (m) {
      if (m.kind !== 'compatible') return;
      if (m.base_url) url.value = m.base_url;
      if (m.model && m.model.indexOf('openai/') === 0) model.value = m.model.slice(7);
      if (m.small_model && m.small_model.indexOf('openai/') === 0 && m.small_model !== m.model) small.value = m.small_model.slice(7);
    }).catch(function () {});
  }

  function chatgptForm() {
    var auth = info.kind === 'chatgpt' && info.auth ? info.auth : 'subscription';
    var result = h('div'); var fields = modelFields({ label: T.model.model, placeholder: T.provider.chatgpt_model_hint, small: true });
    // ChatGPT models take images, so it is on unless this install already runs ChatGPT with it turned off.
    var images = h('input', { type: 'checkbox' }); images.checked = info.kind === 'chatgpt' ? info.images : true;
    var wrap = h('div');
    var authRow = h('div', { class: 'segments small' });
    ['subscription', 'api-key'].forEach(function (a) {
      authRow.appendChild(h('button', { type: 'button', class: auth === a ? 'on' : '', onclick: function () { auth = a; draw(); } }, T.provider.auth[a]));
    });
    function draw() {
      clear(wrap); clear(authRow);
      ['subscription', 'api-key'].forEach(function (a) { authRow.appendChild(h('button', { type: 'button', class: auth === a ? 'on' : '', onclick: function () { auth = a; draw(); } }, T.provider.auth[a])); });
      var have = creds ? (auth === 'subscription' ? creds.chatgpt_login : creds.openai_key) : false;
      wrap.appendChild(authRow);
      if (!creds) { wrap.appendChild(message('error', explain({ code: 'script_missing' }))); return; }
      wrap.appendChild(h('p', {}, T.provider.credential + ': ', pill(have, T.provider.stored, T.provider.not_stored), have ? ' ' : null, have ? removeButton(auth === 'subscription' ? 'chatgpt-login' : 'openai-key') : null));
      wrap.appendChild(auth === 'subscription' ? chatgptLoginWidget() : secretForm(T.provider.openai_key, T.provider.openai_key_help, function (v) { return api('POST', '/credentials/openai-key', { value: v }); }, 'chatgpt'));
      fields.nodes.forEach(function (n) { wrap.appendChild(n); });
      wrap.appendChild(h('label', { class: 'row' }, images, T.model.images)); wrap.appendChild(h('p', { class: 'hint' }, T.model.imagesHelp));
      wrap.appendChild(result);
      wrap.appendChild(h('div', { class: 'row' }, applyRow(result, function () { return strip({ kind: 'chatgpt', auth: auth, model: fields.model.value.trim(), smallModel: fields.small.value.trim(), images: images.checked }); }, have)));
    }
    draw();
    return wrap;
  }

  function claudeForm() {
    var result = h('div'); var fields = modelFields({ label: T.provider.claude_model, placeholder: T.provider.claude_model_hint, small: false });
    var wrap = h('div');
    if (!creds) { wrap.appendChild(message('error', explain({ code: 'script_missing' }))); return wrap; }
    wrap.appendChild(h('p', {}, T.provider.credential + ': ', pill(creds.claude, T.provider.stored, T.provider.not_stored), creds.claude ? ' ' : null, creds.claude ? removeButton('claude') : null));
    wrap.appendChild(secretForm(T.provider.claude_secret, T.provider.claude_help, function (v) { return api('POST', '/credentials/claude', { value: v }); }, 'claude'));
    fields.nodes.forEach(function (n) { wrap.appendChild(n); });
    wrap.appendChild(result);
    wrap.appendChild(h('div', { class: 'row' }, applyRow(result, function () { return strip({ kind: 'claude', model: fields.model.value.trim() }); }, creds.claude)));
    return wrap;
  }

  function renderPanel() {
    clear(panel);
    var form = choice === 'compatible' ? compatibleForm() : choice === 'chatgpt' ? chatgptForm() : claudeForm();
    panel.appendChild(h('div', { class: 'card' }, form));
    panel.appendChild(h('div', { class: 'links' }, guide('how-a-model-change-works', T.model.applyHelp), guide('endpoint-checks-and-errors', T.model.errorsHelp)));
  }

  Promise.all([loadStatus(), loadCreds()]).then(function (results) {
    var kind = results[0].kind; choice = kind === 'chatgpt' || kind === 'claude' ? kind : 'compatible';
    renderChooser(); renderPanel();
  }).catch(function (err) { clear(box); fail(box, err); });
}

function viewBackups() {
  var out = h('div'); var box = h('div', { class: 'card' }, T.loading); var progress = h('div');
  var createBtn = h('button', { class: 'primary', type: 'button' }, T.backups.create); var timer = null;
  show(h('div', {}, h('h1', {}, T.backups.title), h('p', { class: 'muted' }, T.backups.note, ' ', guide('restoring-a-backup', T.backups.restoreHelp)), h('div', { class: 'links' }, guide('the-backup-key', T.backups.keyHelp), guide('consistency-levels', T.backups.consistencyHelp), guide('retention-and-pruning', T.backups.retentionHelp), guide('moving-to-another-machine', T.backups.moveHelp)), h('div', { class: 'row' }, createBtn), progress, out, box));
  createBtn.onclick = function () {
    clear(out); createBtn.disabled = true;
    ensureReauth().then(function () { return api('POST', '/backups', {}); }).then(function (r) { follow(r.job); })
      .catch(function (err) { createBtn.disabled = false; fail(out, err); });
  };
  // Draws the state of the backup and keeps asking until it is over.
  function follow(job) {
    clearTimeout(timer);
    if (job.state === 'running') { createBtn.disabled = true; drawProgress(job); timer = setTimeout(poll, 2000); return; }
    clear(progress); createBtn.disabled = false;
    if (job.state === 'error') return fail(out, { code: job.error });
    if (job.state === 'done') {
      if (job.key) showKey(job.key, job.backup); else out.appendChild(message('ok', T.backups.doneNoKey));
      load();
    }
  }
  function poll() {
    if (!document.body.contains(progress)) return;
    api('GET', '/backups/job').then(function (r) { follow(r.job); }).catch(function () { timer = setTimeout(poll, 4000); });
  }
  function clockText(sec) { return Math.floor(sec / 60) + ' min ' + (sec % 60) + ' s'; }
  function drawProgress(job) {
    var text = job.phase === 'waiting' ? T.backups.phase_waiting.replace('{n}', job.wait_seconds)
      : job.phase === 'snapshot' ? T.backups.phase_snapshot
      : T.backups.phase_pack.replace('{files}', job.entries).replace('{size}', fmtBytes(job.bytes));
    clear(progress);
    progress.appendChild(h('div', { class: 'notice', role: 'status' }, h('strong', {}, T.backups.running), h('p', {}, text),
      h('progress', {}), h('p', { class: 'muted' }, T.backups.elapsed + ': ' + clockText(job.elapsed_seconds) + '. ' + T.backups.keepOpen)));
  }
  function consLabel(c) { return c === 'quiescent' ? T.backups.consAgentsIdle : c === 'best-effort' ? T.backups.consAgentsWorking : c === 'cold' ? T.backups.consStopped : c; }
  function showKey(key, backup) {
    var saved = h('input', { type: 'checkbox' }); var done = h('button', { class: 'primary', type: 'button', disabled: true }, T.close);
    dialog(function (close) {
      saved.onchange = function () { done.disabled = !saved.checked; }; done.onclick = close;
      return h('div', {}, h('h1', {}, T.backups.keyTitle), h('p', {}, T.backups.keyBody), h('code', { class: 'key' }, key), backup && backup.consistency === 'best-effort' ? h('div', { class: 'notice' }, T.backups.bestEffort, ' ', guide('consistency-levels', T.backups.consistencyHelp)) : null, h('p', {}, guide('the-backup-key', T.backups.keyHelp)), h('label', { class: 'row' }, saved, T.backups.keySaved), h('div', { class: 'row' }, done));
    });
  }
  function load() {
    api('GET', '/backups').then(function (r) {
      clear(box);
      if (!r.backups.length) return box.appendChild(h('p', { class: 'muted' }, T.none));
      var body = h('tbody');
      r.backups.forEach(function (b) {
        var verify = h('button', { type: 'button', onclick: function () { verifyDialog(b.id); } }, T.backups.verify);
        var download = h('button', { type: 'button', onclick: function () { clear(out); ensureReauth().then(function () { window.location.href = '/api/v1/backups/' + b.id + '/download'; }).catch(function (err) { fail(out, err); }); } }, T.backups.download);
        var del = h('button', { class: 'danger', type: 'button', onclick: function () { if (!window.confirm(T.backups.confirmDelete)) return; clear(out); ensureReauth().then(function () { return api('DELETE', '/backups/' + b.id); }).then(load).catch(function (err) { fail(out, err); }); } }, T.backups.del);
        body.appendChild(h('tr', {}, h('td', {}, h('b', {}, fmtDate(b.created_at)), b.trigger === 'scheduled' ? ' ' : null, b.trigger === 'scheduled' ? h('span', { class: 'pill ok' }, T.backups.scheduled) : null), cell(T.backups.size, fmtBytes(b.bytes)), cell(T.backups.release, b.release), cell(T.backups.consistency, consLabel(b.consistency)), h('td', { class: 'actions' }, h('div', { class: 'row' }, verify, download, del))));
      });
      box.appendChild(h('table', { class: 'stack' }, h('thead', {}, h('tr', {}, h('th', {}, T.backups.created), h('th', {}, T.backups.size), h('th', {}, T.backups.release), h('th', {}, T.backups.consistency), h('th', {}, T.backups.actions))), body));
    }).catch(function (err) { clear(box); fail(box, err); });
  }
  function verifyDialog(id) {
    var key = h('input', { autocomplete: 'off', spellcheck: 'false', required: true }); var res = h('div');
    dialog(function (close) {
      return h('form', { onsubmit: function (ev) { ev.preventDefault(); clear(res);
        api('POST', '/backups/' + id + '/verify', { key: key.value.trim() }).then(function () { res.appendChild(message('ok', T.backups.verifyOk)); }).catch(function (err) { fail(res, err); }); } },
        h('h1', {}, T.backups.verify), h('label', {}, T.backups.verifyKey, key), res, h('div', { class: 'row' }, h('button', { class: 'primary', type: 'submit' }, T.backups.verify), h('button', { type: 'button', onclick: close }, T.close)));
    });
  }
  load();
  api('GET', '/backups/job').then(function (r) { if (r.job.state === 'running' || (r.job.state === 'done' && r.job.key)) follow(r.job); }).catch(function () {});
}

function viewPhone() {
  var out = h('div'); var box = h('div', { class: 'card' }, T.loading);
  show(h('div', {}, h('h1', {}, T.phone.title), h('p', { class: 'muted' }, T.phone.intro, ' ', guide('the-phone-app', T.phone.help)), out, box));
  function chip(ok, yes, no) { return h('span', { class: ok ? 'pill ok' : 'pill' }, ok ? yes : no); }
  function row(label, value) { return h('p', {}, h('span', { class: 'muted' }, label + ': '), value); }
  function showToken(token) {
    var saved = h('input', { type: 'checkbox' }); var done = h('button', { class: 'primary', type: 'button', disabled: true }, T.close);
    dialog(function (close) {
      saved.onchange = function () { done.disabled = !saved.checked; }; done.onclick = function () { close(); load(); };
      return h('div', {}, h('h1', {}, T.phone.tokenTitle), h('p', {}, T.phone.tokenBody), h('code', { class: 'key' }, token), h('label', { class: 'row' }, saved, T.phone.tokenSaved), h('div', { class: 'row' }, done));
    });
  }
  function load() {
    api('GET', '/phone').then(function (s) {
      clear(box);
      if (!s.installed) { box.appendChild(h('p', {}, T.phone.notInstalled, ' ', guide('the-phone-app', T.phone.help))); return; }
      box.appendChild(h('h2', {}, T.phone.connection));
      box.appendChild(row(T.phone.app, chip(s.connected, T.phone.connected, T.phone.notConnected)));
      if (s.connected && s.connected_at) box.appendChild(row(T.phone.since, fmtDate(s.connected_at) + (s.locale ? ' (' + s.locale + ')' : '')));
      else if (s.last_disconnect_at) box.appendChild(row(T.phone.lastSeen, fmtDate(s.last_disconnect_at)));
      box.appendChild(row(T.phone.channel, chip(s.listening, T.phone.listening, s.enabled ? T.phone.enabledNotRunning : T.phone.off)));
      if (s.restart_needed) box.appendChild(h('div', { class: 'notice' }, T.phone.restart));
      box.appendChild(row(T.phone.address, s.url ? h('code', {}, s.url) : T.phone['problem_' + s.address_problem] || '-'));
      box.appendChild(row(T.phone.agent, s.agent || h('span', {}, T.phone.notWired, ' ', guide('the-phone-app', T.phone.help))));
      box.appendChild(row(T.phone.push, chip(s.push_registered, T.phone.pushYes, T.phone.pushNo)));
      box.appendChild(row(T.phone.token, chip(s.token_set, T.phone.tokenSet, T.phone.tokenMissing)));
      var tokenBtn = h('button', { type: 'button' }, T.phone.newToken);
      tokenBtn.onclick = function () {
        if (s.token_set && s.connected && !window.confirm(T.phone.confirmToken)) return;
        clear(out); tokenBtn.disabled = true;
        ensureReauth().then(function () { return api('POST', '/phone/token', {}); }).then(function (r) { tokenBtn.disabled = false; showToken(r.token); })
          .catch(function (err) { tokenBtn.disabled = false; fail(out, err); });
      };
      var switchBtn = h('button', { type: 'button', class: s.enabled ? 'danger' : 'primary' }, s.enabled ? T.phone.turnOff : T.phone.turnOn);
      switchBtn.onclick = function () {
        clear(out); switchBtn.disabled = true;
        ensureReauth().then(function () { return api('POST', '/phone/enabled', { enabled: !s.enabled }); }).then(function () { out.appendChild(message('ok', T.phone.changed)); load(); })
          .catch(function (err) { switchBtn.disabled = false; fail(out, err); });
      };
      box.appendChild(h('div', { class: 'row' }, tokenBtn, switchBtn));
    }).catch(function (err) { clear(box); fail(box, err); });
  }
  load();
}

var views = { overview: viewOverview, agents: viewAgents, model: viewModel, phone: viewPhone, backups: viewBackups };
// The current page lives in the address (#model), so leaving for the guide and coming back lands on the same page.
function fromHash() { var name = location.hash.replace('#', ''); return Object.prototype.hasOwnProperty.call(views, name) ? name : 'overview'; }
function render(name) { state.view = name; renderNav(); views[name](); }
function go(name) { if (location.hash === '#' + name) render(name); else location.hash = name; }
window.addEventListener('hashchange', function () { if (state.csrf) render(fromHash()); });
function renderNav() {
  var nav = document.getElementById('nav'); clear(nav);
  Object.keys(views).forEach(function (name) { nav.appendChild(h('button', { type: 'button', 'aria-current': state.view === name ? 'page' : false, onclick: function () { go(name); } }, T.nav[name])); });
}
function enter() {
  document.getElementById('top').hidden = false;
  var local = ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) >= 0;
  var warn = state.insecure && !local;
  var banner = document.getElementById('banner'); banner.hidden = !warn; clear(banner); if (warn) { banner.appendChild(document.createTextNode(T.insecure)); banner.appendChild(guide('https-and-network-access', T.guide.insecureMore)); }
  render(fromHash());
}
function start() {
  state.csrf = null; document.getElementById('top').hidden = true;
  api('GET', '/session').then(function (s) { state.csrf = s.csrf_token; state.insecure = s.insecure_http; enter(); }).catch(function () {
    api('GET', '/setup').then(function (r) { viewAuth(r.needed); }).catch(function (err) { show(message('error', explain(err))); });
  });
}
var lo = document.getElementById('logout'); lo.textContent = T.logout;
lo.onclick = function () { api('DELETE', '/session').then(start).catch(start); };
start();
`;
