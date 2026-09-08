/**
 * WebDAV 协议层（PRD 5.3 动作映射表）。
 *
 * 每个方法对应表中一行，含该行记录的协议约束。
 * 不依赖 `vscode`，可脱离扩展宿主单测（NFR-4.1）。
 */
import { fromStatus, WebdavError } from './errors.ts';
import { HttpClient, headerValue, type RequestOptions } from './request.ts';
import { encodePath, joinPrefix, stripPrefix, basename, isSafeName } from './path.ts';
import type {
  DirEntry,
  IWebdavClient,
  ReadResult,
  ServerCapabilities,
  Stat,
  WriteOptions,
} from './types.ts';
import {
  excludeSelf,
  findSelf,
  normalizeEtag,
  parseMultiStatus,
  PROPFIND_BODY,
  type RemoteEntry,
} from './propfind.ts';

export type { Stat, DirEntry, ReadResult, WriteOptions } from './types.ts';

export class WebdavClient implements IWebdavClient {
  private readonly http: HttpClient;
  private readonly pathPrefix: string;
  /** 用于 MOVE/COPY 的 Destination 头（必须是绝对 URL，5.3）。 */
  private readonly origin: string;

  constructor(http: HttpClient, pathPrefix: string, origin: string) {
    this.http = http;
    this.pathPrefix = pathPrefix;
    this.origin = origin.replace(/\/+$/, '');
  }

  /** 工作区内路径 → 已编码的完整请求路径。 */
  private encode(path: string): string {
    return encodePath(joinPrefix(this.pathPrefix, path));
  }

  /** 服务器绝对路径 → 工作区内路径；不属于本连接时返回 undefined。 */
  private toWorkspacePath(absPath: string): string | undefined {
    return stripPrefix(absPath, this.pathPrefix);
  }

  // ---- PROPFIND Depth:0 — stat（5.3 第 1 行）----

  /**
   * 部分服务端对 `Depth: 0` 支持不佳，因此失败时回退到父目录 `Depth: 1` 后筛选
   * （5.3 表中记录的约束）。
   */
  async stat(path: string, ctx = 'stat'): Promise<Stat> {
    const encoded = this.encode(path);
    const absPath = joinPrefix(this.pathPrefix, path);

    const res = await this.http.request({
      method: 'PROPFIND',
      encodedPath: encoded,
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      context: ctx,
    });

    if (res.status === 207) {
      const entries = parseMultiStatus(res.body.toString('utf8'), encoded);
      const self = findSelf(entries, absPath) ?? entries[0];
      if (self) return toStat(self);
      throw new WebdavError('ProtocolError', 'PROPFIND 响应中缺少目标条目');
    }

    // 400/403/405 等常见于不支持 Depth:0 的服务端 → 回退
    if (res.status === 400 || res.status === 403 || res.status === 405) {
      const viaParent = await this.statViaParent(path, ctx);
      if (viaParent) return viaParent;
    }

    throw fromStatus(res.status, ctx);
  }

  private async statViaParent(path: string, ctx: string): Promise<Stat | undefined> {
    if (path === '/' || path === '') return undefined;
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    const encodedParent = this.encode(parent);
    const res = await this.http.request({
      method: 'PROPFIND',
      encodedPath: encodedParent,
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      context: ctx,
    });
    if (res.status !== 207) return undefined;
    const entries = parseMultiStatus(res.body.toString('utf8'), encodedParent);
    const target = findSelf(entries, joinPrefix(this.pathPrefix, path));
    return target ? toStat(target) : undefined;
  }

  // ---- PROPFIND Depth:1 — readDirectory（5.3 第 2 行）----

