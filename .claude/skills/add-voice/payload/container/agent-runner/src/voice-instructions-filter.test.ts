import { describe, expect, it } from 'bun:test';
import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { instructionsForSession, withoutVoiceSection } from './voice-instructions-filter.js';

const DOC = [
  '# Assistant',
  '',
  'Persona.',
  '',
  '<!-- nanovoice:begin (managed by the add-voice skill) -->',
  '## Canale voce',
  'Regole della voce.',
  '<!-- nanovoice:end -->',
  '',
  '## Calendario',
  'Regole del calendario.',
  '',
].join('\n');

function setup() {
  const dir = mkdtempSync(path.join(tmpdir(), 'voice-filter-'));
  const file = path.join(dir, 'CLAUDE.md');
  writeFileSync(file, DOC);
  return { dir, file };
}

describe('withoutVoiceSection', () => {
  it('takes the section out and keeps the rest joined', () => {
    const out = withoutVoiceSection(DOC);
    expect(out).not.toContain('Canale voce');
    expect(out).toContain('Persona.\n\n## Calendario');
  });

  it('leaves a text without the section, or with a broken one, as it is', () => {
    expect(withoutVoiceSection('# Solo persona.\n')).toBe('# Solo persona.\n');
    const broken = '# A\n<!-- nanovoice:begin x -->\nno end';
    expect(withoutVoiceSection(broken)).toBe(broken);
  });
});

describe('instructionsForSession', () => {
  it('gives the voice session, and an unbound one, the whole file', () => {
    const { dir, file } = setup();
    expect(instructionsForSession(file, { channel: () => 'voice', dataHome: dir })).toBe(file);
    expect(instructionsForSession(file, { channel: () => null, dataHome: dir })).toBe(file);
  });

  it('gives another channel a copy without the voice section', () => {
    const { dir, file } = setup();
    const out = instructionsForSession(file, { channel: () => 'telegram', dataHome: dir });
    expect(out).not.toBe(file);
    expect(readFileSync(out, 'utf8')).not.toContain('Regole della voce');
    expect(readFileSync(out, 'utf8')).toContain('Regole del calendario');
  });

  it('falls back to the whole file on any problem', () => {
    const { dir } = setup();
    const missing = path.join(dir, 'missing.md');
    expect(instructionsForSession(missing, { channel: () => 'telegram', dataHome: dir })).toBe(missing);
    const thrown = () => { throw new Error('no mailbox yet'); };
    expect(instructionsForSession(path.join(dir, 'CLAUDE.md'), { channel: thrown, dataHome: dir })).toBe(path.join(dir, 'CLAUDE.md'));
  });
});
