/**
 * 诊断日志通道（PRD FR-6.1）。
 *
 * 本类扩展的问题绝大多数源于服务端实现差异，无请求日志则无法远程定位，
 * 因此该能力前置到 MVP。脱敏规则见 redact.ts（NFR-2.4）。
 */
import * as vscode from 'vscode';
import { redactText, redactUrl } from './redact.ts';

export type LogLevel = 'off' | 'error' | 'info' | 'debug';

const ORDER: Record<LogLevel, number> = { off: 0, error: 1, info: 2, debug: 3 };

let channel: vscode.OutputChannel | undefined;
let level: LogLevel = 'info';

export function initLog(ctx: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('WebDAV');
  ctx.subscriptions.push(channel);
  refreshLevel();
  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('webdavEdit.logLevel')) refreshLevel();
    })
  );
}

function refreshLevel(): void {
  level = vscode.workspace.getConfiguration('webdavEdit').get<LogLevel>('logLevel', 'info');
}

export function showLog(): void {
  channel?.show(true);
}

/** 当前是否开启 debug，供调用方跳过昂贵的日志字符串构造。 */
export function isDebugEnabled(): boolean {
  return level === 'debug';
}

function write(lvl: Exclude<LogLevel, 'off'>, msg: string): void {
  if (level === 'off' || ORDER[lvl] > ORDER[level] || !channel) return;
  const ts = new Date().toISOString().slice(11, 23);
  channel.appendLine(`[${ts}] [${lvl}] ${msg}`);
}

export const log = {
  error(msg: string, err?: unknown): void {
    write('error', redactText(err ? `${msg}: ${String(err)}` : msg));
  },
  warn(msg: string): void {
    write('error', redactText(`WARN ${msg}`));
  },
  info(msg: string): void {
    write('info', redactText(msg));
  },
  debug(msg: string): void {
    write('debug', redactText(msg));
  },
  /** 记录一次 HTTP 往返。请求体与响应体一律不落日志（FR-6.1）。 */
  http(
    method: string,
    url: string,
    status: number | undefined,
    durationMs: number,
    extra?: Record<string, string | number | undefined>
  ): void {
    if (level !== 'debug') return;
    const tail = extra
      ? Object.entries(extra)
          .filter(([, v]) => v !== undefined)
          .map(([k, v]) => ` ${k}=${v}`)
          .join('')
      : '';
    write(
      'debug',
      `${method} ${redactUrl(url)} -> ${status ?? 'ERR'} ${Math.round(durationMs)}ms${tail}`
    );
  },
};
