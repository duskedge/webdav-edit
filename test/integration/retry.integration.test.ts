/**
 * 401 重认证与幂等重试（PRD FR-1.2、FR-4.2 / 开发计划 T-3.3）。
 *
 * 两条行为要证明：
 *   - 401 时给上层**一次**刷新凭据的机会，成功即重发；失败则把 401 交回，
 *     由上层做一次性引导而非反复弹窗。
 *   - 只有幂等方法自动重试；PUT 绝不自动重试——重试可能覆盖他人在此期间的写入。
 */
import { expect, test } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { HttpClient } from '../../src/webdav/request.ts';

interface Stub {
  url: string;
  hits: string[];
  close: () => Promise<void>;
}

/** 起一个可编程的最小服务端：按调用次序返回预设状态码。 */
async function stub(
  plan: (n: number, method: string) => { status: number; body?: string }
): Promise<Stub> {
  const hits: string[] = [];
  const server = http.createServer((req, res) => {
    hits.push(`${req.method} ${req.url}`);
    const { status, body } = plan(hits.length, req.method ?? '');
    res.writeHead(status, status === 401 ? { 'WWW-Authenticate': 'Basic realm="x"' } : {});
    res.end(body ?? '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function client(
  url: string,
  extra: Partial<ConstructorParameters<typeof HttpClient>[0]> = {}
): HttpClient {
  return new HttpClient({
    baseUrl: url,
    authType: 'basic',
    ignoreSsl: false,
    connectTimeoutMs: 3000,
    requestTimeoutMs: 5000,
    maxConcurrent: 4,
    getCredentials: async () => ({ username: 'u', password: 'p' }),
    ...extra,
  });
}

test('401 → 重认证钩子返回 true 时重发一次并成功', async () => {
  const s = await stub((n) => (n === 1 ? { status: 401 } : { status: 200, body: 'ok' }));
  let calls = 0;
  const c = client(s.url, {
    onUnauthorized: async () => {
      calls += 1;
      return true;
    },
  });
  try {
    const res = await c.request({ method: 'GET', encodedPath: '/a' });
    expect(res.status).toBe(200);
    expect(calls).toBe(1);
    expect(s.hits).toHaveLength(2);
  } finally {
    c.dispose();
    await s.close();
  }
});

test('401 → 钩子返回 false 时把 401 交回上层，不再重试', async () => {
  const s = await stub(() => ({ status: 401 }));
  let calls = 0;
  const c = client(s.url, {
    onUnauthorized: async () => {
      calls += 1;
      return false;
    },
  });
  try {
    const res = await c.request({ method: 'GET', encodedPath: '/a' });
    expect(res.status).toBe(401);
    expect(calls).toBe(1);
    // 只发了首个请求，没有因 401 而反复重发
    expect(s.hits).toHaveLength(1);
  } finally {
    c.dispose();
    await s.close();
  }
});

test('未提供重认证钩子时，401 原样返回', async () => {
  const s = await stub(() => ({ status: 401 }));
  const c = client(s.url);
  try {
    expect((await c.request({ method: 'GET', encodedPath: '/a' })).status).toBe(401);
    expect(s.hits).toHaveLength(1);
  } finally {
    c.dispose();
    await s.close();
  }
});

test('并发 401 只触发一次重认证，避免多个弹窗', async () => {
  const s = await stub((_n, m) => (m === 'GET' ? { status: 401 } : { status: 200 }));
  let calls = 0;
  const c = client(s.url, {
    onUnauthorized: async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 30));
      return false;
    },
  });
  try {
    await Promise.all([
      c.request({ method: 'GET', encodedPath: '/a' }),
      c.request({ method: 'GET', encodedPath: '/b' }),
      c.request({ method: 'GET', encodedPath: '/c' }),
    ]);
    expect(calls).toBe(1);
  } finally {
    c.dispose();
    await s.close();
  }
});

test('幂等请求遇 5xx 自动重试并最终成功', async () => {
  const s = await stub((n) => (n < 3 ? { status: 503 } : { status: 200, body: 'ok' }));
  const c = client(s.url, { maxRetries: 2 });
  try {
    expect((await c.request({ method: 'GET', encodedPath: '/a' })).status).toBe(200);
    expect(s.hits).toHaveLength(3);
  } finally {
    c.dispose();
    await s.close();
  }
});

test('PUT 遇 5xx 绝不自动重试（可能覆盖他人写入）', async () => {
  const s = await stub(() => ({ status: 503 }));
  const c = client(s.url, { maxRetries: 3 });
  try {
    // 传输层返回响应本身，状态码→异常的转换是 client.ts 的职责
    const res = await c.request({ method: 'PUT', encodedPath: '/a', body: 'x' });
    expect(res.status).toBe(503);
    expect(s.hits).toHaveLength(1);
  } finally {
    c.dispose();
    await s.close();
  }
});

test('MOVE / DELETE / MKCOL 同样不自动重试', async () => {
  for (const method of ['MOVE', 'DELETE', 'MKCOL', 'COPY']) {
    const s = await stub(() => ({ status: 503 }));
    const c = client(s.url, { maxRetries: 3 });
    try {
      expect((await c.request({ method, encodedPath: '/a' })).status).toBe(503);
      expect(s.hits, `${method} 不应重试`).toHaveLength(1);
    } finally {
      c.dispose();
      await s.close();
    }
  }
});

test('501 不重试（应走降级路径而非重试）', async () => {
  const s = await stub(() => ({ status: 501 }));
  const c = client(s.url, { maxRetries: 3 });
  try {
    expect((await c.request({ method: 'GET', encodedPath: '/a' })).status).toBe(501);
    expect(s.hits).toHaveLength(1);
  } finally {
    c.dispose();
    await s.close();
  }
});

test('429 视为瞬时状态，幂等请求会重试', async () => {
  const s = await stub((n) => (n < 2 ? { status: 429 } : { status: 200, body: 'ok' }));
  const c = client(s.url, { maxRetries: 2 });
  try {
    expect((await c.request({ method: 'GET', encodedPath: '/a' })).status).toBe(200);
    expect(s.hits).toHaveLength(2);
  } finally {
    c.dispose();
    await s.close();
  }
});

test('不可重试的错误（404）立即返回，不浪费退避时间', async () => {
  const s = await stub(() => ({ status: 404 }));
  const c = client(s.url, { maxRetries: 3 });
  try {
    const started = Date.now();
    expect((await c.request({ method: 'GET', encodedPath: '/a' })).status).toBe(404);
    expect(s.hits).toHaveLength(1);
    expect(Date.now() - started).toBeLessThan(500);
  } finally {
    c.dispose();
    await s.close();
  }
});

test('maxRetries=0 时禁用重试', async () => {
  const s = await stub(() => ({ status: 503 }));
  const c = client(s.url, { maxRetries: 0 });
  try {
    expect((await c.request({ method: 'GET', encodedPath: '/a' })).status).toBe(503);
    expect(s.hits).toHaveLength(1);
  } finally {
    c.dispose();
    await s.close();
  }
});
