/**
 * connectionId → WebdavClient 解析器（开发计划 §3、PRD 5.2）。
 *
 * 承担两件事：
 *   1. **懒加载**：provider 在 activate() 同步阶段注册，此时不得触网也不得读
 *      SecretStorage；客户端实例在首次 IO 时才建立（5.2 第 3 条）。
 *   2. **实例缓存**：同一连接复用 HttpClient，从而复用 keep-alive 连接池与
 *      Digest 质询状态，并让 NFR-1.3 的并发上限按连接生效。
 */
import { HttpClient } from '../webdav/request.ts';
import { WebdavClient } from '../webdav/client.ts';
import { WebdavError } from '../webdav/errors.ts';
import { log } from '../log/channel.ts';
import type { ConnectionStore } from './store.ts';

export interface ResolvedConnection {
  dav: WebdavClient;
  readonly: boolean;
}

export interface ResolverTuning {
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxConcurrent: number;
  /** FR-1.6：继承 VSCode `http.proxy`，可按连接覆盖。 */
  proxy?: string;
  noProxy?: string;
  maxRetries?: number;
}

interface Entry extends ResolvedConnection {
  http: HttpClient;
}

export class ConnectionResolver {
  private readonly store: ConnectionStore;
  private readonly tuning: () => ResolverTuning;
  private readonly entries = new Map<string, Entry>();

  /**
   * 401 重认证钩子（T-3.3）。由 UI 层注入——协议层不认识 VSCode 的输入框。
   * 返回 true 表示凭据已更新、值得重发。
   */
  private reauthenticate: ((connectionId: string) => Promise<boolean>) | undefined;

  constructor(store: ConnectionStore, tuning: () => ResolverTuning) {
    this.store = store;
    this.tuning = tuning;
  }

  /** 注入重认证处理器（由 ui 层在激活时设置）。 */
  setReauthHandler(handler: (connectionId: string) => Promise<boolean>): void {
    this.reauthenticate = handler;
  }

  resolve(connectionId: string): ResolvedConnection {
    const existing = this.entries.get(connectionId);
    if (existing) return existing;

    const conn = this.store.get(connectionId);
    if (!conn) {
      throw new WebdavError('NotFound', `连接配置不存在（${connectionId}）`);
    }

    const t = this.tuning();
    const http = new HttpClient({
      baseUrl: conn.baseUrl,
      authType: conn.authType,
      ignoreSsl: conn.ignoreSsl,
      connectTimeoutMs: t.connectTimeoutMs,
      requestTimeoutMs: t.requestTimeoutMs,
      maxConcurrent: t.maxConcurrent,
      // 凭据在真正发请求时才读取，构造阶段不触碰 SecretStorage
      getCredentials: () => this.store.getCredentials(connectionId),
      onHttp: (m, u, s, ms, extra) => log.http(m, u, s, ms, extra),
      ...(t.proxy ? { proxy: t.proxy } : {}),
      ...(t.noProxy ? { noProxy: t.noProxy } : {}),
      ...(t.maxRetries !== undefined ? { maxRetries: t.maxRetries } : {}),
      ...(conn.headers ? { extraHeaders: conn.headers } : {}),
      onUnauthorized: async () => {
        if (!this.reauthenticate) return false;
        const refreshed = await this.reauthenticate(connectionId);
        return refreshed;
      },
    });

    const entry: Entry = {
      http,
      dav: new WebdavClient(http, conn.pathPrefix, conn.baseUrl),
      readonly: conn.readonly,
    };
    this.entries.set(connectionId, entry);
    return entry;
  }

  /** 连接配置或凭据变更后须丢弃既有实例（PRD 5.4）。 */
  invalidate(connectionId?: string): void {
    if (connectionId) {
      this.entries.get(connectionId)?.http.dispose();
      this.entries.delete(connectionId);
      return;
    }
    this.disposeAll();
  }

  disposeAll(): void {
    for (const e of this.entries.values()) e.http.dispose();
    this.entries.clear();
  }
}
