/**
 * 代理端到端测试（PRD FR-1.6 / T-3.5）。
 *
 * 起一个真实的 HTTP 代理（含 CONNECT 隧道支持），验证：
 *   - 明文目标经代理时用 absolute-form 请求行；
 *   - TLS 目标经代理时走 CONNECT 隧道并完成握手；
 *   - Proxy-Authorization 正确送达；
 *   - no_proxy 命中时绕过代理直连。
 *
 * 自研代理层的价值全在这些分支上——不测就等于没做（依赖红线换来的是调试自由度，
 * 不是省掉验证）。
 */
import { afterAll, beforeAll, expect, test } from 'vitest';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as tls from 'tls';
import type { AddressInfo } from 'net';
import { execFileSync } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { HttpClient } from '../../src/webdav/request.ts';
import { WebdavClient } from '../../src/webdav/client.ts';
import { TestWebdavServer } from '../helpers/webdavServer.ts';

// ---- 一个最小 HTTP 代理，记录经过它的请求 ----

interface ProxyLog {
  absoluteFormRequests: string[];
  connectTargets: string[];
  proxyAuth: (string | undefined)[];
}

function startProxy(requireAuth?: string): Promise<{
  port: number;
  log: ProxyLog;
  close: () => Promise<void>;
}> {
  const log: ProxyLog = { absoluteFormRequests: [], connectTargets: [], proxyAuth: [] };

  const server = http.createServer((req, res) => {
    log.absoluteFormRequests.push(req.url ?? '');
    log.proxyAuth.push(req.headers['proxy-authorization'] as string | undefined);

    if (requireAuth && req.headers['proxy-authorization'] !== requireAuth) {
      res.writeHead(407, { 'Proxy-Authenticate': 'Basic realm="proxy"' }).end();
      return;
    }

    // absolute-form：URL 必须是完整的，据此转发
    let target: URL;
    try {
      target = new URL(req.url ?? '');
    } catch {
      res.writeHead(400).end('expected absolute-form request URI');
      return;
    }

    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      }
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });

  // CONNECT 隧道
  server.on('connect', (req, clientSocket, head) => {
    log.connectTargets.push(req.url ?? '');
    log.proxyAuth.push(req.headers['proxy-authorization'] as string | undefined);

    if (requireAuth && req.headers['proxy-authorization'] !== requireAuth) {
      clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      return;
    }

    const [host, port] = (req.url ?? '').split(':');
    const upstream = net.connect({ host: host!, port: Number(port) }, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.address() as AddressInfo).port,
        log,
        close: () =>
          new Promise<void>((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}

// ---- 自签名 TLS 版 WebDAV 服务端（验证 CONNECT + TLS 握手）----

function selfSignedCert(): { key: string; cert: string } {
  // 用 openssl 现场生成，避免把证书 material 提交进仓库。使用临时文件而不是
  // /dev/stdout，兼容 GitHub Runner、Windows 与受限沙箱环境。
  const directory = mkdtempSync(join(tmpdir(), 'webdav-edit-cert-'));
  const keyPath = join(directory, 'key.pem');
  const certPath = join(directory, 'cert.pem');

  try {
    execFileSync(
      'openssl',
      [
        'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
        '-subj', '/CN=127.0.0.1',
        '-addext', 'subjectAltName=IP:127.0.0.1',
        '-keyout', keyPath, '-out', certPath,
      ],
      { stdio: ['ignore', 'ignore', 'ignore'] }
    );
    return {
      key: readFileSync(keyPath, 'utf8'),
      cert: readFileSync(certPath, 'utf8'),
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

let origin: TestWebdavServer;
let originUrl: string;

beforeAll(async () => {
  origin = new TestWebdavServer({ prefix: '/dav' });
  originUrl = await origin.start();
  origin.addFile('/hello.txt', 'via proxy');
});

afterAll(async () => {
  await origin.stop();
});

test('明文目标经代理：使用 absolute-form 请求行', async () => {
  const proxy = await startProxy();
  const http1 = new HttpClient({
    baseUrl: originUrl,
    authType: 'none',
    ignoreSsl: false,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 10000,
    maxConcurrent: 4,
    getCredentials: async () => undefined,
    proxy: `http://127.0.0.1:${proxy.port}`,
  });
  try {
    const dav = new WebdavClient(http1, '/dav', originUrl);
    expect((await dav.read('/hello.txt')).data.toString()).toBe('via proxy');
    // 代理确实收到了完整 URL，而不是 origin-form 的 /dav/hello.txt
    expect(proxy.log.absoluteFormRequests.some((u) => u.startsWith('http://'))).toBe(true);
  } finally {
    http1.dispose();
    await proxy.close();
  }
});

test('明文目标经代理：Proxy-Authorization 正确送达（407 场景）', async () => {
  const expected = 'Basic ' + Buffer.from('alice:pw').toString('base64');
  const proxy = await startProxy(expected);

  // 凭据正确 → 通过
  const ok = new HttpClient({
    baseUrl: originUrl,
    authType: 'none',
    ignoreSsl: false,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 10000,
    maxConcurrent: 2,
    getCredentials: async () => undefined,
    proxy: `http://alice:pw@127.0.0.1:${proxy.port}`,
  });
  try {
    const dav = new WebdavClient(ok, '/dav', originUrl);
    expect((await dav.read('/hello.txt')).data.toString()).toBe('via proxy');
    expect(proxy.log.proxyAuth).toContain(expected);
  } finally {
    ok.dispose();
    await proxy.close();
  }
});

test('no_proxy 命中时绕过代理直连', async () => {
  const proxy = await startProxy();
  const client = new HttpClient({
    baseUrl: originUrl,
    authType: 'none',
    ignoreSsl: false,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 10000,
    maxConcurrent: 2,
    getCredentials: async () => undefined,
    proxy: `http://127.0.0.1:${proxy.port}`,
    noProxy: '127.0.0.1',
  });
  try {
    const dav = new WebdavClient(client, '/dav', originUrl);
    expect((await dav.read('/hello.txt')).data.toString()).toBe('via proxy');
    // 绕过生效：代理不应看到任何请求
    expect(proxy.log.absoluteFormRequests).toHaveLength(0);
    expect(proxy.log.connectTargets).toHaveLength(0);
  } finally {
    client.dispose();
    await proxy.close();
  }
});

test('TLS 目标经代理：走 CONNECT 隧道并完成握手', async () => {
  const { key, cert } = selfSignedCert();

  // 一个最小 HTTPS 端点，够验证隧道打通即可
  const tlsServer = https.createServer({ key, cert }, (_req, res) => {
    // 不手写 Content-Length：写错长度会让多余字节留在 keep-alive 连接上，
    // 污染下一次响应解析（表现为 HPE_INVALID_CONSTANT，且极难定位到源头）。
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('tunnel');
  });
  await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r));
  const tlsPort = (tlsServer.address() as AddressInfo).port;

  const proxy = await startProxy();
  const client = new HttpClient({
    baseUrl: `https://127.0.0.1:${tlsPort}`,
    authType: 'none',
    // 自签名证书：按连接放行（NFR-2.3），不动全局 TLS 开关
    ignoreSsl: true,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 10000,
    maxConcurrent: 2,
    getCredentials: async () => undefined,
    proxy: `http://127.0.0.1:${proxy.port}`,
  });

  try {
    const res = await client.request({ method: 'GET', encodedPath: '/', context: 'tunnel' });
    expect(res.status).toBe(200);
    // 关键断言：确实走了 CONNECT，而不是明文转发
    expect(proxy.log.connectTargets).toContain(`127.0.0.1:${tlsPort}`);
    expect(proxy.log.absoluteFormRequests).toHaveLength(0);
  } finally {
    client.dispose();
    await proxy.close();
    await new Promise<void>((r) => tlsServer.close(() => r()));
  }
});

test('自签名证书在 ignoreSsl=false 时经隧道仍应被拒（NFR-2.3 不被代理绕过）', async () => {
  const { key, cert } = selfSignedCert();
  const tlsServer = https.createServer({ key, cert }, (_req, res) => res.end('x'));
  await new Promise<void>((r) => tlsServer.listen(0, '127.0.0.1', r));
  const tlsPort = (tlsServer.address() as AddressInfo).port;

  const proxy = await startProxy();
  const client = new HttpClient({
    baseUrl: `https://127.0.0.1:${tlsPort}`,
    authType: 'none',
    ignoreSsl: false,
    connectTimeoutMs: 5000,
    requestTimeoutMs: 10000,
    maxConcurrent: 2,
    getCredentials: async () => undefined,
    proxy: `http://127.0.0.1:${proxy.port}`,
  });

  try {
    await expect(
      client.request({ method: 'GET', encodedPath: '/', context: 'tunnel' })
    ).rejects.toThrow();
  } finally {
    client.dispose();
    await proxy.close();
    await new Promise<void>((r) => tlsServer.close(() => r()));
  }
});

// 保持对 tls 模块的引用，避免 lint 误判未使用
void tls;
