/**
 * 重定向跟随（真机实测发现：Apache mod_dav 对无尾斜杠的集合 URL 返回 301）。
 *
 * 这个缺陷只有对真实服务端跑才暴露得出来——Nextcloud 对无尾斜杠的 PROPFIND
 * 直接返回 207，而 Apache 返回 301。不跟随重定向会让所有 Apache/mod_dav
 * 用户完全无法使用。
 *
 * 安全约束同样在此固化：跨源重定向绝不跟随，否则 Authorization 头会被
 * 发送给另一台主机（NFR-2.1）。
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { HttpClient } from '../../src/webdav/request.ts';
import { WebdavClient } from '../../src/webdav/client.ts';

interface Srv {
  url: string;
  port: number;
  hits: Array<{ method: string; path: string; auth?: string }>;
  close: () => Promise<void>;
}

/** 模拟 Apache：集合 URL 无尾斜杠时 301 到带斜杠的版本。 */
async function apacheLike(redirectTo?: (host: string) => string): Promise<Srv> {
  const hits: Srv['hits'] = [];
  const server = http.createServer((req, res) => {
    const path = req.url ?? '';
    hits.push({
      method: req.method ?? '',
      path,
      ...(req.headers['authorization']
        ? { auth: String(req.headers['authorization']) }
        : {}),
    });

    // 集合路径缺尾斜杠 → 301（Apache mod_dav 的真实行为）
    if (path === '/dav') {
      const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
      res.writeHead(301, {
        Location: redirectTo ? redirectTo(host) : `http://${host}/dav/`,
      });
      res.end();
      return;
    }

    if (req.method === 'PROPFIND' && path === '/dav/') {
      const body =
        '<?xml version="1.0"?><D:multistatus xmlns:D="DAV:">' +
        '<D:response><D:href>/dav/</D:href><D:propstat><D:prop>' +
        '<D:resourcetype><D:collection/></D:resourcetype></D:prop>' +
        '<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>' +
        '</D:multistatus>';
      res.writeHead(207, { 'Content-Type': 'application/xml' });
      res.end(body);
      return;
    }

    res.writeHead(404).end();
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    hits,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}

function client(url: string): HttpClient {
  return new HttpClient({
    baseUrl: url,
    authType: 'basic',
    ignoreSsl: false,
    connectTimeoutMs: 3000,
    requestTimeoutMs: 5000,
    maxConcurrent: 4,
    getCredentials: async () => ({ username: 'u', password: 'p' }),
  });
}

// ---- 一台「外部」主机，用于验证跨源不跟随 ----
let evil: { url: string; hits: number; close: () => Promise<void> };

beforeAll(async () => {
  let hits = 0;
  const server = http.createServer((_req, res) => {
    hits += 1;
    res.writeHead(207).end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as AddressInfo).port;
  evil = {
    url: `http://127.0.0.1:${port}`,
    get hits() {
      return hits;
    },
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  } as typeof evil;
});

afterAll(async () => {
  await evil.close();
});

test('Apache 风格 301（补尾斜杠）被正确跟随', async () => {
  const srv = await apacheLike();
  const c = client(srv.url);
  try {
    const dav = new WebdavClient(c, '/dav', srv.url);
    const stat = await dav.stat('/');
    expect(stat.isDirectory).toBe(true);

    // 确实发生了两跳：先 /dav 得 301，再 /dav/ 得 207
    expect(srv.hits.map((h) => h.path)).toEqual(['/dav', '/dav/']);
  } finally {
    c.dispose();
    await srv.close();
  }
});

test('重定向后保持原方法（不得把 PROPFIND 降级为 GET）', async () => {
  const srv = await apacheLike();
  const c = client(srv.url);
  try {
    const dav = new WebdavClient(c, '/dav', srv.url);
    await dav.stat('/');
    expect(srv.hits.every((h) => h.method === 'PROPFIND')).toBe(true);
  } finally {
    c.dispose();
    await srv.close();
  }
});

test('重定向后仍携带认证头（否则第二跳会 401）', async () => {
  const srv = await apacheLike();
  const c = client(srv.url);
  try {
    const dav = new WebdavClient(c, '/dav', srv.url);
    await dav.stat('/');
    expect(srv.hits).toHaveLength(2);
    expect(srv.hits[1]!.auth).toBeDefined();
  } finally {
    c.dispose();
    await srv.close();
  }
});

test('跨源重定向绝不跟随——Authorization 不得发往其他主机', async () => {
  const before = evil.hits;
  const srv = await apacheLike(() => `${evil.url}/stolen`);
  const c = client(srv.url);
  try {
    const dav = new WebdavClient(c, '/dav', srv.url);
    // 跨源时把 3xx 交回上层，表现为一个非 207 的错误
    await expect(dav.stat('/')).rejects.toThrow();
    // 关键断言：外部主机一个请求都不应收到
    expect(evil.hits).toBe(before);
  } finally {
    c.dispose();
    await srv.close();
  }
});

test('重定向循环在跳数用尽后报错，不无限循环', async () => {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits += 1;
    const port = (server.address() as AddressInfo).port;
    // 永远重定向到另一个路径，制造循环
    res.writeHead(301, {
      Location: `http://127.0.0.1:${port}${req.url === '/a' ? '/b' : '/a'}`,
    });
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const c = client(url);

  try {
    const dav = new WebdavClient(c, '/a', url);
    await expect(dav.stat('/')).rejects.toThrow(/重定向次数过多/);
    // 有上限，不会打爆服务端
    expect(hits).toBeLessThanOrEqual(5);
  } finally {
    c.dispose();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('相对 Location 也能正确解析', async () => {
  const srv = await apacheLike(() => '/dav/');
  const c = client(srv.url);
  try {
    const dav = new WebdavClient(c, '/dav', srv.url);
    expect((await dav.stat('/')).isDirectory).toBe(true);
  } finally {
    c.dispose();
    await srv.close();
  }
});
