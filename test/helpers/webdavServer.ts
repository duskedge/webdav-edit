/**
 * 内存版 WebDAV 测试服务端。
 *
 * 用于端到端验证 httpClient + client + propfind + path 的协作。
 * 刻意模拟 5.6 矩阵中的真实差异：可配置 href 形态、是否支持 Depth:0、
 * 是否支持 COPY/MOVE，以便对回退路径做验证。
 */
import * as http from 'http';
import type { AddressInfo } from 'net';

export interface ServerOptions {
  /** 服务端 WebDAV 根前缀，如 '/dav'。 */
  prefix?: string;
  /** href 形态：绝对路径（多数）或绝对 URL（部分服务端）。 */
  hrefStyle?: 'path' | 'url';
  /** 模拟不支持 Depth:0 的服务端（返回 400），验证 stat 回退父目录。 */
  supportDepth0?: boolean;
  /** 模拟不支持 COPY 的服务端（返回 405），验证降级为下载+上传。 */
  supportCopy?: boolean;
  /** 要求 Basic 认证。 */
  auth?: { username: string; password: string };
}

interface FileNode {
  type: 'file';
  content: Buffer;
  mtime: Date;
  etag: string;
}
interface DirNode {
  type: 'dir';
  mtime: Date;
}
type Node = FileNode | DirNode;

export class TestWebdavServer {
  private readonly server: http.Server;
  private readonly nodes = new Map<string, Node>();
  private readonly opts: Required<Omit<ServerOptions, 'auth'>> & Pick<ServerOptions, 'auth'>;
  private etagSeq = 0;
  port = 0;

