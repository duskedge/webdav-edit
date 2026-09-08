/**
 * WebDAV 虚拟文件系统（PRD FR-3.1 ~ FR-3.9）。
 *
 * 关键约束（5.2）：本类的构造函数与 registerFileSystemProvider 必须能在
 * activate() 的**同步阶段**完成，因此这里不做任何 await——凭据与客户端
 * 都是懒加载，首次 IO 时才建立。
 */
import * as vscode from 'vscode';
import { MetadataCache } from './cache.ts';
import { log } from '../log/channel.ts';
import { isWebdavError, WebdavError } from '../webdav/errors.ts';
import type { WebdavClient, Stat } from '../webdav/client.ts';
import { basename } from '../webdav/path.ts';
import { ConnectionStore } from '../connection/store.ts';
import { MissingCredentialsError } from '../connection/secrets.ts';
import { ConnectionResolver } from '../connection/resolver.ts';
import { DirectoryPoller } from './poller.ts';
import { toFsError } from './errorMap.ts';

export class WebdavFileSystemProvider implements vscode.FileSystemProvider {
  private readonly store: ConnectionStore;
  private readonly cache: MetadataCache;
  private readonly resolver: ConnectionResolver;
  /** FR-3.9 P2：可选轮询，默认关闭（T-4.3）。 */
  private readonly poller: DirectoryPoller;

  /** 已提示过凭据缺失的连接，避免反复弹窗（5.2 第 4 条）。 */
  private readonly promptedForCredentials = new Set<string>();

  /** 同一文件的写请求串行化（NFR-1.3）。 */
  private readonly writeChains = new Map<string, Promise<unknown>>();

  /** FR-4.4：readFile 时记录 ETag，writeFile 时用于 If-Match 条件写。 */
  private readonly etags = new Map<string, string>();

  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;

  constructor(store: ConnectionStore) {
    this.store = store;
    this.cache = new MetadataCache(config<number>('cacheTtlSeconds', 30));
    this.resolver = new ConnectionResolver(store, () => ({
      connectTimeoutMs: config<number>('connectTimeoutMs', 10000),
      requestTimeoutMs: config<number>('requestTimeoutMs', 60000),
      maxConcurrent: config<number>('maxConcurrentRequests', 6),
      maxRetries: config<number>('maxRetries', 2),
      // FR-1.6：默认继承 VSCode 的 http.proxy / http.noProxy
      ...(resolveProxy() !== undefined ? { proxy: resolveProxy() } : {}),
      ...(resolveNoProxy() !== undefined ? { noProxy: resolveNoProxy() } : {}),
    }));

    this.poller = new DirectoryPoller({
      cache: this.cache,
      resolver: this.resolver,
      onChanged: (connectionId, path) =>
        this.fire(buildUri(connectionId, path), vscode.FileChangeType.Changed),
      log,
    });
    this.poller.configure(config<number>('pollIntervalSeconds', 0));

    store.onDidChange(() => {
      // 配置变更后既有客户端可能已失效（5.4）
      this.resolver.disposeAll();
      this.cache.clear();
    });
  }

  dispose(): void {
    this.poller.dispose();
    this.resolver.disposeAll();
    this.emitter.dispose();
  }

  /**
   * 暴露 resolver 供 TreeView 与 QuickPick 复用**同一实例**。
   * 若各自新建，会得到独立的连接池与 Digest 质询状态，
   * 既浪费连接也让 NFR-1.3 的并发上限失去意义。
   */
  get connectionResolver(): ConnectionResolver {
    return this.resolver;
  }

  /** 供配置变更时刷新 TTL。 */
  refreshConfig(): void {
    this.cache.setTtl(config<number>('cacheTtlSeconds', 30));
    this.poller.configure(config<number>('pollIntervalSeconds', 0));
  }

  // ---- FR-3.9 watch：WebDAV 无推送能力，实现为 no-op ----

