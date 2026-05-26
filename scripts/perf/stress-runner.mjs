import { config } from 'dotenv';
import http from 'node:http';
import https from 'node:https';
import { performance } from 'node:perf_hooks';
import { spawnSync } from 'node:child_process';
import { cpus, totalmem, freemem, loadavg } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import { URL } from 'node:url';

config({ path: '.env.local' });
config();

const args = parseArgs(process.argv.slice(2));
const scenario = args.scenario || 'health';
const baseUrl = (args.baseUrl || process.env.PERF_BASE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const durationSec = Number(args.duration || process.env.PERF_DURATION_SECONDS || 20);
const concurrency = Number(args.concurrency || process.env.PERF_CONCURRENCY || 20);
const warmupSec = Number(args.warmup || process.env.PERF_WARMUP_SECONDS || 2);
const output = args.output || '';
const prefix = args.prefix || process.env.PERF_DATA_PREFIX || 'perf_local';
const password = args.password || process.env.PERF_USER_PASSWORD || 'OpenWookPerf123!';
const bankId = args.bankId ? Number(args.bankId) : Number(process.env.PERF_BANK_ID || 110);
const userCount = Number(args.userCount || process.env.PERF_USER_COUNT || 80);
const localAddressBase = args.localAddressBase || process.env.PERF_LOCAL_ADDRESS_BASE || '127.0.0.';
const maxLocalAddresses = Number(args.localAddresses || process.env.PERF_LOCAL_ADDRESSES || 180);
const timeoutMs = Number(args.timeoutMs || process.env.PERF_TIMEOUT_MS || 30000);
const rampName = args.ramp || '';
const includeStatic = args.static === 'true' || process.env.PERF_INCLUDE_STATIC === 'true';

const parsedBase = new URL(baseUrl);
const isHttps = parsedBase.protocol === 'https:';
const agentByLocalAddress = new Map();
const keepAliveAgentOptions = {
  keepAlive: true,
  maxSockets: Math.max(1024, concurrency + 20),
  maxFreeSockets: Math.max(256, concurrency + 20),
  timeout: timeoutMs,
  scheduling: 'lifo',
  rejectUnauthorized: false,
  servername: parsedBase.hostname
};

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith('--')) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i += 1;
    } else {
      out[key] = 'true';
    }
  }
  return out;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, item) => acc + item, 0);
  return {
    count: sorted.length,
    min: sorted.length ? sorted[0] : null,
    avg: sorted.length ? sum / sorted.length : null,
    p50: percentile(sorted, 50),
    p90: percentile(sorted, 90),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    max: sorted.length ? sorted[sorted.length - 1] : null
  };
}

function formatMs(value) {
  return value === null || value === undefined ? null : Number(value.toFixed(2));
}

function localAddressFor(index) {
  if (parsedBase.hostname !== 'openwook.cloud' && parsedBase.hostname !== '127.0.0.1' && parsedBase.hostname !== 'localhost') return undefined;
  if (!localAddressBase.startsWith('127.0.0.')) return undefined;
  const hostPart = 2 + (index % Math.max(1, maxLocalAddresses));
  if (hostPart > 254) return undefined;
  return `${localAddressBase}${hostPart}`;
}

function agentFor(localAddress) {
  const key = localAddress || 'default';
  let agent = agentByLocalAddress.get(key);
  if (!agent) {
    const options = { ...keepAliveAgentOptions, localAddress };
    agent = isHttps ? new https.Agent(options) : new http.Agent(options);
    agentByLocalAddress.set(key, agent);
  }
  return agent;
}

function routePath(path) {
  return `${parsedBase.pathname.replace(/\/$/, '')}${path}` || path;
}

