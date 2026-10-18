import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { labelsFor, main, questions } from './issue-labeler.mjs';

const endpoint = 'https://example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone';
const decision = (kind = 'bug', area = 'area:server', confidence = 0.95) => ({ answers: {
  kind: { type: 'choice', choice: kind, confidence },
  area: { type: 'choice', choice: area, confidence },
} });
const issue = { title: '[Bug]: Import fails', body: '### Affected area\n\nAI service or document processing',
  state: 'open', labels: [] };

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'practiq-issue-labeler-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(join(dir, 'event.json'), JSON.stringify(options.event ?? { issue: { number: 1 } }));
  const env = { GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'owner/repo',
    GITHUB_EVENT_NAME: 'issues', GITHUB_EVENT_PATH: join(dir, 'event.json'), GH_TOKEN: 'github-test-token',
    ISSUE_LABELER_API_KEY: 'bailian-test-token', ISSUE_LABELER_ENDPOINT: endpoint, DRY_RUN: 'false', ...options.env };
  const calls = [];
  let reads = 0;
  const request = async (url, init) => {
    calls.push({ url, ...init, body: init.body && JSON.parse(init.body) });
    if (options.respond) {
      const response = await options.respond(url, init);
      if (response) return response;
    }
    if (url === endpoint) return Response.json(options.result ?? decision());
    if (url === 'https://api.github.com/repos/owner/repo/issues/1' && init.method === 'GET') {
      return Response.json((reads++ > 0 && options.current) || options.issue || issue);
    }
    assert.equal(url, 'https://api.github.com/repos/owner/repo/issues/1/labels');
    assert.equal(init.method, 'POST');
    return Response.json([]);
  };
  return { env, calls, request };
}

test('closed choices map to existing type and project-area labels', () => {
  assert.deepEqual(labelsFor(decision()), ['bug', 'area:server']);
  assert.deepEqual(labelsFor(decision('documentation', 'documentation')), ['documentation']);
  assert.deepEqual(labelsFor(decision('other', 'other')), []);
  assert.deepEqual(labelsFor(decision('question', 'area:desktop', 0.85)), ['question', 'area:desktop']);
  assert.deepEqual(labelsFor(decision('enhancement', 'area:android')), ['enhancement', 'area:android']);
});

test('low confidence is evaluated independently and never adds a guessed label', () => {
  const result = decision();
  result.answers.kind.confidence = 0.84;
  assert.deepEqual(labelsFor(result), ['area:server']);
  result.answers.area.confidence = 0.2;
  assert.deepEqual(labelsFor(result), []);
});

test('existing manual types, areas, and unrelated labels are preserved', () => {
  assert.deepEqual(labelsFor(decision(), ['enhancement', 'area:web', 'P1', 'help wanted']), []);
  assert.deepEqual(labelsFor(decision(), ['bug']), ['area:server']);
  assert.deepEqual(labelsFor(decision('question', 'documentation'), ['bug']), ['documentation']);
});

test('reject malformed model results and labels outside the allow-list', () => {
  for (const result of [null, {}, { answers: {} }]) assert.throws(() => labelsFor(result));
  for (const choice of ['P0', 'wontfix', '__proto__', 'constructor', '$(echo unsafe)', null]) {
    assert.throws(() => labelsFor(decision(choice)), /Invalid kind choice/);
  }
  for (const confidence of [-1, 1.1, NaN, Infinity, '0.99', null, undefined]) {
    const result = decision();
    result.answers.kind.confidence = confidence;
    assert.throws(() => labelsFor(result), /Invalid kind confidence/);
  }
  const result = decision();
  result.answers.area.type = 'score';
  assert.throws(() => labelsFor(result), /Invalid area choice/);
});

test('send bounded issue data using System One; add only validated labels', async t => {
  const f = await fixture(t, { issue: { ...issue, title: '$(echo unsafe) ${{ secrets.KEY }}',
    body: 'x'.repeat(20000), unrelated: 'never send this' } });
  assert.deepEqual(await main(f.env, f.request), ['bug', 'area:server']);
  const model = f.calls.find(call => call.url === endpoint);
  assert.equal(model.headers.Authorization, 'Bearer bailian-test-token');
  assert.equal(model.redirect, 'error');
  assert.equal(model.body.model, 'decision-model-preview');
  assert.deepEqual(model.body.questions, questions);
  assert.equal(model.body.state.title, '$(echo unsafe) ${{ secrets.KEY }}');
  assert.equal(model.body.state.body.length, 16000);
  assert.deepEqual(Object.keys(model.body.state), ['title', 'body']);
  assert(!JSON.stringify(model.body).includes('github-test-token'));
  assert.deepEqual(f.calls.at(-1).body, { labels: ['bug', 'area:server'] });
  assert(f.calls.every(call => ['GET', 'POST'].includes(call.method)));
});

