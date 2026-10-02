import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isAllowedEmail, scanIdentity, scanText } from './privacy-scan.mjs';

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