function makeRequest({ method = 'GET', path = '/', body, headers = {}, userIndex = 0, expect = [200], timeout = timeoutMs }) {
  const localAddress = localAddressFor(userIndex);
  const payload = body === undefined ? undefined : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
  const requestHeaders = {
    Accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
    'User-Agent': `openwook-local-stress/${scenario}`,
    ...headers
  };
  if (payload) {
    requestHeaders['Content-Type'] ??= 'application/json';
    requestHeaders['Content-Length'] = payload.length;
  }

  const options = {
    protocol: parsedBase.protocol,
    hostname: parsedBase.hostname,
    port: parsedBase.port || (isHttps ? 443 : 80),
    path: routePath(path),
    method,
    headers: requestHeaders,
    agent: agentFor(localAddress),
    timeout,
    rejectUnauthorized: false,
    servername: parsedBase.hostname
  };
  if (parsedBase.hostname === 'openwook.cloud') {
    options.lookup = (_hostname, _opts, cb) => cb(null, '127.0.0.1', 4);
  }

  const started = performance.now();
  return new Promise((resolve) => {
    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let bytes = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        bytes += chunk.length;
        if (chunks.length < 16 && bytes < 1024 * 1024) chunks.push(chunk);
      });
      res.on('end', () => {
        const ms = performance.now() - started;
        const text = Buffer.concat(chunks).toString('utf8');
        const ok = expect.includes(res.statusCode);
        resolve({ ok, status: res.statusCode, ms, bytes, headers: res.headers, text });
      });
    });
    req.on('timeout', () => {
      req.destroy(new Error(`timeout after ${timeout}ms`));
    });
    req.on('error', (error) => {
      const ms = performance.now() - started;
      resolve({ ok: false, status: 0, ms, bytes: 0, error: error.code || error.message, text: '' });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function cookieHeaderFrom(headers) {
  const setCookie = headers['set-cookie'];
  if (!setCookie) return '';
  const cookies = Array.isArray(setCookie) ? setCookie : [setCookie];
  return cookies.map((item) => String(item).split(';')[0]).join('; ');
}

async function loginUser(userNumber, userIndex = userNumber) {
  const username = userNumber === 0 ? `${prefix}_owner` : `${prefix}_user_${String(((userNumber - 1) % userCount) + 1).padStart(4, '0')}`;
  const response = await makeRequest({
    method: 'POST',
    path: '/api/v1/auth/login',
    body: { login: username, password },
    userIndex,
    expect: [200]
  });
  return { ...response, username, cookie: cookieHeaderFrom(response.headers) };
}

async function createPracticeSession(cookie, userIndex, count = 20) {
  const response = await makeRequest({
    method: 'POST',
    path: '/api/v1/practice-sessions',
    body: { bankId, mode: 'all', questionCount: count },
    headers: cookie ? { Cookie: cookie } : {},
    userIndex,
    expect: [201]
  });
  let sessionId = null;
  try {
    sessionId = JSON.parse(response.text).data.id;
  } catch {}
  return { ...response, sessionId: sessionId ? Number(sessionId) : null };
}

async function seedSessions(count) {
  const sessions = [];
  const total = Math.min(count, userCount);
  const batch = 20;
  for (let start = 1; start <= total; start += batch) {
    const slice = Array.from({ length: Math.min(batch, total - start + 1) }, (_, i) => start + i);
    const loggedIn = await Promise.all(slice.map((userNumber, i) => loginUser(userNumber, start + i)));
    const created = await Promise.all(loggedIn.map((login, i) => login.cookie ? createPracticeSession(login.cookie, start + i, 20) : login));
    for (let i = 0; i < slice.length; i += 1) {
      if (loggedIn[i].cookie && created[i].sessionId) {
        sessions.push({ userNumber: slice[i], userIndex: start + i, cookie: loggedIn[i].cookie, sessionId: created[i].sessionId });
      }
    }
  }
  if (sessions.length === 0) throw new Error('Could not seed any authenticated practice sessions');
  return sessions;
}

async function setupScenario() {
  if (scenario === 'health') return { name: scenario };
  if (scenario === 'static-home') return { name: scenario };
  if (scenario === 'public-api') return { name: scenario };
  if (scenario === 'register') return { name: scenario, seq: 0 };
  if (scenario === 'login') return { name: scenario };
  if (scenario === 'auth-me') {
    const login = await loginUser(1, 1);
    if (!login.cookie) throw new Error(`auth-me login failed: ${login.status} ${login.text}`);
    return { name: scenario, cookie: login.cookie };
  }
  if (scenario === 'bank-read') {
    const login = await loginUser(1, 1);
    if (!login.cookie) throw new Error(`bank-read login failed: ${login.status} ${login.text}`);
    return { name: scenario, cookie: login.cookie };
  }
  if (scenario === 'practice-read' || scenario === 'practice-mixed') {
    const sessions = await seedSessions(Number(args.sessions || Math.min(userCount, Math.max(10, concurrency))));
    return { name: scenario, sessions };
  }
  if (scenario === 'db-query') {
    const login = await loginUser(1, 1);
    if (!login.cookie) throw new Error(`db-query login failed: ${login.status} ${login.text}`);
    return { name: scenario, cookie: login.cookie };
  }
  throw new Error(`Unknown scenario: ${scenario}`);
}

async function requestForScenario(state, sequence, workerIndex) {
  if (scenario === 'health') {
    return makeRequest({ path: '/api/health', userIndex: workerIndex, expect: [200] });
  }
  if (scenario === 'static-home') {
    const paths = ['/', '/sign-in', '/sign-up'];
    return makeRequest({ path: paths[sequence % paths.length], userIndex: workerIndex, expect: [200, 302, 307, 308] });
  }
  if (scenario === 'public-api') {
    const paths = [
      '/api/v1/subjects',
      '/api/v1/question-types?subject=general',
      '/api/v1/knowledge-points?subject=general'
    ];
    return makeRequest({ path: paths[sequence % paths.length], userIndex: workerIndex, expect: [200] });
  }
  if (scenario === 'register') {
    const unique = `${Date.now().toString(36)}_${process.pid.toString(36)}_${sequence.toString(36)}_${workerIndex.toString(36)}`;
    const safePrefix = prefix.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 10) || 'perf';
    const username = `${safePrefix}_r_${unique}`.slice(0, 32);
    return makeRequest({
      method: 'POST',
      path: '/api/v1/auth/register',
      body: { username, email: `${username}_${sequence}@example.test`, password },
      userIndex: sequence,
      expect: [201]
    });
  }
  if (scenario === 'login') {
    const userNumber = (sequence % userCount) + 1;
    return loginUser(userNumber, sequence);
  }
  if (scenario === 'auth-me') {
    return makeRequest({ path: '/api/v1/auth/me', headers: { Cookie: state.cookie }, userIndex: workerIndex, expect: [200] });
  }
  if (scenario === 'bank-read') {
    const paths = [
      `/api/v1/banks/${bankId}/items?limit=100`,
      `/api/v1/banks/${bankId}`,
      '/api/v1/banks?scope=all&limit=50',
      `/api/v1/search/questions?bankId=${bankId}&q=synthetic`,
      '/api/v1/analytics/me/summary'
    ];
    return makeRequest({ path: paths[sequence % paths.length], headers: { Cookie: state.cookie }, userIndex: workerIndex, expect: [200] });
  }
  if (scenario === 'practice-read') {
    const session = state.sessions[sequence % state.sessions.length];
    const index = sequence % 20;
    return makeRequest({ path: `/api/v1/practice-sessions/${session.sessionId}/question-page?index=${index}`, headers: { Cookie: session.cookie }, userIndex: session.userIndex, expect: [200] });
  }
  if (scenario === 'practice-mixed') {
    const session = state.sessions[sequence % state.sessions.length];
    const mod = sequence % 10;
    if (mod === 0) {
      return createPracticeSession(session.cookie, session.userIndex, 20);
    }
    if (mod <= 2) {
      return makeRequest({ path: `/api/v1/practice-sessions/${session.sessionId}/questions`, headers: { Cookie: session.cookie }, userIndex: session.userIndex, expect: [200] });
    }
    return makeRequest({ path: `/api/v1/practice-sessions/${session.sessionId}/question-page?index=${sequence % 20}`, headers: { Cookie: session.cookie }, userIndex: session.userIndex, expect: [200] });
  }
  if (scenario === 'db-query') {
    const paths = [
      `/api/v1/search/questions?bankId=${bankId}&q=synthetic`,
      `/api/v1/banks/${bankId}/items?limit=100`,
      '/api/v1/analytics/me/summary',
      `/api/v1/banks/${bankId}`
    ];
    return makeRequest({ path: paths[sequence % paths.length], headers: { Cookie: state.cookie }, userIndex: workerIndex, expect: [200] });
  }
}

function captureCommand(cmd, args) {
  const result = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 });
  return {
    status: result.status,
    stdout: result.stdout?.trim() || '',
    stderr: result.stderr?.trim() || ''
  };
}

