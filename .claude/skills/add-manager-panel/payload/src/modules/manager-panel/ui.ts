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
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; " +
  "frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

export const INDEX_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>NanoClaw Manager</title>
    <link rel="stylesheet" href="/app.css" />
  </head>
  <body>
    <div id="banner" role="alert" hidden></div>
    <header id="top" hidden>
      <strong>NanoClaw Manager</strong>
      <nav id="nav"></nav>
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
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #12161b; --panel: #1b2128; --text: #e6e9ed; --muted: #9aa5b1; --line: #2c343d;
    --accent: #4c9aff; --accent-text: #08111c; --danger: #ff8a80; --ok: #56d364; --warn-bg: #3a2f08; --warn-text: #f5deb3;
  }
}
:root[data-theme="dark"] {
  --bg: #12161b; --panel: #1b2128; --text: #e6e9ed; --muted: #9aa5b1; --line: #2c343d;
  --accent: #4c9aff; --accent-text: #08111c; --danger: #ff8a80; --ok: #56d364; --warn-bg: #3a2f08; --warn-text: #f5deb3;
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
code, .key { font-family: ui-monospace, monospace; word-break: break-all; }
.key { display: block; padding: 10px; background: var(--bg); border: 1px dashed var(--line); border-radius: 6px; margin: 8px 0; user-select: all; }
`;

export const APP_JS = `
'use strict';
var T = {
  nav: { overview: 'Overview', agents: 'Agents', model: 'Model', backups: 'Backups' },
  logout: 'Sign out',
  insecure: 'This connection is not encrypted: your password and backup keys cross the network in clear text. Use HTTPS (see the setup notes) unless you are on localhost.',
  setup: { title: 'Welcome', sub: 'Create the administrator account for this install.', code: 'Setup code', password: 'Password (at least 12 characters)', submit: 'Create account', hint: 'Get the code by running pnpm exec tsx scripts/manager-panel.ts setup-code on this machine.' },
  login: { title: 'Sign in', sub: 'Manage your NanoClaw install.', password: 'Password', submit: 'Sign in' },
  reauth: { title: 'Confirm your password', body: 'This action needs your password again.', submit: 'Confirm' },
  cancel: 'Cancel', close: 'Close', loading: 'Loading…', none: 'Nothing here yet.',
  overview: { title: 'Overview', release: 'Release', agents: 'Agents', running: 'Running now', sessions: 'Sessions', gateway: 'Credential gateway', channels: 'Channels', providers: 'Providers', backups: 'Backups', latest: 'Latest', never: 'never', up: 'Uptime' },
  agents: { title: 'Agents', name: 'Name', provider: 'Provider', model: 'Model', state: 'State', restart: 'Restart', running: 'running', idle: 'idle', restarted: 'Restart requested.' },
  model: {
    title: 'Model', current: 'Current settings', baseUrl: 'Endpoint (OpenAI-compatible, ending in /v1)', model: 'Model', small: 'Small model (optional)',
    check: 'Check endpoint', apply: 'Apply to all agents', follows: 'Uses the install settings', differs: 'Different from the install settings',
    keyNote: 'API keys are not entered here. For an endpoint that needs one, store it with: pnpm exec tsx setup/index.ts --step provider-auth opencode',
    checked: 'Endpoint checked.', applied: 'Applied.', affected: 'Agents that will be restarted', context: 'Context window', models: 'Models offered',
    interrupted: 'A previous change was interrupted. It is rolled back automatically at the next start.',
  },
  backups: {
    title: 'Backups', create: 'Create backup', created: 'Created', size: 'Size', release: 'Release', consistency: 'Consistency', actions: 'Actions',
    verify: 'Verify', download: 'Download', del: 'Delete', force: 'Back up even if agents are running',
    keyTitle: 'Save this key now', keyBody: 'This key is needed to open the backup and is not stored anywhere. Put it in your password manager.', keySaved: 'I have stored the key',
    verifyKey: 'Backup key', verifyOk: 'The backup is intact.', confirmDelete: 'Delete this backup permanently?', waiting: 'Waiting for running agents to finish before the snapshot…',
    note: 'Restoring is done from the terminal with the service stopped: pnpm exec tsx scripts/manager-backup.ts restore <id>',
  },
  errors: {
    invalid_credentials: 'Wrong password.', login_throttled: 'Too many attempts. Wait a moment and try again.', invalid_setup_code: 'That setup code is not valid.',
    password_too_short: 'The password is too short.', password_too_long: 'The password is too long.', already_configured: 'An administrator already exists.',
    unauthenticated: 'Your session ended. Sign in again.', reauth_required: 'Confirm your password first.', rate_limited: 'Too many requests. Slow down.',
    agents_busy: 'Agents are still running. Try again later or back up anyway.', probe_failed: 'The endpoint did not pass its checks',
    model_not_found: 'The endpoint does not list that model.', endpoint_unreachable: 'Could not reach the endpoint.', endpoint_invalid: 'That is not a valid endpoint URL.',
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
  } }, needSetup && h('label', {}, T.setup.code, code), needSetup && h('p', { class: 'hint' }, T.setup.hint),
    h('label', {}, needSetup ? T.setup.password : T.login.password, password), out,
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
  }).catch(function (err) { clear(box); fail(box, err); });
}

