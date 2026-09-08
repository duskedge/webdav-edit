/**
 * WebDAV 路径编码 / 解码规则（PRD 5.3）。
 *
 * 这是此类客户端历史上的首要 Bug 来源，因此独立成模块并配有穷举字符样例的单测。
 * 三条规则：
 *   1. 出站：按 segment 逐段 encodeURIComponent，保留 `/` 作分隔符。
 *   2. 入站：`<D:href>` 可能是绝对 URL / 绝对路径 / 相对路径，且已被百分号编码。
 *      须先归一化为绝对路径 → 解码 → 剥离 pathPrefix。
 *   3. 目录尾斜杠在不同服务端表现不一，比对前统一归一化。
 */

/**
 * 逐段编码为 WebDAV 请求路径。
 *
 * `encodeURIComponent` 不编码 `!'()*`，其中 `'`、`(`、`)` 在部分服务端的 XML/URL
 * 处理链路上会出问题，因此额外编码，与 RFC 3986 的 unreserved 集合对齐。
 */
export function encodePath(decodedPath: string): string {
  return normalizeSlashes(decodedPath).split('/').map(encodeSegment).join('/');
}

export function encodeSegment(segment: string): string {
  return encodeURIComponent(segment).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

/** 解码一条 href 的路径部分。非法百分号序列不抛错，原样保留。 */
export function decodePath(encodedPath: string): string {
  return normalizeSlashes(encodedPath)
    .split('/')
    .map((seg) => {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    })
    .join('/');
}

/** 折叠重复斜杠并保证以 `/` 开头。不改变尾斜杠。 */
export function normalizeSlashes(p: string): string {
  const collapsed = p.replace(/\/{2,}/g, '/');
  return collapsed.startsWith('/') ? collapsed : '/' + collapsed;
}

/** 去除尾斜杠（根路径 `/` 除外），用于路径相等性比对。 */
export function stripTrailingSlash(p: string): string {
  if (p.length > 1 && p.endsWith('/')) {
    return p.replace(/\/+$/, '') || '/';
  }
  return p;
}

/**
 * 解析 `<D:href>` 为服务器上的绝对**解码后**路径。
 * 支持三种形态：绝对 URL、绝对路径、相对路径（相对于 requestPath）。
 */
export function hrefToAbsolutePath(href: string, requestPath: string): string {
  let raw = href.trim();

  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) {
    // 绝对 URL：取其 pathname（保留原始百分号编码）
    try {
      raw = new URL(raw).pathname;
    } catch {
      // 解析失败则落到下面按路径处理
    }
  }

  if (!raw.startsWith('/')) {
    // 相对路径：以请求路径所在目录为基准
    const base = requestPath.endsWith('/')
      ? requestPath
      : requestPath.slice(0, requestPath.lastIndexOf('/') + 1);
    raw = base + raw;
  }

  return decodePath(raw);
}

/**
 * 从服务器绝对路径中剥离连接的 pathPrefix，得到工作区内路径。
 * 不匹配前缀时返回 undefined（调用方据此判定该条目不属于本连接）。
 */
export function stripPrefix(absPath: string, pathPrefix: string): string | undefined {
  const prefix = stripTrailingSlash(normalizeSlashes(pathPrefix || '/'));
  const abs = stripTrailingSlash(normalizeSlashes(absPath));
  if (prefix === '/') {
    return abs;
  }
  if (abs === prefix) {
    return '/';
  }
  if (abs.startsWith(prefix + '/')) {
    return abs.slice(prefix.length);
  }
  return undefined;
}

/** 拼接 pathPrefix 与工作区内路径，得到服务器绝对**解码后**路径。 */
export function joinPrefix(pathPrefix: string, path: string): string {
  const prefix = stripTrailingSlash(normalizeSlashes(pathPrefix || '/'));
  const rel = normalizeSlashes(path);
  if (prefix === '/') {
    return rel;
  }
  return rel === '/' ? prefix : prefix + rel;
}

/** 父目录路径。根的父仍是根。 */
export function dirname(p: string): string {
  const s = stripTrailingSlash(normalizeSlashes(p));
  if (s === '/') return '/';
  const idx = s.lastIndexOf('/');
  return idx <= 0 ? '/' : s.slice(0, idx);
}

/** 最后一段名称（已解码）。 */
export function basename(p: string): string {
  const s = stripTrailingSlash(normalizeSlashes(p));
  if (s === '/') return '';
  return s.slice(s.lastIndexOf('/') + 1);
}

/**
 * 校验远端返回的文件名，防御路径穿越与控制字符（NFR-2.5）。
 * 远端文件名视为不可信输入。
 */
export function isSafeName(name: string): boolean {
  if (!name || name === '.' || name === '..') return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (/[\u0000-\u001F\u007F]/.test(name)) return false;
  return true;
}