  watch(): vscode.Disposable {
    // 外部变更依赖 FR-2.4 的手动刷新；此处返回空 Disposable 是正确实现，不是缺陷。
    return new vscode.Disposable(() => undefined);
  }

  // ---- FR-3.1 stat ----

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { connectionId, path } = parseUri(uri);
    const cached = this.cache.getStat(connectionId, path);
    if (cached) return toFileStat(cached, this.isReadonly(connectionId));

    return this.guard(uri, async () => {
      const { dav } = await this.session(connectionId);
      const stat = await this.cache.dedupe(`stat ${connectionId} ${path}`, () =>
        dav.stat(path)
      );
      this.cache.setStat(connectionId, path, stat);
      return toFileStat(stat, this.isReadonly(connectionId));
    });
  }

  // ---- FR-3.2 readDirectory ----

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { connectionId, path } = parseUri(uri);
    const cached = this.cache.getChildren(connectionId, path);
    if (cached) return cached.map(toTuple);

    return this.guard(uri, async () => {
      const { dav } = await this.session(connectionId);
      const children = await this.cache.dedupe(`list ${connectionId} ${path}`, () =>
        dav.list(path)
      );
      // NFR-1.1：一次 Depth:1 回填全部子项 stat
      this.cache.setChildren(connectionId, path, children);
      // T-4.3：只轮询用户实际浏览过的目录
      this.poller.track(connectionId, path, children);
      return children.map(toTuple);
    });
  }

  // ---- FR-3.3 readFile ----

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { connectionId, path } = parseUri(uri);

    return this.guard(uri, async () => {
      const { dav } = await this.session(connectionId);
      const limit = maxBytes();

      // 先用缓存或 HEAD 判断大小，避免下载超限文件后才报错（FR-3.3、5.5）
      const known = this.cache.getStat(connectionId, path);
      if (known && known.size > limit) throw tooLarge(known.size, limit);

      const result = await withTransferProgress(
        `正在下载 ${basename(path)}`,
        known?.size,
        (onProgress, signal) => dav.read(path, { onProgress, signal })
      );
      if (result.data.length > limit) throw tooLarge(result.data.length, limit);

      if (result.etag) this.etags.set(etagKey(connectionId, path), result.etag);
      return new Uint8Array(result.data);
    });
  }

  // ---- FR-3.4 writeFile ----

  /**
   * 按 `options: { create, overwrite }` 组合正确抛出 FileExists / FileNotFound，
   * 否则「新建文件 / 另存为」行为异常（FR-3.4 明确要求）。
   */
  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { readonly create: boolean; readonly overwrite: boolean }
  ): Promise<void> {
    const { connectionId, path } = parseUri(uri);
    this.assertWritable(connectionId, uri);

    const limit = maxBytes();
    if (content.length > limit) {
      throw toFsError(tooLarge(content.length, limit), uri);
    }

    // NFR-1.3：同一文件的写请求串行化，避免并发 PUT 互相覆盖
    return this.serializeWrite(connectionId, path, () =>
      this.guard(uri, async () => {
        const { dav } = await this.session(connectionId);
        const existing = await this.probe(dav, connectionId, path);

        if (!existing && !options.create) {
          throw new WebdavError('NotFound', '目标文件不存在');
        }
        if (existing && !options.overwrite) {
          throw new WebdavError('Conflict', '目标文件已存在');
        }
        if (existing?.isDirectory) {
          throw new WebdavError('Conflict', '目标是一个目录');
        }

        const etag = this.etags.get(etagKey(connectionId, path));
        const body = Buffer.from(content);

        let newEtag: string | undefined;
        try {
          newEtag = await withTransferProgress(
            `正在保存 ${basename(path)}`,
            body.length,
            (onProgress, signal) =>
              dav.write(path, body, {
                // FR-4.4：仅在覆盖既有文件时做条件写
                ...(existing && etag ? { ifMatch: etag } : {}),
                onProgress,
                signal,
              })
          );
        } catch (err) {
          // T-3.2：412 表示远端已被他人修改，交给用户三选一
          if (isWebdavError(err) && err.code === 'PreconditionFailed') {
            newEtag = await this.resolveWriteConflict(uri, dav, path, body, connectionId);
          } else {
            throw err;
          }
        }

        if (newEtag) this.etags.set(etagKey(connectionId, path), newEtag);
        else this.etags.delete(etagKey(connectionId, path));

        this.cache.invalidate(connectionId, path);
        this.fire(
          uri,
          existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created
        );
      })
    );
  }

  // ---- FR-3.5 createDirectory ----

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { connectionId, path } = parseUri(uri);
    this.assertWritable(connectionId, uri);

    return this.guard(uri, async () => {
      const { dav } = await this.session(connectionId);
      await dav.mkcol(path);
      this.cache.invalidate(connectionId, path);
      this.fire(uri, vscode.FileChangeType.Created);
    });
  }

  // ---- FR-3.6 delete ----

  async delete(uri: vscode.Uri, options: { readonly recursive: boolean }): Promise<void> {
    const { connectionId, path } = parseUri(uri);
    this.assertWritable(connectionId, uri);

    return this.guard(uri, async () => {
      const { dav } = await this.session(connectionId);
      const stat = this.cache.getStat(connectionId, path);
      // 目录删除一律带 Depth: infinity（5.3）
      await dav.remove(path, options.recursive || stat?.isDirectory === true);

      this.cache.invalidateSubtree(connectionId, path);
      this.etags.delete(etagKey(connectionId, path));
      this.fire(uri, vscode.FileChangeType.Deleted);
    });
  }

  // ---- FR-3.7 rename ----

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    const from = parseUri(oldUri);
    const to = parseUri(newUri);
    this.assertWritable(from.connectionId, oldUri);
    this.assertSameConnection(from.connectionId, to.connectionId, newUri);

    return this.guard(oldUri, async () => {
      const { dav } = await this.session(from.connectionId);
      await dav.move(from.path, to.path, options.overwrite);

      this.cache.invalidateSubtree(from.connectionId, from.path);
      this.cache.invalidate(to.connectionId, to.path);
      this.etags.delete(etagKey(from.connectionId, from.path));
      this.emitter.fire([
        { type: vscode.FileChangeType.Deleted, uri: oldUri },
        { type: vscode.FileChangeType.Created, uri: newUri },
      ]);
    });
  }

  // ---- FR-3.8 copy ----

  /**
   * 实现该可选方法后，VSCode 会直接走 WebDAV COPY，
   * 而不是回退为「下载 + 上传」（FR-3.8 的理由）。
   */
  async copy(
    source: vscode.Uri,
    destination: vscode.Uri,
    options: { readonly overwrite: boolean }
  ): Promise<void> {
    const from = parseUri(source);
    const to = parseUri(destination);
    this.assertWritable(from.connectionId, source);
    this.assertSameConnection(from.connectionId, to.connectionId, destination);

    return this.guard(source, async () => {
      const { dav } = await this.session(from.connectionId);
      try {
        await dav.copy(from.path, to.path, options.overwrite);
      } catch (err) {
        // 服务端不支持 COPY 时回退为 read + write（5.3 表中记录的降级路径）。
        //
        // 除 405/501 外还覆盖 500：实测 AList（对象存储后端）对 COPY 返回裸 500，
        // 而非规范建议的 405/501。用户的意图是「复制这个文件」——服务端做不了原生
        // COPY 时，下载+上传能达成同样结果；硬失败则什么也得不到。
        // 真正的服务端故障会在回退路径上同样失败，因此不会掩盖问题。
        if (isWebdavError(err) && (err.code === 'NotSupported' || err.code === 'ServerError')) {
          log.info(`服务端 COPY 失败（${err.code} ${err.status ?? '-'}），回退为下载+上传`);
          const data = await dav.read(from.path);
          await dav.write(to.path, data.data);
        } else {
          throw err;
        }
      }
      this.cache.invalidate(to.connectionId, to.path);
      this.fire(destination, vscode.FileChangeType.Created);
    });
  }

  // ---- FR-2.4 手动刷新 ----

  /** 清除指定路径子树的缓存并通知 VSCode 重新拉取。 */
  refresh(uri: vscode.Uri): void {
    const { connectionId, path } = parseUri(uri);
    this.cache.invalidateSubtree(connectionId, path);
    this.fire(uri, vscode.FileChangeType.Changed);
  }

  // ---- 内部 ----

  /**
   * 懒加载会话，委托给 resolver（5.2 第 3 条）。
   * 仍保留 async 签名：调用点全部在 IO 路径上，且未来若需在此处 await
   * 能力探测（OPTIONS），无需再改所有调用方。
   */
  private async session(connectionId: string): Promise<{ dav: WebdavClient }> {
    return this.resolver.resolve(connectionId);
  }

  /**
   * 保存冲突处理（PRD FR-4.4 / T-3.2）。
   *
   * 只在 If-Match 失配（412）时进入。三个选项对应 PRD 的措辞：
   * 覆盖远端 / 放弃本地修改并重载 / 另存为新文件。
   * 用户取消则抛回 412，编辑器保持「未保存」状态——这是正确的：
   * 静默丢弃用户的修改比报错糟糕得多。
   */
  private async resolveWriteConflict(
    uri: vscode.Uri,
    dav: WebdavClient,
    path: string,
    body: Buffer,
    connectionId: string
  ): Promise<string | undefined> {
    const name = basename(path);
    const choice = await vscode.window.showWarningMessage(
      `「${name}」在远端已被他人修改。`,
      { modal: true, detail: '你的本地修改与远端版本产生冲突，请选择处理方式。' },
      '覆盖远端',
      '放弃本地修改并重载',
      '另存为新文件'
    );

    switch (choice) {
      case '覆盖远端': {
        // 不带 If-Match 强制写入
        const etag = await dav.write(path, body);
        log.info(`冲突：用户选择覆盖远端 ${path}`);
        return etag;
      }

      case '放弃本地修改并重载': {
        this.cache.invalidate(connectionId, path);
        this.etags.delete(etagKey(connectionId, path));
        log.info(`冲突：用户选择放弃本地修改 ${path}`);
        // 通知编辑器重新读取远端内容
        this.fire(uri, vscode.FileChangeType.Changed);
        await vscode.commands.executeCommand('workbench.action.files.revert');
        return undefined;
      }

      case '另存为新文件': {
        const suffix = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const target = insertBeforeExtension(path, `.conflict-${suffix}`);
        const etag = await dav.write(target, body);
        this.cache.invalidate(connectionId, target);
        log.info(`冲突：用户选择另存为 ${target}`);
        void vscode.window.showInformationMessage(`已另存为 ${basename(target)}`);
        return etag;
      }

      default:
        // 用户取消：把 412 抛回，保持文档为未保存状态
        throw new WebdavError(
          'PreconditionFailed',
          `「${name}」未保存：远端已被他人修改`
        );
    }
  }

  /** 探测目标是否存在，供 writeFile 判定 create/overwrite 语义。 */
  private async probe(
    dav: WebdavClient,
    connectionId: string,
    path: string
  ): Promise<Stat | undefined> {
    const cached = this.cache.getStat(connectionId, path);
    if (cached) return cached;
    try {
      return await dav.stat(path, 'writeFile 前置检查');
    } catch (err) {
      if (isWebdavError(err) && err.code === 'NotFound') return undefined;
      throw err;
    }
  }

  private isReadonly(connectionId: string): boolean {
    return this.store.get(connectionId)?.readonly === true;
  }

  private assertWritable(connectionId: string, uri: vscode.Uri): void {
    if (this.isReadonly(connectionId)) {
      throw vscode.FileSystemError.NoPermissions(uri);
    }
  }

  private assertSameConnection(a: string, b: string, uri: vscode.Uri): void {
    if (a !== b) {
      // 跨连接的 MOVE/COPY 无法用单次 WebDAV 动作完成。
      // Destination 头必须与源同源，跨源须走「下载+上传」，超出 MVP 范围。
      log.info(`拒绝跨连接操作: ${a} -> ${b} (${uri.toString()})`);
      throw vscode.FileSystemError.Unavailable('不支持跨 WebDAV 连接的移动或复制');
    }
  }

  private serializeWrite<T>(
    connectionId: string,
    path: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const key = `${connectionId} ${path}`;
    const prev = this.writeChains.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    this.writeChains.set(
      key,
      next.catch(() => undefined)
    );
    void next.finally(() => {
      if (this.writeChains.get(key) === undefined) this.writeChains.delete(key);
    });
    return next;
  }

  private fire(uri: vscode.Uri, type: vscode.FileChangeType): void {
    this.emitter.fire([{ type, uri }]);
  }

  /** 统一异常出口：协议层错误 → vscode.FileSystemError（FR-4.2）。 */
  private async guard<T>(uri: vscode.Uri, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MissingCredentialsError) {
        this.onMissingCredentials(err.connectionId);
        throw vscode.FileSystemError.NoPermissions(uri);
      }
      if (err instanceof vscode.FileSystemError) throw err;
      throw toFsError(err, uri);
    }
  }

  /**
   * SecretStorage 不参与 Settings Sync，新设备上凭据为空。
   * 这里给一次性引导，而非让用户看到一串「无权限」（FR-1.2）。
   */
  private onMissingCredentials(connectionId: string): void {
    if (this.promptedForCredentials.has(connectionId)) return;
    this.promptedForCredentials.add(connectionId);

    const conn = this.store.get(connectionId);
    const name = conn?.alias ?? connectionId;
    void vscode.window
      .showWarningMessage(
        `WebDAV 连接「${name}」缺少密码。密码不随设置同步，需要在本设备重新输入。`,
        '输入密码'
      )
      .then(async (choice) => {
        if (choice !== '输入密码') return;
        const password = await vscode.window.showInputBox({
          prompt: `请输入「${name}」的密码或 Token`,
          password: true,
          ignoreFocusOut: true,
        });
        if (password === undefined) return;
        await this.store.setPassword(connectionId, password);
        this.promptedForCredentials.delete(connectionId);
        this.cache.clearConnection(connectionId);
        void vscode.commands.executeCommand('workbench.files.action.refreshFilesExplorer');
      });
  }
}

