/**
 * HTTP 传输层（PRD NFR-1.3、NFR-1.5、NFR-2.3、FR-1.5、FR-1.6）。
 *
 * 直接使用 Node 的 http/https 模块而非 fetch：
 *   - VSCode 1.75 搭载 Node 16，全局 fetch 尚不稳定（NFR-3.2）。
 *   - 需要按连接粒度控制 TLS agent（自签名证书不得全局放开，NFR-2.3）。
 *   - 需要精确的连接/读写双超时与请求级字节计数（进度提示）。
 *
 * 不依赖 `vscode`，可脱离扩展宿主单测（NFR-4.1）。
 */
import * as http from 'http';
import * as https from 'https';
import { URL } from 'url';
import {
  basicHeader,
  bearerHeader,
  canPreAuthenticate,
  digestHeader,
  parseDigestChallenge,
} from './auth/index.ts';
import type { Credentials, DigestState } from './types.ts';
import { fromNetworkError, isRetryable, WebdavError } from './errors.ts';
import { createProxyAgent, proxyEndpoint, shouldBypass, type ProxyAgentResult } from './proxy.ts';
import type { AuthType } from '../connection/types.ts';

export interface HttpClientOptions {
  baseUrl: string;
  authType: AuthType;
  ignoreSsl: boolean;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxConcurrent: number;
  /** 懒加载凭据（PRD 5.2：provider 注册不得阻塞在 SecretStorage 上）。 */
  getCredentials: () => Promise<Credentials | undefined>;
  /** 代理地址（FR-1.6）。由上层从 VSCode `http.proxy` 或连接配置解析后传入。 */
  proxy?: string;
  /** 绕过代理的主机列表，遵循 `no_proxy` 惯例。 */
  noProxy?: string;
  /** 幂等请求的最大重试次数（T-3.3）。0 表示不重试。 */
  maxRetries?: number;
  /**
   * 自定义请求头（FR-1.5 P2 / T-4.1）。
   * 已由 connection/store.ts 过滤掉认证类头部；此处只负责附加。
   */
  extraHeaders?: Record<string, string>;
  /**
   * 收到 401 时的重认证钩子（T-3.3）。
   * 返回 true 表示凭据已更新、值得重发；返回 false 则把 401 交回上层。
   */
  onUnauthorized?: () => Promise<boolean>;
  onHttp?: (
    method: string,
    url: string,
    status: number | undefined,
    ms: number,
    extra?: Record<string, string | number | undefined>
  ) => void;
}

export interface RequestOptions {
  method: string;
  /** 已编码的路径（含 pathPrefix），如 `/dav/a%20b/c.txt`。 */
  encodedPath: string;
  headers?: Record<string, string>;
  body?: Buffer | string;
  /** 用于错误文案的上下文描述。 */
  context?: string;
  signal?: AbortSignal;
  onProgress?: (transferred: number, total: number | undefined) => void;
}

export interface HttpResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

export class HttpClient {
  private readonly opts: HttpClientOptions;
  private readonly agent: http.Agent | https.Agent;
  private readonly secure: boolean;
  private readonly base: URL;

  /** Digest 质询状态按客户端（即按连接）保持，避免每次请求都吃一个 401。 */
  private digest: DigestState | undefined;

  /** 代理配置（FR-1.6）。undefined 表示直连。 */
  private readonly proxy: ProxyAgentResult | undefined;

  /** NFR-1.3 并发上限。 */
  private active = 0;
  private readonly queue: Array<() => void> = [];

  constructor(opts: HttpClientOptions) {
    this.opts = opts;
    this.base = new URL(opts.baseUrl);
    this.secure = this.base.protocol === 'https:';

    const common = {
      keepAlive: true,
      maxSockets: opts.maxConcurrent,
      timeout: opts.connectTimeoutMs,
    };
    // FR-1.6：目标命中 no_proxy 时直连
    const bypass = shouldBypass(this.base.hostname, opts.noProxy);
    this.proxy = bypass
      ? undefined
      : createProxyAgent(this.secure, {
          url: opts.proxy ?? '',
          rejectUnauthorized: !opts.ignoreSsl,
          maxSockets: opts.maxConcurrent,
          timeoutMs: opts.connectTimeoutMs,
        });

    this.agent =
      this.proxy?.agent ??
      (this.secure
        ? new https.Agent({
            ...common,
            // NFR-2.3：仅按连接放开，严禁修改 NODE_TLS_REJECT_UNAUTHORIZED
            rejectUnauthorized: !opts.ignoreSsl,
          })
        : new http.Agent(common));
  }