  /**
   * 必须过滤代表目录自身的 `<response>` 条目（5.3 强制要求）。
   * 返回的子项 stat 供上层一次性回填缓存（NFR-1.1：一次请求满足后续 N 次 stat）。
   */
  async list(path: string, ctx = 'readDirectory'): Promise<DirEntry[]> {
    const encoded = this.encode(path);
    const absPath = joinPrefix(this.pathPrefix, path);

    const res = await this.http.request({
      method: 'PROPFIND',
      encodedPath: encoded,
      headers: { Depth: '1', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      context: ctx,
    });
    if (res.status !== 207) throw fromStatus(res.status, ctx);

    const all = parseMultiStatus(res.body.toString('utf8'), encoded);
    const children = excludeSelf(all, absPath);

    const out: DirEntry[] = [];
    for (const entry of children) {
      const wsPath = this.toWorkspacePath(entry.absPath);
      if (wsPath === undefined) continue; // 不属于本连接前缀，忽略
      const name = basename(wsPath);
      // NFR-2.5：远端文件名视为不可信输入
      if (!isSafeName(name)) continue;
      out.push({ name, isDirectory: entry.isDirectory, stat: toStat(entry) });
    }
    return out;
  }

  // ---- GET — readFile（5.3 第 3 行）----

  async read(
    path: string,
    opts: { signal?: AbortSignal; onProgress?: RequestOptions['onProgress'] } = {}
  ): Promise<ReadResult> {
    const res = await this.http.request({
      method: 'GET',
      encodedPath: this.encode(path),
      context: 'readFile',
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });
    if (res.status !== 200 && res.status !== 206) throw fromStatus(res.status, 'readFile');

    const etag = normalizeEtag(headerValue(res.headers['etag']));
    return { data: res.body, ...(etag !== undefined ? { etag } : {}) };
  }

  /** 仅取大小，用于写前的存在性/大小检查，避免下载整个文件。 */
  async head(path: string): Promise<{ status: number; size?: number; etag?: string }> {
    const res = await this.http.request({
      method: 'HEAD',
      encodedPath: this.encode(path),
      context: 'head',
    });
    const len = headerValue(res.headers['content-length']);
    const etag = normalizeEtag(headerValue(res.headers['etag']));
    return {
      status: res.status,
      ...(len !== undefined ? { size: Number(len) } : {}),
      ...(etag !== undefined ? { etag } : {}),
    };
  }

  // ---- PUT — writeFile（5.3 第 4 行）----

  async write(path: string, data: Buffer, opts: WriteOptions = {}): Promise<string | undefined> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/octet-stream',
    };
    if (opts.ifMatch) headers['If-Match'] = `"${opts.ifMatch}"`;

    const res = await this.http.request({
      method: 'PUT',
      encodedPath: this.encode(path),
      headers,
      body: data,
      context: 'writeFile',
      ...(opts.signal ? { signal: opts.signal } : {}),
      ...(opts.onProgress ? { onProgress: opts.onProgress } : {}),
    });