// ---- URI 与类型转换 ----

export interface ParsedUri {
  connectionId: string;
  path: string;
}

/** `webdav://<connectionId>/<remotePath>`（PRD 5.1）。 */
export function parseUri(uri: vscode.Uri): ParsedUri {
  return {
    connectionId: uri.authority,
    path: uri.path || '/',
  };
}

export function buildUri(connectionId: string, path: string): vscode.Uri {
  return vscode.Uri.from({
    scheme: 'webdav',
    authority: connectionId,
    path: path.startsWith('/') ? path : '/' + path,
  });
}

function toFileStat(stat: Stat, readonly: boolean): vscode.FileStat {
  const base = {
    type: stat.isDirectory ? vscode.FileType.Directory : vscode.FileType.File,
    ctime: stat.ctime,
    mtime: stat.mtime,
    size: stat.size,
  };
  return readonly
    ? { ...base, permissions: vscode.FilePermission.Readonly }
    : base;
}

function toTuple(e: { name: string; isDirectory: boolean }): [string, vscode.FileType] {
  return [e.name, e.isDirectory ? vscode.FileType.Directory : vscode.FileType.File];
}

function tooLarge(actual: number, limit: number): WebdavError {
  const mb = (n: number): string => (n / 1024 / 1024).toFixed(1);
  return new WebdavError(
    'TooLarge',
    `文件大小 ${mb(actual)}MB 超过上限 ${mb(limit)}MB。` +
      `VSCode 的文件系统接口不支持流式读写，可在设置 webdavEdit.maxFileSizeMB 中调整上限。`
  );
}