function systemSnapshot(label) {
  const ps = captureCommand('ps', ['-eo', 'pid,comm,pcpu,pmem,rss,args', '--sort=-pcpu']);
  const ss = captureCommand('ss', ['-ant']);
  const pgUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
  const pg = pgUrl ? captureCommand('psql', [pgUrl, '-Atc', "select count(*) filter (where state='active') as active, count(*) as total, count(*) filter (where wait_event_type is not null) as waiting from pg_stat_activity where datname=current_database(); select coalesce(round(avg(extract(epoch from now()-query_start)*1000))::int,0) from pg_stat_activity where datname=current_database() and state='active' and query_start is not null;"]) : { status: null, stdout: '', stderr: 'No database URL' };
  const redisUrl = process.env.REDIS_URL || '';
  const redis = redisUrl ? captureCommand('redis-cli', ['-u', redisUrl, 'info', 'clients']) : { status: null, stdout: '', stderr: 'No redis URL' };
  const servicePids = captureServicePids();
  const serviceStats = captureServiceStats(servicePids);
  return {
    label,
    timestamp: new Date().toISOString(),
    loadavg: loadavg(),
    cpuCount: cpus().length,
    memory: { total: totalmem(), free: freemem() },
    topProcesses: ps.stdout.split('\n').slice(0, 16).join('\n'),
    tcpSummary: summarizeTcp(ss.stdout),
    postgres: pg.stdout,
    postgresError: pg.stderr,
    redisClients: redis.stdout.split('\n').filter((line) => /connected_clients|blocked_clients|tracking_clients|maxclients/.test(line)).join('\n'),
    redisError: redis.stderr,
    servicePids,
    serviceStats
  };
}

