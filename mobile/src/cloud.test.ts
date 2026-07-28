import assert from 'node:assert/strict';
import test from 'node:test';

import { cloudErrorFromResponse } from './cloud';

test('cloud error envelopes map to actionable messages', () => {
  assert.match(cloudErrorFromResponse(401, null).message, /重新登录/);
  assert.match(cloudErrorFromResponse(403, { error: { code: 'PLUS_REQUIRED', message: 'x' } }).message, /Plus 会员/);
  assert.match(cloudErrorFromResponse(422, { error: { code: 'VALIDATION_ERROR', message: 'bad stem' } }).message, /bad stem/);
  assert.match(cloudErrorFromResponse(429, {}).message, /请求过多/);
  assert.match(cloudErrorFromResponse(500, 'not json').message, /暂时不可用/);
});
