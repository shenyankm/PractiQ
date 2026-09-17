import test from 'node:test';
import assert from 'node:assert/strict';
import { answerPayload, request, ApiError } from '../src/api.ts';
// @ts-ignore JavaScript check script is shared with CI.
import { checkSource } from '../scripts/check-styles.mjs';

test('failed writes retain their key, successful writes release it', async () => {
  const original = globalThis.fetch;
  const keys: string[] = [];
  let count = 0;
  globalThis.fetch = async (_url, options) => {
    keys.push((options?.headers as Record<string,string>)['Idempotency-Key']);
    if (++count === 1) throw new TypeError('Network lost after commit');
    return Response.json({ data: { id: 1 } });
  };
  try {
    await assert.rejects(request('/banks', { method: 'POST', body: { name: 'a' } }));
    await request('/banks', { method: 'POST', body: { name: 'a' } });
    await request('/banks', { method: 'POST', body: { name: 'a' } });
    assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]);
  } finally { globalThis.fetch = original; }
});
test('style restrictions reject visual overrides and arbitrary values', () => {
  assert.deepEqual(checkSource('<Card className="grid gap-4 md:grid-cols-2 max-w-7xl" />'), []);
  for (const source of ['<Card style={{color:"red"}}/>', '<Card className="bg-red-500"/>', '<Card className="w-[123px]"/>', '<Card className={custom}/>', '<style>body{}</style>', '<button>Save</button>']) assert.ok(checkSource(source).length, source);
});
test('answer payloads match the API modes', () => {
  assert.deepEqual(answerPayload('choice', '', ['A', 'C']), { selected: ['A', 'C'] });
  assert.deepEqual(answerPayload('true_false', 'false', []), { value: false });
  assert.deepEqual(answerPayload('fill_blank', 'one\ntwo', []), { value: ['one', 'two'] });
});

test('different file uploads never reuse an uncertain upload key', async () => {
  const original = globalThis.fetch;
  const keys: string[] = [];
  globalThis.fetch = async (_url, options) => { keys.push((options?.headers as Record<string,string>)['Idempotency-Key']); throw new TypeError('connection lost'); };
  try {
    for (const content of ['first', 'first', 'second']) {
      const form = new FormData(); form.append('file', new File([content], 'same.txt', { type: 'text/plain' }));
      await assert.rejects(request('/media', { method: 'POST', body: form }));
    }
    assert.equal(keys[0], keys[1]); assert.notEqual(keys[1], keys[2]);
  } finally { globalThis.fetch = original; }
});
