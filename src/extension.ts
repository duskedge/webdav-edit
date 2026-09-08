/**
 * 扩展入口（PRD 5.2 激活与初始化时序）。
 *
 * ⚠ 关键约束：`registerFileSystemProvider` 必须在 activate() 的**同步阶段**完成。
 * 用 `webdav://` URI 打开工作区会触发窗口重载，重载后 VSCode 会立即请求
 * stat/readDirectory；此时若 provider 尚未注册，工作区会表现为空或直接报错。
 *
 * 因此本文件里 activate() 在注册 provider 之前不得出现任何 await，
 * 凭据与网络连接一律懒加载（见 fs/provider.ts 的 session()）。
 */
import * as vscode from 'vscode';
import { initLog, log } from './log/channel.ts';
import { ConnectionStore } from './connection/store.ts';
import { WebdavFileSystemProvider } from './fs/provider.ts';
import { registerCommands } from './ui/commands.ts';
import { registerStatusBar } from './ui/statusBar.ts';
import { promptReauthenticate } from './ui/reauth.ts';
import { WebdavTreeProvider } from './ui/tree.ts';

export function activate(ctx: vscode.ExtensionContext): void {
  // 1) 日志与配置存储：均为同步构造，不触网、不读 SecretStorage
  initLog(ctx);
  const store = new ConnectionStore(ctx);

  // 2) provider 注册——必须先于任何 await（5.2 第 2 条）
  const provider = new WebdavFileSystemProvider(store);
  ctx.subscriptions.push(provider);
  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('webdav', provider, {
      // 8.1 待决策：当前统一按大小写敏感处理（Linux 后端为主流场景）。
      // 若后续支持按连接配置，需要注意这是 provider 级的一次性选项。
      isCaseSensitive: true,
    })
  );

  // 3) 其余 UI 与命令注册可以在此之后
  const tree = new WebdavTreeProvider(store, provider.connectionResolver);
  ctx.subscriptions.push(tree);
  ctx.subscriptions.push(
    vscode.window.createTreeView('webdavEdit.connections', {
      treeDataProvider: tree,
      showCollapseAll: true,
    })
  );
  ctx.subscriptions.push(store.onDidChange(() => tree.refresh()));

  // T-3.3：401 重认证由 UI 层提供——协议层不认识 VSCode 的输入框
  provider.connectionResolver.setReauthHandler((connectionId) =>
    promptReauthenticate(store, connectionId)
  );

  registerCommands(ctx, { ctx, store, provider, resolver: provider.connectionResolver, tree });
  registerStatusBar(ctx, store);

  ctx.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('webdavEdit.cacheTtlSeconds')) {
        provider.refreshConfig();
      }
    })
  );

  log.info(`WebDAV 扩展已激活，已配置 ${store.list().length} 个连接`);
}

export function deactivate(): void {
  // 资源均挂在 ctx.subscriptions 上，由 VSCode 统一释放
}
