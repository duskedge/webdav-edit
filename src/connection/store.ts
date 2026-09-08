/**
 * 连接配置与凭据存储（PRD FR-1.2、FR-1.4、NFR-2.1）。
 *
 * 分工：
 *   - 常规配置 → VSCode 全局配置（可参与 Settings Sync）。
 *   - 密码/Token → SecretStorage，严禁明文落盘。
 *
 * SecretStorage **不参与 Settings Sync**：配置同步到新设备后凭据为空。
 * 本模块用 `MissingCredentials` 显式区分该状态，避免上层误报为网络错误（FR-1.2）。
 */
import * as vscode from 'vscode';
import { MissingCredentialsError, SecretStore } from './secrets.ts';
import {
  isValidConnectionId,
  type ConnectionConfig,
  type AuthType,
} from '../connection/types.ts';
import type { Credentials } from '../webdav/types.ts';
import { log } from '../log/channel.ts';

export { MissingCredentialsError } from './secrets.ts';

const SECTION = 'webdavEdit';
const KEY = 'connections';

export class ConnectionStore {
  private readonly secrets: SecretStore;
  private readonly onChangeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.onChangeEmitter.event;

  constructor(ctx: vscode.ExtensionContext) {
    this.secrets = new SecretStore(ctx.secrets);
    ctx.subscriptions.push(this.onChangeEmitter);
    ctx.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration(`${SECTION}.${KEY}`)) this.onChangeEmitter.fire();
      })
    );
  }

  /** 读取全部连接。非法条目会被跳过并记录日志，不让坏配置阻断整个扩展。 */
  list(): ConnectionConfig[] {
    const raw = vscode.workspace
      .getConfiguration(SECTION)
      .get<unknown[]>(KEY, []);
    const out: ConnectionConfig[] = [];
    for (const item of raw ?? []) {
      const conn = normalize(item);
      if (conn) {
        out.push(conn);
      } else {
        log.warn(`跳过一条非法的连接配置: ${safeJson(item)}`);
      }
    }
    return out;
  }

  get(id: string): ConnectionConfig | undefined {
    return this.list().find((c) => c.id === id);
  }

  async upsert(conn: ConnectionConfig, password?: string): Promise<void> {
    if (!isValidConnectionId(conn.id)) {
      throw new Error(`非法的连接 id: ${conn.id}（仅允许 [a-z0-9-]）`);
    }
    const all = this.list();
    const idx = all.findIndex((c) => c.id === conn.id);
    if (idx >= 0) all[idx] = conn;
    else all.push(conn);

    await vscode.workspace
      .getConfiguration(SECTION)
      .update(KEY, all, vscode.ConfigurationTarget.Global);

    if (password !== undefined) {
      await this.setPassword(conn.id, password);
    }
    this.onChangeEmitter.fire();
  }

  /** 删除连接时同步清理 SecretStorage 中的凭据（FR-1.4）。 */
  async remove(id: string): Promise<void> {
    const all = this.list().filter((c) => c.id !== id);
    await vscode.workspace
      .getConfiguration(SECTION)
      .update(KEY, all, vscode.ConfigurationTarget.Global);
    await this.secrets.delete(id);
    this.onChangeEmitter.fire();
  }

  async setPassword(id: string, password: string): Promise<void> {
    await this.secrets.set(id, password);
  }

  async getPassword(id: string): Promise<string | undefined> {
    return this.secrets.get(id);
  }

  /**
   * 取用于发起请求的凭据。
   * 凭据缺失时抛 MissingCredentialsError，由上层触发一次性的重新输入引导，
   * 而非反复弹窗（PRD 5.2 第 4 条）。
   */
  async getCredentials(id: string): Promise<Credentials | undefined> {
    const conn = this.get(id);
    if (!conn) return undefined;
    if (conn.authType === 'none') return undefined;

    const password = await this.getPassword(id);
    if (password === undefined) {
      throw new MissingCredentialsError(id);
    }
    return { username: conn.username, password };
  }
}

function normalize(item: unknown): ConnectionConfig | undefined {
  if (!item || typeof item !== 'object') return undefined;
  const o = item as Record<string, unknown>;

  const id = typeof o['id'] === 'string' ? o['id'] : undefined;
  const baseUrl = typeof o['baseUrl'] === 'string' ? o['baseUrl'] : undefined;
  if (!id || !baseUrl || !isValidConnectionId(id)) return undefined;
  if (!/^https?:\/\//i.test(baseUrl)) return undefined;

  const authType = o['authType'];
  return {
    id,
    alias: typeof o['alias'] === 'string' && o['alias'] ? o['alias'] : id,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    pathPrefix: typeof o['pathPrefix'] === 'string' && o['pathPrefix'] ? o['pathPrefix'] : '/',
    username: typeof o['username'] === 'string' ? o['username'] : '',
    authType: isAuthType(authType) ? authType : 'basic',
    ignoreSsl: o['ignoreSsl'] === true,
    readonly: o['readonly'] === true,
    ...(normalizeHeaders(o['headers']) !== undefined
      ? { headers: normalizeHeaders(o['headers'])! }
      : {}),
  };
}

/**
 * 校验自定义请求头（T-4.1）。
 *
 * 剔除认证类头部：凭据必须走 SecretStorage，允许用户在普通配置里写
 * `Authorization` 等于是给了一条把密码明文落盘的旁路（NFR-2.1）。
 * 同时拒绝含控制字符的名称/值，防止请求头注入。
 */
export function normalizeHeaders(v: unknown): Record<string, string> | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out: Record<string, string> = {};
  for (const [rawName, rawValue] of Object.entries(v as Record<string, unknown>)) {
    const name = rawName.trim();
    if (!name || typeof rawValue !== 'string') continue;
    if (FORBIDDEN_HEADERS.has(name.toLowerCase())) {
      log.warn(`忽略自定义请求头 ${name}：认证类头部须走 SecretStorage`);
      continue;
    }
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) {
      log.warn(`忽略非法的请求头名称 ${JSON.stringify(name)}`);
      continue;
    }
    if (/[\u0000-\u001F\u007F]/.test(rawValue)) {
      log.warn(`忽略含控制字符的请求头值 ${name}`);
      continue;
    }
    out[name] = rawValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/** 由认证逻辑接管、不允许用户覆盖的头部。 */
const FORBIDDEN_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'host',
  'content-length',
]);

function isAuthType(v: unknown): v is AuthType {
  return v === 'basic' || v === 'digest' || v === 'bearer' || v === 'none';
}

/** 日志用的安全序列化，绝不输出可能含凭据的字段（NFR-2.4）。 */
function safeJson(item: unknown): string {
  if (!item || typeof item !== 'object') return String(item);
  const o = item as Record<string, unknown>;
  return JSON.stringify({ id: o['id'], alias: o['alias'], baseUrl: o['baseUrl'] });
}
