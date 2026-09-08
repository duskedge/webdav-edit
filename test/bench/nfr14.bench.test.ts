/**
 * NFR-1.4 五项性能指标验证（开发计划 T-3.7）。
 *
 * | 场景 | 指标 |
 * | 含 1000 个条目的目录首次展开 | P95 < 2s |
 * | 缓存命中的 stat | P95 < 100ms（不产生网络请求）|
 * | 打开 1MB 文本文件 | P95 < 1.5s |
 * | 保存 5MB 文件 | P95 < 3s |
 * | 扩展激活到 provider 注册完成 | < 50ms（不含网络与 SecretStorage）|
 *
 * 最后一项由 scripts/check-activation.mjs 在静态层面守住（注册前无 await），
 * 这里验证前四项。
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import { HttpClient } from '../../src/webdav/request.ts';
import { WebdavClient } from '../../src/webdav/client.ts';
import { MetadataCache } from '../../src/fs/cache.ts';
import { TestWebdavServer } from '../helpers/webdavServer.ts';

const ITERATIONS = Number(process.env['BENCH_ITERATIONS'] ?? 20);
const REMOTE_HOST = process.env['DAV_HOST'];

/** 对本地内存服务端而言，NFR-1.4 的绝对阈值毫无挑战性；收紧以便发现回归。 */
const LOCAL_SCALE = REMOTE_HOST ? 1 : 0.25;

interface Timing {
  p50: number;
  p95: number;
  max: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx]!;
}

async function measure(n: number, fn: (i: number) => Promise<unknown>): Promise<Timing> {
  const samples: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  samples.sort((a, b) => a - b);
  return { p50: percentile(samples, 50), p95: percentile(samples, 95), max: samples[samples.length - 1]! };
}

const report: Array<{
  name: string;
  timing: Timing;
  budget: number;
  /** 该场景在实测带宽下的理论下限（毫秒）。仅传输类场景有意义。 */
  floor?: number;
}> = [];

function record(name: string, timing: Timing, budget: number, bytes?: number): void {
  report.push({
    name,
    timing,
    budget,
    ...(bytes !== undefined && measuredMbps > 0
      ? { floor: (bytes * 8) / (measuredMbps * 1e6) * 1000 }
      : {}),
  });
}

/**
 * 实测有效带宽（Mbps）。
 *
 * 没有它，一条超预算的结果无法区分「代码慢」与「网络就这么快」——
 * 而这两者的处置完全相反：前者要优化实现，后者要么换环境、要么修订指标。
 */
let measuredMbps = 0;

async function measureBandwidth(): Promise<number> {
  if (!REMOTE_HOST) return 0;
  try {
    // 取多次采样的**中位数**，不取单次或最优值。
    // 实测该链路 RTT 27–103ms、抖动 31ms，单样本会系统性偏乐观
    // （单样本 6.8 Mbps vs 20MB 持续传输 3.8 Mbps，差 1.8 倍），
    // 据此算出的「理论下限」会把环境问题误判成实现问题。
    const samples: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const res = await dav.read(ONE_MB);
      const seconds = (performance.now() - t0) / 1000;
      samples.push((res.data.length * 8) / seconds / 1e6);
    }
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)]!;
  } catch {
    return 0;
  }
}

let server: TestWebdavServer | undefined;
let dav: WebdavClient;
let http: HttpClient;

/** 真机模式下的固定装置路径（由 docker/seed 与基准准备步骤创建）。 */
const BIG_DIR = REMOTE_HOST ? '/bench-1000' : '/big';
const ONE_MB = REMOTE_HOST ? '/bench-1mb.txt' : '/one-mb.txt';
const WRITE_DIR = REMOTE_HOST ? '/bench-write' : '';

beforeAll(async () => {
  if (REMOTE_HOST) {
    // 正式基线：对真实 Nextcloud 跑，走真实局域网（NFR-1.4 的定义环境）
    const user = process.env['DAV_USER'] ?? 'davtest';
    const pass = process.env['DAV_PASS'] ?? 'davtest-pw';
    const baseUrl = `http://${REMOTE_HOST}:8081`;
    http = new HttpClient({
      baseUrl,
      authType: 'basic',
      ignoreSsl: false,
      connectTimeoutMs: 10_000,
      requestTimeoutMs: 120_000,
      maxConcurrent: 6,
      getCredentials: async () => ({ username: user, password: pass }),
    });
    dav = new WebdavClient(http, `/remote.php/dav/files/${user}`, baseUrl);
    await dav.mkcol(WRITE_DIR).catch(() => undefined);
    return;
  }

  server = new TestWebdavServer({ prefix: '/dav' });
  const baseUrl = await server.start();
  http = new HttpClient({
    baseUrl,
    authType: 'none',
    ignoreSsl: false,
    connectTimeoutMs: 10_000,
    requestTimeoutMs: 60_000,
    maxConcurrent: 6,
    getCredentials: async () => undefined,
  });
  dav = new WebdavClient(http, '/dav', baseUrl);

  // 1000 条目的目录
  server.addDir('/big');
  for (let i = 0; i < 1000; i++) {
    server.addFile(`/big/file-${String(i).padStart(4, '0')}.txt`, 'x');
  }
  server.addFile('/one-mb.txt', 'a'.repeat(1024 * 1024));
}, 300_000);

