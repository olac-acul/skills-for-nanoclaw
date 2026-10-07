import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { TXN_DIR, createBundle } from './bundle.js';
import { generateKey } from './crypto.js';
import { createSyntheticInstall, makeHost, type SyntheticInstall } from './fixtures/synthetic-install.js';
import {
  RestoreError,
  commitRestore,
  filterEnvForRehearsal,
  mergeTargetOwnedEnv,
  planRestore,
  restoreBundle,
  rollbackRestore,
} from './restore.js';

let tmp: string;
let source: SyntheticInstall;
let target: SyntheticInstall;
let key: Buffer;
let bundleFile: string;

function query<T>(file: string, sql: string): T[] {
  const db = new Database(file, { readonly: true });
  try {
    return db.prepare(sql).all() as T[];
  } finally {
    db.close();
  }
}

function tree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const name of fs.readdirSync(dir).sort()) {
      const full = path.join(dir, name);
      out.push(path.relative(root, full));
      if (fs.lstatSync(full).isDirectory()) walk(full);
    }
  };
  walk(root);
  return out;
}

beforeEach(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-restore-'));
  source = createSyntheticInstall(tmp, { label: 'source', derivedImage: true });
  target = createSyntheticInstall(tmp, { label: 'target', groups: ['t1'] });
  key = generateKey();
  bundleFile = path.join(tmp, 'bundles', 'source.mbk');
  await createBundle({ host: source.host, key, destFile: bundleFile });
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('planRestore', () => {
  it('reports migrations the host will still apply when the backup is older', async () => {
    const newerCode = makeHost(target.project, target.home, ['one', 'two', 'three']);
    const plan = await planRestore(newerCode, bundleFile, key);
    expect(plan.migrationsToRun).toEqual(['three']);
  });

  it('refuses a backup made by newer code', async () => {
    const olderCode = makeHost(target.project, target.home, ['one']);
    await expect(planRestore(olderCode, bundleFile, key)).rejects.toMatchObject({ code: 'backup_newer' });
  });

  it('warns about skills the bundle needs that are not installed here', async () => {
    const bare = makeHost(target.project, target.home, ['one', 'two'], {
      installed: () => ({
        channels: [],
        providers: [],
        containerProviders: [],
        modules: [],
        gateway: null,
        driver: 'docker',
      }),
      installedGateways: () => [],
    });
    const plan = await planRestore(bare, bundleFile, key);
    expect(plan.warnings.join(' ')).toContain('channel telegram');
    expect(plan.warnings.join(' ')).toContain('gateway onecli');
  });
});

describe('restoreBundle (full)', () => {
  it('replaces the install state with the backup and fixes the database for a clean start', async () => {
    const result = await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });

    const central = path.join(target.project, 'data', 'v2.db');
    expect(query(central, 'SELECT id FROM agent_groups ORDER BY id')).toEqual([{ id: 'g1' }, { id: 'g2' }]);
    expect(
      query<{ container_status: string }>(central, 'SELECT container_status FROM sessions').every(
        (row) => row.container_status === 'stopped',
      ),
    ).toBe(true);
    expect(query(central, 'SELECT * FROM host_instances')).toEqual([]);
    expect(query(central, 'SELECT * FROM session_claims')).toEqual([]);
    expect(query(central, 'SELECT agent_group_id, image_tag FROM container_configs ORDER BY agent_group_id')).toEqual([
      { agent_group_id: 'g1', image_tag: null },
      { agent_group_id: 'g2', image_tag: null },
    ]);
    expect(result.rebuildGroups).toEqual(['g1']);

    const session = path.join(target.project, 'data', 'v2-sessions', 'g1', 's1');
    expect(query(path.join(session, 'outbound.db'), 'SELECT body FROM messages_out')).toEqual([
      { body: 'source-reply' },
    ]);
    expect(fs.readFileSync(path.join(session, 'inbox', 'attachment.txt'), 'utf8')).toBe('source-attachment');
    expect(fs.readFileSync(path.join(target.project, 'groups', 'g1', 'CLAUDE.local.md'), 'utf8')).toBe('source-memory');
    expect(fs.readFileSync(path.join(target.project, 'store', 'auth', 'creds.json'), 'utf8')).toContain('source');
    expect(fs.readFileSync(path.join(target.project, '.env'), 'utf8')).toContain('NANOCLAW_NAME=source');
    expect(fs.readFileSync(path.join(target.home, 'mount-allowlist.json'), 'utf8')).toContain('source');
    // Machine identity stays as it was unless explicitly requested.
    expect(fs.readFileSync(path.join(target.home, 'device-key.json'), 'utf8')).toBe('target-device-key');
  });

  it('keeps this install’s own upgrade marker instead of the one in the backup', async () => {
    const result = await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    expect(result.upgradeMarkerPreserved).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(target.project, 'data', 'upgrade-state.json'), 'utf8')).commit).toBe(
      'target',
    );
  });

  it('can restore machine identity when asked', async () => {
    await createBundle({
      host: source.host,
      key,
      destFile: bundleFile.replace('source', 'withid'),
      includeMachineIdentity: true,
    });
    await restoreBundle({
      host: target.host,
      bundleFile: bundleFile.replace('source', 'withid'),
      key,
      mode: 'full',
      restoreMachineIdentity: true,
    });
    expect(fs.readFileSync(path.join(target.home, 'device-key.json'), 'utf8')).toBe('source-device-key');
  });

  it('leaves no scratch directories after commit', async () => {
    const result = await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    await commitRestore(target.host, result.txn);
    for (const dir of ['data', 'groups', 'store']) {
      expect(fs.existsSync(path.join(target.project, dir, TXN_DIR))).toBe(false);
    }
    expect(tree(path.join(target.project, 'groups'))).toEqual(['g1', 'g1/CLAUDE.local.md']);
  });

  it('keeps a symlinked data root a symlink', async () => {
    const external = path.join(tmp, 'external-data');
    fs.renameSync(path.join(target.project, 'data'), external);
    fs.symlinkSync(external, path.join(target.project, 'data'));
    await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    expect(fs.lstatSync(path.join(target.project, 'data')).isSymbolicLink()).toBe(true);
    expect(query(path.join(external, 'v2.db'), 'SELECT COUNT(*) c FROM agent_groups')).toEqual([{ c: 2 }]);
  });
});

