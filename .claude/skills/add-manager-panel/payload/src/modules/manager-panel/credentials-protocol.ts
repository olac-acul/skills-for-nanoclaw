/**
 * The conversation between the panel and `scripts/manager-credentials.ts`.
 *
 * The script runs as a child process because the code that talks to the credential gateway lives
 * outside `src/`. A secret travels from the panel to the script on stdin as JSON and is never put
 * on a command line by this protocol, never echoed back, and never part of an event. The script
 * answers with one JSON event per line on stdout; everything else it prints is ignored.
 */

export type ScriptEvent =
  | { type: 'status'; claude: boolean; openaiKey: boolean; chatgptLogin: boolean }
  | { type: 'prompt'; url: string; code: string }
  | { type: 'done' }
  | { type: 'error'; code: ScriptErrorCode };

export type ScriptErrorCode =
  | 'gateway_unavailable'
  | 'invalid_secret'
  | 'save_failed'
  | 'remove_failed'
  | 'login_failed'
  | 'login_timeout'
  | 'login_cancelled'
  | 'runtime_unavailable'
  | 'script_missing'
  | 'script_failed';

const ERROR_CODES: ReadonlySet<string> = new Set<ScriptErrorCode>([
  'gateway_unavailable',
  'invalid_secret',
  'save_failed',
  'remove_failed',
  'login_failed',
  'login_timeout',
  'login_cancelled',
  'runtime_unavailable',
  'script_missing',
  'script_failed',
]);

/** API keys and subscription tokens are single printable tokens with no spaces. */
export function validSecret(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{16,1024}$/.test(value);
}

export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex -- terminal escape sequences are exactly what is being removed
  return text.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

/** The sign-in page must be on OpenAI's own domains; anything else printed by the container is refused. */
export function isTrustedLoginUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unparsable URL is simply not trusted
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false;
  const host = url.hostname.toLowerCase();
  return ['openai.com', 'chatgpt.com'].some((domain) => host === domain || host.endsWith(`.${domain}`));
}

/** The pairing page and code that `opencode auth login` prints for a headless sign-in. */
export function parseDeviceOutput(text: string): { url: string; code: string } | null {
  const clean = stripAnsi(text);
  const url = /Go to:\s*(https:\/\/[^\s]+)/.exec(clean)?.[1];
  if (url && !isTrustedLoginUrl(url)) return null;
  const code = /Enter code:\s*([A-Za-z0-9-]{4,32})/.exec(clean)?.[1];
  return url && code ? { url, code } : null;
}

interface SecretListEntry {
  id?: string;
  name?: string;
  type?: string;
}

function secrets(listJson: string): SecretListEntry[] {
  const parsed = JSON.parse(listJson) as { data?: SecretListEntry[] };
  return Array.isArray(parsed.data) ? parsed.data : [];
}

/** Only the secret this panel manages: of type anthropic, or named exactly "Anthropic". */
function isAnthropic(entry: SecretListEntry): boolean {
  return entry.type === 'anthropic' || entry.name === 'Anthropic';
}

/** Output of `onecli secrets list`: is an Anthropic credential stored, and under which id? */
export function findAnthropicSecret(listJson: string): { id: string | null; name: string | null } | null {
  const found = secrets(listJson).find(isAnthropic);
  return found
    ? { id: typeof found.id === 'string' ? found.id : null, name: typeof found.name === 'string' ? found.name : null }
    : null;
}

/** The credentials the panel can remove. */
export type CredentialKind = 'claude' | 'openai-key' | 'chatgpt-login';

export function isCredentialKind(value: unknown): value is CredentialKind {
  return value === 'claude' || value === 'openai-key' || value === 'chatgpt-login';
}

/** Output of `onecli secrets list`: the entry stored under exactly this name, if any. */
export function findSecretByName(listJson: string, name: string): { id: string | null } | null {
  const found = secrets(listJson).find((entry) => entry.name === name);
  return found ? { id: typeof found.id === 'string' ? found.id : null } : null;
}

export function encodeEvent(event: ScriptEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** Parse the lines of a script's stdout, ignoring anything that is not a known event. */
export function parseEvents(stdout: string): ScriptEvent[] {
  const events: ScriptEvent[] = [];
  for (const line of stdout.split('\n')) {
    const text = line.trim();
    if (!text.startsWith('{')) continue;
    let value: unknown;
    try {
      value = JSON.parse(text);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a line that is not JSON is simply not an event
    } catch {
      continue;
    }
    const event = value as Record<string, unknown>;
    if (
      event.type === 'status' &&
      typeof event.claude === 'boolean' &&
      typeof event.openaiKey === 'boolean' &&
      typeof event.chatgptLogin === 'boolean'
    ) {
      events.push({
        type: 'status',
        claude: event.claude,
        openaiKey: event.openaiKey,
        chatgptLogin: event.chatgptLogin,
      });
    } else if (
      event.type === 'prompt' &&
      typeof event.url === 'string' &&
      typeof event.code === 'string' &&
      isTrustedLoginUrl(event.url)
    ) {
      events.push({ type: 'prompt', url: event.url, code: event.code });
    } else if (event.type === 'done') {
      events.push({ type: 'done' });
    } else if (event.type === 'error') {
      events.push({
        type: 'error',
        code:
          typeof event.code === 'string' && ERROR_CODES.has(event.code)
            ? (event.code as ScriptErrorCode)
            : 'script_failed',
      });
    }
  }
  return events;
}