afterAll(async () => {
  if (REMOTE_HOST) await dav.remove(WRITE_DIR, true).catch(() => undefined);
  http.dispose();
  await server?.stop();

  const lines = [
    '',
    '=== NFR-1.4 性能基准 ===',
    REMOTE_HOST
      ? `环境：真机 ${REMOTE_HOST}（正式基线）`
      : '环境：本地内存服务端（⚠ 数字偏乐观，仅用于回归比较）',
    `采样：${ITERATIONS} 次`,
    measuredMbps > 0
      ? `实测有效带宽：${measuredMbps.toFixed(1)} Mbps` +
        `（NFR-1.4 定义环境为 100 Mbps，当前约 ${((measuredMbps / 100) * 100).toFixed(0)}%）`
      : '',
    '',
    '| 场景 | P50 | P95 | 预算 | 理论下限 | 结论 |',
    '| :--- | ---: | ---: | ---: | ---: | :--- |',
    ...report.map((r) => {
      const pass = r.timing.p95 < r.budget;
      // 预算低于当前带宽的理论下限 → 再快的实现也达不到，是环境问题
      const envLimited = !pass && r.floor !== undefined && r.floor > r.budget;
      const verdict = pass ? '✅' : envLimited ? '⚠ 环境受限' : '❌ 需优化实现';
      return (
        `| ${r.name} | ${r.timing.p50.toFixed(1)}ms | ${r.timing.p95.toFixed(1)}ms | ` +
        `${r.budget}ms | ${r.floor !== undefined ? r.floor.toFixed(0) + 'ms' : '—'} | ${verdict} |`
      );
    }),
    '',
    ...(report.some((r) => r.floor !== undefined && r.floor > r.budget && r.timing.p95 >= r.budget)
      ? [
          '> ⚠ 标注「环境受限」的项：其**理论下限已超出预算**，说明在当前带宽下',
          '> 任何实现都无法达标，不是代码缺陷。需在 NFR-1.4 定义的 100 Mbps 环境',
          '> 复测，或据实修订该指标。',
          '',
        ]
      : []),
  ];
  // vitest 会捕获 console.*，基准报告必须直接写 stdout 才看得到
  process.stdout.write(lines.join('\n') + '\n');
});

test('⓪ 测量有效带宽（用于区分「环境受限」与「实现待优化」）', async () => {
  measuredMbps = await measureBandwidth();
  if (REMOTE_HOST) expect(measuredMbps).toBeGreaterThan(0);
}, 120_000);

test('① 含 1000 个条目的目录首次展开 P95 < 2s', async () => {
  const budget = 2000 * LOCAL_SCALE;
  const timing = await measure(Math.min(ITERATIONS, 10), async () => {
    const entries = await dav.list(BIG_DIR);
    expect(entries).toHaveLength(1000);
  });
  record('1000 条目目录展开', timing, budget);
  expect(timing.p95).toBeLessThan(budget);
}, 120_000);

test('② 缓存命中的 stat P95 < 100ms 且不产生网络请求', async () => {
  const cache = new MetadataCache(30);
  const entries = await dav.list(BIG_DIR);
  cache.setChildren('conn', BIG_DIR, entries);

  const before = server?.requests.length ?? 0;
  const timing = await measure(ITERATIONS * 10, (i) => {
    const name = entries[i % entries.length]!.name;
    const hit = cache.getStat('conn', `${BIG_DIR}/${name}`);
    expect(hit).toBeDefined();
    return Promise.resolve();
  });

  // 关键断言：缓存命中期间一个请求都不该发出（NFR-1.1）
  if (server) expect(server.requests.length).toBe(before);
  record('缓存命中 stat', timing, 100);
  expect(timing.p95).toBeLessThan(100);
});

test('③ 打开 1MB 文本文件 P95 < 1.5s', async () => {
  const budget = 1500 * LOCAL_SCALE;
  const timing = await measure(Math.min(ITERATIONS, 10), async () => {
    const res = await dav.read(ONE_MB);
    expect(res.data.length).toBe(1024 * 1024);
  });
  record('读取 1MB 文件', timing, budget, 1024 * 1024);
  expect(timing.p95).toBeLessThan(budget);
}, 120_000);

test('④ 保存 5MB 文件 P95 < 3s', async () => {
  const budget = 3000 * LOCAL_SCALE;
  const body = Buffer.alloc(5 * 1024 * 1024, 0x61);
  const timing = await measure(Math.min(ITERATIONS, 8), async (i) => {
    await dav.write(REMOTE_HOST ? `${WRITE_DIR}/b-${i}.bin` : `/bench-${i}.bin`, body);
  });
  record('保存 5MB 文件', timing, budget, 5 * 1024 * 1024);
  expect(timing.p95).toBeLessThan(budget);
}, 120_000);

test('⑤ readDirectory 回填后逐个 stat 不再产生网络请求（NFR-1.1 验收）', async () => {
  const cache = new MetadataCache(30);
  const entries = await dav.list(BIG_DIR);
  cache.setChildren('conn', BIG_DIR, entries);

  const before = server?.requests.length ?? 0;
  for (const e of entries) {
    expect(cache.getStat('conn', `${BIG_DIR}/${e.name}`)).toBeDefined();
  }
  if (server) expect(server.requests.length - before).toBe(0);
});