test('dry-run calls the model but never mutates GitHub labels', async t => {
  const f = await fixture(t, { event: {}, env: { GITHUB_EVENT_NAME: 'workflow_dispatch', ISSUE_NUMBER: '1', DRY_RUN: 'true' } });
  assert.deepEqual(await main(f.env, f.request), ['bug', 'area:server']);
  assert.equal(f.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(f.calls.find(call => call.method === 'POST').url, endpoint);
});

test('missing dry-run setting defaults to no mutation', async t => {
  const f = await fixture(t, { env: { DRY_RUN: undefined } });
  await main(f.env, f.request);
  assert.equal(f.calls.filter(call => call.url.endsWith('/labels')).length, 0);
});

test('closed issues and pull requests do not call the model', async t => {
  for (const value of [{ ...issue, state: 'closed' }, { ...issue, pull_request: {} }]) {
    const f = await fixture(t, { issue: value });
    assert.deepEqual(await main(f.env, f.request), []);
    assert.equal(f.calls.length, 1);
  }
  const f = await fixture(t, { event: { issue: { number: 1, pull_request: {} } } });
  assert.deepEqual(await main(f.env, f.request), []);
  assert.equal(f.calls.length, 0);
});

test('honor labels added by a maintainer while the model was running', async t => {
  const f = await fixture(t, { current: { ...issue, labels: [{ name: 'question' }, { name: 'area:web' }] } });
  assert.deepEqual(await main(f.env, f.request), []);
  assert(!f.calls.some(call => call.url.endsWith('/labels')));
});

test('do not apply a stale decision after the issue changes or closes', async t => {
  for (const current of [{ ...issue, body: 'Changed' }, { ...issue, title: 'Changed' }, { ...issue, state: 'closed' }]) {
    const f = await fixture(t, { current });
    assert.deepEqual(await main(f.env, f.request), []);
    assert(!f.calls.some(call => call.url.endsWith('/labels')));
  }
});

test('validate credentials, trusted ref, issue number, event, and endpoint before network access', async t => {
  for (const env of [{ ISSUE_LABELER_API_KEY: '' }, { GH_TOKEN: '' }, { GITHUB_REF: 'refs/heads/untrusted' },
    { GITHUB_REPOSITORY: '../escape' }, { GITHUB_EVENT_NAME: 'push' },
    ...['-1', '1/labels', '9007199254740992'].map(ISSUE_NUMBER => ({ GITHUB_EVENT_NAME: 'workflow_dispatch', ISSUE_NUMBER })),
    ...['http://example.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/systemone',
      'https://evil.example/compatible-mode/v1/systemone', `${endpoint}?key=bad`,
      'https://example.cn-beijing.maas.aliyuncs.com/chat/completions'].map(ISSUE_LABELER_ENDPOINT => ({ ISSUE_LABELER_ENDPOINT }))]) {
    const f = await fixture(t, { env });
    await assert.rejects(main(f.env, f.request));
    assert.equal(f.calls.length, 0);
  }
});

test('provider HTTP errors, malformed JSON, and transport errors never write labels or expose error bodies', async t => {
  for (const respond of [
    url => url === endpoint && new Response('secret response body', { status: 429 }),
    url => url === endpoint && new Response('not JSON with secret response body'),
    url => { if (url === endpoint) throw new Error('secret response body'); },
  ]) {
    const f = await fixture(t, { respond });
    await assert.rejects(main(f.env, f.request), error => !error.message.includes('secret response body'));
    assert(!f.calls.some(call => call.url.endsWith('/labels')));
    assert.equal(f.calls.filter(call => call.url === endpoint).length, 1);
  }
});

test('invalid model output rejects the entire update rather than partially writing labels', async t => {
  const result = decision('bug', 'P0');
  const f = await fixture(t, { result });
  await assert.rejects(main(f.env, f.request), /Invalid area choice/);
  assert(!f.calls.some(call => call.url.endsWith('/labels')));
});

test('GitHub write failures are reported without retrying a model call', async t => {
  const f = await fixture(t, { respond: url => url.endsWith('/labels') && new Response('', { status: 403 }) });
  await assert.rejects(main(f.env, f.request), /GitHub request failed: HTTP 403/);
  assert.equal(f.calls.filter(call => call.url === endpoint).length, 1);
});
