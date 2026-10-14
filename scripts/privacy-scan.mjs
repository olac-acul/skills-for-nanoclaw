#!/usr/bin/env node
/**
 * Lightweight privacy gate.
 *
 * Blocks commits and CI runs that would publish private network addresses,
 * personal email addresses, credentials, or a non-anonymous git identity.
 *
 * Modes (combine freely):
 *   --staged    scan the staged version of changed files (pre-commit hook)
 *   --all       scan every tracked file
 *   --history   scan every commit's author/committer email and message
 *   --history-content  scan every line ever added in any commit, deleted ones included, and every file name
 *   --identity  check the identity git would use for the next commit
 *   --deny-list <file>  one case-insensitive pattern per line (blank lines and # comments ignored): terms that
 *               must never appear, such as real names, domains and account ids. Keep that file OUT of the
 *               repository, or it would publish exactly what it forbids. Applies to every mode above.
 *               Without the flag, the file named by $PRIVACY_SCAN_DENY_LIST, or else
 *               ~/.config/privacy-scan/deny-list.txt, is used when it exists.
 *
 * A line containing `privacy-scan: allow` is skipped. Synthetic data should
 * use CGNAT addresses (100.64.0.0/10), `.test` names and `example.*` emails.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 1024 * 1024;

/** Emails that are safe to publish. */
const ALLOWED_EMAIL = [
  /@users\.noreply\.github\.com$/i,
  /@noreply\.github\.com$/i,
  /@example\.(com|org|net)$/i,
  /@[a-z0-9.-]*\.test$/i,
  /^noreply@anthropic\.com$/i,
  // `package@1.2.3`, a pinned dependency: an address cannot end in a number.
  /@\d+(\.\d+)+$/,
];

export const RULES = [
  {
    id: 'private-ipv4',
    description: 'private IPv4 address (RFC 1918)',
    pattern:
      /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
  },
  {
    id: 'private-hostname',
    description: 'LAN-only hostname (.lan, .local, .internal, .home.arpa)',
    // The lookahead keeps file names such as CLAUDE.local.md from matching.
    // `host.docker.internal` is Docker's own fixed name for the host, not anyone's network.
    pattern: /\b(?!host\.docker\.internal\b)(?<!host\.)[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:lan|local|internal|home\.arpa|localdomain)\b(?!\.[a-z0-9])/gi,
  },
  {
    id: 'credential',
    description: 'looks like a credential',
    pattern:
      /\b(?:ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{40,}|sk-[A-Za-z0-9_-]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b|-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/g,
  },
  {
    id: 'credential-assignment',
    description: 'secret-looking value assigned to a key/token/password variable',
    pattern: /\b(?:api[_-]?key|secret|token|passw(?:or)?d)\b\s*[:=]\s*['"][^'"\s]{16,}['"]/gi,
  },
];

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g;

export function isAllowedEmail(email) {
  return ALLOWED_EMAIL.some((re) => re.test(email));
}

/** Turn the text of a deny list into patterns. A line that is not a valid regular expression is taken literally. */
export function parseDenyList(text) {
  const patterns = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    try {
      patterns.push(new RegExp(line, 'i'));
    } catch {
      patterns.push(new RegExp(line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
    }
  }
  return patterns;
}

/** Return findings for one block of text. `options.deny` is a list of patterns that must not appear. */
export function scanText(text, label, options = {}) {
  const findings = [];
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.includes('privacy-scan: allow')) return;
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        findings.push({ label, line: index + 1, rule: rule.id, description: rule.description, match: redact(match[0]) });
      }
    }
    for (const match of line.matchAll(EMAIL)) {
      if (!isAllowedEmail(match[0])) {
        findings.push({ label, line: index + 1, rule: 'email', description: 'non-anonymous email address', match: redact(match[0]) });
      }
    }
    for (const pattern of options.deny ?? []) {
      if (pattern.test(line)) {
        findings.push({ label, line: index + 1, rule: 'denied-term', description: 'a term from the deny list', match: redact(pattern.source) });
      }
    }
  });
  return findings;
}

