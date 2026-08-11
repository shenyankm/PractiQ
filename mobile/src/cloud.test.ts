import assert from 'node:assert/strict';
import test from 'node:test';

import { cloudErrorFromResponse } from './cloud';

test('cloud error envelopes map to actionable messages', () => {
  assert.match(cloudErrorFromResponse(401, null).message, /重新登录/);
  assert.match(cloudErrorFromResponse(403, { error: { code: 'PRO_REQUIRED', message: 'x' } }).message, /PRO 订阅/);
  assert.match(cloudErrorFromResponse(409, { error: { code: 'LLM_CONFIG_REQUIRED', message: 'x' } }).message, /API Key/);
  assert.match(cloudErrorFromResponse(422, { error: { code: 'VALIDATION_ERROR', message: 'bad stem' } }).message, /bad stem/);
  assert.match(cloudErrorFromResponse(429, {}).message, /请求过多/);
  assert.match(cloudErrorFromResponse(500, 'not json').message, /暂时不可用/);
});
