/**
 * SecretStorage 封装（PRD FR-1.2）。
 *
 * 密码/Token 一律经此进出，严禁明文落盘或写入 settings.json。
 * SecretStorage **不参与 Settings Sync**：配置同步到新设备后凭据为空，
 * 该状态由 MissingCredentialsError 显式表达，避免上层误报为网络错误。
 */
import * as vscode from 'vscode';

/** 凭据缺失。上层据此触发一次性的重新输入引导（PRD 5.2 第 4 条）。 */
export class MissingCredentialsError extends Error {
  readonly connectionId: string;
  constructor(connectionId: string) {
    super(`missing credentials for ${connectionId}`);
    this.name = 'MissingCredentialsError';
    this.connectionId = connectionId;
  }
}

/** 键名以连接 id 索引，删除连接时同步清理（FR-1.4）。 */
function secretKey(id: string): string {
  return `webdavEdit.password.${id}`;
}

export class SecretStore {
  private readonly secrets: vscode.SecretStorage;

  constructor(secrets: vscode.SecretStorage) {
    this.secrets = secrets;
  }

  async set(id: string, password: string): Promise<void> {
    await this.secrets.store(secretKey(id), password);
  }

  async get(id: string): Promise<string | undefined> {
    return this.secrets.get(secretKey(id));
  }

  async delete(id: string): Promise<void> {
    await this.secrets.delete(secretKey(id));
  }
}
