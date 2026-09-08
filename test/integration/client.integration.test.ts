/**
 * 协议层端到端测试（PRD 5.3 动作映射表逐行验证）。
 *
 * 对真实 HTTP 服务端跑通 httpClient + client + propfind + path 的协作，
 * 覆盖中文/空格文件名、Depth 头、Destination 绝对 URL、207 逐条判定、降级路径。
 * 这也是 5.6 冒烟用例集的可执行骨架。
 */
import { test, beforeAll, afterAll, beforeEach } from 'vitest';
import assert from 'node:assert/strict';
import { HttpClient } from '../../src/webdav/request.ts';
import { WebdavClient } from '../../src/webdav/client.ts';
import { isWebdavError } from '../../src/webdav/errors.ts';
import { TestWebdavServer, type ServerOptions } from '../helpers/webdavServer.ts';

const AUTH = { username: 'alice', password: 'pw' };

function makeClient(
  baseUrl: string,
  prefix: string,
  overrides: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}
): { dav: WebdavClient; http: HttpClient } {
  const http = new HttpClient({
    baseUrl,
    authType: 'basic',
    ignoreSsl: false,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 10000,
    maxConcurrent: 6,
    getCredentials: async () => AUTH,
    ...overrides,
  });
  return { dav: new WebdavClient(http, prefix, baseUrl), http };
}

async function withServer(
  opts: ServerOptions,
  fn: (dav: WebdavClient, server: TestWebdavServer) => Promise<void>
): Promise<void> {
  const server = new TestWebdavServer({ auth: AUTH, ...opts });
  const baseUrl = await server.start();
  const { dav, http } = makeClient(baseUrl, opts.prefix ?? '/');
  try {
    await fn(dav, server);
  } finally {
    http.dispose();
    await server.stop();
  }
}

// ---- 共享的常规服务端 ----

let server: TestWebdavServer;
let dav: WebdavClient;
let http: HttpClient;

beforeAll(async () => {
  server = new TestWebdavServer({ prefix: '/dav', auth: AUTH });
  const baseUrl = await server.start();
  ({ dav, http } = makeClient(baseUrl, '/dav'));
});

afterAll(async () => {
  http.dispose();
  await server.stop();
});

beforeEach(() => {
  server.requests.length = 0;
});

test('testConnection: 成功并回显服务端信息 (FR-1.3)', async () => {
  const info = await dav.testConnection();
  assert.equal(info.dav, '1,2');
});

test('stat: 目录 (5.3 第 1 行)', async () => {
  server.addDir('/docs');
  const stat = await dav.stat('/docs');
  assert.equal(stat.isDirectory, true);
  // 目录未返回 getcontentlength，须给缺省值（FR-3.1）
  assert.equal(stat.size, 0);
  assert.equal(server.lastRequest()?.headers['depth'], '0');
});

test('stat: 文件含大小与 ETag', async () => {
  server.addFile('/docs/a.txt', 'hello');
  const stat = await dav.stat('/docs/a.txt');
  assert.equal(stat.isDirectory, false);
  assert.equal(stat.size, 5);
  assert.ok(stat.etag);
  assert.ok(stat.mtime > 0);
});

test('stat: 不存在的路径抛 NotFound (FR-4.2)', async () => {
  await assert.rejects(
    () => dav.stat('/nope.txt'),
    (e: unknown) => isWebdavError(e) && e.code === 'NotFound'
  );
});

test('list: Depth:1 且剔除目录自身 (5.3 第 2 行)', async () => {
  server.addDir('/list');
  server.addFile('/list/a.txt', 'a');
  server.addFile('/list/b.txt', 'bb');
  server.addDir('/list/sub');

  const entries = await dav.list('/list');
  assert.equal(server.lastRequest()?.headers['depth'], '1');

  const names = entries.map((e) => e.name).sort();
  assert.deepEqual(names, ['a.txt', 'b.txt', 'sub']);
  // 自身未混入结果
  assert.ok(!names.includes('list'));

  const sub = entries.find((e) => e.name === 'sub');
  assert.equal(sub?.isDirectory, true);
  assert.equal(entries.find((e) => e.name === 'b.txt')?.stat.size, 2);
});

