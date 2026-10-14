/**
 * Integration test for the voice channel's single reach-in: the self-registration import in the
 * `src/channels/index.ts` barrel. Imports the real barrel and asserts the registry contains `voice`;
 * red if `import './voice.js';` is deleted or the barrel (or the `ws` dependency) fails to load.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js';

describe('voice channel registration', () => {
  it('registers voice via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('voice');
  });
});