/** Never echo a full secret back into CI logs. */
function redact(value) {
  return value.length <= 8 ? '***' : `${value.slice(0, 3)}***${value.slice(-2)}`;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

export function scanFiles(paths, readFile, options = {}) {
  const findings = [];
  for (const path of paths) {
    const buffer = readFile(path);
    if (!buffer || buffer.length > MAX_BYTES || isBinary(buffer)) continue;
    findings.push(...scanText(buffer.toString('utf8'), path, options));
  }
  return findings;
}

export function scanIdentity(commits, options = {}) {
  const findings = [];
  for (const commit of commits) {
    for (const [role, email] of [
      ['author', commit.authorEmail],
      ['committer', commit.committerEmail],
    ]) {
      if (!isAllowedEmail(email)) {
        findings.push({ label: commit.sha.slice(0, 8), line: 0, rule: 'commit-identity', description: `${role} email is not anonymous`, match: redact(email) });
      }
    }
    findings.push(...scanText(commit.message, `${commit.sha.slice(0, 8)}:message`, options));
    for (const name of [commit.authorName, commit.committerName]) {
      if (name) findings.push(...scanText(name, `${commit.sha.slice(0, 8)}:identity`, { deny: options.deny }));
    }
  }
  return findings;
}

function listCommits() {
  const SEP = '\u001f';
  const END = '\u001e';
  const out = git(['log', '--all', `--format=%H${SEP}%ae${SEP}%ce${SEP}%an${SEP}%cn${SEP}%B${END}`]);
  return out
    .split(END)
    .map((entry) => entry.replace(/^\n/, ''))
    .filter(Boolean)
    .map((entry) => {
      const [sha, authorEmail, committerEmail, authorName, committerName, message] = entry.split(SEP);
      return { sha, authorEmail, committerEmail, authorName, committerName, message: message ?? '' };
    });
}

/**
 * Every line ever added in any commit, and every file name ever tracked. A finding is reported once per
 * file and value, with the oldest commit that carried it and how many commits did.
 */
export function scanHistoryContent(options = {}, run = git) {
  const out = run(['log', '--all', '--reverse', '-p', '-U0', '--no-color', '--no-ext-diff', '--format=\u001eCOMMIT %H']);
  const seen = new Map();
  let sha = '';
  let file = '';
  const add = (label, finding) => {
    const key = `${finding.rule}|${file}|${finding.match}`;
    const entry = seen.get(key);
    if (entry) entry.commits += 1;
    else seen.set(key, { ...finding, label, commits: 1 });
  };
  for (const raw of out.split('\n')) {
    if (raw.startsWith('\u001eCOMMIT ')) {
      sha = raw.slice(8).trim().slice(0, 8);
      continue;
    }
    if (raw.startsWith('diff --git ')) {
      file = raw.split(' b/').pop() ?? '';
      for (const finding of scanText(file, `${sha}:path`, { deny: options.deny })) add(`${sha}:${file}`, { ...finding, rule: `path-${finding.rule}` });
      continue;
    }
    if (!raw.startsWith('+') || raw.startsWith('+++')) continue;
    for (const finding of scanText(raw.slice(1), `${sha}:${file}`, options)) add(`${sha}:${file}`, finding);
  }
  return [...seen.values()].map((f) => ({ ...f, description: `${f.description}${f.commits > 1 ? ` (in ${f.commits} commits)` : ''}` }));
}

/** Where a private deny list is looked for when none is given on the command line. */
export function defaultDenyFile(env = process.env, exists = existsSync) {
  const file = env.PRIVACY_SCAN_DENY_LIST || join(homedir(), '.config', 'privacy-scan', 'deny-list.txt');
  return exists(file) ? file : null;
}

function parseArgs(argv) {
  const modes = new Set();
  let denyFile = null;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--deny-list') denyFile = argv[++i] ?? null;
    else modes.add(argv[i]);
  }
  return { modes, denyFile: denyFile ?? defaultDenyFile() };
}

function main(argv) {
  const { modes, denyFile } = parseArgs(argv);
  const options = { deny: denyFile ? parseDenyList(readFileSync(denyFile, 'utf8')) : [] };
  if (modes.size === 0) modes.add('--all');
  let findings = [];

  if (modes.has('--staged')) {
    const staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z']).split('\0').filter(Boolean);
    findings.push(
      ...scanFiles(staged, (path) => {
        try {
          return execFileSync('git', ['show', `:${path}`], { maxBuffer: 64 * 1024 * 1024 });
        } catch {
          return null;
        }
      }, options),
    );
  }
  if (modes.has('--all')) {
    const tracked = git(['ls-files', '-z']).split('\0').filter(Boolean);
    findings.push(
      ...scanFiles(tracked, (path) => {
        try {
          return readFileSync(path);
        } catch {
          return null;
        }
      }, options),
    );
  }
  if (modes.has('--history')) findings.push(...scanIdentity(listCommits(), options));
  if (modes.has('--history-content')) findings.push(...scanHistoryContent(options));
  if (modes.has('--identity')) {
    const email = (kind) => /<([^>]*)>/.exec(git(['var', kind]))?.[1] ?? '';
    findings.push(
      ...scanIdentity([
        { sha: 'pending-commit', authorEmail: email('GIT_AUTHOR_IDENT'), committerEmail: email('GIT_COMMITTER_IDENT'), message: '' },
      ]),
    );
  }

  if (findings.length === 0) {
    console.log('privacy-scan: clean');
    return 0;
  }
  for (const f of findings) {
    console.error(`privacy-scan: ${f.label}${f.line ? `:${f.line}` : ''} [${f.rule}] ${f.description} (${f.match})`);
  }
  console.error(`privacy-scan: ${findings.length} finding(s). Use synthetic data, or add "privacy-scan: allow" on a line that is intentionally public.`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}
