/**
 * 协议层公共类型（开发计划 §3）。
 *
 * 独立成文件的目的是让 `fs/` 与 `connection/` 依赖接口而非实现——
 * 5.8.3「接口隔离」要求保留「换回第三方实现而不动上层」的退路。
 */
import type { AuthType } from '../connection/types.ts';

export interface Credentials {
  username: string;
  password: string;
}

/** Digest 质询状态。按连接持有，nc 需要在同一 nonce 下单调递增。 */
export interface DigestState {
  realm: string;
  nonce: string;
  qop?: string;
  opaque?: string;
  algorithm: string;
  nc: number;
  cnonce: string;
}

export interface Stat {
  isDirectory: boolean;
  size: number;
  mtime: number;
  ctime: number;
  etag?: string;
}

export interface DirEntry {
  name: string;
  isDirectory: boolean;
  stat: Stat;
}

export interface ReadResult {
  data: Buffer;
  etag?: string;
}

export interface WriteOptions {
  /** FR-4.4：带 `If-Match` 做条件写，检测远端是否已被他人修改。 */
  ifMatch?: string;
  signal?: AbortSignal;
  onProgress?: (transferred: number, total: number | undefined) => void;
}

/** 服务端能力探测结果（OPTIONS，用于 5.6 兼容性矩阵与降级决策）。 */
export interface ServerCapabilities {
  /** `DAV:` 响应头声明的合规等级，如 "1,2"。 */
  davLevel?: string;
  /** `Server:` 响应头。 */
  server?: string;
  /** `Allow:` 中声明支持的动作（已大写）。 */
  allow: string[];
}

export interface ClientOptions {
  baseUrl: string;
  authType: AuthType;
  ignoreSsl: boolean;
  connectTimeoutMs: number;
  requestTimeoutMs: number;
  maxConcurrent: number;
  /** 懒加载凭据（PRD 5.2：provider 注册不得阻塞在 SecretStorage 上）。 */
  getCredentials: () => Promise<Credentials | undefined>;
  proxy?: string;
  onHttp?: (
    method: string,
    url: string,
    status: number | undefined,
    ms: number,
    extra?: Record<string, string | number | undefined>
  ) => void;
}

/**
 * 协议层对外接口（5.8.3 接口隔离）。
 * `fs/provider.ts` 只依赖此接口，不依赖具体 HTTP 实现。
 */
export interface IWebdavClient {
  stat(path: string, ctx?: string): Promise<Stat>;
  list(path: string, ctx?: string): Promise<DirEntry[]>;
  read(
    path: string,
    opts?: { signal?: AbortSignal; onProgress?: WriteOptions['onProgress'] }
  ): Promise<ReadResult>;
  write(path: string, data: Buffer, opts?: WriteOptions): Promise<string | undefined>;
  mkcol(path: string): Promise<void>;
  remove(path: string, recursive: boolean): Promise<void>;
  move(from: string, to: string, overwrite: boolean): Promise<void>;
  copy(from: string, to: string, overwrite: boolean): Promise<void>;
  options(path?: string): Promise<ServerCapabilities>;
}
