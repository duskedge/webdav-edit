/**
 * 命令与交互（PRD FR-1.1、FR-1.3、FR-1.4、FR-2.1、FR-4.5）。
 */
import * as vscode from 'vscode';
import { homedir } from 'node:os';
import {
  describe,
  generateConnectionId,
  isSecure,
  parseServerUrl,
  type AuthType,
  type ConnectionConfig,
} from '../connection/types.ts';
import { ConnectionStore } from '../connection/store.ts';
import { HttpClient } from '../webdav/request.ts';
import { WebdavClient } from '../webdav/client.ts';
import { basename } from '../webdav/path.ts';
import { isWebdavError } from '../webdav/errors.ts';
import { buildUri, type WebdavFileSystemProvider } from '../fs/provider.ts';
import type { ConnectionResolver } from '../connection/resolver.ts';
import { pickRemoteDirectory } from './quickpick.ts';
import type { TreeNode, WebdavTreeProvider } from './tree.ts';
import { ConnectionEditorPanel } from './connectionEditor.ts';
import { explainFullTextSearch, findByName, guarded } from './search.ts';
import { log, showLog } from '../log/channel.ts';

const RECENT_KEY = 'webdavEdit.recentFolders';
const CAPABILITY_NOTICE_KEY = 'webdavEdit.capabilityNoticeShown';

export interface CommandDeps {
  ctx: vscode.ExtensionContext;
  store: ConnectionStore;
  provider: WebdavFileSystemProvider;
  resolver: ConnectionResolver;
  tree: WebdavTreeProvider;
}

export function registerCommands(ctx: vscode.ExtensionContext, deps: CommandDeps): void {
  const { ctx: extCtx, store, provider, resolver, tree } = deps;
  const reg = (id: string, fn: (...args: any[]) => unknown): void => {
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
  };

  reg('webdavEdit.addConnection', async () => {
    await addConnection(store);
    tree.refresh();
  });
  reg('webdavEdit.manageConnections', async () => {
    await manageConnections(store);
    tree.refresh();
  });
  reg('webdavEdit.openFolder', () => openFolder(ctx, store, resolver));
  reg('webdavEdit.showLog', () => showLog());

  // ---- FR-1.1 增强：Webview 连接管理面板（T-3.8）----
  reg('webdavEdit.openConnectionEditor', (node?: TreeNode) => {
    const editId = node && node.kind === 'connection' ? node.conn.id : undefined;
    ConnectionEditorPanel.show(extCtx, store, () => tree.refresh(), editId);
  });

  // ---- FR-5.1 查找（T-3.9）----
  reg('webdavEdit.findByName', () => guarded(() => findByName(store, resolver)));
  reg('webdavEdit.searchInFiles', () => explainFullTextSearch());

  // ---- FR-2.4 刷新（T-2.8）----
  reg('webdavEdit.refresh', (node?: TreeNode) => {
    if (node && node.kind === 'entry') {
      provider.refresh(buildUri(node.connectionId, node.path));
      tree.refresh(node);
      return;
    }
    if (node && node.kind === 'connection') {
      provider.refresh(buildUri(node.conn.id, '/'));
      tree.refresh(node);
      return;
    }
    // 无节点：清空所有已配置连接的缓存并刷新整棵树。
    // 不能只处理 workspaceFolders：用户可能只在 WebDAV 侧边栏浏览连接，
    // 当前工作区仍是本地目录，此时也必须让刷新按钮真正拉取最新目录。
    const refreshedConnections = new Set<string>();
    for (const conn of store.list()) {
      provider.refresh(buildUri(conn.id, '/'));
      refreshedConnections.add(conn.id);
    }

    // 兼容配置已移除、但窗口中仍暂存着 webdav 工作区的情况。
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (
        folder.uri.scheme === 'webdav' &&
        !refreshedConnections.has(folder.uri.authority)
      ) {
        provider.refresh(folder.uri);
      }
    }
    tree.refresh();
  });

  // ---- FR-2.2 TreeView 上下文菜单（T-2.5）----
  reg('webdavEdit.openNodeInCurrentWindow', (node: TreeNode) =>
    openNode(ctx, node, 'current')
  );
  reg('webdavEdit.openNodeInNewWindow', (node: TreeNode) => openNode(ctx, node, 'new'));
  reg('webdavEdit.addNodeToWorkspace', (node: TreeNode) => openNode(ctx, node, 'add'));
  reg('webdavEdit.downloadFile', (node: TreeNode) => downloadFile(node, provider));
  reg('webdavEdit.copyRemotePath', async (node: TreeNode) => {
    const path = node.kind === 'entry' ? node.path : node.kind === 'connection' ? '/' : '';
    if (!path) return;
    await vscode.env.clipboard.writeText(path);
    void vscode.window.showInformationMessage(`已复制路径：${path}`);
  });
  reg('webdavEdit.browseConnection', async (node: TreeNode) => {
    if (node.kind !== 'connection') return;
    const path = await pickRemoteDirectory(node.conn, resolver);
    if (path === undefined) return;
    await openTarget(ctx, node.conn.id, node.conn.alias, path, 'ask');
  });
}

