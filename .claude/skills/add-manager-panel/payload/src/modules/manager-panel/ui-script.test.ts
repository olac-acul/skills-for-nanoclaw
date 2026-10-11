import vm from 'node:vm';

import { describe, expect, it } from 'vitest';

import { APP_JS, APP_CSS, INDEX_HTML } from './ui.js';

/**
 * The browser script is one big template string. A character that means something inside a template (a
 * backslash escape, a `${`) silently changes the script the browser receives, and nothing else in the suite
 * would notice. Compiling it (without running it) catches a broken script.
 */
describe('the served browser script', () => {
  it('is syntactically valid JavaScript', () => {
    expect(() => new vm.Script(APP_JS, { filename: 'app.js' })).not.toThrow();
  });

  it('has no inline script or style in the page, which the content security policy would block', () => {
    expect(INDEX_HTML).not.toMatch(/<script(?![^>]*\bsrc=)/i);
    expect(INDEX_HTML).not.toMatch(/\sstyle=/i);
    expect(INDEX_HTML).not.toMatch(/\son[a-z]+=/i);
  });

  it('does not use the DOM sinks the review ruled out', () => {
    for (const sink of ['innerHTML', 'outerHTML', 'insertAdjacentHTML', 'document.write', 'eval(', 'new Function(']) {
      // The sentence in the header comment that mentions innerHTML as forbidden is not a use.
      const uses = APP_JS.split('\n').filter((line) => line.includes(sink) && !/^\s*(\/\/|\*)/.test(line));
      expect(uses, sink).toEqual([]);
    }
  });

  it('keeps the stylesheet free of remote references', () => {
    expect(APP_CSS).not.toMatch(/url\(\s*['"]?https?:/i);
    expect(APP_CSS).not.toMatch(/@import/i);
  });
});