function captureServicePids() {
  const listeners = captureCommand('ss', ['-ltnp']);
  const pids = { next: [], caddy: [], postgres: [], redis: [] };
  for (const line of listeners.stdout.split('\n')) {
    const pidMatches = [...line.matchAll(/pid=(\d+)/g)].map((match) => Number(match[1]));
    if (line.includes(':3000')) pids.next.push(...pidMatches);
    if (line.includes(':80') || line.includes(':443')) pids.caddy.push(...pidMatches);
    if (line.includes(':5432')) pids.postgres.push(...pidMatches);
    if (line.includes(':6379')) pids.redis.push(...pidMatches);
  }
  // ss may hide PostgreSQL process PIDs for sockets owned by another user; include process-name fallback.
  const all = captureCommand('ps', ['-eo', 'pid,comm,args']);
  for (const line of all.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\S+)\s+(.+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const comm = match[2];
    const args = match[3];
    if (/next-server|next start/.test(args)) pids.next.push(pid);
    if (comm === 'caddy' || /caddy run/.test(args)) pids.caddy.push(pid);
    if (comm === 'postgres' || /^postgres/.test(args)) pids.postgres.push(pid);
    if (comm === 'redis-server' || /redis-server/.test(args)) pids.redis.push(pid);
  }
  return Object.fromEntries(Object.entries(pids).map(([key, values]) => [key, [...new Set(values)].sort((a, b) => a - b)]));
}

function captureServiceStats(servicePids) {
  const stats = {};
  for (const [name, pids] of Object.entries(servicePids)) {
    if (!pids.length) {
      stats[name] = { pids: [], cpu: 0, mem: 0, rss: 0, raw: '' };
      continue;
    }
    const result = captureCommand('ps', ['-p', pids.join(','), '-o', 'pid=,comm=,pcpu=,pmem=,rss=,args=']);
    let cpu = 0;
    let mem = 0;
    let rss = 0;
    for (const line of result.stdout.split('\n')) {
      const match = line.trim().match(/^(\d+)\s+(\S+)\s+([\d.]+)\s+([\d.]+)\s+(\d+)\s+(.+)$/);
      if (!match) continue;
      cpu += Number(match[3]) || 0;
      mem += Number(match[4]) || 0;
      rss += Number(match[5]) || 0;
    }
    stats[name] = { pids, cpu, mem, rss, raw: result.stdout.trim() };
  }
  return stats;
}