async function downloadFile(
  node: TreeNode,
  provider: WebdavFileSystemProvider
): Promise<void> {
  if (node.kind !== 'entry' || node.isDirectory) return;

  const fileName = basename(node.path);
  const destination = await vscode.window.showSaveDialog({
    title: `下载 ${fileName}`,
    saveLabel: '下载',
    defaultUri: vscode.Uri.joinPath(vscode.Uri.file(homedir()), 'Downloads', fileName),
  });
  if (!destination) return;

  try {
    const data = await provider.readFile(buildUri(node.connectionId, node.path));
    await vscode.workspace.fs.writeFile(destination, data);
    const choice = await vscode.window.showInformationMessage(
      `已下载 ${fileName}`,
      '打开文件',
      '在文件管理器中显示'
    );
    if (choice === '打开文件') {
      await vscode.commands.executeCommand('vscode.open', destination);
    } else if (choice === '在文件管理器中显示') {
      await vscode.commands.executeCommand('revealFileInOS', destination);
    }
  } catch (err) {
    log.error(`下载 ${node.path} 失败`, err);
    const message = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`下载失败：${message}`);
  }
}

type OpenMode = 'current' | 'new' | 'add' | 'ask';

async function openNode(
  ctx: vscode.ExtensionContext,
  node: TreeNode,
  mode: OpenMode
): Promise<void> {
  if (node.kind === 'connection') {
    return openTarget(ctx, node.conn.id, node.conn.alias, '/', mode);
  }
  if (node.kind === 'entry' && node.isDirectory) {
    return openTarget(ctx, node.connectionId, node.name, node.path, mode);
  }
}

async function openTarget(
  ctx: vscode.ExtensionContext,
  connectionId: string,
  alias: string,
  path: string,
  mode: OpenMode
): Promise<void> {
  await rememberRecent(ctx, { connectionId, path, alias });
  await showCapabilityNoticeOnce(ctx);
  const uri = buildUri(connectionId, path);

  if (mode === 'add') {
    // 多根工作区（PRD 8.1.2 待关闭）：混合本地+远程时 VSCode 的虚拟工作区
    // 判定与能力降级行为尚未实测，此处仅提供入口。
    const index = vscode.workspace.workspaceFolders?.length ?? 0;
    vscode.workspace.updateWorkspaceFolders(index, 0, { uri, name: alias });
    return;
  }

  const forceNewWindow =
    mode === 'new' ||
    (mode === 'ask' && vscode.workspace.workspaceFolders !== undefined);
  log.info(`打开工作区 ${uri.toString()}（新窗口=${forceNewWindow}）`);
  await vscode.commands.executeCommand('vscode.openFolder', uri, { forceNewWindow });
}

// ---- FR-1.1 新增连接 ----

async function addConnection(store: ConnectionStore): Promise<ConnectionConfig | undefined> {
  const urlInput = await vscode.window.showInputBox({
    title: 'WebDAV 连接 (1/4)',
    prompt: '服务器地址。可直接粘贴完整 WebDAV URL，将自动拆解地址与路径前缀',
    placeHolder: 'https://cloud.example.com/remote.php/dav/files/alice/',
    ignoreFocusOut: true,
    validateInput: (v) => (parseServerUrl(v) ? undefined : '无法解析为有效的 http(s) 地址'),
  });
  if (!urlInput) return undefined;

  const parsed = parseServerUrl(urlInput);
  if (!parsed) return undefined;

  // NFR-2.2：HTTP 明文连接需显式二次确认
  if (!parsed.secure) {
    const ok = await vscode.window.showWarningMessage(
      '该地址使用 HTTP 明文传输，密码与文件内容将不加密。建议改用 HTTPS。',
      { modal: true },
      '仍然继续'
    );
    if (ok !== '仍然继续') return undefined;
  }

  const alias = await vscode.window.showInputBox({
    title: 'WebDAV 连接 (2/4)',
    prompt: '连接别名',
    value: new URL(parsed.baseUrl).hostname,
    ignoreFocusOut: true,
  });
  if (alias === undefined) return undefined;

  const authType = await pickAuthType();
  if (!authType) return undefined;

  let username = '';
  let password = '';
  if (authType !== 'none') {
    if (authType !== 'bearer') {
      const u = await vscode.window.showInputBox({
        title: 'WebDAV 连接 (3/4)',
        prompt: '用户名',
        ignoreFocusOut: true,
      });
      if (u === undefined) return undefined;
      username = u;
    }
    const p = await vscode.window.showInputBox({
      title: 'WebDAV 连接 (4/4)',
      prompt: authType === 'bearer' ? 'Token' : '密码或应用专用密码',
      password: true,
      ignoreFocusOut: true,
    });
    if (p === undefined) return undefined;
    password = p;
  }

  const conn: ConnectionConfig = {
    id: generateConnectionId(),
    alias: alias || parsed.baseUrl,
    baseUrl: parsed.baseUrl,
    pathPrefix: parsed.pathPrefix,
    username,
    authType,
    ignoreSsl: false,
    readonly: false,
  };

  // FR-1.3：保存前先测试
  const result = await testConnection(conn, password);
  if (!result.ok) {
    const choice = await vscode.window.showWarningMessage(
      `连接测试失败：${result.message}`,
      '仍然保存',
      '查看日志',
      '取消'
    );
    if (choice === '查看日志') showLog();
    if (choice !== '仍然保存') return undefined;
  } else {
    void vscode.window.showInformationMessage(
      `连接成功${result.server ? `（服务端：${result.server}）` : ''}`
    );
  }

  await store.upsert(conn, password);
  log.info(`已保存连接 ${describe(conn)}`);
  return conn;
}

