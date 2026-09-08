/**
 * 侧边栏连接视图（PRD FR-2.2 / 开发计划 T-2.5）。
 *
 * 两层结构：连接节点 → 远程目录树。
 * 目录内容走 provider 的同一套缓存（NFR-1.1），因此展开树不会额外放大请求量。
 */
import * as vscode from 'vscode';
import type { ConnectionConfig } from '../connection/types.ts';
import { isSecure } from '../connection/types.ts';
import type { ConnectionStore } from '../connection/store.ts';
import type { ConnectionResolver } from '../connection/resolver.ts';
import { isWebdavError } from '../webdav/errors.ts';
import { buildUri } from '../fs/provider.ts';
import { log } from '../log/channel.ts';

export type TreeNode = ConnectionNode | DirectoryNode | MessageNode;

export interface ConnectionNode {
  kind: 'connection';
  conn: ConnectionConfig;
}

export interface DirectoryNode {
  kind: 'entry';
  connectionId: string;
  path: string;
  name: string;
  isDirectory: boolean;
}

/** 错误或空目录的占位节点——让失败在树里可见，而不是显示成空目录。 */
export interface MessageNode {
  kind: 'message';
  text: string;
  tooltip?: string;
}

export class WebdavTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly store: ConnectionStore;
  private readonly resolver: ConnectionResolver;

  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(store: ConnectionStore, resolver: ConnectionResolver) {
    this.store = store;
    this.resolver = resolver;
  }

  dispose(): void {
    this.emitter.dispose();
  }

  /** 传 undefined 刷新整棵树；传节点只刷新该子树（FR-2.4）。 */
  refresh(node?: TreeNode): void {
    this.emitter.fire(node);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    switch (node.kind) {
      case 'connection':
        return connectionItem(node.conn);
      case 'entry':
        return entryItem(node);
      case 'message': {
        const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
        item.contextValue = 'webdavMessage';
        if (node.tooltip) item.tooltip = node.tooltip;
        return item;
      }
    }
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (!node) {
      const connections = this.store.list();
      if (connections.length === 0) {
        return [{ kind: 'message', text: '尚未配置连接，点击标题栏 + 新增' }];
      }
      return connections.map((conn) => ({ kind: 'connection', conn }));
    }

    if (node.kind === 'message') return [];

    const connectionId = node.kind === 'connection' ? node.conn.id : node.connectionId;
    const path = node.kind === 'connection' ? '/' : node.path;

    if (node.kind === 'entry' && !node.isDirectory) return [];

    try {
      const { dav } = this.resolver.resolve(connectionId);
      const entries = await dav.list(path);
      if (entries.length === 0) {
        return [{ kind: 'message', text: '（空目录）' }];
      }
      return entries
        .sort(compareEntries)
        .map(
          (e): DirectoryNode => ({
            kind: 'entry',
            connectionId,
            path: path === '/' ? `/${e.name}` : `${path}/${e.name}`,
            name: e.name,
            isDirectory: e.isDirectory,
          })
        );
    } catch (err) {
      // 失败必须在树里可见，否则用户会把「连不上」误认成「空目录」
      const message = isWebdavError(err) ? err.userMessage : String(err);
      log.error(`TreeView 读取 ${path} 失败`, err);
      return [
        {
          kind: 'message',
          text: `⚠ ${message}`,
          tooltip: '双击连接节点可重新测试连接；详情见「WebDAV: 显示诊断日志」',
        },
      ];
    }
  }
}

function connectionItem(conn: ConnectionConfig): vscode.TreeItem {
  const item = new vscode.TreeItem(conn.alias, vscode.TreeItemCollapsibleState.Collapsed);
  item.contextValue = 'webdavConnection';
  item.iconPath = new vscode.ThemeIcon(conn.readonly ? 'lock' : 'server-environment');

  const warnings: string[] = [];
  if (!isSecure(conn)) warnings.push('HTTP 明文传输');
  if (conn.ignoreSsl) warnings.push('已忽略证书校验');

  item.description = `${conn.baseUrl}${conn.pathPrefix === '/' ? '' : conn.pathPrefix}`;
  item.tooltip = new vscode.MarkdownString(
    [
      `**${conn.alias}**`,
      '',
      `- 地址：\`${conn.baseUrl}${conn.pathPrefix === '/' ? '' : conn.pathPrefix}\``,
      `- 认证：${conn.authType}`,
      ...(conn.readonly ? ['- 只读连接'] : []),
      ...warnings.map((w) => `- ⚠ ${w}`),
    ].join('\n')
  );
  return item;
}

function entryItem(node: DirectoryNode): vscode.TreeItem {
  const item = new vscode.TreeItem(
    node.name,
    node.isDirectory
      ? vscode.TreeItemCollapsibleState.Collapsed
      : vscode.TreeItemCollapsibleState.None
  );
  item.resourceUri = buildUri(node.connectionId, node.path);
  item.contextValue = node.isDirectory ? 'webdavDirectory' : 'webdavFile';

  if (!node.isDirectory) {
    // 单击直接打开文件，与资源管理器行为一致
    item.command = {
      command: 'vscode.open',
      title: '打开文件',
      arguments: [item.resourceUri],
    };
  }
  return item;
}

/** 目录优先，再按名称——与 VSCode 资源管理器一致。 */
function compareEntries(
  a: { name: string; isDirectory: boolean },
  b: { name: string; isDirectory: boolean }
): number {
  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
}
