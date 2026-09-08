/**
 * HTTP(S) 代理支持（PRD FR-1.6 / 开发计划 T-3.5）。
 *
 * 自研而非引入 `proxy-agent`：开发计划 §1 的依赖红线要求运行时依赖仅
 * `fast-xml-parser`。所需能力其实很小——两种情形：
 *
 *   - **明文目标**：直接连代理，请求行用 absolute-form（`GET http://host/p`）。
 *   - **TLS 目标**：先 `CONNECT host:port` 建隧道，再在返回的 socket 上做 TLS 握手。
 *
 * 不依赖 `vscode`，可脱离扩展宿主单测（NFR-4.1）。
 */
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import type * as stream from 'stream';
import * as tls from 'tls';
import { URL } from 'url';

export interface ProxySettings {
  /** 形如 `http://proxy.corp:8080` 或 `http://user:pw@proxy.corp:8080`。 */
  url: string;
  /** 目标为 HTTPS 时是否校验目标证书（与连接的 ignoreSsl 一致）。 */
  rejectUnauthorized: boolean;
  /** 与直连保持一致的连接上限（NFR-1.3）。 */
  maxSockets: number;
  timeoutMs: number;
}

export interface ParsedProxy {
  host: string;
  port: number;
  /** 预先算好的 `Proxy-Authorization` 头，无凭据时为 undefined。 */
  auth?: string;
}

/** 解析代理 URL。非法或空值返回 undefined（视为不使用代理）。 */
export function parseProxyUrl(raw: string | undefined): ParsedProxy | undefined {
  if (!raw || !raw.trim()) return undefined;
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (!url.hostname) return undefined;

  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return undefined;

  const parsed: ParsedProxy = { host: url.hostname, port };
  if (url.username) {
    const raw64 = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
    parsed.auth = 'Basic ' + Buffer.from(raw64, 'utf8').toString('base64');
  }
  return parsed;
}

/**
 * 判断目标主机是否应绕过代理（遵循 `no_proxy` 惯例）。
 * 支持 `*`、`.suffix`、`host`、`host:port`，逗号分隔。
 */
export function shouldBypass(hostname: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const host = hostname.toLowerCase();
  for (const raw of noProxy.split(',')) {
    const rule = raw.trim().toLowerCase().replace(/:\d+$/, '');
    if (!rule) continue;
    if (rule === '*') return true;
    if (rule.startsWith('.')) {
      if (host.endsWith(rule) || host === rule.slice(1)) return true;
    } else if (host === rule) {
      return true;
    }
  }
  return false;
}

/**
 * 面向 TLS 目标的代理 Agent：先 CONNECT 建隧道，再在隧道上握手。
 *
 * 覆写 `createConnection` 而非自己管连接池，是为了继续复用 http.Agent 的
 * keep-alive 与 maxSockets 逻辑（NFR-1.3）。
 */
class HttpsOverHttpProxyAgent extends https.Agent {
  private readonly proxy: ParsedProxy;
  private readonly timeoutMs: number;

  constructor(proxy: ParsedProxy, opts: https.AgentOptions & { timeoutMs: number }) {
    super(opts);
    this.proxy = proxy;
    this.timeoutMs = opts.timeoutMs;
  }

  // 签名对齐 http.Agent.createConnection（callback 可选），
  // 否则 TS 认为与基类不兼容。
  override createConnection(
    options: http.ClientRequestArgs,
    callback?: (err: Error | null, stream: stream.Duplex) => void
  ): stream.Duplex | null | undefined {
    const done = (err: Error | null, sock?: stream.Duplex): void => {
      callback?.(err, sock as stream.Duplex);
    };
    const targetHost = String(options.host ?? '');
    const targetPort = Number(options.port ?? 443);

    const socket = net.connect({ host: this.proxy.host, port: this.proxy.port });
    let settled = false;

    const fail = (err: Error): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      done(err);
    };

    const timer = setTimeout(
      () => fail(Object.assign(new Error('proxy CONNECT timeout'), { code: 'ETIMEDOUT' })),
      this.timeoutMs
    );