    if (!isSuccess(res.status)) throw fromStatus(res.status, 'writeFile');
    return normalizeEtag(headerValue(res.headers['etag']));
  }

  // ---- MKCOL — createDirectory（5.3 第 5 行）----

  /** `409` 表示父目录不存在，由 fromStatus 映射为 Conflict → FileNotFound。 */
  async mkcol(path: string): Promise<void> {
    const res = await this.http.request({
      method: 'MKCOL',
      encodedPath: this.encode(path),
      context: 'createDirectory',
    });
    if (!isSuccess(res.status)) throw fromStatus(res.status, 'createDirectory');
  }

  // ---- DELETE — delete（5.3 第 6 行）----

  /**
   * 删除目录须带 `Depth: infinity`。部分服务端返回 207，
   * 此时须逐条解析子状态判断是否全部成功（5.3 表中记录的约束）。
   */
  async remove(path: string, recursive: boolean): Promise<void> {
    const res = await this.http.request({
      method: 'DELETE',
      encodedPath: this.encode(path),
      headers: recursive ? { Depth: 'infinity' } : {},
      context: 'delete',
    });

    if (res.status === 207) {
      const failure = firstFailureStatus(res.body.toString('utf8'));
      if (failure) throw fromStatus(failure, 'delete');
      return;
    }
    if (!isSuccess(res.status)) throw fromStatus(res.status, 'delete');
  }

  // ---- MOVE / COPY — rename / copy（5.3 第 7、8 行）----

  /** `Destination` 必须是**绝对 URL** 且正确百分号编码。 */
  async move(from: string, to: string, overwrite: boolean): Promise<void> {
    await this.moveOrCopy('MOVE', from, to, overwrite, 'rename');
  }

  async copy(from: string, to: string, overwrite: boolean): Promise<void> {
    await this.moveOrCopy('COPY', from, to, overwrite, 'copy');
  }

  private async moveOrCopy(
    method: 'MOVE' | 'COPY',
    from: string,
    to: string,
    overwrite: boolean,
    ctx: string
  ): Promise<void> {
    const headers: Record<string, string> = {
      Destination: this.destinationUrl(to),
      Overwrite: overwrite ? 'T' : 'F',
    };
    if (method === 'COPY') headers['Depth'] = 'infinity';

    const res = await this.http.request({
      method,
      encodedPath: this.encode(from),
      headers,
      context: ctx,
    });

    if (res.status === 207) {
      const failure = firstFailureStatus(res.body.toString('utf8'));
      if (failure) throw fromStatus(failure, ctx);
      return;
    }
    if (!isSuccess(res.status)) throw fromStatus(res.status, ctx);
  }

  /** 供 Destination 头使用的绝对 URL。 */
  destinationUrl(path: string): string {
    return this.origin + this.encode(path);
  }

  // ---- OPTIONS — 服务端能力探测（5.6 兼容性矩阵 / 降级决策）----

  /**
   * 探测服务端支持的动作集合。
   * 用途：在尝试 COPY/MOVE 之前先判断是否支持，避免用一次失败请求换取该信息；
   * 同时为 5.6 兼容性矩阵提供可自动采集的数据来源。
   */
  async options(path = '/'): Promise<ServerCapabilities> {
    const res = await this.http.request({
      method: 'OPTIONS',
      encodedPath: this.encode(path),
      context: '能力探测',
    });
    if (!isSuccess(res.status)) throw fromStatus(res.status, '能力探测');

    const allow = (headerValue(res.headers['allow']) ?? '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean);

    return {
      allow,
      ...(headerValue(res.headers['dav']) !== undefined
        ? { davLevel: headerValue(res.headers['dav']) }
        : {}),
      ...(headerValue(res.headers['server']) !== undefined
        ? { server: headerValue(res.headers['server']) }
        : {}),
    };
  }

  // ---- 连接测试（FR-1.3）----

  /**
   * 对 pathPrefix 根发起 PROPFIND 验证连通性与鉴权。
   * 回显服务端识别信息，便于用户确认连对了服务。
   */
  async testConnection(): Promise<{ dav?: string; server?: string }> {
    const encoded = this.encode('/');
    const res = await this.http.request({
      method: 'PROPFIND',
      encodedPath: encoded,
      headers: { Depth: '0', 'Content-Type': 'application/xml; charset=utf-8' },
      body: PROPFIND_BODY,
      context: '连接测试',
    });

    if (res.status === 207 || res.status === 200) {
      return {
        ...(headerValue(res.headers['dav']) !== undefined
          ? { dav: headerValue(res.headers['dav']) }
          : {}),
        ...(headerValue(res.headers['server']) !== undefined
          ? { server: headerValue(res.headers['server']) }
          : {}),
      };
    }
    // A1：Nginx 原生 DAV 模块不支持 PROPFIND，在此明确检出
    if (res.status === 405 || res.status === 501) {
      throw new WebdavError(
        'NotSupported',
        '服务端不支持 PROPFIND。若使用 Nginx，需额外启用 nginx-dav-ext-module',
        { status: res.status }
      );
    }
    throw fromStatus(res.status, '连接测试');
  }
}

function toStat(e: RemoteEntry): Stat {
  return {
    isDirectory: e.isDirectory,
    size: e.size,
    mtime: e.mtime,
    ctime: e.ctime,
    ...(e.etag !== undefined ? { etag: e.etag } : {}),
  };
}

export function isSuccess(status: number): boolean {
  return status >= 200 && status < 300;
}

/**
 * 从 207 响应中找出第一个失败的子状态码。
 * 全部成功时返回 undefined。
 */
export function firstFailureStatus(xml: string): number | undefined {
  const matches = xml.matchAll(/<[^>]*status[^>]*>\s*HTTP\/[\d.]+\s+(\d{3})/gi);
  for (const m of matches) {
    const code = Number(m[1]);
    if (code >= 400) return code;
  }
  return undefined;
}