describe('rollback', () => {
  it('puts every root, the env file and the settings back exactly', async () => {
    const centralBefore = query(path.join(target.project, 'data', 'v2.db'), 'SELECT * FROM agent_groups');
    const before = {
      data: tree(path.join(target.project, 'data')),
      groups: tree(path.join(target.project, 'groups')),
      store: tree(path.join(target.project, 'store')),
    };
    const envBefore = fs.readFileSync(path.join(target.project, '.env'), 'utf8');

    const result = await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    expect(query(path.join(target.project, 'data', 'v2.db'), 'SELECT * FROM agent_groups')).not.toEqual(centralBefore);
    await rollbackRestore(target.host, result.txn);

    expect(tree(path.join(target.project, 'data'))).toEqual(before.data);
    expect(tree(path.join(target.project, 'groups'))).toEqual(before.groups);
    expect(tree(path.join(target.project, 'store'))).toEqual(before.store);
    expect(fs.readFileSync(path.join(target.project, '.env'), 'utf8')).toBe(envBefore);
    expect(fs.readFileSync(path.join(target.home, 'mount-allowlist.json'), 'utf8')).toContain('target');
    expect(query(path.join(target.project, 'data', 'v2.db'), 'SELECT * FROM agent_groups')).toEqual(centralBefore);
    await expect(rollbackRestore(target.host, result.txn)).rejects.toMatchObject({ code: 'nothing_to_roll_back' });
  });

  it('rolls itself back when staging fails, leaving the install untouched', async () => {
    const before = tree(path.join(target.project, 'data'));
    const damaged = fs.readFileSync(bundleFile);
    fs.writeFileSync(bundleFile, damaged.subarray(0, damaged.length - 100));
    await expect(restoreBundle({ host: target.host, bundleFile, key, mode: 'full' })).rejects.toBeTruthy();
    expect(tree(path.join(target.project, 'data'))).toEqual(before);
    expect(fs.readFileSync(path.join(target.project, '.env'), 'utf8')).toContain('NANOCLAW_NAME=target');
  });
});

describe('safety checks', () => {
  it('refuses to restore while the host is listening on its CLI socket', async () => {
    const socket = path.join(target.project, 'data', 'ncl.sock');
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(socket, resolve));
    try {
      await expect(restoreBundle({ host: target.host, bundleFile, key, mode: 'full' })).rejects.toMatchObject({
        code: 'host_running',
      });
    } finally {
      server.close();
    }
  });

  it('refuses before touching anything when the bundle is for newer code', async () => {
    const older = makeHost(target.project, target.home, ['one']);
    await expect(restoreBundle({ host: older, bundleFile, key, mode: 'full' })).rejects.toBeInstanceOf(RestoreError);
    expect(query(path.join(target.project, 'data', 'v2.db'), 'SELECT id FROM agent_groups')).toEqual([{ id: 't1' }]);
  });
});

