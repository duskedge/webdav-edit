/**
 * 层级式目录导航选择器（PRD FR-2.1 / 开发计划 T-2.4）。
 *
 * 支持：逐级展开、返回上一级、选择当前目录、手动输入路径跳转。
 * 与 TreeView（FR-2.2）互补——QuickPick 全键盘可达，适合「打开目录」这一线性流程。
 */
import * as vscode from 'vscode';
import type { ConnectionConfig } from '../connection/types.ts';
import type { ConnectionResolver } from '../connection/resolver.ts';
import { isWebdavError } from '../webdav/errors.ts';
import { dirname } from '../webdav/path.ts';
import { showLog } from '../log/channel.ts';

/** 特殊动作项用符号区分，避免与真实目录名冲突。 */
const ACTION = {
  select: Symbol('select'),
  up: Symbol('up'),
  manual: Symbol('manual'),
} as const;

type Action = (typeof ACTION)[keyof typeof ACTION];

interface Item extends vscode.QuickPickItem {
  action?: Action;
  childName?: string;
}

/**
 * 逐级浏览远程目录并返回用户选定的路径。
 * 用户取消返回 undefined。
 */
export async function pickRemoteDirectory(
  conn: ConnectionConfig,
  resolver: ConnectionResolver,
  startPath = '/'
): Promise<string | undefined> {
  let current = startPath;

  for (;;) {
    const items = await loadLevel(conn, resolver, current);
    if (items === undefined) return undefined; // 加载失败且用户选择放弃

    const picked = await vscode.window.showQuickPick(items, {
      title: `${conn.alias} — ${current}`,
      placeHolder: '选择子目录进入，或选择「使用当前目录」',
      ignoreFocusOut: true,
      matchOnDescription: true,
    });
    if (!picked) return undefined;

    switch (picked.action) {
      case ACTION.select:
        return current;

      case ACTION.up:
        current = dirname(current);
        break;

      case ACTION.manual: {
        const input = await vscode.window.showInputBox({
          title: '跳转到路径',
          prompt: '相对于连接路径前缀的绝对路径',
          value: current,
          ignoreFocusOut: true,
          validateInput: (v) => (v.startsWith('/') ? undefined : '路径必须以 / 开头'),
        });
        if (input) current = input;
        break;
      }

      default:
        // 进入子目录
        current = current === '/' ? `/${picked.childName}` : `${current}/${picked.childName}`;
        break;
    }
  }
}

/**
 * 载入一级目录并组装选项。
 * 返回 undefined 表示用户在错误提示中选择了放弃。
 */
async function loadLevel(
  conn: ConnectionConfig,
  resolver: ConnectionResolver,
  path: string
): Promise<Item[] | undefined> {
  let dirs: string[];
  try {
    const { dav } = resolver.resolve(conn.id);
    const entries = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Window, title: `正在读取 ${path}…` },
      () => dav.list(path)
    );
    dirs = entries.filter((e) => e.isDirectory).map((e) => e.name).sort(byName);
  } catch (err) {
    const message = isWebdavError(err) ? err.userMessage : String(err);
    const choice = await vscode.window.showErrorMessage(
      `无法读取目录 ${path}：${message}`,
      '返回上一级',
      '查看日志',
      '取消'
    );
    if (choice === '查看日志') showLog();
    if (choice === '返回上一级' && path !== '/') {
      return loadLevel(conn, resolver, dirname(path));
    }
    return undefined;
  }

  const items: Item[] = [
    {
      label: '$(check) 使用当前目录',
      description: path,
      action: ACTION.select,
    },
  ];

  if (path !== '/') {
    items.push({ label: '$(arrow-up) ..', description: '返回上一级', action: ACTION.up });
  }

  items.push({ label: '$(edit) 输入路径…', action: ACTION.manual });

  if (dirs.length > 0) {
    items.push({ label: '子目录', kind: vscode.QuickPickItemKind.Separator });
    for (const name of dirs) {
      items.push({ label: `$(folder) ${name}`, childName: name });
    }
  } else {
    items.push({
      label: '（无子目录）',
      kind: vscode.QuickPickItemKind.Separator,
    });
  }

  return items;
}

/** 目录名排序：数字按数值、其余按本地化规则，贴近资源管理器的直觉。 */
function byName(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}