async function pickAuthType(): Promise<AuthType | undefined> {
  const picked = await vscode.window.showQuickPick(
    [
      { label: 'Basic', description: '用户名 + 密码（最常用）', value: 'basic' as const },
      { label: 'Digest', description: 'Apache mod_dav 常见默认', value: 'digest' as const },
      { label: 'Bearer Token', description: '网关或 OAuth 场景', value: 'bearer' as const },
      { label: '无认证', description: '匿名访问', value: 'none' as const },
    ],
    { title: '认证方式', ignoreFocusOut: true }
  );
  return picked?.value;
}

// ---- FR-1.3 连接测试 ----

interface TestResult {
  ok: boolean;
  message?: string;
  server?: string;
}

export async function testConnection(
  conn: ConnectionConfig,
  password: string
): Promise<TestResult> {
  const http = new HttpClient({
    baseUrl: conn.baseUrl,
    authType: conn.authType,
    ignoreSsl: conn.ignoreSsl,
    connectTimeoutMs: 10000,
    requestTimeoutMs: 20000,
    maxConcurrent: 2,
    getCredentials: async () => ({ username: conn.username, password }),
    onHttp: (m, u, s, ms, extra) => log.http(m, u, s, ms, extra),
  });

  try {
    const dav = new WebdavClient(http, conn.pathPrefix, conn.baseUrl);
    const info = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: '正在测试 WebDAV 连接…' },
      () => dav.testConnection()
    );
    return {
      ok: true,
      ...(info.server !== undefined ? { server: info.server } : {}),
    };
  } catch (err) {
    const message = isWebdavError(err) ? err.userMessage : String(err);
    log.error('连接测试失败', err);
    return { ok: false, message };
  } finally {
    http.dispose();
  }
}

// ---- FR-1.4 连接管理 ----