  dispose(): void {
    this.agent.destroy();
  }

  /**
   * 发起请求。三层处理，顺序固定：
   *   1. Digest 二次握手（FR-1.5 P1）——401 且带质询时重发一次。
   *   2. 401 重认证（T-3.3）——凭据更新后重发一次，避免上层反复弹窗。
   *   3. 幂等请求的瞬时错误重试（T-3.3）。
   */
  async request(req: RequestOptions): Promise<HttpResponse> {
    await this.acquire();
    try {
      return await this.withRetry(req);
    } finally {
      this.release();
    }
  }

  private async withRetry(req: RequestOptions): Promise<HttpResponse> {
    const maxRetries = idempotent(req.method) ? (this.opts.maxRetries ?? 2) : 0;
    let lastErr: unknown;
    let lastResponse: HttpResponse | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // 指数退避，带上限；瞬时抖动重试过密只会加重服务端压力
        await delay(Math.min(200 * 2 ** (attempt - 1), 2000));
      }
      try {
        const res = await this.followRedirects(req);
        // 传输层不把状态码转成异常（那是 client.ts 的职责），
        // 因此瞬时性状态码要在这里单独识别，否则重试对 5xx 完全不生效。
        if (attempt < maxRetries && isTransientStatus(res.status)) {
          lastResponse = res;
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (!(err instanceof WebdavError) || !isRetryable(err)) throw err;
      }
    }

