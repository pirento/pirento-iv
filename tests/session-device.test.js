/** Unit tests: device labels saved with sessions (deviceLabel in src/services/auth/security.js). */

import assert from 'node:assert/strict';
import test from 'node:test';
import { deviceLabel } from '../src/services/auth/security.js';

test('common browsers and systems get a short readable label', () => {
  const cases = [
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
      'Chrome on Windows',
    ],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0',
      'Edge on Windows',
    ],
    [
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36',
      'Chrome on Android',
    ],
    [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 Version/17.5 Mobile/15E148 Safari/604.1',
      'Safari on iPhone/iPad',
    ],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5; rv:131.0) Gecko/20100101 Firefox/131.0', 'Firefox on Mac'],
    ['', 'Browser on unknown system'],
  ];
  for (const [agent, label] of cases) assert.equal(deviceLabel(agent), label);
});