describe('rehearsal mode', () => {
  it('drops channel credentials, stores and identity files, and pauses pending work', async () => {
    const result = await restoreBundle({ host: target.host, bundleFile, key, mode: 'rehearsal' });

    const env = fs.readFileSync(path.join(target.project, '.env'), 'utf8');
    expect(env).toContain('NANOCLAW_NAME=source');
    expect(env).toContain('OPENCODE_MODEL=openai/test');
    expect(env).not.toContain('TELEGRAM_BOT_TOKEN');
    expect(env).not.toContain('SIGNAL_ACCOUNT');
    expect(env).not.toContain('OPENCODE_API_TOKEN'); // secret-looking names go even inside kept prefixes
    expect(result.droppedEnvKeys.sort()).toEqual(['OPENCODE_API_TOKEN', 'SIGNAL_ACCOUNT', 'TELEGRAM_BOT_TOKEN']);

    expect(fs.existsSync(path.join(target.project, 'data', 'photon-auth.json'))).toBe(false);
    expect(fs.readdirSync(path.join(target.project, 'store'))).toEqual([TXN_DIR]);
    expect(fs.readFileSync(path.join(target.home, 'device-key.json'), 'utf8')).toBe('target-device-key');

    const inbound = path.join(target.project, 'data', 'v2-sessions', 'g1', 's1', 'inbound.db');
    expect(query(inbound, 'SELECT id, status FROM messages_in ORDER BY id')).toEqual([
      { id: 'm1', status: 'paused' },
      { id: 'm2', status: 'completed' },
      { id: 'm3', status: 'completed' },
    ]);
    // The conversation history itself is kept.
    expect(fs.readFileSync(path.join(target.project, 'groups', 'g1', 'CLAUDE.local.md'), 'utf8')).toBe('source-memory');
  });
});

describe('infrastructure settings of the target', () => {
  it('keeps the gateway and panel settings of this machine instead of those in the backup', async () => {
    const result = await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    const env = fs.readFileSync(path.join(target.project, '.env'), 'utf8');
    expect(env).toContain('NANOCLAW_NAME=source'); // data-level setting comes from the backup
    expect(env).toContain('ONECLI_URL=http://target-gateway.test:10254');
    expect(env).toContain('NANOCLAW_GATEWAY_PROVIDER=gw-target');
    expect(env).not.toContain('source-gateway');
    expect(result.keptEnvKeys.sort()).toEqual(['NANOCLAW_GATEWAY_PROVIDER', 'ONECLI_URL']);
  });

  it('merges without touching other lines', () => {
    const merged = mergeTargetOwnedEnv('A=1\nONECLI_URL=old\n\n\nB=2\n', 'X=9\nONECLI_URL=new\nPANEL_PORT=4000\n');
    expect(merged.text).toBe('A=1\n\nB=2\nONECLI_URL=new\nPANEL_PORT=4000\n');
    expect(merged.kept).toEqual(['ONECLI_URL', 'PANEL_PORT']);
    expect(mergeTargetOwnedEnv(null, 'A=1\n')).toEqual({ text: null, kept: [] });
    expect(mergeTargetOwnedEnv('A=1\n', null)).toEqual({ text: 'A=1\n', kept: [] });
  });
});

describe('filterEnvForRehearsal', () => {
  it('keeps comments and allowlisted keys only', () => {
    const { kept, dropped } = filterEnvForRehearsal(
      '# note\nTZ=UTC\nexport NANOCLAW_X=1\nSLACK_BOT_TOKEN=x\nNANOCLAW_SECRET=y\n',
    );
    expect(kept).toContain('# note');
    expect(kept).toContain('TZ=UTC');
    expect(kept).toContain('NANOCLAW_X=1');
    expect(dropped.sort()).toEqual(['NANOCLAW_SECRET', 'SLACK_BOT_TOKEN']);
  });
});