    if (lastResponse) return lastResponse;
    throw lastErr;
  }

  /**
   * 跟随重定向（实测发现：Apache mod_dav 对无尾斜杠的集合 URL 返回 301）。
   *
   * 两条硬约束：
   *   1. **只跟随同源重定向**。跨源跟随会把 `Authorization` 头发送给另一台主机，
   *      等于凭据泄漏（NFR-2.1）。跨源时直接把 3xx 交回上层。
   *   2. **保持原方法与请求体**。WebDAV 的 PROPFIND/PUT 等在重定向后必须维持语义，
   *      不能像浏览器那样把 301 上的 POST 降级成 GET。
   */
  private async followRedirects(req: RequestOptions): Promise<HttpResponse> {
    let current = req;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const res = await this.sendWithAuth(current);
      if (!REDIRECT_STATUS.has(res.status)) return res;

      const location = headerValue(res.headers['location']);
      if (!location) return res;

      let target: URL;
      try {
        target = new URL(location, this.base.toString());
      } catch {
        return res;
      }

      // 同源判定：协议 + 主机 + 端口都必须一致
      if (target.origin !== this.base.origin) {
        this.opts.onHttp?.(current.method, target.toString(), res.status, 0, {
          note: 'cross-origin-redirect-refused',
        });
        return res;
      }

      current = { ...current, encodedPath: target.pathname };
    }

    // 跳数用尽：按超出限制处理，避免无限循环
    throw new WebdavError('ProtocolError', '重定向次数过多，可能存在循环');
  }

  /** 处理 Digest 握手与 401 重认证。 */
  private async sendWithAuth(req: RequestOptions): Promise<HttpResponse> {
    const first = await this.send(req);
    if (first.status !== 401) return first;

    // Digest：解析质询后重试一次（FR-1.5 P1）
    if (this.opts.authType === 'digest') {
      const challenge = headerValue(first.headers['www-authenticate']);
      const state = challenge ? parseDigestChallenge(challenge) : undefined;
      if (state) {
        this.digest = state;
        return this.send(req);
      }
      return first;
    }

    // T-3.3：给上层一次刷新凭据的机会，成功则重发。
    // 只尝试一次——失败后交回上层，由其做一次性引导而非反复弹窗。
    if (this.opts.onUnauthorized && !this.reauthInFlight) {
      this.reauthInFlight = true;
      try {
        const refreshed = await this.opts.onUnauthorized();
        if (refreshed) return await this.send(req);
      } finally {
        this.reauthInFlight = false;
      }
    }
    return first;
  }

  /** 防止并发请求同时触发重认证，导致多个弹窗。 */
  private reauthInFlight = false;

  private async send(req: RequestOptions): Promise<HttpResponse> {
    const cred = await this.opts.getCredentials();
    const url = new URL(this.base.toString());
    url.pathname = req.encodedPath;

    const headers: Record<string, string> = {
      // 部分服务端在缺少 UA 时行为异常
      'User-Agent': 'vscode-webdav-workspace',
      Accept: '*/*',
      // 自定义头在协议头之前展开：协议正确性优先于用户偏好，
      // 否则用户覆盖 Depth/Destination 会直接破坏 WebDAV 语义
      ...this.opts.extraHeaders,
      ...req.headers,
    };

    const auth = this.authHeader(cred, req.method, req.encodedPath);
    if (auth) headers['Authorization'] = auth;

    const bodyBuf =
      req.body === undefined
        ? undefined
        : Buffer.isBuffer(req.body)
          ? req.body
          : Buffer.from(req.body, 'utf8');
    if (bodyBuf) {
      headers['Content-Length'] = String(bodyBuf.length);
    } else if (METHODS_REQUIRING_LENGTH.has(req.method)) {
      // 部分服务端对无 body 的 PUT 要求显式 0，否则挂起
      headers['Content-Length'] = '0';
    }

    const started = Date.now();
    try {
      const res = await this.raw(url, req, headers, bodyBuf);
      this.opts.onHttp?.(req.method, url.toString(), res.status, Date.now() - started, {
        bytes: res.body.length,
      });
      return res;
    } catch (err) {
      this.opts.onHttp?.(req.method, url.toString(), undefined, Date.now() - started, {
        err: (err as { code?: string }).code ?? 'ERR',
      });
      throw err instanceof WebdavError
        ? err
        : fromNetworkError(err, req.context ?? req.method);
    }
  }

  private authHeader(
    cred: Credentials | undefined,
    method: string,
    encodedPath: string
  ): string | undefined {
    if (!cred) return undefined;
    switch (this.opts.authType) {
      case 'basic':
        return basicHeader(cred);
      case 'bearer':
        return bearerHeader(cred);
      case 'digest':
        return this.digest
          ? digestHeader(this.digest, cred, method, encodedPath)
          : undefined; // 首个请求先吃 401 拿质询
      case 'none':
      default:
        return undefined;
    }
  }

  private raw(
    url: URL,
    req: RequestOptions,
    headers: Record<string, string>,
    body: Buffer | undefined
  ): Promise<HttpResponse> {
    return new Promise<HttpResponse>((resolve, reject) => {
      const mod = this.secure ? https : http;
      // 明文目标经代理时：连的是代理主机，请求行用 absolute-form，
      // 并附带 Proxy-Authorization（TLS 目标走 CONNECT 隧道，不走这里）。
      const viaProxy = this.proxy?.useAbsoluteUri === true;
      const endpoint = viaProxy ? proxyEndpoint({
        url: this.opts.proxy ?? '',
        rejectUnauthorized: !this.opts.ignoreSsl,
        maxSockets: this.opts.maxConcurrent,
        timeoutMs: this.opts.connectTimeoutMs,
      }) : undefined;

      if (viaProxy && this.proxy?.proxyAuthHeader) {
        headers['Proxy-Authorization'] = this.proxy.proxyAuthHeader;
      }

      const request = mod.request(
        {
          protocol: url.protocol,
          hostname: endpoint ? endpoint.host : url.hostname,
          port: endpoint ? endpoint.port : url.port || undefined,
          path: viaProxy ? url.toString() : url.pathname + url.search,
          method: req.method,
          headers: viaProxy ? { ...headers, Host: url.host } : headers,
          agent: this.agent,
        },
        (res) => {
          const total = res.headers['content-length']
            ? Number(res.headers['content-length'])
            : undefined;
          const chunks: Buffer[] = [];
          let received = 0;

          res.on('data', (c: Buffer) => {
            chunks.push(c);
            received += c.length;
            req.onProgress?.(received, total);
          });
          res.on('end', () => {
            cleanup();
            resolve({
              status: res.statusCode ?? 0,
              headers: res.headers,
              body: Buffer.concat(chunks),
            });
          });
          res.on('error', (err) => {
            cleanup();
            reject(err);
          });
        }
      );

      // NFR-1.5 双超时：连接阶段与整体读写阶段分别计时。
      //
      // ⚠ 不能用 `request.setTimeout(connectTimeoutMs)`：Node 把它作用于
      // **整个请求期间的 socket 空闲超时**，而非仅连接阶段。慢链路上服务端
      // TTFB 一旦超过该值，正在进行的传输就会被误杀——实测 3.8Mbps 链路上
      // 大文件读写因此频繁失败。正确做法是只在连接建立前计时。
      let connected = false;
      const connectTimer = setTimeout(() => {
        if (!connected) {
          request.destroy(Object.assign(new Error('connect timeout'), { code: 'ETIMEDOUT' }));
        }
      }, this.opts.connectTimeoutMs);

      request.on('socket', (socket) => {
        const markConnected = (): void => {
          connected = true;
          clearTimeout(connectTimer);
        };
        // 复用 keep-alive 连接时 socket 已经是连通状态
        if (!socket.connecting) markConnected();
        else socket.once('connect', markConnected);
      });

      const overall = setTimeout(() => {
        request.destroy(Object.assign(new Error('request timeout'), { code: 'ETIMEDOUT' }));
      }, this.opts.requestTimeoutMs);

      const onAbort = (): void => {
        request.destroy(Object.assign(new Error('aborted'), { code: 'ABORT_ERR' }));
      };
      req.signal?.addEventListener('abort', onAbort, { once: true });

      const cleanup = (): void => {
        clearTimeout(connectTimer);
        clearTimeout(overall);
        req.signal?.removeEventListener('abort', onAbort);
      };

      request.on('error', (err) => {
        cleanup();
        reject(err);
      });

      if (body) request.write(body);
      request.end();
    });
  }

  /** 首个请求即可携带凭据的方式无需预热；Digest 需要先取质询。 */
  needsChallenge(): boolean {
    return this.opts.authType === 'digest' && !this.digest;
  }

  preAuthenticates(): boolean {
    return canPreAuthenticate(this.opts.authType);
  }

  private acquire(): Promise<void> {
    if (this.active < this.opts.maxConcurrent) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        resolve();
      });
    });
  }

  private release(): void {
    this.active -= 1;
    this.queue.shift()?.();
  }
}

const METHODS_REQUIRING_LENGTH = new Set(['PUT', 'POST', 'PROPFIND', 'PROPPATCH']);

/** 需要跟随的重定向状态码。308/307 明确要求保持方法，301/302 在 WebDAV 场景同样保持。 */
const REDIRECT_STATUS = new Set([301, 302, 307, 308]);
const MAX_REDIRECTS = 3;

export function headerValue(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  return Array.isArray(v) ? v[0] : v;
}

/**
 * 幂等方法才允许自动重试。
 * PUT 在 WebDAV 语义上幂等，但重试可能覆盖他人在这期间的写入，
 * 因此排除在外——冲突检测交给 FR-4.4 的 If-Match。
 */
function idempotent(method: string): boolean {
  return method === 'GET' || method === 'HEAD' || method === 'PROPFIND' || method === 'OPTIONS';
}

/**
 * 值得重试的瞬时状态码。
 * 501 排除在外——「不支持该动作」重试多少次都一样，应走降级路径（FR-3.8）。
 */
function isTransientStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status !== 501);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
