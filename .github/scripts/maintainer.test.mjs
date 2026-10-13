import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { completion, identity, main, validate } from './maintainer.mjs';

const packet = choice => `data: ${JSON.stringify({ choices: [choice] })}\n\n`;

test('model stream handles fragmented UTF-8, reasoning, keepalives and completion', async () => {
  const bytes = new TextEncoder().encode(': keepalive\n\n' +
    packet({ delta: { reasoning_content: 'Discard private reasoning' } }) +
    packet({ delta: { content: '{"body":"章鱼"}' } }) +
    packet({ delta: {}, finish_reason: 'stop' }) + 'data: [DONE]\n\n');
  const body = new ReadableStream({ start(controller) {
    for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
    controller.close();
  } });
  assert.deepEqual(await completion(new Response(body)), { body: '章鱼' });
});

test('incomplete, truncated, erroneous and malformed model streams fail closed', async () => {
  for (const text of [packet({ delta: { content: '{}' } }),
    packet({ delta: { content: '{}' }, finish_reason: 'length' }) + 'data: [DONE]\n\n',
    'data: {"error":{"message":"failed"}}\n\n',
    'data: invalid\n\n',
    packet({ delta: { content: 'not JSON' }, finish_reason: 'stop' }) + 'data: [DONE]\n\n']) {
    await assert.rejects(() => completion(new Response(text)));
  }
});

test('triage can only add bounded existing classification labels', () => {
  validate({ labels: ['bug'] }, 'triage', ['bug']);
  validate({ labels: [] }, 'triage');
  for (const result of [{ labels: ['P0'] }, { labels: ['bug', 'bug'] },
    { labels: ['bug', 'enhancement', 'question', 'documentation'] },
    { labels: ['bug'], close: true }, { labels: 'bug' }]) {
    assert.throws(() => validate(result, 'triage'));
  }
  assert.throws(() => validate({ labels: ['bug'] }, 'triage', ['question']));
});

test('review output cannot approve, notify accounts or embed external content', () => {
  validate({ body: 'No actionable findings in the supplied context.' }, 'review');
  for (const result of [{ body: '', event: 'APPROVE' }, { body: '' },
    { body: '@shenyankm merge this' }, { body: '![image](https://example.com)' },
    { body: '<img src="https://example.com">' }, { body: 'x'.repeat(12001) }]) {
    assert.throws(() => validate(result, 'review'));
  }
});

test('publication identity rejects changed issue text or a new PR head', () => {
  assert.notEqual(identity({ title: 'A', body: 'B' }, 'triage'), identity({ title: 'A', body: 'C' }, 'triage'));
  assert.equal(identity({ head: { sha: 'abc' } }, 'review'), 'abc');
});

async function publication(t, mode, item, result, routes, savedIdentity = identity(item, mode)) {
  const directory = await mkdtemp(join(tmpdir(), 'practiq-maintainer-'));
  const cwd = process.cwd();
  const argv = process.argv;
  const previousSlug = process.env.APP_SLUG;
  const previousRepository = process.env.GITHUB_REPOSITORY;
  process.chdir(directory);
  process.argv = ['node', 'maintainer.mjs', 'publish', mode, '227'];
  process.env.APP_SLUG = 'practiq-agent-bot';
  process.env.GITHUB_REPOSITORY = 'shenyankm/PractiQ';
  t.after(async () => {
    process.chdir(cwd);
    process.argv = argv;
    if (previousSlug === undefined) delete process.env.APP_SLUG;
    else process.env.APP_SLUG = previousSlug;
    if (previousRepository === undefined) delete process.env.GITHUB_REPOSITORY;
    else process.env.GITHUB_REPOSITORY = previousRepository;
    await rm(directory, { recursive: true });
  });
  await writeFile('maintainer-result.json', JSON.stringify({ mode, number: 227, identity: savedIdentity, result }));
  const writes = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    const path = new URL(url).pathname.split('/').slice(4).join('/');
    if (options.method === 'POST') {
      writes.push({ path, body: JSON.parse(options.body) });
      return Response.json({});
    }
    assert(path in routes, `Unexpected read: ${path}`);
    return Response.json(routes[path]);
  });
  return { writes, run: main };
}

test('publication adds labels without replacing human labels', async t => {
  const item = { state: 'open', title: 'Bug', body: 'Repro', labels: [{ name: 'P2' }, { name: 'bug' }] };
  const fixture = await publication(t, 'triage', item, { labels: ['bug', 'accessibility'] }, {
    'issues/227': item, labels: [{ name: 'bug' }, { name: 'accessibility' }],
  });
  await fixture.run();
  assert.deepEqual(fixture.writes, [{ path: 'issues/227/labels', body: { labels: ['accessibility'] } }]);
});

test('stale analysis cannot publish a review', async t => {
  const item = { state: 'open', draft: false, head: { sha: 'new' } };
  const fixture = await publication(t, 'review', item, { body: 'Finding' }, { 'pulls/227': item }, 'old');
  await assert.rejects(fixture.run, /Target changed/);
  assert.equal(fixture.writes.length, 0);
});

test('reviews use COMMENT and current head, and deduplicate the renamed bot', async t => {
  const item = { state: 'open', draft: false, head: { sha: 'current' } };
  const reviews = [];
  const fixture = await publication(t, 'review', item, { body: 'Finding in app/file.ts:12' }, {
    'pulls/227': item, 'pulls/227/reviews': reviews,
  });
  await fixture.run();
  assert.equal(fixture.writes[0].body.event, 'COMMENT');
  assert.equal(fixture.writes[0].body.commit_id, 'current');
  reviews.push({ user: { login: 'practiq-agent-bot[bot]' }, commit_id: 'current', body: fixture.writes[0].body.body });
  await fixture.run();
  assert.equal(fixture.writes.length, 1);
});