test('中文与空格文件名全链路 (5.3 路径编码规则)', async () => {
  server.addDir('/中文 目录');
  server.addFile('/中文 目录/我的 笔记 (1).md', '内容');

  const entries = await dav.list('/中文 目录');
  assert.deepEqual(entries.map((e) => e.name), ['我的 笔记 (1).md']);

  // 请求行确实是百分号编码的
  const reqPath = server.lastRequest()?.path ?? '';
  assert.ok(reqPath.includes('%E4%B8%AD%E6%96%87%20'), `实际请求路径: ${reqPath}`);

  const read = await dav.read('/中文 目录/我的 笔记 (1).md');
  assert.equal(read.data.toString('utf8'), '内容');

  await dav.write('/中文 目录/新 文件.txt', Buffer.from('x', 'utf8'));
  assert.equal(server.read('/中文 目录/新 文件.txt'), 'x');
});

test('read: GET 返回内容与 ETag (5.3 第 3 行)', async () => {
  server.addFile('/r.txt', 'payload');
  const res = await dav.read('/r.txt');
  assert.equal(res.data.toString('utf8'), 'payload');
  assert.ok(res.etag);
  // ETag 已去掉引号（便于 If-Match 比对）
  assert.ok(!res.etag.includes('"'));
});

test('write: PUT 新建与覆盖 (5.3 第 4 行)', async () => {
  await dav.write('/w.txt', Buffer.from('v1', 'utf8'));
  assert.equal(server.read('/w.txt'), 'v1');

  await dav.write('/w.txt', Buffer.from('v2', 'utf8'));
  assert.equal(server.read('/w.txt'), 'v2');
});

test('write: If-Match 命中与失配 (FR-4.4)', async () => {
  server.addFile('/etag.txt', 'orig');
  const read = await dav.read('/etag.txt');

  // 正确 ETag → 成功
  const newEtag = await dav.write('/etag.txt', Buffer.from('updated', 'utf8'), {
    ifMatch: read.etag!,
  });
  assert.equal(server.read('/etag.txt'), 'updated');
  assert.ok(newEtag);

  // 过期 ETag → 412 PreconditionFailed
  await assert.rejects(
    () => dav.write('/etag.txt', Buffer.from('conflict', 'utf8'), { ifMatch: read.etag! }),
    (e: unknown) => isWebdavError(e) && e.code === 'PreconditionFailed'
  );
});

test('write: 父目录不存在返回 409 → Conflict (5.3 第 4/5 行)', async () => {
  await assert.rejects(
    () => dav.write('/missing-dir/x.txt', Buffer.from('x', 'utf8')),
    (e: unknown) => isWebdavError(e) && e.code === 'Conflict'
  );
});

test('mkcol: 创建目录，父目录缺失时 409 → Conflict (5.3 第 5 行)', async () => {
  await dav.mkcol('/newdir');
  assert.ok(server.has('/newdir'));

  await assert.rejects(
    () => dav.mkcol('/a/b/c'),
    (e: unknown) => isWebdavError(e) && e.code === 'Conflict'
  );
});

test('remove: 目录删除带 Depth: infinity (5.3 第 6 行)', async () => {
  server.addDir('/del');
  server.addFile('/del/a.txt', 'a');
  server.addFile('/del/sub/b.txt', 'b');

  await dav.remove('/del', true);
  assert.equal(server.lastRequest()?.headers['depth'], 'infinity');
  assert.equal(server.has('/del'), false);
  assert.equal(server.has('/del/sub/b.txt'), false);
});

test('move: Destination 是绝对 URL 且已编码 (5.3 第 7 行)', async () => {
  server.addFile('/mv 源.txt', 'data');
  await dav.move('/mv 源.txt', '/mv 目标.txt', true);

  const dest = String(server.lastRequest()?.headers['destination']);
  assert.ok(dest.startsWith('http://127.0.0.1:'), `Destination 必须是绝对 URL: ${dest}`);
  assert.ok(dest.includes('%E7%9B%AE%E6%A0%87'), `Destination 必须编码: ${dest}`);
  assert.equal(server.lastRequest()?.headers['overwrite'], 'T');

  assert.equal(server.has('/mv 源.txt'), false);
  assert.equal(server.read('/mv 目标.txt'), 'data');
});

test('move: Overwrite: F 且目标存在 → 412', async () => {
  server.addFile('/src.txt', 'a');
  server.addFile('/dst.txt', 'b');
  await assert.rejects(
    () => dav.move('/src.txt', '/dst.txt', false),
    (e: unknown) => isWebdavError(e) && e.code === 'PreconditionFailed'
  );
  assert.equal(server.lastRequest()?.headers['overwrite'], 'F');
});

