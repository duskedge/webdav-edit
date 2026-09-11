/**
 * 401 重认证引导（PRD FR-1.2、FR-4.2 / 开发计划 T-3.3）。
 *
 * 验收标准是「密码过期后引导重输，**不反复弹窗**」。为此有两道闸：
 *   1. 传输层保证同一时刻只有一个重认证在飞（request.ts 的 reauthInFlight）。
 *   2. 这里对同一连接做冷却：用户明确取消后，短时间内不再打扰。
 */
import * as vscode from 'vscode';
import type { ConnectionStore } from '../connection/store.ts';
import { log } from '../log/channel.ts';

/** 用户取消后的冷却时间。够长到不烦人，够短到改完密码能马上重试。 */
const COOLDOWN_MS = 60_000;

const declinedUntil = new Map<string, number>();
const missingCredentialsInFlight = new Map<string, Promise<boolean>>();

/**
 * 凭据不存在时给出可操作的输入引导，并合并同一连接的并发提示。
 * 常见于 Settings Sync、新设备，以及扩展标识发生变化后的首次启动。
 */
export async function promptMissingCredentials(
  store: ConnectionStore,
  connectionId: string
): Promise<boolean> {
  const existing = missingCredentialsInFlight.get(connectionId);
  if (existing) return existing;

  const task = askForMissingCredentials(store, connectionId);
  missingCredentialsInFlight.set(connectionId, task);
  try {
    return await task;
  } finally {
    if (missingCredentialsInFlight.get(connectionId) === task) {
      missingCredentialsInFlight.delete(connectionId);
    }
  }
}

async function askForMissingCredentials(
  store: ConnectionStore,
  connectionId: string
): Promise<boolean> {
  const until = declinedUntil.get(connectionId) ?? 0;
  if (Date.now() < until) return false;

  const conn = store.get(connectionId);
  const name = conn?.alias ?? connectionId;
  const choice = await vscode.window.showWarningMessage(
    `WebDAV 连接「${name}」缺少密码或 Token。连接信息已保留，请在本设备重新输入凭据。`,
    '输入凭据',
    '暂不处理'
  );

  if (choice !== '输入凭据') {
    declinedUntil.set(connectionId, Date.now() + COOLDOWN_MS);
    return false;
  }

  const password = await vscode.window.showInputBox({
    title: `「${name}」认证`,
    prompt: conn?.authType === 'bearer' ? '请输入 Token' : '请输入密码或应用专用密码',
    password: true,
    ignoreFocusOut: true,
  });

  if (password === undefined) {
    declinedUntil.set(connectionId, Date.now() + COOLDOWN_MS);
    return false;
  }

  await store.setPassword(connectionId, password);
  declinedUntil.delete(connectionId);
  log.info(`连接 ${connectionId} 的缺失凭据已补充`);
  return true;
}

/**
 * 提示用户重新输入凭据。
 * @returns true 表示凭据已更新、值得重发请求。
 */
export async function promptReauthenticate(
  store: ConnectionStore,
  connectionId: string
): Promise<boolean> {
  const until = declinedUntil.get(connectionId) ?? 0;
  if (Date.now() < until) {
    log.debug(`连接 ${connectionId} 处于重认证冷却期，跳过提示`);
    return false;
  }

  const conn = store.get(connectionId);
  const name = conn?.alias ?? connectionId;

  const choice = await vscode.window.showWarningMessage(
    `WebDAV 连接「${name}」认证失败，凭据可能已过期。`,
    '重新输入密码',
    '暂不处理'
  );

  if (choice !== '重新输入密码') {
    declinedUntil.set(connectionId, Date.now() + COOLDOWN_MS);
    return false;
  }

  const password = await vscode.window.showInputBox({
    title: `「${name}」认证`,
    prompt: conn?.authType === 'bearer' ? '请输入新的 Token' : '请输入新的密码或应用专用密码',
    password: true,
    ignoreFocusOut: true,
  });

  if (password === undefined) {
    declinedUntil.set(connectionId, Date.now() + COOLDOWN_MS);
    return false;
  }

  await store.setPassword(connectionId, password);
  declinedUntil.delete(connectionId);
  log.info(`连接 ${connectionId} 的凭据已更新，将重发请求`);
  return true;
}

/** 连接配置变更或被删除时清掉冷却状态。 */
export function clearReauthCooldown(connectionId?: string): void {
  if (connectionId) declinedUntil.delete(connectionId);
  else declinedUntil.clear();
}