function summarizeTcp(text) {
  const counts = {};
  for (const line of text.split('\n')) {
    const state = line.trim().split(/\s+/)[0];
    if (!state || state === 'State') continue;
    counts[state] = (counts[state] || 0) + 1;
  }
  return counts;
}

async function runLoad(state) {
  let stop = false;
  let sequence = 0;
  const results = [];
  const started = performance.now();
  const warmupUntil = started + warmupSec * 1000;
  const stopAt = started + (warmupSec + durationSec) * 1000;
  let maxInFlight = 0;
  let inFlight = 0;

  async function worker(workerIndex) {
    while (!stop) {
      const now = performance.now();
      if (now >= stopAt) break;
      const currentSequence = sequence++;
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const response = await requestForScenario(state, currentSequence, workerIndex);
      inFlight -= 1;
      response.sequence = currentSequence;
      response.workerIndex = workerIndex;
      response.afterWarmup = performance.now() >= warmupUntil;
      if (response.afterWarmup) results.push(response);
    }
  }

  const workers = Array.from({ length: concurrency }, (_, index) => worker(index + 1));
  await Promise.all(workers);
  stop = true;

  return { results, elapsedMs: performance.now() - warmupUntil, maxInFlight };
}

function analyze(results, elapsedMs, maxInFlight, snapshots) {
  const latencies = results.map((item) => item.ms);
  const ok = results.filter((item) => item.ok).length;
  const errors = results.length - ok;
  const byStatus = {};
  const byError = {};
  for (const item of results) {
    byStatus[item.status] = (byStatus[item.status] || 0) + 1;
    if (!item.ok) {
      const key = item.error || `HTTP_${item.status}`;
      byError[key] = (byError[key] || 0) + 1;
    }
  }
  const latency = summarize(latencies);
  return {
    scenario,
    ramp: rampName || undefined,
    baseUrl,
    bankId,
    concurrency,
    durationSec,
    warmupSec,
    requests: results.length,
    ok,
    errors,
    errorRate: results.length ? errors / results.length : 0,
    rps: elapsedMs > 0 ? results.length / (elapsedMs / 1000) : 0,
    maxInFlight,
    latencyMs: Object.fromEntries(Object.entries(latency).map(([key, value]) => [key, typeof value === 'number' ? formatMs(value) : value])),
    byStatus,
    byError,
    snapshots,
    generatedAt: new Date().toISOString()
  };
}

const snapshots = [systemSnapshot('before')];
const state = await setupScenario();
if (includeStatic) {
  await makeRequest({ path: '/', userIndex: 1, expect: [200, 302, 307, 308] });
}
const midTimer = setInterval(() => {
  snapshots.push(systemSnapshot(`during-${snapshots.length}`));
}, Math.max(3000, Math.floor(durationSec * 1000 / 3)));
const { results, elapsedMs, maxInFlight } = await runLoad(state);
clearInterval(midTimer);
snapshots.push(systemSnapshot('after'));
for (const agent of agentByLocalAddress.values()) agent.destroy();

const report = analyze(results, elapsedMs, maxInFlight, snapshots);
const line = [
  `scenario=${scenario}`,
  `c=${concurrency}`,
  `requests=${report.requests}`,
  `rps=${report.rps.toFixed(1)}`,
  `avg=${report.latencyMs.avg}`,
  `p95=${report.latencyMs.p95}`,
  `p99=${report.latencyMs.p99}`,
  `errors=${report.errors}`,
  `errorRate=${(report.errorRate * 100).toFixed(2)}%`,
  `status=${JSON.stringify(report.byStatus)}`
].join(' ');
console.log(line);

if (output) {
  await mkdir(new URL('.', `file://${process.cwd()}/${output}`).pathname, { recursive: true }).catch(() => {});
  await writeFile(output, JSON.stringify(report, null, 2));
}