    socket.once('error', fail);

    socket.once('connect', () => {
      const lines = [
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1`,
        `Host: ${targetHost}:${targetPort}`,
      ];
      if (this.proxy.auth) lines.push(`Proxy-Authorization: ${this.proxy.auth}`);
      socket.write(lines.join('\r\n') + '\r\n\r\n');
    });

    // 用 Buffer 累积而非字符串：CONNECT 响应之后紧跟的可能是二进制 TLS 数据，
    // 按 latin1 来回转换有损坏风险。
    const chunks: Buffer[] = [];
    const onData = (chunk: Buffer): void => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      const end = buf.indexOf('\r\n\r\n');
      if (end < 0) {
        // 防御异常代理返回超长头部
        if (buf.length > 64 * 1024) fail(new Error('proxy CONNECT 响应头过大'));
        return;
      }

      socket.removeListener('data', onData);
      clearTimeout(timer);

      const status = Number(/^HTTP\/1\.[01] (\d{3})/.exec(buf.subarray(0, end).toString('latin1'))?.[1] ?? 0);
      if (status !== 200) {
        fail(
          Object.assign(new Error(`代理拒绝 CONNECT（HTTP ${status}）`), {
            code: status === 407 ? 'EPROXYAUTH' : 'EPROXYCONNECT',
            statusCode: status,
          })
        );
        return;
      }

      if (settled) return;
      settled = true;
      socket.removeListener('error', fail);

      // 'data' 监听已把 socket 置为流动模式；交给 TLS 前必须暂停，
      // 并把头部之后多读到的字节退回流中——否则 TLS 握手会丢开头的数据，
      // 表现为上层 HTTP 解析器报 HPE_INVALID_CONSTANT。
      socket.pause();
      const leftover = buf.subarray(end + 4);
      if (leftover.length > 0) socket.unshift(leftover);

      const secured = tls.connect({
        socket,
        servername: (options as { servername?: string }).servername ?? targetHost,
        rejectUnauthorized: (this.options as https.AgentOptions).rejectUnauthorized !== false,
      });
      secured.once('error', (err) => done(err));
      secured.once('secureConnect', () => done(null, secured));
    };

    socket.on('data', onData);
    return undefined;
  }
}

export interface ProxyAgentResult {
  agent: http.Agent | https.Agent;
  /** 明文目标经代理时，请求行须用 absolute-form。 */
  useAbsoluteUri: boolean;
  /** 明文目标经代理时随请求发送的 Proxy-Authorization。 */
  proxyAuthHeader?: string;
}

/**
 * 为「目标 + 代理」组合构造 Agent。
 * `proxy` 为空或目标命中 no_proxy 时返回 undefined，由调用方走直连。
 */
export function createProxyAgent(
  targetSecure: boolean,
  settings: ProxySettings
): ProxyAgentResult | undefined {
  const proxy = parseProxyUrl(settings.url);
  if (!proxy) return undefined;

  if (targetSecure) {
    return {
      agent: new HttpsOverHttpProxyAgent(proxy, {
        keepAlive: true,
        maxSockets: settings.maxSockets,
        timeout: settings.timeoutMs,
        timeoutMs: settings.timeoutMs,
        rejectUnauthorized: settings.rejectUnauthorized,
      }),
      useAbsoluteUri: false,
    };
  }

  // 明文目标：直接把请求发给代理，用 absolute-form 请求行
  return {
    agent: new http.Agent({
      keepAlive: true,
      maxSockets: settings.maxSockets,
      timeout: settings.timeoutMs,
    }),
    useAbsoluteUri: true,
    ...(proxy.auth !== undefined ? { proxyAuthHeader: proxy.auth } : {}),
  };
}

/** 明文走代理时，请求实际要连的是代理主机。 */
export function proxyEndpoint(settings: ProxySettings): ParsedProxy | undefined {
  return parseProxyUrl(settings.url);
}