describe('gateway selection and credentials', () => {
  const withoutSelection = (host: typeof target.host) =>
    makeHost(target.project, target.home, ['one', 'two'], {
      installed: () => ({ ...host.installed(), gateway: null }),
    });

  it('does not call a gateway missing when its skill is installed but not selected', async () => {
    const plan = await planRestore(withoutSelection(target.host), bundleFile, key);
    expect(plan.warnings.join(' ')).not.toContain('gateway');
  });

  it('warns when this machine uses a different gateway than the backup', async () => {
    const other = makeHost(target.project, target.home, ['one', 'two'], {
      installed: () => ({ ...target.host.installed(), gateway: 'other-gw' }),
      installedGateways: () => ['onecli', 'other-gw'],
    });
    const plan = await planRestore(other, bundleFile, key);
    expect(plan.warnings.join(' ')).toContain('this machine uses the other-gw gateway');
  });

  it("adopts the backup's gateway when this machine has none selected and the skill is installed", async () => {
    fs.writeFileSync(path.join(target.project, '.env'), 'ONECLI_URL=http://target-gateway.test:10254\n');
    const result = await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    const env = fs.readFileSync(path.join(target.project, '.env'), 'utf8');
    expect(env).toContain('NANOCLAW_GATEWAY_PROVIDER=onecli');
    expect(result.adoptedEnvKeys).toEqual(['NANOCLAW_GATEWAY_PROVIDER']);
  });

  it("does not adopt a gateway whose skill is not installed here, and never overrides this machine's choice", async () => {
    fs.writeFileSync(path.join(target.project, '.env'), 'ONECLI_URL=http://target-gateway.test:10254\n');
    const bare = makeHost(target.project, target.home, ['one', 'two'], { installedGateways: () => [] });
    expect((await restoreBundle({ host: bare, bundleFile, key, mode: 'full' })).adoptedEnvKeys).toEqual([]);
    expect(fs.readFileSync(path.join(target.project, '.env'), 'utf8')).not.toContain('NANOCLAW_GATEWAY_PROVIDER');
  });

  it("lists the credentials the backup's machine had and this one lacks, by name", async () => {
    const names = (list: string[] | null) => async () => list;
    const src = makeHost(source.project, source.home, ['one', 'two'], {
      gatewayCredentialNames: names(['Anthropic', 'OpenCode openai']),
    });
    const file = path.join(tmp, 'bundles', 'named.mbk');
    await createBundle({ host: src, key, destFile: file });
    const here = makeHost(target.project, target.home, ['one', 'two'], {
      gatewayCredentialNames: names(['Anthropic']),
    });
    expect((await planRestore(here, file, key)).credentialsToReenter).toEqual(['OpenCode openai']);
    const unknown = makeHost(target.project, target.home, ['one', 'two'], { gatewayCredentialNames: names(null) });
    expect((await planRestore(unknown, file, key)).credentialsToReenter).toEqual(['Anthropic', 'OpenCode openai']);
    // A backup made without names (older bundle, gateway not asked) has nothing to list.
    expect((await planRestore(here, bundleFile, key)).credentialsToReenter).toEqual([]);
  });

  it('never lets a failing gateway lookup break the backup', async () => {
    const broken = makeHost(source.project, source.home, ['one', 'two'], {
      gatewayCredentialNames: async () => {
        throw new Error('gateway down');
      },
    });
    const file = path.join(tmp, 'bundles', 'broken.mbk');
    await expect(createBundle({ host: broken, key, destFile: file })).resolves.toBeDefined();
  });
});

describe('rehearsal report', () => {
  it("does not list as dropped a setting this machine's own value replaced", async () => {
    fs.appendFileSync(path.join(source.project, '.env'), 'NO_PROXY=100.64.0.1\n');
    fs.appendFileSync(path.join(target.project, '.env'), 'no_proxy=100.64.0.2\n');
    const file = path.join(tmp, 'bundles', 'proxy.mbk');
    await createBundle({ host: source.host, key, destFile: file });
    const result = await restoreBundle({ host: target.host, bundleFile: file, key, mode: 'rehearsal' });
    expect(result.droppedEnvKeys).not.toContain('NO_PROXY');
    expect(result.keptEnvKeys).toContain('no_proxy');
  });
});

describe('finished transactions', () => {
  it('keeps only the latest journal, so a repeated command still gets a clear answer', async () => {
    const first = await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    await commitRestore(target.host, first.txn);
    const second = await restoreBundle({ host: target.host, bundleFile, key, mode: 'full' });
    await rollbackRestore(target.host, second.txn);
    expect(fs.readdirSync(path.join(target.project, TXN_DIR))).toEqual([second.txn]);
    await expect(commitRestore(target.host, second.txn)).rejects.toMatchObject({ code: 'nothing_to_roll_back' });
  });
});
