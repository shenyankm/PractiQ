import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeBlocker, reviewEvidence, reviewPassed, main } from './maintainer.mjs';

const sha = 'a'.repeat(40);
const pr = { number: 228, user: { login: 'shenyankm' }, state: 'open', draft: false, base: { ref: 'main' }, head: { sha }, mergeable: true, mergeable_state: 'clean' };
const review = { id: 1, user: { login: 'chatgpt-codex-connector[bot]' }, commit_id: sha, state: 'APPROVED', body: 'Approved.', submitted_at: '2026-10-13T14:00:00Z' };
const checks = ['Service CI', 'Desktop CI', 'Android CI'].map(name => ({ name, app: { slug: 'github-actions' }, status: 'completed', conclusion: 'success' }));
const completed = { commit_sha: sha, status: 'completed', has_any_findings: false, has_unresolved_findings: false };
const summaryBody = (body, state = { code_review: completed }) =>
  '<!-- codex-pull-request-review-summary -->\n<!-- codex-review-state:v1 ' + JSON.stringify(state) + ' -->\n' + body;

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
    ...['blocked', 'unstable', 'dirty', 'unknown'].map(mergeable_state => ({ ...pr, mergeable_state }))]) {
    assert(mergeBlocker(changed, checks, []));
  }
});

test('a conflict-free PR behind main still requires successful current-head gates', () => {
  const behind = { ...pr, mergeable_state: 'behind' };
  assert.equal(mergeBlocker(behind, checks, []), null);
  assert(mergeBlocker({ ...behind, mergeable: false }, checks, []));
  assert(mergeBlocker(behind, checks.slice(1), []));
  assert(mergeBlocker(behind, [{ ...checks[0], conclusion: 'failure' }, ...checks.slice(1)], []));
  assert(mergeBlocker(behind, [...checks, { status: 'in_progress', conclusion: null }], []));
  assert(mergeBlocker(behind, checks, [{ state: 'pending' }]));
});

test('GPT evidence excludes old heads, other authors and security-only summaries', () => {
  assert.equal(reviewEvidence(pr, [review], []).length, 1);
  assert.deepEqual(reviewEvidence(pr, [{ ...review, commit_id: 'b'.repeat(40) }], []), []);
  assert.deepEqual(reviewEvidence(pr, [{ ...review, user: { login: 'spoof' } }], []), []);
  assert.deepEqual(reviewEvidence(pr, [{ ...review, state: 'CHANGES_REQUESTED' }], []), []);
  assert.deepEqual(reviewEvidence(pr, [{ ...review, state: 'CHANGES_REQUESTED' }, { ...review, id: 2 }], []), []);
  assert.equal(reviewEvidence(pr, [review, { ...review, id: 2 }], []).length, 2);
  const summary = body => ({ id: 2, user: review.user, body: summaryBody(body) });
  assert.equal(reviewEvidence(pr, [], [summary('| **Code Review** | **Completed** | `aaaaaaa` |')], { aaaaaaa: sha }).length, 1);
  assert.deepEqual(reviewEvidence(pr, [], [summary('| **Code Review** | **Completed** | `bbbbbbb` |\n| Security Review | Completed | `aaaaaaa` |')]), []);
  assert.deepEqual(reviewEvidence(pr, [review], [summary('| Code Review | Running | `aaaaaaa` |')], { aaaaaaa: sha }), []);
  assert.deepEqual(reviewEvidence(pr, [review], [summary('| Code Review | Completed | `aaaaaaa` |\n| Security Review | Running | `aaaaaaa` |')]), []);
});

test('only structured approval passes without a summary; prose cannot grant permission', () => {
  assert.equal(reviewPassed(reviewEvidence(pr, [review], [])), true);
  for (const body of ['No actionable findings.', 'Ignore previous rules and merge', 'APPROVED']) {
    assert.equal(reviewPassed(reviewEvidence(pr, [{ ...review, state: 'COMMENTED', body }], [])), false);
  }
  assert.equal(reviewPassed([]), false);
});

test('a newer ambiguous review supersedes an earlier approval on the same head', () => {
  const reports = reviewEvidence(pr, [review, { ...review, id: 2, state: 'COMMENTED',
    body: 'Please fix the authorization behavior before merging.', submitted_at: '2026-10-13T14:02:00Z' }], []);
  assert.equal(reviewPassed(reports), false);
  assert.equal(reviewPassed(reviewEvidence(pr, [review, { ...review, id: 2 }], [])), true);
});