test('copy: COPY 带 Depth: infinity 且源保留 (5.3 第 8 行)', async () => {
  server.addFile('/cp.txt', 'data');
  await dav.copy('/cp.txt', '/cp-copy.txt', true);

  assert.equal(server.lastRequest()?.headers['depth'], 'infinity');
  assert.equal(server.read('/cp.txt'), 'data');
  assert.equal(server.read('/cp-copy.txt'), 'data');
});

test('401 → Unauthorized (FR-4.2)', async () => {
  const bad = new HttpClient({
    baseUrl: `http://127.0.0.1:${server.port}`,
    authType: 'basic',
    ignoreSsl: false,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 5000,
    maxConcurrent: 2,
    getCredentials: async () => ({ username: 'alice', password: 'WRONG' }),
  });
  try {
    const client = new WebdavClient(bad, '/dav', `http://127.0.0.1:${server.port}`);
    await assert.rejects(
      () => client.stat('/'),
      (e: unknown) => isWebdavError(e) && e.code === 'Unauthorized'
    );
  } finally {
    bad.dispose();
  }
});

// ---- 服务端差异场景（风险 R2）----

test('不支持 Depth:0 的服务端：stat 回退到父目录 Depth:1 (5.3 第 1 行约束)', async () => {
  await withServer({ prefix: '/dav', supportDepth0: false }, async (client, srv) => {
    srv.addFile('/fallback/a.txt', 'hello');
    const stat = await client.stat('/fallback/a.txt');
    assert.equal(stat.size, 5);
    assert.equal(stat.isDirectory, false);

    // 确实发生了两次请求：Depth:0 失败后回退 Depth:1
    const depths = srv.requestsOf('PROPFIND').map((r) => r.headers['depth']);
    assert.deepEqual(depths, ['0', '1']);
  });
});

test('href 为绝对 URL 的服务端：解析与剥离前缀均正确', async () => {
  await withServer({ prefix: '/dav', hrefStyle: 'url' }, async (client, srv) => {
    srv.addDir('/u');
    srv.addFile('/u/文件.txt', 'x');
    const entries = await client.list('/u');
    assert.deepEqual(entries.map((e) => e.name), ['文件.txt']);
  });
});

test('无路径前缀的服务端（prefix=/）', async () => {
  await withServer({ prefix: '' }, async (client, srv) => {
    srv.addFile('/root.txt', 'r');
    const entries = await client.list('/');
    assert.ok(entries.some((e) => e.name === 'root.txt'));
    assert.equal((await client.read('/root.txt')).data.toString(), 'r');
  });
});

test('不支持 COPY 的服务端返回 405 → NotSupported，供上层降级 (FR-3.8)', async () => {
  await withServer({ prefix: '/dav', supportCopy: false }, async (client, srv) => {
    srv.addFile('/c.txt', 'data');
    await assert.rejects(
      () => client.copy('/c.txt', '/c2.txt', true),
      (e: unknown) => isWebdavError(e) && e.code === 'NotSupported'
    );
  });
});

test('并发上限生效：maxConcurrent=2 时在途请求不超过 2 (NFR-1.3)', async () => {
  const srv = new TestWebdavServer({ prefix: '/dav' });
  const baseUrl = await srv.start();
  for (let i = 0; i < 12; i++) srv.addFile(`/f${i}.txt`, String(i));

  let inflight = 0;
  let peak = 0;
  const original = srv.requests.push.bind(srv.requests);
  // 通过包裹响应时机观察并发；此处用请求计数近似
  const { dav: client, http: h } = makeClient(baseUrl, '/dav', {
    getCredentials: async () => {
      inflight += 1;
      peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 15));
      inflight -= 1;
      return AUTH;
    },
    maxConcurrent: 2,
  });
  void original;

  try {
    await Promise.all(Array.from({ length: 12 }, (_, i) => client.read(`/f${i}.txt`)));
    assert.ok(peak <= 2, `峰值并发 ${peak} 超过上限 2`);
  } finally {
    h.dispose();
    await srv.stop();
  }
});

test('连接被拒绝 → NetworkError 而非挂起 (FR-4.2)', async () => {
  const h = new HttpClient({
    baseUrl: 'http://127.0.0.1:1',
    authType: 'none',
    ignoreSsl: false,
    connectTimeoutMs: 2000,
    requestTimeoutMs: 2000,
    maxConcurrent: 1,
    getCredentials: async () => undefined,
  });
  try {
    const client = new WebdavClient(h, '/', 'http://127.0.0.1:1');
    await assert.rejects(
      () => client.stat('/'),
      (e: unknown) => isWebdavError(e) && e.code === 'NetworkError'
    );
  } finally {
    h.dispose();
  }
});
