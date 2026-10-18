import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const reviewer = 'chatgpt-codex-connector[bot]';
const approver = 'practiq-pr-bot[bot]';
const requiredCI = ['Service CI', 'Desktop CI', 'Android CI'];

export function approvalBlocker(pr, checks, statuses) {
  if (pr.state !== 'open' || pr.draft || pr.base.ref !== 'main') return 'Not an open, ready PR targeting main';
  if (!requiredCI.every(name => checks.some(check => check.name === name && check.app?.slug === 'github-actions' && check.status === 'completed' && check.conclusion === 'success'))) return 'Required CI gates have not all passed';
  // Skipped jobs are inapplicable; the three final CI gates must still succeed.
  if (checks.some(check => check.status !== 'completed' || !['success', 'skipped'].includes(check.conclusion))) return 'A check is pending or not successful';
  if (statuses.some(status => status.state !== 'success')) return 'A commit status is pending or not successful';
  if (pr.mergeable !== true) return 'GitHub reports conflicts or unknown mergeability';
  return null;
}

export function reviewEvidence(pr, reviews, comments, resolvedShas = {}) {
  const current = reviews.filter(review => review.user?.login === reviewer && review.commit_id === pr.head.sha);
  if (current.some(review => ['CHANGES_REQUESTED', 'PENDING'].includes(review.state))) return [];
  const reports = current.filter(review => review.state !== 'DISMISSED').map(review =>
    ({ id: review.id, type: 'review', state: review.state, body: review.body, submitted_at: review.submitted_at }));
  for (const comment of comments.filter(comment => comment.user?.login === reviewer && comment.body.includes('codex-pull-request-review-summary')).slice(-1)) {
    let state;
    try { state = JSON.parse(comment.body.match(/<!-- codex-review-state:v1 (.*?) -->/)?.[1]); } catch { return []; }
    if (!state?.code_review || [state.code_review, ...(state.security_review ? [state.security_review] : [])].some(review =>
      review.commit_sha !== pr.head.sha || review.status !== 'completed' ||
      review.has_any_findings !== false || review.has_unresolved_findings !== false)) return [];
    const lines = comment.body.split('\n');
    const line = lines.find(line => line.includes('Code Review'));
    const security = lines.find(line => line.includes('Security Review'));
    if (Boolean(security) !== Boolean(state.security_review)) return [];
    if (security) {
      const securitySha = security.match(/`([0-9a-f]{7,40})`/)?.[1];
      if (!securitySha || (resolvedShas[securitySha] ?? securitySha) !== pr.head.sha || !security.includes('Completed')) return [];
    }
    const sha = line?.match(/`([0-9a-f]{7,40})`/)?.[1];
    if (!sha || (resolvedShas[sha] ?? sha) !== pr.head.sha || !line.includes('Completed')) return [];
    const completed = [line, ...(security ? [security] : [])]
      .map(row => Date.parse(row.match(/datetime="([^"]+)"/)?.[1]));
    reports.push({ id: comment.id, type: 'summary', body: comment.body,
      completed_at: completed.every(Number.isFinite) ? new Date(Math.max(...completed)).toISOString() : null });
  }
  return reports;
}

export function reviewPassed(reports, reactions = []) {
  if (!reports.length || reports.some(report => report.type === 'review' && report.findings?.length)) return false;
  if (reports.filter(report => report.type === 'review').at(-1)?.state === 'APPROVED') return true;
  return reports.some(report => report.type === 'summary' && reactions.some(reaction =>
    reaction.content === '+1' && Date.parse(reaction.created_at) >= Date.parse(report.completed_at) &&
    reports.filter(report => report.type === 'review').every(review =>
      Date.parse(reaction.created_at) >= Date.parse(review.submitted_at))));
}

async function api(path, method = 'GET', body) {
  const token = method === 'GET' ? process.env.GH_READ_TOKEN : process.env.GH_REVIEW_TOKEN;
  assert(token, `Missing ${method === 'GET' ? 'read' : 'review'} token`);
  assert(method === 'GET' || (method === 'POST' && /^pulls\/\d+\/reviews$/.test(path)) ||
    (method === 'PUT' && /^pulls\/\d+\/reviews\/\d+\/dismissals$/.test(path)), 'Unsupported review mutation');
  const response = await fetch(`https://api.github.com/repos/${process.env.GITHUB_REPOSITORY}/${path}`, {
    method, signal: AbortSignal.timeout(30000),
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert(response.ok, `GitHub request failed: ${response.status}`);
  return response.json();
}

async function pages(path, key) {
  const rows = [];
  for (let page = 1; page <= 10; page++) {
    const result = await api(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const batch = key ? result[key] : result;
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error('Pagination exceeds supported limit; no approval attempted');
}

async function evidenceFor(pr) {
  const reviews = await pages(`pulls/${pr.number}/reviews`);
  const comments = await pages(`issues/${pr.number}/comments`);
  const summary = comments.filter(comment => comment.user?.login === reviewer && comment.body.includes('codex-pull-request-review-summary')).at(-1);
  const resolvedShas = {};
  for (const row of summary?.body.split('\n').filter(row => row.includes('Code Review') || row.includes('Security Review')) ?? []) {
    const sha = row.match(/`([0-9a-f]{7,40})`/)?.[1];
    if (sha && sha.length < 40) resolvedShas[sha] = (await api(`commits/${sha}`)).sha;
  }
  const reports = reviewEvidence(pr, reviews, comments, resolvedShas);
  for (const report of reports.filter(report => report.type === 'review')) {
    report.findings = (await pages(`pulls/${pr.number}/reviews/${report.id}/comments`))
      .map(comment => ({ path: comment.path, line: comment.line, body: comment.body }));
  }
  const reactions = reports.length ? (await pages(`issues/${pr.number}/reactions`))
    .filter(reaction => reaction.user?.login === reviewer && reaction.content === '+1')
    .map(reaction => ({ id: reaction.id, created_at: reaction.created_at, content: reaction.content })) : [];
  const approvals = reviews.filter(review => review.user?.login === approver && review.commit_id === pr.head.sha &&
    review.state === 'APPROVED').map(review => review.id);
  return { reports, reactions, approvals };
}

export async function main() {
  const number = process.env.PR_NUMBER;
  assert(!number || /^[1-9]\d*$/.test(number), 'Invalid PR number');
  assert(!number || Number.isSafeInteger(Number(number)), 'Invalid PR number');
  const targets = number ? [{ number: Number(number) }] : await pages('pulls?state=open&base=main');
  for (const target of targets) {
    try {
      const pr = await api(`pulls/${target.number}`);
      if (pr.state !== 'open' || pr.draft || pr.base.ref !== 'main') continue;
      const evidence = await evidenceFor(pr);
      const files = await pages(`pulls/${target.number}/files`);
      const protectedFiles = files.some(file => [file.filename, file.previous_filename].some(path =>
        path?.startsWith('.github/workflows/') || path?.startsWith('.github/scripts/') || path?.startsWith('server/scripts/')));
      const checks = await pages(`commits/${pr.head.sha}/check-runs?filter=latest`, 'check_runs');
      const statuses = await pages(`commits/${pr.head.sha}/status`, 'statuses');
      let reason = protectedFiles ? 'CI definition or scope changes require manual review' : approvalBlocker(pr, checks, statuses);
      if (!reviewPassed(evidence.reports, evidence.reactions)) reason = 'No clean completed current-head GPT Code Review';
      if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
        const permission = await api(`collaborators/${encodeURIComponent(process.env.GITHUB_ACTOR)}/permission`);
        assert(['admin', 'maintain', 'write'].includes(permission.permission), 'Dispatch actor is not a maintainer');
      }
      if (reason) {
        console.log(`#${target.number}: ${reason}`);
        if (process.env.DRY_RUN === 'false' && evidence.approvals.length) {
          const fresh = await api(`pulls/${target.number}`);
          assert.equal(fresh.head.sha, pr.head.sha, 'PR head changed; no dismissal');
          const current = await evidenceFor(fresh);
          for (const id of evidence.approvals.filter(id => current.approvals.includes(id))) {
            await api(`pulls/${target.number}/reviews/${id}/dismissals`, 'PUT', {
              message: 'PR bot approval withdrawn: current Codex review or validation conditions no longer pass.',
            });
          }
        }
        continue;
      }
      if (evidence.approvals.length) { console.log(`#${target.number}: already approved this head`); continue; }
      if (process.env.DRY_RUN !== 'false') { console.log(`#${target.number}: eligible for approval (dry run)`); continue; }
      const fresh = await api(`pulls/${target.number}`);
      assert.equal(fresh.head.sha, pr.head.sha, 'PR head changed after evaluation; no approval');
      assert.deepEqual(await evidenceFor(fresh), evidence, 'GPT review changed after evaluation; no approval');
      const finalChecks = await pages(`commits/${pr.head.sha}/check-runs?filter=latest`, 'check_runs');
      const finalStatuses = await pages(`commits/${pr.head.sha}/status`, 'statuses');
      assert.equal(approvalBlocker(fresh, finalChecks, finalStatuses), null, 'Approval conditions changed after evaluation');
      if (process.env.GITHUB_EVENT_NAME === 'workflow_dispatch') {
        const permission = await api(`collaborators/${encodeURIComponent(process.env.GITHUB_ACTOR)}/permission`);
        assert(['admin', 'maintain', 'write'].includes(permission.permission), 'Dispatch authorization changed after evaluation');
      }
      const result = await api(`pulls/${target.number}/reviews`, 'POST', {
        commit_id: pr.head.sha, event: 'APPROVE',
        body: 'Current-head Codex connector review evidence and CI checks passed. Approval only; GitHub enforces required review and CI gates; merging remains manual.',
      });
      assert(result.state === 'APPROVED' && result.commit_id === pr.head.sha, 'Review approval was not confirmed');
      try {
        assert.equal((await api(`pulls/${target.number}`)).head.sha, pr.head.sha, 'PR head changed during approval');
      } catch (error) {
        await api(`pulls/${target.number}/reviews/${result.id}/dismissals`, 'PUT', {
          message: 'PR bot approval withdrawn: the current head could not be confirmed after submission.',
        });
        throw error;
      }
      console.log(`#${target.number}: approved ${pr.head.sha}`);
    } catch (error) { console.error(`#${target.number}: ${error.message}; skipped`); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