function viewAgents() {
  var box = h('div', { class: 'card' }, T.loading); var out = h('div'); show(h('div', {}, h('h1', {}, T.agents.title), out, box));
  function load() {
    api('GET', '/agents').then(function (r) {
      clear(box);
      if (!r.agents.length) return box.appendChild(h('p', { class: 'muted' }, T.none));
      var head = h('tr', {}, h('th', {}, T.agents.name), h('th', {}, T.agents.provider), h('th', {}, T.agents.model), h('th', {}, T.agents.state), h('th'));
      var table = h('table', {}, h('thead', {}, head));
      var body = h('tbody');
      r.agents.forEach(function (a) {
        var btn = h('button', { type: 'button', onclick: function () {
          btn.disabled = true; clear(out);
          api('POST', '/agents/' + a.id + '/restart').then(function () { out.appendChild(message('ok', T.agents.restarted)); setTimeout(load, 1500); }).catch(function (err) { btn.disabled = false; fail(out, err); });
        } }, T.agents.restart);
        body.appendChild(h('tr', {}, h('td', {}, a.name), h('td', {}, a.provider || '-'), h('td', {}, a.model || '-'), h('td', {}, h('span', { class: 'pill ' + (a.running ? 'ok' : '') }, a.running ? T.agents.running : T.agents.idle)), h('td', {}, btn)));
      });
      table.appendChild(body); box.appendChild(table);
    }).catch(function (err) { clear(box); fail(box, err); });
  }
  load();
}

function viewModel() {
  var out = h('div'); var box = h('div', { class: 'card' }, T.loading); var form = h('div', { class: 'card' });
  show(h('div', {}, h('h1', {}, T.model.title), out, box, form));
  var url = h('input', { type: 'url', required: true, placeholder: 'http://host:8000/v1', autocomplete: 'off', spellcheck: 'false' });
  var model = h('input', { required: true, list: 'models', autocomplete: 'off', spellcheck: 'false' });
  var small = h('input', { autocomplete: 'off', spellcheck: 'false' });
  var list = h('datalist', { id: 'models' });
  var result = h('div');
  var checked = false;
  function values() { return { baseUrl: url.value.trim(), model: model.value.trim(), smallModel: small.value.trim() || undefined }; }
  function strip(v) { var o = {}; for (var k in v) if (v[k] !== undefined) o[k] = v[k]; return o; }
  api('GET', '/model').then(function (m) {
    clear(box);
    if (m.interrupted) box.appendChild(message('error', T.model.interrupted));
    box.appendChild(h('h2', {}, T.model.current));
    box.appendChild(h('p', {}, h('span', { class: 'muted' }, T.model.baseUrl + ': '), m.base_url || '-'));
    box.appendChild(h('p', {}, h('span', { class: 'muted' }, T.model.model + ': '), m.model || '-', ' ', h('span', { class: 'muted' }, '(' + T.model.small.replace(' (optional)', '') + ': ' + (m.small_model || '-') + ')')));
    var rows = h('tbody');
    m.groups.forEach(function (g) { rows.appendChild(h('tr', {}, h('td', {}, g.name), h('td', {}, g.provider || '-'), h('td', {}, g.model || '-'), h('td', {}, h('span', { class: 'pill ' + (g.follows_settings ? 'ok' : 'bad') }, g.follows_settings ? T.model.follows : T.model.differs)))); });
    if (m.groups.length) box.appendChild(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, T.agents.name), h('th', {}, T.agents.provider), h('th', {}, T.agents.model), h('th'))), rows));
    if (m.base_url) url.value = m.base_url; if (m.model && m.model.indexOf('openai/') === 0) model.value = m.model.slice(7);
    if (m.small_model && m.small_model.indexOf('openai/') === 0 && m.small_model !== m.model) small.value = m.small_model.slice(7);
  }).catch(function (err) { clear(box); fail(box, err); });

  var checkBtn = h('button', { type: 'button' }, T.model.check); var applyBtn = h('button', { class: 'primary', type: 'button', disabled: true }, T.model.apply);
  checkBtn.onclick = function () {
    clear(result); checked = false; applyBtn.disabled = true;
    if (!url.reportValidity() || !model.reportValidity()) return;
    api('POST', '/model/preflight', strip(values())).then(function (p) {
      clear(list); p.models.forEach(function (id) { list.appendChild(h('option', { value: id })); });
      if (!p.ok) return result.appendChild(message('error', (T.errors[p.reason] || p.reason) + ''));
      checked = true; applyBtn.disabled = false;
      result.appendChild(message('ok', T.model.checked + ' ' + T.model.affected + ': ' + p.restarts_needed + (p.context_limit ? '. ' + T.model.context + ': ' + p.context_limit : '') + '.'));
    }).catch(function (err) { fail(result, err); });
  };
  applyBtn.onclick = function () {
    if (!checked) return; clear(result); applyBtn.disabled = true;
    ensureReauth().then(function () { return api('POST', '/model/apply', strip(values())); }).then(function (r) {
      result.appendChild(message('ok', T.model.applied + ' ' + r.restarted + '/' + r.agents + ' agents restarted.')); viewModel();
    }).catch(function (err) { applyBtn.disabled = false; fail(result, err); });
  };
  [url, model, small].forEach(function (el) { el.oninput = function () { checked = false; applyBtn.disabled = true; }; });
  form.appendChild(h('form', { onsubmit: function (ev) { ev.preventDefault(); } }, h('label', {}, T.model.baseUrl, url), h('label', {}, T.model.model, model, list), h('label', {}, T.model.small, small),
    h('p', { class: 'muted' }, T.model.keyNote), result, h('div', { class: 'row' }, checkBtn, applyBtn)));
}

