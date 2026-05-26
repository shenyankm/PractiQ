import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const baseUrl = process.env.PERF_BASE_URL || 'https://openwook.cloud';
const bankId = process.env.PERF_BANK_ID || '167';
const userCount = process.env.PERF_USER_COUNT || '1000';
const questionCount = process.env.PERF_QUESTION_COUNT || '5000';
const duration = process.env.PERF_QUICK_DURATION || '6';
const warmup = process.env.PERF_QUICK_WARMUP || '1';
const outDir = process.env.PERF_OUT_DIR || `reports/perf/quick-${new Date().toISOString().replace(/[:.]/g, '-')}`;
const prefix = process.env.PERF_DATA_PREFIX || 'perf_run_20260525';
const scenarios = [
  { name: 'health', concurrency: 150, p95BudgetMs: 1000, maxErrorRate: 0 },
  { name: 'public-api', concurrency: 150, p95BudgetMs: 1000, maxErrorRate: 0 },
  { name: 'auth-me', concurrency: 150, p95BudgetMs: 1200, maxErrorRate: 0 },
  { name: 'login', concurrency: 8, p95BudgetMs: 1200, maxErrorRate: 0 },
  { name: 'db-query', concurrency: 50, p95BudgetMs: 1200, maxErrorRate: 0 }
];

await mkdir(outDir, { recursive: true });
const results = [];
for (const scenario of scenarios) {
  const output = `${outDir}/${scenario.name}-c${scenario.concurrency}.json`;
  const args = [
    'scripts/perf/stress-runner.mjs',
    '--scenario', scenario.name,
    '--baseUrl', baseUrl,
    '--bankId', bankId,
    '--userCount', userCount,
    '--questionCount', questionCount,
    '--duration', duration,
    '--warmup', warmup,
    '--concurrency', String(scenario.concurrency),
    '--output', output,
    '--ramp', `quick-${scenario.name}-c${scenario.concurrency}`
  ];
  const result = await run('node', args, { ...process.env, PERF_DATA_PREFIX: prefix });
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  if (result.status !== 0) {
    results.push({ ...scenario, failed: true, status: result.status });
    continue;
  }
  const json = JSON.parse(await readFile(output, 'utf8'));
  results.push({
    ...scenario,
    requests: json.requests,
    rps: Number(json.rps.toFixed(2)),
    p95: json.latencyMs.p95,
    p99: json.latencyMs.p99,
    errorRate: json.errorRate,
    passed: json.errorRate <= scenario.maxErrorRate && json.latencyMs.p95 <= scenario.p95BudgetMs
  });
}

const passed = results.every((item) => item.passed === true);
await writeFile(`${outDir}/quick-regression-summary.json`, JSON.stringify({ baseUrl, bankId, duration, warmup, results, passed }, null, 2));
console.table(results.map((item) => ({ scenario: item.name, c: item.concurrency, rps: item.rps, p95: item.p95, p99: item.p99, errorRate: item.errorRate, budget: item.p95BudgetMs, passed: item.passed })));
if (!passed) process.exit(1);

function run(command, args, env) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('close', (status) => resolve({ status, stdout, stderr }));
  });
}
