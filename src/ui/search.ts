/**
 * 查找入口（PRD FR-5.1 v1.0 方案 / 开发计划 T-3.9）。
 *
 * 验收标准是「搜索入口不再静默无结果」。因此两件事都要做：
 *   1. 提供可用的「按文件名查找」。
 *   2. 对全文搜索给出明确说明——虚拟工作区下 ripgrep 不可用，
 *      而 TextSearchProvider 仍是 proposed API，无法发布到 Marketplace。
 */
import * as vscode from 'vscode';
import type { ConnectionResolver } from '../connection/resolver.ts';
import type { ConnectionStore } from '../connection/store.ts';
import { buildUri } from '../fs/provider.ts';
import { isWebdavError } from '../webdav/errors.ts';
import { DEFAULT_LIMITS, describeTruncation, searchByName } from '../webdav/search.ts';
import { log, showLog } from '../log/channel.ts';

/** 当前工作区中的 WebDAV 根，没有则返回 undefined。 */
function currentWebdavFolder(): vscode.WorkspaceFolder | undefined {
  return vscode.workspace.workspaceFolders?.find((f) => f.uri.scheme === 'webdav');
}

export async function findByName(
  store: ConnectionStore,
  resolver: ConnectionResolver
): Promise<void> {
  const folder = currentWebdavFolder();
  if (!folder) {
    void vscode.window.showInformationMessage(
      '当前工作区不是 WebDAV 目录。请先用「WebDAV: 连接并打开远程目录」打开。'
    );
    return;
  }

  const connectionId = folder.uri.authority;
  const conn = store.get(connectionId);
  if (!conn) {
    void vscode.window.showErrorMessage('当前工作区对应的连接配置不存在。');
    return;
  }

  const query = await vscode.window.showInputBox({
    title: '按文件名查找',
    prompt: '输入文件名的一部分（大小写不敏感）',
    placeHolder: '例如：config',
    ignoreFocusOut: true,
  });
  if (!query) return;

  const outcome = await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `在 ${conn.alias} 中查找「${query}」`,
      cancellable: true,
    },
    async (progress, token) => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      const { dav } = resolver.resolve(connectionId);

      return searchByName(dav, folder.uri.path || '/', query, {
        signal: controller.signal,
        onProgress: (visited, current) =>
          progress.report({ message: `已扫描 ${visited} 个目录：${current}` }),
      });
    }
  );

  if (outcome.hits.length === 0) {
    const detail = outcome.truncated ? `（${describeTruncation(outcome)}）` : '';
    void vscode.window.showInformationMessage(`未找到匹配「${query}」的文件${detail}`);
    return;
  }

  const items = outcome.hits.map((hit) => ({
    label: `${hit.isDirectory ? '$(folder)' : '$(file)'} ${hit.name}`,
    description: hit.path,
    hit,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    title: outcome.truncated
      ? `${outcome.hits.length} 条结果 — ${describeTruncation(outcome)}`
      : `${outcome.hits.length} 条结果`,
    matchOnDescription: true,
    ignoreFocusOut: true,
  });
  if (!picked) return;

  const uri = buildUri(connectionId, picked.hit.path);
  if (picked.hit.isDirectory) {
    await vscode.commands.executeCommand('revealInExplorer', uri);
  } else {
    await vscode.window.showTextDocument(uri);
  }
}

/**
 * 全文搜索说明（FR-5.1）。
 *
 * 与其让用户在搜索框里等一个永远不来的结果，不如直接说明原因与替代方案。
 */
export async function explainFullTextSearch(): Promise<void> {
  const choice = await vscode.window.showInformationMessage(
    'WebDAV 工作区暂不支持全文搜索。',
    {
      modal: true,
      detail:
        '虚拟工作区下 VSCode 的 ripgrep 无法访问远程文件；而实现全文搜索所需的 ' +
        'TextSearchProvider 目前仍是 proposed API，使用后扩展无法发布到 Marketplace。\n\n' +
        '可用替代：按文件名查找；或将目录同步到本地后再搜索。',
    },
    '按文件名查找'
  );
  if (choice === '按文件名查找') {
    await vscode.commands.executeCommand('webdavEdit.findByName');
  }
}

/** 供命令注册时复用的错误处理包装。 */
export async function guarded(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const message = isWebdavError(err) ? err.userMessage : String(err);
    log.error('查找失败', err);
    const choice = await vscode.window.showErrorMessage(`查找失败：${message}`, '查看日志');
    if (choice === '查看日志') showLog();
  }
}

export { DEFAULT_LIMITS };
