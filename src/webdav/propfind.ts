/**
 * PROPFIND 请求构造与响应解析（PRD 5.3、FR-3.1、FR-3.2）。
 *
 * 这是服务端差异（风险 R2）的集中地：
 *   - `<D:href>` 可能是绝对 URL / 绝对路径 / 相对路径，且已被百分号编码。
 *   - 命名空间前缀不固定（`D:`、`d:`、`lp1:`，或无前缀）。
 *   - `Depth: 1` 的结果里含目录自身，必须过滤。
 *   - 目录条目未必返回 `getcontentlength`，日期格式也不统一。
 *
 * 不依赖 `vscode`，可脱离扩展宿主单测（NFR-4.1）。
 */
import { XMLParser } from 'fast-xml-parser';
import { WebdavError } from './errors.ts';
import { hrefToAbsolutePath, stripTrailingSlash } from './path.ts';

export interface RemoteEntry {
  /** 服务器上的绝对**解码后**路径（尚未剥离 pathPrefix）。 */
  absPath: string;
  isDirectory: boolean;
  size: number;
  mtime: number;
  ctime: number;
  etag?: string;
}

/** 只请求需要的属性，减小响应体积（NFR-1.4）。 */
export const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<D:propfind xmlns:D="DAV:"><D:prop>' +
  '<D:resourcetype/>' +
  '<D:getcontentlength/>' +
  '<D:getlastmodified/>' +
  '<D:creationdate/>' +
  '<D:getetag/>' +
  '</D:prop></D:propfind>';

const parser = new XMLParser({
  ignoreAttributes: true,
  // 剥离命名空间前缀，抹平 D:/d:/lp1: 等差异
  transformTagName: (tag: string) => {
    const idx = tag.indexOf(':');
    return (idx >= 0 ? tag.slice(idx + 1) : tag).toLowerCase();
  },
  parseTagValue: false,
  trimValues: true,
});

/**
 * 解析 207 Multi-Status 响应体。
 *
 * @param requestPath 发起请求的**编码后**路径，用于解析相对 href 并识别自身条目。
 */
export function parseMultiStatus(xml: string, requestPath: string): RemoteEntry[] {
  let doc: unknown;
  try {
    doc = parser.parse(xml);
  } catch (err) {
    throw new WebdavError('ProtocolError', '服务端返回的 XML 无法解析', { cause: err });
  }

  const multistatus = pick(doc, 'multistatus');
  if (!multistatus) {
    throw new WebdavError('ProtocolError', '服务端响应缺少 multistatus 元素');
  }

  const responses = asArray(pick(multistatus, 'response'));
  const entries: RemoteEntry[] = [];

  for (const res of responses) {
    const href = text(pick(res, 'href'));
    if (!href) continue;

    // 一个 response 可能含多个 propstat（按 HTTP 状态分组），只取 2xx 的那组
    const propstat = asArray(pick(res, 'propstat')).find((ps) => {
      const status = text(pick(ps, 'status'));
      return !status || / 2\d\d /.test(status);
    });
    const prop = propstat ? pick(propstat, 'prop') : undefined;
    if (!prop) continue;

    entries.push(toEntry(href, prop, requestPath));
  }

  return entries;
}

function toEntry(href: string, prop: unknown, requestPath: string): RemoteEntry {
  const absPath = hrefToAbsolutePath(href, requestPath);

  const resourcetype = pick(prop, 'resourcetype');
  // <collection/> 存在即为目录。空标签在 fast-xml-parser 下是空字符串，
  // 因此用 key 是否存在判断，不能用真值判断。
  const isDirectory =
    resourcetype !== undefined &&
    resourcetype !== null &&
    typeof resourcetype === 'object' &&
    'collection' in (resourcetype as Record<string, unknown>);

  const size = Number(text(pick(prop, 'getcontentlength')) ?? '0');
  const mtime = parseDate(text(pick(prop, 'getlastmodified')));
  const ctime = parseDate(text(pick(prop, 'creationdate'))) || mtime;
  const etag = normalizeEtag(text(pick(prop, 'getetag')));

  return {
    absPath,
    isDirectory,
    size: Number.isFinite(size) && size >= 0 ? size : 0,
    mtime,
    ctime,
    ...(etag !== undefined ? { etag } : {}),
  };
}

/**
 * 从 Depth:1 的结果中剔除代表目录自身的那条（5.3 强制要求）。
 * 比对前统一去掉尾斜杠——不同服务端对目录 href 是否带尾 `/` 表现不一。
 */
export function excludeSelf(entries: RemoteEntry[], selfAbsPath: string): RemoteEntry[] {
  const self = stripTrailingSlash(selfAbsPath);
  return entries.filter((e) => stripTrailingSlash(e.absPath) !== self);
}

/** 在结果中找出代表自身的那条（供 stat 使用，含 Depth:0 回退场景）。 */
export function findSelf(
  entries: RemoteEntry[],
  selfAbsPath: string
): RemoteEntry | undefined {
  const self = stripTrailingSlash(selfAbsPath);
  return entries.find((e) => stripTrailingSlash(e.absPath) === self);
}

/**
 * 解析日期。`getlastmodified` 规范上是 RFC 1123，`creationdate` 是 ISO 8601，
 * 但实测两者都可能出现，因此统一交给 Date 解析，失败则返回 0。
 */
export function parseDate(v: string | undefined): number {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isNaN(t) ? 0 : t;
}

/** 去掉 ETag 的弱标记与引号，便于稳定比对（FR-4.4）。 */
export function normalizeEtag(v: string | undefined): string | undefined {
  if (!v) return undefined;
  return v.replace(/^\s*W\//i, '').replace(/^"|"$/g, '').trim() || undefined;
}

// ---- 小工具：容忍 fast-xml-parser 的各种返回形态 ----

function pick(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== 'object') return undefined;
  return (obj as Record<string, unknown>)[key];
}

function asArray(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function text(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  // <status>HTTP/1.1 200 OK</status> 之类可能被解析成带 #text 的对象
  const t = (v as Record<string, unknown>)['#text'];
  return typeof t === 'string' ? t : undefined;
}
