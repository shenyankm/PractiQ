import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { api, catalog, classify, dimension, labelNames, missingLabels, syncLabels } from './issue-labeler.mjs';

export async function main() {
  const event = JSON.parse(readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'));
  const eventName = process.env.GITHUB_EVENT_NAME;
  assert(['pull_request_target', 'workflow_dispatch'].includes(eventName), 'Unsupported PR labeling event');
  if (eventName === 'pull_request_target' && event.action !== 'opened') {
    console.log('Only newly opened PRs are classified automatically; use workflow_dispatch to retry.');
    return;
  }
  const number = eventName === 'pull_request_target' ? event.pull_request?.number : event.inputs?.number;
  assert(/^[1-9]\d*$/.test(String(number)) && Number.isSafeInteger(Number(number)), 'Invalid PR number');
  const pr = await api(`pulls/${number}`);
  assert(pr, 'PR not found');
  if (pr.state !== 'open' || pr.base?.ref !== 'main') {
    console.log(`#${number}: only open PRs targeting main can be classified.`);
    return;
  }
  const present = new Set(labelNames(pr).map(dimension));
  if (eventName !== 'workflow_dispatch' && ['type', 'area', 'priority'].every(group => present.has(group))) return;
  const files = await api(`pulls/${number}/files?per_page=100`);
  assert(Array.isArray(files), 'Invalid PR files response');
  const candidates = await classify(pr, { pullRequest: true, files });
  const proposed = missingLabels(pr, candidates);
  // GitHub accepts Pull requests write for repository label creation too.
  await syncLabels(catalog.filter(label => proposed.includes(label.name)), false);
  const fresh = await api(`pulls/${number}`);
  assert(fresh && fresh.state === 'open' && fresh.base?.ref === 'main' &&
    fresh.head?.sha === pr.head?.sha && fresh.base?.sha === pr.base?.sha &&
    fresh.title === pr.title && fresh.body === pr.body, 'PR changed during classification; rerun the workflow');
  const labels = missingLabels(fresh, candidates);
  if (!labels.length) return;
  await api(`issues/${number}/labels`, 'POST', { labels });
  console.log(`#${number}: added ${labels.join(', ')}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
