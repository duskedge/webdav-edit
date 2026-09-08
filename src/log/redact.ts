/**
 * 凭据脱敏（PRD NFR-2.4）。
 *
 * 刻意不依赖 `vscode`：协议层与错误层都要用它，而这两层必须能脱离扩展宿主
 * 单独测试（NFR-4.1）。日志通道相关逻辑在 log.ts。
 */

export const REDACTED = '***';

/** 需要脱敏的请求/响应头（小写比对）。 */
export const SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'cookie',
  'set-cookie',
  'x-auth-token',
]);

/** 脱敏头部集合，用于 debug 输出。 */
export function redactHeaders(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined) continue;
    out[k] = SENSITIVE_HEADERS.has(k.toLowerCase())
      ? REDACTED
      : Array.isArray(v)
        ? v.join(', ')
        : v;
  }
  return out;
}

/**
 * 剥离 URL 中的 userinfo，防止 `https://user:pw@host` 形态泄漏。
 *
 * 刻意不加 `^` 锚定：凭据常出现在错误消息中间（如「请求 https://u:p@host 失败」），
 * 只处理开头会漏掉这类形态。
 */
export function redactUrl(url: string): string {
  return url.replace(/([a-zA-Z][\w+.-]*:\/\/)[^/\s@]*@/g, `$1${REDACTED}@`);
}

/**
 * 兜底文本脱敏：用于错误消息与异常堆栈，避免凭据被拼进 message
 * 后经由日志或弹窗泄漏。
 */
export function redactText(text: string): string {
  return redactUrl(text)
    .replace(/(Basic|Bearer|Digest)\s+[A-Za-z0-9+/=._~-]+/gi, `$1 ${REDACTED}`)
    .replace(
      /(password|passwd|token|secret)("?\s*[:=]\s*"?)[^\s",;}]+/gi,
      `$1$2${REDACTED}`
    );
}
