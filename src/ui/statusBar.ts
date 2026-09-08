/**
 * 状态栏指示器（PRD FR-4.3）。
 *
 * 当前工作区为 WebDAV 目录时显示连接别名，点击打开连接管理面板。
 * 同时对风险配置（HTTP 明文、忽略证书）给出可见标注（NFR-2.2、NFR-2.3）。
 */
import * as vscode from 'vscode';
import { isSecure } from '../connection/types.ts';
import { ConnectionStore } from '../connection/store.ts';

export function registerStatusBar(
  ctx: vscode.ExtensionContext,
  store: ConnectionStore
): void {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = 'webdavEdit.manageConnections';
  ctx.subscriptions.push(item);

  const update = (): void => {
    const folder = vscode.workspace.workspaceFolders?.find(
      (f) => f.uri.scheme === 'webdav'
    );
    if (!folder) {
      item.hide();
      return;
    }

    const conn = store.get(folder.uri.authority);
    if (!conn) {
      item.text = '$(warning) WebDAV: 连接配置丢失';
      item.tooltip = `工作区 ${folder.uri.toString()} 对应的连接配置不存在，请重新配置。`;
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      item.show();
      return;
    }

    const warnings: string[] = [];
    if (!isSecure(conn)) warnings.push('HTTP 明文传输');
    if (conn.ignoreSsl) warnings.push('已忽略证书校验');

    item.text = `${warnings.length ? '$(shield-x)' : '$(cloud)'} WebDAV: ${conn.alias}${
      conn.readonly ? ' (只读)' : ''
    }`;
    item.tooltip = new vscode.MarkdownString(
      [
        `**${conn.alias}**`,
        '',
        `- 地址：\`${conn.baseUrl}${conn.pathPrefix === '/' ? '' : conn.pathPrefix}\``,
        `- 路径：\`${folder.uri.path}\``,
        `- 认证：${conn.authType}`,
        ...warnings.map((w) => `- ⚠ ${w}`),
      ].join('\n')
    );
    item.backgroundColor = warnings.length
      ? new vscode.ThemeColor('statusBarItem.warningBackground')
      : undefined;
    item.show();
  };

  update();
  ctx.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(update));
  ctx.subscriptions.push(store.onDidChange(update));
}