async function manageConnections(store: ConnectionStore): Promise<void> {
  const connections = store.list();
  if (connections.length === 0) {
    const choice = await vscode.window.showInformationMessage(
      '尚未配置任何 WebDAV 连接。',
      '新增连接'
    );
    if (choice === '新增连接') await addConnection(store);
    return;
  }

  const picked = await vscode.window.showQuickPick(
    connections.map((c) => ({
      label: c.alias,
      description: `${c.baseUrl}${c.pathPrefix === '/' ? '' : c.pathPrefix}`,
      detail: [
        c.authType,
        c.readonly ? '只读' : undefined,
        c.ignoreSsl ? '⚠ 允许自签名证书' : undefined,
        isSecure(c) ? undefined : '⚠ HTTP 明文',
      ]
        .filter(Boolean)
        .join(' · '),
      conn: c,
    })),
    { title: '选择要管理的连接', ignoreFocusOut: true }
  );
  if (!picked) return;

  const action = await vscode.window.showQuickPick(
    [
      { label: '$(key) 更新密码', value: 'password' as const },
      { label: '$(pencil) 重命名', value: 'rename' as const },
      { label: '$(plug) 测试连接', value: 'test' as const },
      {
        label: picked.conn.readonly ? '$(unlock) 取消只读' : '$(lock) 设为只读',
        value: 'readonly' as const,
      },
      { label: '$(trash) 删除连接', value: 'delete' as const },
    ],
    { title: picked.conn.alias, ignoreFocusOut: true }
  );
  if (!action) return;

  switch (action.value) {
    case 'password': {
      const p = await vscode.window.showInputBox({
        prompt: `「${picked.conn.alias}」的新密码或 Token`,
        password: true,
        ignoreFocusOut: true,
      });
      if (p !== undefined) {
        await store.setPassword(picked.conn.id, p);
        void vscode.window.showInformationMessage('密码已更新');
      }
      break;
    }
    case 'rename': {
      const name = await vscode.window.showInputBox({
        prompt: '新的别名',
        value: picked.conn.alias,
        ignoreFocusOut: true,
      });
      if (name) await store.upsert({ ...picked.conn, alias: name });
      break;
    }
    case 'test': {
      const password = (await store.getPassword(picked.conn.id)) ?? '';
      const result = await testConnection(picked.conn, password);
      if (result.ok) {
        void vscode.window.showInformationMessage(
          `连接成功${result.server ? `（服务端：${result.server}）` : ''}`
        );
      } else {
        const c = await vscode.window.showErrorMessage(
          `连接失败：${result.message}`,
          '查看日志'
        );
        if (c === '查看日志') showLog();
      }
      break;
    }
    case 'readonly': {
      await store.upsert({ ...picked.conn, readonly: !picked.conn.readonly });
      break;
    }
    case 'delete': {
      const ok = await vscode.window.showWarningMessage(
        `确定删除连接「${picked.conn.alias}」？已保存的密码也会一并清除。`,
        { modal: true },
        '删除'
      );
      if (ok === '删除') {
        await store.remove(picked.conn.id);
        void vscode.window.showInformationMessage('连接已删除');
      }
      break;
    }
  }
}

// ---- FR-2.1 打开远程目录（MVP：连接选择 + 路径输入）----

async function openFolder(
  ctx: vscode.ExtensionContext,
  store: ConnectionStore,
  resolver: ConnectionResolver
): Promise<void> {
  let connections = store.list();
  if (connections.length === 0) {
    const created = await addConnection(store);
    if (!created) return;
    connections = store.list();
  }

  const conn =
    connections.length === 1
      ? connections[0]
      : (
          await vscode.window.showQuickPick(
            connections.map((c) => ({
              label: c.alias,
              description: c.baseUrl,
              conn: c,
            })),
            { title: '选择 WebDAV 连接', ignoreFocusOut: true }
          )
        )?.conn;
  if (!conn) return;

  // FR-2.3 最近打开：有历史时先给快捷入口，否则直接进层级浏览
  const recent = ctx.globalState
    .get<RecentFolder[]>(RECENT_KEY, [])
    .filter((r) => r.connectionId === conn.id);

  let path: string | undefined;
  if (recent.length > 0) {
    const picked = await vscode.window.showQuickPick(
      [
        ...recent.map((r) => ({ label: r.path, description: '最近打开', path: r.path })),
        { label: '$(list-tree) 浏览远程目录…', path: undefined as string | undefined },
      ],
      { title: `${conn.alias} — 选择目录`, ignoreFocusOut: true }
    );
    if (!picked) return;
    path = picked.path;
  }

  // T-2.4 层级导航
  if (path === undefined) {
    path = await pickRemoteDirectory(conn, resolver);
  }
  if (path === undefined) return;

  await openTarget(ctx, conn.id, conn.alias, path, 'ask');
}

interface RecentFolder {
  connectionId: string;
  path: string;
  alias: string;
}

/** FR-2.3：只记录 connectionId + 路径，绝不含凭据（NFR-2.1）。 */
async function rememberRecent(
  ctx: vscode.ExtensionContext,
  entry: RecentFolder
): Promise<void> {
  const existing = ctx.globalState.get<RecentFolder[]>(RECENT_KEY, []);
  const next = [
    entry,
    ...existing.filter(
      (r) => !(r.connectionId === entry.connectionId && r.path === entry.path)
    ),
  ].slice(0, 10);
  await ctx.globalState.update(RECENT_KEY, next);
}

// ---- FR-4.5 首次能力提示 ----

export async function showCapabilityNoticeOnce(
  ctx: vscode.ExtensionContext
): Promise<void> {
  if (ctx.globalState.get<boolean>(CAPABILITY_NOTICE_KEY, false)) return;
  await ctx.globalState.update(CAPABILITY_NOTICE_KEY, true);

  void vscode.window
    .showInformationMessage(
      'WebDAV 工作区是「虚拟工作区」：终端、调试、Git 与多数语言服务在此模式下不可用，' +
        '全文搜索也受限。适合浏览与轻量编辑远程文件。',
      '知道了'
    )
    .then(() => undefined);
}