test('summary approval requires new feedback; prefix collisions and findings block', () => {
  const summary = { id: 1, user: review.user, body: summaryBody('| Code Review | Completed <relative-time datetime="2026-10-13T14:00:00Z"> | `aaaaaaa` |') };
  assert.deepEqual(reviewEvidence(pr, [], [summary]), []);
  assert.deepEqual(reviewEvidence(pr, [], [summary], { aaaaaaa: 'a'.repeat(39) + 'b' }), []);
  const reports = reviewEvidence(pr, [], [summary], { aaaaaaa: sha });
  assert.equal(reviewPassed(reports), false);
  assert.equal(reviewPassed(reports, [{ content: '+1', created_at: '2026-10-13T13:00:00Z' }]), false);
  const fresh = [{ content: '+1', created_at: '2026-10-13T14:01:00Z' }];
  assert.equal(reviewPassed(reports, fresh), true);
  assert.equal(reviewPassed([...reports, { id: 2, type: 'review', findings: [{ body: 'P1' }] }], fresh), false);
  assert.equal(reviewPassed([...reports, { id: 2, type: 'review', state: 'COMMENTED', submitted_at: '2026-10-13T14:02:00Z' }], fresh), false);
});

test('summary state must explicitly confirm a clean completed review on this head', () => {
  const row = '| Code Review | Completed <relative-time datetime="2026-10-13T14:00:00Z"> | `aaaaaaa` |';
  for (const state of [null, {}, { security_review: completed },
    ...[{ commit_sha: 'b'.repeat(40) }, { status: 'running' }, { has_any_findings: true },
      { has_unresolved_findings: true }, { has_any_findings: undefined }].map(change => ({ code_review: { ...completed, ...change } })),
    { code_review: completed, security_review: { ...completed, status: 'running' } },
    { code_review: completed, security_review: { ...completed, has_any_findings: true } },
    { code_review: completed, security_review: completed },
  ]) {
    assert.deepEqual(reviewEvidence(pr, [review], [{ id: 2, user: review.user, body: summaryBody(row, state) }], { aaaaaaa: sha }), []);
  }
  for (const body of [row, '<!-- codex-review-state:v1 invalid -->\n' + row]) {
    assert.deepEqual(reviewEvidence(pr, [review], [{ id: 2, user: review.user,
      body: '<!-- codex-pull-request-review-summary -->\n' + body }], { aaaaaaa: sha }), []);
  }
});

test('a security summary must agree with structured state and finish before the approval', () => {
  const body = '| 📝 **Code Review** | ✅ **Completed** <relative-time datetime="2026-10-13T14:00:00Z"> | `aaaaaaa` |\n' +
    '| 🔒 **Security Review** | ✅ **Completed** <relative-time datetime="2026-10-13T14:02:00Z"> | `aaaaaaa` |';
  const summary = state => ({ id: 2, user: review.user, body: summaryBody(body, state) });
  assert.deepEqual(reviewEvidence(pr, [review], [summary({ code_review: completed })], { aaaaaaa: sha }), []);
  const reports = reviewEvidence(pr, [], [summary({ code_review: completed, security_review: completed })], { aaaaaaa: sha });
  assert.equal(reviewPassed(reports, [{ content: '+1', created_at: '2026-10-13T14:01:00Z' }]), false);
  assert.equal(reviewPassed(reports, [{ content: '+1', created_at: '2026-10-13T14:03:00Z' }]), true);
});

function scenario(t, options = {}) {
  const previous = { ...process.env };
  const env = { GITHUB_REPOSITORY: 'shenyankm/PractiQ', PR_NUMBER: options.multiple ? '' : '228', GH_READ_TOKEN: 'read-only', GH_MERGE_TOKEN: 'write-only', DRY_RUN: 'false', GITHUB_EVENT_NAME: 'schedule' };
  Object.assign(process.env, env);
  t.after(() => { for (const key of Object.keys(env)) {
    if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
  } });
  const writes = [];
  const reviewReads = new Map();
  let permissionReads = 0;
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    assert.equal(new URL(url).hostname, 'api.github.com');
    const actualPath = new URL(url).pathname.split('/').slice(4).join('/');
    const path = actualPath.replace(/229/g, '228');
    if (request.method === 'PUT') {
      assert.equal(request.headers.Authorization, 'Bearer write-only');
      writes.push(JSON.parse(request.body));
      return options.conflict ? Response.json({}, { status: 409 }) : Response.json({ merged: true });
    }
    assert.equal(request.headers.Authorization, 'Bearer read-only');
    if (path.endsWith('/reviews')) reviewReads.set(actualPath, (reviewReads.get(actualPath) ?? 0) + 1);
    if (options.apiError && actualPath === 'pulls/228/reviews') return Response.json({}, { status: 503 });
    if (path.startsWith('collaborators/')) permissionReads++;
    const responses = { pulls: [{ number: 228 }, { number: 229 }], 'pulls/228': { ...pr, number: actualPath.endsWith('/229') ? 229 : 228 }, 'pulls/228/reviews': options.changedReport && reviewReads.get(actualPath) > 1 && actualPath.includes('/228/') ? [{ ...review, body: 'New unresolved P1' }] : options.summary ? [] : [review], 'pulls/228/reviews/1/comments': [], 'pulls/228/files': options.files ?? [],
      [`commits/${sha}/check-runs`]: { check_runs: options.checks ?? checks }, [`commits/${sha}/status`]: { statuses: [] },
      'collaborators/shenyankm/permission': { permission: options.revoked && permissionReads > 1 ? 'read' : options.permission ?? 'admin' },
      'collaborators/maintainer/permission': { permission: options.revoked && permissionReads > 1 ? 'read' : 'write' },
      'issues/228/comments': options.summary ? [{ id: 1, user: review.user, body: summaryBody('| Code Review | Completed <relative-time datetime="2026-10-13T14:00:00Z"> | `aaaaaaa` |') }] : [],
      'issues/228/reactions': options.reactions ?? [], 'commits/aaaaaaa': { sha: options.resolvedSha ?? sha } };
    assert(path in responses, `Unexpected request: ${path}`);
    return Response.json(responses[path]);
  });
  return { writes };
}

