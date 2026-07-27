import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldFailPermanently, shouldQueueAfterFailure } from './openwook/sync-policy';

test('sync retries offline, conflicts, and server failures but parks invalid writes', () => {
  assert.equal(shouldFailPermanently(0), false);
  assert.equal(shouldFailPermanently(401), false);
  assert.equal(shouldFailPermanently(409), false);
  assert.equal(shouldFailPermanently(429), false);
  assert.equal(shouldFailPermanently(500), false);
  assert.equal(shouldFailPermanently(422), true);
  assert.equal(shouldQueueAfterFailure(503), true);
  assert.equal(shouldQueueAfterFailure(409, 'INVALID_STATE'), false);
  assert.equal(shouldQueueAfterFailure(409, 'REQUEST_IN_PROGRESS'), true);
});