/**
 * 传输进度提示与取消（PRD FR-4.1 / T-3.1）。
 *
 * 只有「预计会慢」时才弹进度条：小文件瞬间完成，弹一下反而是噪音。
 * 判据取 FR-4.1 的两条——超过 1MB，或耗时超过 1 秒。因此进度条是**延迟出现**的：
 * 先无声开始传输，1 秒后仍未完成才显形。
 */
const PROGRESS_DELAY_MS = 1000;
const PROGRESS_SIZE_THRESHOLD = 1024 * 1024;

async function withTransferProgress<T>(
  title: string,
  expectedBytes: number | undefined,
  run: (
    onProgress: (transferred: number, total: number | undefined) => void,
    signal: AbortSignal
  ) => Promise<T>
): Promise<T> {
  const controller = new AbortController();
  const big = (expectedBytes ?? 0) >= PROGRESS_SIZE_THRESHOLD;

  let report: ((pct: number, msg: string) => void) | undefined;
  let finished = false;
  let settleProgress: (() => void) | undefined;
  let lastPct = 0;

  const onProgress = (transferred: number, total: number | undefined): void => {
    const known = total ?? expectedBytes;
    if (!report) return;
    if (known && known > 0) {
      const pct = Math.min(100, Math.floor((transferred / known) * 100));
      if (pct > lastPct) {
        report(pct - lastPct, `${formatBytes(transferred)} / ${formatBytes(known)}`);
        lastPct = pct;
      }
    } else {
      report(0, formatBytes(transferred));
    }
  };

  /** 到点仍未结束才显示进度条。 */
  const showProgress = (): void => {
    if (finished) return;
    void vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: true,
      },
      (progress, token) =>
        new Promise<void>((resolve) => {
          settleProgress = resolve;
          report = (increment, message) => progress.report({ increment, message });
          token.onCancellationRequested(() => controller.abort());
          if (finished) resolve();
        })
    );
  };

  const timer = big ? undefined : setTimeout(showProgress, PROGRESS_DELAY_MS);
  if (big) showProgress();

  try {
    return await run(onProgress, controller.signal);
  } finally {
    finished = true;
    if (timer) clearTimeout(timer);
    settleProgress?.();
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 在扩展名之前插入后缀：`a/b.txt` + `.conflict-x` → `a/b.conflict-x.txt`。 */
export function insertBeforeExtension(path: string, suffix: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  if (dot <= slash + 1) return path + suffix; // 无扩展名，或以点开头的隐藏文件
  return path.slice(0, dot) + suffix + path.slice(dot);
}

function config<T>(key: string, fallback: T): T {
  return vscode.workspace.getConfiguration('webdavEdit').get<T>(key, fallback);
}

/**
 * FR-1.6：代理默认取 VSCode 的 `http.proxy`；扩展自身配置可覆盖。
 * 两者都为空时退回环境变量，与命令行工具的惯例一致。
 */
function resolveProxy(): string | undefined {
  const own = config<string>('proxy', '');
  if (own) return own;
  const vs = vscode.workspace.getConfiguration('http').get<string>('proxy', '');
  if (vs) return vs;
  return process.env['https_proxy'] ?? process.env['HTTPS_PROXY'] ?? undefined;
}

function resolveNoProxy(): string | undefined {
  const own = config<string>('noProxy', '');
  if (own) return own;
  return process.env['no_proxy'] ?? process.env['NO_PROXY'] ?? undefined;
}

function maxBytes(): number {
  return Math.max(1, config<number>('maxFileSizeMB', 50)) * 1024 * 1024;
}

function etagKey(connectionId: string, path: string): string {
  return `${connectionId} ${path}`;
}

