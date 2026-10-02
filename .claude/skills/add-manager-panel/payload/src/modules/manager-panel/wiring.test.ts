/**
 * Goes red if the one-line registration in `src/modules/index.ts` is removed
 * or the module stops registering its lifecycle hooks.
 */
import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { getHostShutdownCallbacks, getHostStartCallbacks } from '../../host-lifecycle.js';

describe('manager panel wiring', () => {
  it('is imported by the modules barrel', () => {
    const barrel = fs.readFileSync(path.join(__dirname, '..', 'index.ts'), 'utf8');
    expect(barrel).toMatch(/^import '\.\/manager-panel\/index\.js';$/m);
  });

  it('registers start and stop hooks with the host when the barrel loads', async () => {
    await import('../index.js');
    expect(getHostStartCallbacks().some((callback) => callback.name === 'startManagerPanel')).toBe(true);
    expect(getHostShutdownCallbacks().some((callback) => callback.name === 'stopManagerPanel')).toBe(true);
  });
});
