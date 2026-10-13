import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeBlocker, reviewEvidence, validateVerdict, main } from './maintainer.mjs';

const sha = 'a'.repeat(40);
const pr = { number: 228, user: { login: 'shenyankm' }, state: 'open', draft: false, base: { ref: 'main' }, head: { sha }, mergeable: true, mergeable_state: 'clean' };
const review = { id: 1, user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: sha, state: 'COMMENTED', body: 'No actionable findings.' };
const checks = ['Service CI', 'Desktop CI', 'Android CI'].map(name => ({ name, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }));
const passed = { passed: true, review_complete: true, head_sha: sha, evidence_id: 1, reason: 'Current review explicitly reports no findings.' };

test('all final CI gates and every applicable check/status must succeed', () => {
  assert.equal(mergeBlocker(pr, checks, []), null);
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'neutral', 'skipped', null]) {
    assert(mergeBlocker(pr, [{ ...checks[0], conclusion }, ...checks.slice(1)], []));
  }
  assert(mergeBlocker(pr, checks.slice(1), []));
  assert(mergeBlocker(pr, [{ ...checks[0], app: { slug: 'other-app' } }, ...checks.slice(1)], []));
  assert(mergeBlocker(pr, [...checks, { status: 'in_progress', conclusion: null }], []));
  assert(mergeBlocker(pr, checks, [{ state: 'pending' }]));
  assert.equal(mergeBlocker(pr, [...checks, { status: 'completed', conclusion: 'skipped' }], [{ state: 'success' }]), null);
});

test('drafts, closed PRs, other branches and protection blockers cannot merge', () => {
  for (const changed of [{ ...pr, draft: true }, { ...pr, state: 'closed' },
    { ...pr, base: { ref: 'release' } }, { ...pr, mergeable: null }, { ...pr, mergeable: false },
    ...['blocked', 'behind', 'unstable', 'dirty', 'unknown'].map(mergeable_state => ({ ...pr, mergeable_state }))]) {
    assert(mergeBlocker(changed, checks, []));
  }
});

test('GPT evidence excludes old heads, other authors and security-only summaries', () => {
  assert.equal(reviewEvidence(pr, [review], []).length, 1);
  assert.deepEqual(reviewEvidence(pr, [{ ...review, commit_id: 'b'.repeat(40) }], []), []);
  assert.deepEqual(reviewEvidence(pr, [{ ...review, user: { login: 'spoof' } }], []), []);
  assert.deepEqual(reviewEvidence(pr, [{ ...review, state: 'CHANGES_REQUESTED' }], []), []);
  const summary = body => ({ id: 2, user: review.user, body: '<!-- codex-pull-request-review-summary -->\n' + body });
  assert.equal(reviewEvidence(pr, [], [summary('| **Code Review** | **Completed** | `aaaaaaa` |')]).length, 1);
  assert.deepEqual(reviewEvidence(pr, [], [summary('| **Code Review** | **Completed** | `bbbbbbb` |\n| Security Review | Completed | `aaaaaaa` |')]), []);
  assert.deepEqual(reviewEvidence(pr, [review], [summary('| Code Review | Completed | `aaaaaaa` |\n| Security Review | Running | `aaaaaaa` |')]), []);
});

test('AI verdict must be complete, structured, current-head and source-bound', () => {
  const reports = reviewEvidence(pr, [review], []);
  assert.equal(validateVerdict(passed, sha, reports).passed, true);
  for (const changed of [{ ...passed, head_sha: 'old' }, { ...passed, review_complete: false },
    { ...passed, evidence_id: 999 }, { ...passed, passed: 'true' }, { ...passed, reason: '' },
    { ...passed, arbitrary: true }]) assert.throws(() => validateVerdict(changed, sha, reports));
});

