import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

const baseUrl = process.env.PERF_BASE_URL || 'https://openwook.cloud';
const bankId = process.env.PERF_BANK_ID || '110';
const userCount = process.env.PERF_USER_COUNT || '1000';
const questionCount = process.env.PERF_QUESTION_COUNT || '5000';
const duration = process.env.PERF_SUITE_DURATION || '12';
const warmup = process.env.PERF_SUITE_WARMUP || '2';
const outDir = process.env.PERF_OUT_DIR || `reports/perf/${new Date().toISOString().replace(/[:.]/g, '-')}`;

const scenarios = [
  { name: 'health', concurrencies: [50, 100, 200, 400] },
  { name: 'public-api', concurrencies: [50, 100, 200, 400] },
  { name: 'login', concurrencies: [10, 20, 40, 80], duration: '10' },
  { name: 'register', concurrencies: [5, 10, 20, 40], duration: '8' },
  { name: 'auth-me', concurrencies: [50, 100, 200, 400] },
  { name: 'bank-read', concurrencies: [20, 50, 100, 200] },
  { name: 'practice-read', concurrencies: [20, 50, 100, 200], sessions: '220' },
  { name: 'practice-mixed', concurrencies: [10, 20, 50, 100], sessions: '160' },
  { name: 'db-query', concurrencies: [20, 50, 100, 200] }
];

await mkdir(outDir, { recursive: true });
console.log(`[suite] output=${outDir}`);

const summaries = [];
for (const scenario of scenarios) {
  for (const concurrency of scenario.concurrencies) {
    const file = `${outDir}/${scenario.name}-c${concurrency}.json`;
    const args = [
      'scripts/perf/stress-runner.mjs',
      '--scenario', scenario.name,
      '--baseUrl', baseUrl,
      '--bankId', bankId,
      '--userCount', userCount,
      '--questionCount', questionCount,
      '--duration', scenario.duration || duration,
      '--warmup', scenario.warmup || warmup,
      '--concurrency', String(concurrency),
      '--output', file,
      '--ramp', `${scenario.name}-c${concurrency}`
    ];
    if (scenario.sessions) args.push('--sessions', scenario.sessions);
    console.log(`[suite] run ${scenario.name} c=${concurrency}`);
    const result = await run('node', args, { env: process.env });
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    if (result.status !== 0) {
      summaries.push({ scenario: scenario.name, concurrency, failed: true, status: result.status, stderr: result.stderr });
      continue;
    }
    if (existsSync(file)) {
      const json = JSON.parse(await readFile(file, 'utf8'));
      summaries.push({
        scenario: json.scenario,
        concurrency: json.concurrency,
        requests: json.requests,
        rps: Number(json.rps.toFixed(2)),
        avg: json.latencyMs.avg,
        p95: json.latencyMs.p95,
        p99: json.latencyMs.p99,
        errors: json.errors,
        errorRate: Number((json.errorRate * 100).toFixed(2)),
        statuses: json.byStatus
      });
    }
  }
}
await writeFile(`${outDir}/summary.json`, JSON.stringify({ baseUrl, bankId, duration, warmup, summaries }, null, 2));
console.log(`[suite] summary=${outDir}/summary.json`);
console.table(summaries.map((item) => ({ scenario: item.scenario, c: item.concurrency, rps: item.rps, avg: item.avg, p95: item.p95, p99: item.p99, err: item.errorRate, statuses: JSON.stringify(item.statuses || {}) })));

function run(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
