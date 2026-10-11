import assert from 'node:assert/strict';
import { test } from 'node:test';

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { defaultDenyFile, isAllowedEmail, parseDenyList, scanHistoryContent, scanIdentity, scanText } from './privacy-scan.mjs';

// Test values are assembled at runtime so this file itself stays clean.
const ip = (...parts) => parts.join('.');
const mail = (user, host) => `${user}@${host}`;

test('flags RFC 1918 addresses', () => {
  for (const addr of [ip(10, 1, 2, 3), ip(192, 168, 0, 7), ip(172, 16, 5, 9), ip(172, 31, 255, 1)]) {
    const found = scanText(`server at ${addr}`, 'f');
    assert.equal(found.length, 1, addr);
    assert.equal(found[0].rule, 'private-ipv4');
  }
});

test('accepts CGNAT, public documentation and out-of-range 172 addresses', () => {
  for (const addr of [ip(100, 64, 0, 1), ip(203, 0, 113, 5), ip(172, 32, 0, 1), ip(172, 15, 0, 1), '127.0.0.1']) {
    assert.deepEqual(scanText(`host ${addr}`, 'f'), [], addr);
  }
});

test('flags LAN-only hostnames but not .test names', () => {
  assert.equal(scanText(`http://nas.${'lan'}/v1`, 'f')[0].rule, 'private-hostname');
  assert.equal(scanText(`http://box.${'internal'}`, 'f')[0].rule, 'private-hostname');
  assert.deepEqual(scanText('http://model.test/v1', 'f'), []);
});

test('does not mistake file names for LAN hostnames', () => {
  assert.deepEqual(scanText('groups/x/CLAUDE.local.md', 'f'), []);
  assert.equal(scanText(`ping nas.${'local'}.`, 'f')[0].rule, 'private-hostname');
  assert.deepEqual(scanText(`http://host.docker.${'internal'}:8000/v1`, 'f'), []);
  assert.equal(scanText(`http://nas.${'lan'}:8080/x`, 'f')[0].rule, 'private-hostname');
});

test('flags personal emails and accepts anonymous ones', () => {
  assert.equal(scanText(`contact ${mail('someone', 'gmail.com')}`, 'f')[0].rule, 'email');
  for (const ok of [mail('1+user', 'users.noreply.github.com'), mail('a', 'example.com'), mail('a', 'host.test'), 'noreply@anthropic.com']) {
    assert.equal(isAllowedEmail(ok), true, ok);
    assert.deepEqual(scanText(ok, 'f'), []);
  }
});

test('flags credentials and redacts them in the report', () => {
  const token = `ghp_${'a'.repeat(36)}`;
  const found = scanText(`export X=${token}`, 'f');
  assert.equal(found[0].rule, 'credential');
  assert.ok(!found[0].match.includes(token));
  assert.equal(scanText(`api_key = "${'k'.repeat(20)}"`, 'f')[0].rule, 'credential-assignment');
  assert.equal(scanText(`-----BEGIN ${'RSA'} PRIVATE KEY-----`, 'f')[0].rule, 'credential');
});

test('allow marker skips a line', () => {
  assert.deepEqual(scanText(`${ip(10, 0, 0, 1)} privacy-scan: allow`, 'f'), []);
});

test('flags non-anonymous commit identities', () => {
  const found = scanIdentity([
    { sha: 'a'.repeat(40), authorEmail: mail('me', 'gmail.com'), committerEmail: mail('1+u', 'users.noreply.github.com'), message: 'ok' },
  ]);
  assert.equal(found.length, 1);
  assert.equal(found[0].rule, 'commit-identity');
});

test('a deny list is read one pattern per line, ignores comments, and takes a broken pattern literally', () => {
  const deny = parseDenyList(['# comment', '', 'Real-Name', 'a(b', 'x{2,'].join('\n'));
  assert.equal(deny.length, 3);
  assert.equal(scanText('written by REAL-NAME today', 'f', { deny }).length, 1);
  assert.equal(scanText('the text a(b is odd', 'f', { deny })[0].rule, 'denied-term');
  assert.deepEqual(scanText('nothing private here', 'f', { deny }), []);
});

test('a denied term is never echoed back, and the allow marker still skips a line', () => {
  const deny = parseDenyList('secret-company-name');
  const [found] = scanText('see secret-company-name for details', 'f', { deny });
  assert.ok(!JSON.stringify(found).includes('secret-company-name'));
  assert.deepEqual(scanText('see secret-company-name for details // privacy-scan: allow', 'f', { deny }), []);
});

test('identity scanning checks author and committer names against the deny list', () => {
  const deny = parseDenyList('Real Person');
  const commit = { sha: 'a'.repeat(40), authorEmail: mail('1+x', 'users.noreply.github.com'), committerEmail: mail('1+x', 'users.noreply.github.com'), authorName: 'Real Person', committerName: 'someone', message: 'fine' };
  assert.equal(scanIdentity([commit], { deny }).length, 1);
});

test('history scan finds a secret that was added and later deleted, and reports it once', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-history-'));
  try {
    const run = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    run(['init', '-q', '-b', 'main']);
    run(['config', 'user.email', mail('1+t', 'users.noreply.github.com')]);
    run(['config', 'user.name', 'tester']);
    const token = `ghp_${'a'.repeat(36)}`;
    mkdirSync(join(dir, 'docs'));
    writeFileSync(join(dir, 'docs', 'notes.md'), `token ${token}\nfine line\n`);
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'add']);
    writeFileSync(join(dir, 'docs', 'notes.md'), `token ${token} again\n`);
    run(['commit', '-qam', 'touch']);
    writeFileSync(join(dir, 'docs', 'notes.md'), 'clean now\n');
    run(['commit', '-qam', 'remove']);
    const found = scanHistoryContent({}, run);
    assert.equal(found.length, 1);
    assert.equal(found[0].rule, 'credential');
    assert.match(found[0].label, /docs\/notes\.md/);
    assert.match(found[0].description, /in 2 commits/);
    assert.ok(!JSON.stringify(found).includes(token));
    // File names are checked too.
    writeFileSync(join(dir, 'about-real-person.txt'), 'x\n');
    run(['add', '-A']);
    run(['commit', '-q', '-m', 'name']);
    const named = scanHistoryContent({ deny: parseDenyList('real-person') }, run);
    assert.ok(named.some((f) => f.rule === 'path-denied-term'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the default deny list is the one named in the environment, or the per-user file, and only if it exists', () => {
  assert.equal(defaultDenyFile({ PRIVACY_SCAN_DENY_LIST: '/some/list.txt' }, () => true), '/some/list.txt');
  assert.equal(defaultDenyFile({ PRIVACY_SCAN_DENY_LIST: '/some/list.txt' }, () => false), null);
  assert.match(defaultDenyFile({}, () => true), /\.config\/privacy-scan\/deny-list\.txt$/);
  assert.equal(defaultDenyFile({}, () => false), null);
});