  /** 记录收到的请求，供断言协议细节（如 Depth 头、Destination 头）。 */
  readonly requests: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }> = [];

  constructor(options: ServerOptions = {}) {
    this.opts = {
      prefix: options.prefix ?? '',
      hrefStyle: options.hrefStyle ?? 'path',
      supportDepth0: options.supportDepth0 ?? true,
      supportCopy: options.supportCopy ?? true,
      ...(options.auth ? { auth: options.auth } : {}),
    };
    this.nodes.set('/', { type: 'dir', mtime: new Date('2025-01-01T00:00:00Z') });
    this.server = http.createServer((req, res) => this.handle(req, res));
  }

  /** 最近一次收到的请求。断言协议细节（Depth / Destination / Overwrite）时使用。 */
  lastRequest(): { method: string; path: string; headers: http.IncomingHttpHeaders } | undefined {
    return this.requests[this.requests.length - 1];
  }

  /** 按方法过滤已收到的请求。 */
  requestsOf(method: string): Array<{ path: string; headers: http.IncomingHttpHeaders }> {
    return this.requests.filter((r) => r.method === method);
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return `http://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) =>
      this.server.close((e) => (e ? reject(e) : resolve()))
    );
  }

  // ---- 测试夹具操作（使用**解码后**的内部路径）----

  addFile(path: string, content: string): void {
    this.ensureParents(path);
    this.nodes.set(norm(path), {
      type: 'file',
      content: Buffer.from(content, 'utf8'),
      mtime: new Date('2025-06-01T12:00:00Z'),
      etag: `etag-${++this.etagSeq}`,
    });
  }

  addDir(path: string): void {
    this.ensureParents(path);
    this.nodes.set(norm(path), { type: 'dir', mtime: new Date('2025-06-01T12:00:00Z') });
  }

  has(path: string): boolean {
    return this.nodes.has(norm(path));
  }

  read(path: string): string | undefined {
    const n = this.nodes.get(norm(path));
    return n?.type === 'file' ? n.content.toString('utf8') : undefined;
  }

  private ensureParents(path: string): void {
    const parts = norm(path).split('/').filter(Boolean);
    let cur = '';
    for (let i = 0; i < parts.length - 1; i++) {
      cur += '/' + parts[i];
      if (!this.nodes.has(cur)) {
        this.nodes.set(cur, { type: 'dir', mtime: new Date('2025-01-01T00:00:00Z') });
      }
    }
  }

  // ---- 请求处理 ----

  private handle(req: http.IncomingMessage, res: http.ServerResponse): void {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      this.requests.push({
        method: req.method ?? '',
        path: req.url ?? '',
        headers: req.headers,
      });
      try {
        this.route(req, res, body);
      } catch (err) {
        res.writeHead(500).end(String(err));
      }
    });
  }

  private route(req: http.IncomingMessage, res: http.ServerResponse, body: Buffer): void {
    if (!this.checkAuth(req, res)) return;

    const target = this.toInternal(req.url ?? '/');
    if (target === undefined) {
      res.writeHead(404).end();
      return;
    }

    switch (req.method) {
      case 'PROPFIND':
        return this.propfind(req, res, target);
      case 'GET':
        return this.get(res, target);
      case 'HEAD':
        return this.head(res, target);
      case 'PUT':
        return this.put(req, res, target, body);
      case 'MKCOL':
        return this.mkcol(res, target);
      case 'DELETE':
        return this.del(res, target);
      case 'MOVE':
      case 'COPY':
        return this.moveOrCopy(req, res, target);
      default:
        res.writeHead(405).end();
    }
  }

  private checkAuth(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (!this.opts.auth) return true;
    const header = req.headers['authorization'];
    const expected =
      'Basic ' +
      Buffer.from(`${this.opts.auth.username}:${this.opts.auth.password}`).toString('base64');
    if (header !== expected) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="test"' }).end();
      return false;
    }
    return true;
  }

  /** 请求 URL（编码后、含 prefix）→ 内部解码路径。 */
  private toInternal(url: string): string | undefined {
    const decoded = decodeURIComponent(url.split('?')[0] ?? '/');
    if (this.opts.prefix && !decoded.startsWith(this.opts.prefix)) return undefined;
    const rest = this.opts.prefix ? decoded.slice(this.opts.prefix.length) : decoded;
    return norm(rest || '/');
  }

  /** 内部路径 → 响应中的 href（编码后、含 prefix）。 */
  private toHref(path: string, isDir: boolean): string {
    const encoded = norm(path)
      .split('/')
      .map((s) => encodeURIComponent(s))
      .join('/');
    const full = (this.opts.prefix + encoded).replace(/\/+$/, '') || '/';
    const withSlash = isDir && full !== '/' ? full + '/' : full;
    return this.opts.hrefStyle === 'url'
      ? `http://127.0.0.1:${this.port}${withSlash}`
      : withSlash;
  }

  private propfind(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: string
  ): void {
    const depth = String(req.headers['depth'] ?? '1');

    if (depth === '0' && !this.opts.supportDepth0) {
      res.writeHead(400).end('Depth: 0 not supported');
      return;
    }

    const node = this.nodes.get(target);
    if (!node) {
      res.writeHead(404).end();
      return;
    }

    const entries: Array<[string, Node]> = [[target, node]];
    if (depth === '1' && node.type === 'dir') {
      for (const [p, n] of this.nodes) {
        if (p !== target && parentOf(p) === target) entries.push([p, n]);
      }
    }

    const xml =
      '<?xml version="1.0" encoding="utf-8"?>\n<D:multistatus xmlns:D="DAV:">' +
      entries.map(([p, n]) => this.responseXml(p, n)).join('') +
      '</D:multistatus>';

    res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8', DAV: '1,2' });
    res.end(xml);
  }

  private responseXml(path: string, node: Node): string {
    const href = this.toHref(path, node.type === 'dir');
    const common =
      `<D:getlastmodified>${node.mtime.toUTCString()}</D:getlastmodified>` +
      `<D:creationdate>${node.mtime.toISOString()}</D:creationdate>`;

    if (node.type === 'dir') {
      // 目录不返回 getcontentlength，并把它放进 404 分组（Nextcloud 行为）
      return (
        `<D:response><D:href>${href}</D:href>` +
        `<D:propstat><D:prop><D:resourcetype><D:collection/></D:resourcetype>${common}</D:prop>` +
        `<D:status>HTTP/1.1 200 OK</D:status></D:propstat>` +
        `<D:propstat><D:prop><D:getcontentlength/></D:prop>` +
        `<D:status>HTTP/1.1 404 Not Found</D:status></D:propstat></D:response>`
      );
    }
    return (
      `<D:response><D:href>${href}</D:href>` +
      `<D:propstat><D:prop><D:resourcetype/>` +
      `<D:getcontentlength>${node.content.length}</D:getcontentlength>` +
      `<D:getetag>"${node.etag}"</D:getetag>${common}</D:prop>` +
      `<D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`
    );
  }

  private get(res: http.ServerResponse, target: string): void {
    const node = this.nodes.get(target);
    if (!node) return void res.writeHead(404).end();
    if (node.type === 'dir') return void res.writeHead(405).end();
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(node.content.length),
      ETag: `"${node.etag}"`,
    });
    res.end(node.content);
  }

  private head(res: http.ServerResponse, target: string): void {
    const node = this.nodes.get(target);
    if (!node) return void res.writeHead(404).end();
    res.writeHead(200, {
      'Content-Length': node.type === 'file' ? String(node.content.length) : '0',
      ...(node.type === 'file' ? { ETag: `"${node.etag}"` } : {}),
    });
    res.end();
  }

  private put(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    target: string,
    body: Buffer
  ): void {
    const parent = parentOf(target);
    if (!this.nodes.has(parent)) return void res.writeHead(409).end();

    const existing = this.nodes.get(target);
    if (existing?.type === 'dir') return void res.writeHead(405).end();

    // If-Match 条件写（FR-4.4）
    const ifMatch = req.headers['if-match'];
    if (ifMatch && existing?.type === 'file') {
      const want = String(ifMatch).replace(/"/g, '');
      if (want !== existing.etag) return void res.writeHead(412).end();
    }

    const etag = `etag-${++this.etagSeq}`;
    this.nodes.set(target, { type: 'file', content: body, mtime: new Date(), etag });
    res.writeHead(existing ? 204 : 201, { ETag: `"${etag}"` }).end();
  }

  private mkcol(res: http.ServerResponse, target: string): void {
    if (this.nodes.has(target)) return void res.writeHead(405).end();
    if (!this.nodes.has(parentOf(target))) return void res.writeHead(409).end();
    this.nodes.set(target, { type: 'dir', mtime: new Date() });
    res.writeHead(201).end();
  }

  private del(res: http.ServerResponse, target: string): void {
    if (!this.nodes.has(target)) return void res.writeHead(404).end();
    for (const p of [...this.nodes.keys()]) {
      if (p === target || p.startsWith(target === '/' ? '/' : target + '/')) {
        this.nodes.delete(p);
      }
    }
    res.writeHead(204).end();
  }

  private moveOrCopy(req: http.IncomingMessage, res: http.ServerResponse, target: string): void {
    if (req.method === 'COPY' && !this.opts.supportCopy) {
      return void res.writeHead(405).end();
    }
    const destHeader = req.headers['destination'];
    if (!destHeader) return void res.writeHead(400).end();

    // Destination 必须是绝对 URL（5.3 约束），这里严格校验
    let destPath: string;
    try {
      destPath = new URL(String(destHeader)).pathname;
    } catch {
      return void res.writeHead(400).end('Destination must be an absolute URL');
    }
    const dest = this.toInternal(destPath);
    if (dest === undefined) return void res.writeHead(400).end();

    const node = this.nodes.get(target);
    if (!node) return void res.writeHead(404).end();
    if (!this.nodes.has(parentOf(dest))) return void res.writeHead(409).end();

    const exists = this.nodes.has(dest);
    if (exists && String(req.headers['overwrite'] ?? 'T').toUpperCase() === 'F') {
      return void res.writeHead(412).end();
    }

    const moving = req.method === 'MOVE';
    for (const [p, n] of [...this.nodes]) {
      if (p === target || p.startsWith(target + '/')) {
        const newPath = dest + p.slice(target.length);
        this.nodes.set(newPath, n.type === 'file' ? { ...n } : { ...n });
        if (moving) this.nodes.delete(p);
      }
    }
    res.writeHead(exists ? 204 : 201).end();
  }
}

function norm(p: string): string {
  const s = ('/' + p).replace(/\/+/g, '/');
  return s.length > 1 ? s.replace(/\/+$/, '') : '/';
}

function parentOf(p: string): string {
  const s = norm(p);
  if (s === '/') return '/';
  const idx = s.lastIndexOf('/');
  return idx <= 0 ? '/' : s.slice(0, idx);
}