test('a stale global thumbs-up cannot support a current-head summary verdict', () => {
  const reports = [{ id: 1, type: 'summary', completed_at: '2026-10-13T13:00:00Z' }];
  assert.throws(() => validateVerdict(passed, sha, reports, []));
  assert.throws(() => validateVerdict(passed, sha, reports, [{ content: '+1', created_at: '2026-10-13T12:00:00Z' }]));
  assert.equal(validateVerdict(passed, sha, reports, [{ content: '+1', created_at: '2026-10-13T13:01:00Z' }]).passed, true);
  const summary = { id: 1, user: review.user, body: '<!-- codex-pull-request-review-summary -->\n| Code Review | Completed <relative-time datetime="2026-10-13T13:00:00Z"> | `aaaaaaa` |\n| Security Review | Completed <relative-time datetime="2026-10-13T13:10:00Z"> | `aaaaaaa` |' };
  const evidence = reviewEvidence(pr, [], [summary]);
  assert.throws(() => validateVerdict(passed, sha, evidence, [{ content: '+1', created_at: '2026-10-13T13:05:00Z' }]));
});

function scenario(t, options = {}) {
  const previous = { ...process.env };
  const env = { GITHUB_REPOSITORY: 'shenyankm/PractiQ', PR_NUMBER: '228', GH_READ_TOKEN: 'read-only', GH_MERGE_TOKEN: 'write-only', DRY_RUN: 'false', GITHUB_EVENT_NAME: 'schedule', PRACTIQ_AGENT_API_KEY: 'model-only', PRACTIQ_AGENT_BASE_URL: 'https://model.example/v1', PRACTIQ_AGENT_MODEL: 'test-model' };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  const writes = [], modelCalls = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    if (new URL(url).hostname === 'model.example') {
      assert.equal(request.headers.Authorization, 'Bearer model-only');
      assert(!request.body.includes('read-only') && !request.body.includes('write-only'));
      modelCalls.push(JSON.parse(request.body));
      if (options.modelError) return Response.json({}, { status: 503 });
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(options.verdict ?? passed) } }] });
    }
    const path = new URL(url).pathname.split('/').slice(4).join('/');
    if (request.method === 'PUT') {
      assert.equal(request.headers.Authorization, 'Bearer write-only');
      writes.push(JSON.parse(request.body));
      return options.conflict ? Response.json({}, { status: 409 }) : Response.json({ merged: true });
    }
    assert.equal(request.headers.Authorization, 'Bearer read-only');
    const responses = { 'pulls/228': pr, 'pulls/228/reviews': [review], 'pulls/228/reviews/1/comments': [],
      [`commits/${sha}/check-runs`]: { check_runs: options.checks ?? checks }, [`commits/${sha}/status`]: { statuses: [] },
      'collaborators/shenyankm/permission': { permission: options.permission ?? 'admin' },
      'issues/228/comments': [], 'issues/228/reactions': [] };
    assert(path in responses, `Unexpected request: ${path}`);
    return Response.json(responses[path]);
  });
  return { writes, modelCalls };
}

test('pending CI and untrusted authors cannot invoke the paid model or merge', async t => {
  const fixture = scenario(t, { checks: checks.slice(1) });
  await main();
  assert.equal(fixture.modelCalls.length, 0);
  assert.equal(fixture.writes.length, 0);
});

test('external authors require a maintainer dispatch before paid interpretation', async t => {
  const fixture = scenario(t, { permission: 'read' });
  await main();
  assert.equal(fixture.modelCalls.length, 0);
  assert.equal(fixture.writes.length, 0);
});

test('model rejection, network failure and invalid evidence never merge', async t => {
  const fixture = scenario(t, { verdict: { ...passed, passed: false, evidence_id: null, reason: 'Ambiguous report' } });
  await main();
  assert.equal(fixture.writes.length, 0);
});

test('model failure aborts before mutation', async t => {
  const fixture = scenario(t, { modelError: true });
  await assert.rejects(main, /503/);
  assert.equal(fixture.writes.length, 0);
});

test('dry run does not merge; rejected merges bind the exact head and are not retried', async t => {
  const fixture = scenario(t, { conflict: true });
  process.env.DRY_RUN = 'true';
  await main();
  assert.equal(fixture.writes.length, 0);
  process.env.DRY_RUN = 'false';
  await assert.rejects(main, /409/);
  assert.deepEqual(fixture.writes, [{ sha, merge_method: 'squash' }]);
});