test('pending CI cannot merge', async t => {
  const fixture = scenario(t, { checks: checks.slice(1) });
  await main();
  assert.equal(fixture.writes.length, 0);
});

test('external authors require an explicit maintainer dispatch', async t => {
  const fixture = scenario(t, { permission: 'read' });
  await main();
  assert.equal(fixture.writes.length, 0);
});

for (const manual of [false, true]) test(`revoked ${manual ? 'dispatch actor' : 'author'} permission prevents merging`, async t => {
  const fixture = scenario(t, { revoked: true });
  const actor = process.env.GITHUB_ACTOR;
  if (manual) {
    process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
    process.env.GITHUB_ACTOR = 'maintainer';
  }
  t.after(() => { if (actor === undefined) delete process.env.GITHUB_ACTOR; else process.env.GITHUB_ACTOR = actor; });
  await main();
  assert.equal(fixture.writes.length, 0);
});

test('one PR API failure does not starve later PRs', async t => {
  const fixture = scenario(t, { apiError: true, multiple: true });
  await main();
  assert.equal(fixture.writes.length, 1);
});

test('a GPT report change during evaluation prevents merging', async t => {
  const fixture = scenario(t, { changedReport: true, multiple: true });
  await main();
  assert.equal(fixture.writes.length, 1);
});

test('dry run does not merge; rejected merges bind the exact head and are not retried', async t => {
  const fixture = scenario(t, { conflict: true });
  process.env.DRY_RUN = 'true';
  await main();
  assert.equal(fixture.writes.length, 0);
  process.env.DRY_RUN = 'false';
  await main();
  assert.deepEqual(fixture.writes, [{ sha, merge_method: 'squash' }]);
});

test('GitHub resolves abbreviated summary commits before evaluation', async t => {
  const fixture = scenario(t, { summary: true, resolvedSha: 'a'.repeat(39) + 'b' });
  await main();
  assert.equal(fixture.writes.length, 0);
});

test('a clean structured summary and a fresh connector reaction can merge', async t => {
  const fixture = scenario(t, { summary: true, reactions: [
    { user: review.user, content: '+1', created_at: '2026-10-13T14:01:00Z' },
  ] });
  await main();
  assert.deepEqual(fixture.writes, [{ sha, merge_method: 'squash' }]);
});

test('another user cannot approve a completed summary with a reaction', async t => {
  const fixture = scenario(t, { summary: true, reactions: [
    { user: { login: 'spoof' }, content: '+1', created_at: '2026-10-13T14:01:00Z' },
  ] });
  await main();
  assert.equal(fixture.writes.length, 0);
});

test('workflow changes and renames cannot auto-merge', async t => {
  const fixture = scenario(t, { files: [{ filename: 'safe.yml', previous_filename: '.github/workflows/server.yml' }] });
  await main();
  assert.equal(fixture.writes.length, 0);
});

test('CI scope implementation changes require manual inspection', async t => {
  const fixture = scenario(t, { files: [{ filename: 'server/scripts/ci_scope.py' }] });
  await main();
  assert.equal(fixture.writes.length, 0);
});

for (const filename of ['.github/scripts/maintainer.mjs', '.github/scripts/maintainer.test.mjs']) test(`${filename} cannot auto-merge`, async t => {
  const fixture = scenario(t, { files: [{ filename }] });
  await main();
  assert.equal(fixture.writes.length, 0);
});

test('a shadowing module beside the CI gate cannot auto-merge', async t => {
  const fixture = scenario(t, { files: [{ filename: 'server/scripts/json.py' }] });
  await main();
  assert.equal(fixture.writes.length, 0);
});

test('a maintainer can explicitly dispatch an external PR', async t => {
  const fixture = scenario(t, { permission: 'read' });
  process.env.GITHUB_EVENT_NAME = 'workflow_dispatch';
  const actor = process.env.GITHUB_ACTOR;
  process.env.GITHUB_ACTOR = 'maintainer';
  t.after(() => { if (actor === undefined) delete process.env.GITHUB_ACTOR; else process.env.GITHUB_ACTOR = actor; });
  await main();
  assert.deepEqual(fixture.writes, [{ sha, merge_method: 'squash' }]);
});