function viewBackups() {
  var out = h('div'); var box = h('div', { class: 'card' }, T.loading); var force = h('input', { type: 'checkbox' });
  var createBtn = h('button', { class: 'primary', type: 'button' }, T.backups.create);
  show(h('div', {}, h('h1', {}, T.backups.title), h('p', { class: 'muted' }, T.backups.note), h('div', { class: 'row' }, createBtn, h('label', { class: 'row' }, force, T.backups.force)), out, box));
  createBtn.onclick = function () {
    clear(out); createBtn.disabled = true;
    ensureReauth().then(function () { out.appendChild(message('ok', T.backups.waiting)); return api('POST', '/backups', { force: force.checked }); }).then(function (r) {
      clear(out); showKey(r.key); load();
    }).catch(function (err) { clear(out); fail(out, err); }).then(function () { createBtn.disabled = false; });
  };
  function showKey(key) {
    var saved = h('input', { type: 'checkbox' }); var done = h('button', { class: 'primary', type: 'button', disabled: true }, T.close);
    dialog(function (close) {
      saved.onchange = function () { done.disabled = !saved.checked; }; done.onclick = close;
      return h('div', {}, h('h1', {}, T.backups.keyTitle), h('p', {}, T.backups.keyBody), h('code', { class: 'key' }, key), h('label', { class: 'row' }, saved, T.backups.keySaved), h('div', { class: 'row' }, done));
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
        body.appendChild(h('tr', {}, h('td', {}, fmtDate(b.created_at)), h('td', {}, fmtBytes(b.bytes)), h('td', {}, b.release), h('td', {}, b.consistency), h('td', {}, h('div', { class: 'row' }, verify, download, del))));
      });
      box.appendChild(h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, T.backups.created), h('th', {}, T.backups.size), h('th', {}, T.backups.release), h('th', {}, T.backups.consistency), h('th', {}, T.backups.actions))), body));
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
}

var views = { overview: viewOverview, agents: viewAgents, model: viewModel, backups: viewBackups };
function go(name) { state.view = name; renderNav(); views[name](); }
function renderNav() {
  var nav = document.getElementById('nav'); clear(nav);
  Object.keys(views).forEach(function (name) { nav.appendChild(h('button', { type: 'button', 'aria-current': state.view === name ? 'page' : false, onclick: function () { go(name); } }, T.nav[name])); });
}
function enter() {
  document.getElementById('top').hidden = false;
  var local = ['localhost', '127.0.0.1', '[::1]'].indexOf(location.hostname) >= 0;
  var warn = state.insecure && !local;
  var banner = document.getElementById('banner'); banner.hidden = !warn; banner.textContent = warn ? T.insecure : '';
  go(state.view);
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
