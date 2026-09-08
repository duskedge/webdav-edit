/** 连接配置模型（PRD FR-1.1、5.1）。 */

import { randomUUID } from 'crypto';

export type AuthType = 'basic' | 'digest' | 'bearer' | 'none';

/** 存放在 VSCode 全局配置中的部分——**绝不包含密码**（FR-1.2、NFR-2.1）。 */
export interface ConnectionConfig {
  /** 唯一标识。受 URI authority 归一化约束，仅允许 [a-z0-9-]（5.1）。 */
  id: string;
  alias: string;
  /** 形如 `https://cloud.example.com` 或 `http://192.168.1.2:5005`，不含路径。 */
  baseUrl: string;
  /** 服务端 WebDAV 根前缀，如 Nextcloud 的 `/remote.php/dav/files/alice/`。 */
  pathPrefix: string;
  username: string;
  authType: AuthType;
  /** 允许自签名证书。仅按连接粒度生效（NFR-2.3）。 */
  ignoreSsl: boolean;
  readonly: boolean;
  /**
   * 自定义请求头（FR-1.5 P2 / T-4.1）。覆盖网关鉴权等长尾场景。
   * 敏感头（Authorization 等）由认证逻辑接管，此处的同名项会被忽略，
   * 以免绕过 SecretStorage 把凭据写进普通配置。
   */
  headers?: Record<string, string>;
}

/**
 * URI authority 在 RFC 3986 中大小写不敏感，且可能被解析层归一化。
 * 因此 id 强制小写字符集，避免连接索引查找失败（PRD 5.1 约束）。
 */
const ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export function isValidConnectionId(id: string): boolean {
  return ID_PATTERN.test(id);
}

/** 生成符合 5.1 约束的连接 id。randomUUID 输出的 v4 已是小写形式，天然满足。 */
export function generateConnectionId(): string {
  return randomUUID();
}

export interface ParsedUrl {
  baseUrl: string;
  pathPrefix: string;
  secure: boolean;
}

/**
 * 从用户粘贴的完整 URL 拆解出 baseUrl 与 pathPrefix（FR-1.1 一键解析）。
 * 解析失败返回 undefined，由调用方给出提示。
 */
export function parseServerUrl(input: string): ParsedUrl | undefined {
  let raw = input.trim();
  if (!raw) return undefined;

  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(raw);
  if (scheme) {
    // 已带协议：只接受 http(s)，否则直接判非法。
    // 若在此处盲目补 https://，`ftp://host/x` 会被解析成 host=ftp 的畸形 URL。
    if (!/^https?$/i.test(scheme[1]!)) return undefined;
  } else {
    raw = 'https://' + raw;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (!url.hostname) return undefined;

  const prefix = url.pathname && url.pathname !== '/' ? url.pathname : '/';
  return {
    baseUrl: `${url.protocol}//${url.host}`,
    pathPrefix: prefix,
    secure: url.protocol === 'https:',
  };
}

export function isSecure(conn: ConnectionConfig): boolean {
  return conn.baseUrl.toLowerCase().startsWith('https://');
}

/** 用于日志与 UI 展示的安全描述，不含任何凭据（NFR-2.4）。 */
export function describe(conn: ConnectionConfig): string {
  return `${conn.alias} <${conn.baseUrl}${conn.pathPrefix === '/' ? '' : conn.pathPrefix}>`;
}
