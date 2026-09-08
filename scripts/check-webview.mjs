/**
 * Webview 安全不变量检查（PRD NFR-2.1、NFR-2.4 / T-3.8）。
 *
 * 这几条都无法被单测覆盖（Webview 需要扩展宿主），但一旦被破坏后果严重且不显眼：
 *   1. CSP 必须存在且限制 script-src 为 nonce。
 *   2. 不得出现 `unsafe-inline` 的脚本源（样式可放宽，脚本不行）。
 *   3. Webview 的 `localResourceRoots` 应收紧。
 *   4. **已保存的密码不得下发给 Webview**——这是本面板最关键的一条：
 *      面板只接收新密码，从不回显旧密码。
 */
import { readFileSync } from 'node:fs';

const FILE = 'src/ui/connectionEditor.ts';
const src = readFileSync(FILE, 'utf8');
const errors = [];

// ---- 1. CSP ----
if (!src.includes('Content-Security-Policy')) {
  errors.push('Webview HTML 未声明 Content-Security-Policy');
}
if (!/script-src 'nonce-/.test(src)) {
  errors.push("CSP 的 script-src 未使用 nonce");
}
if (!/default-src 'none'/.test(src)) {
  errors.push("CSP 未以 default-src 'none' 兜底");
}

// ---- 2. 脚本源不得放宽 ----
const scriptSrcLine = /script-src[^;'"`]*(?:'[^']*'[^;'"`]*)*/.exec(src)?.[0] ?? '';
if (scriptSrcLine.includes('unsafe-inline') || scriptSrcLine.includes('unsafe-eval')) {
  errors.push('CSP 的 script-src 含 unsafe-inline / unsafe-eval');
}

// ---- 3. 资源根收紧 ----
if (!/localResourceRoots:\s*\[\s*\]/.test(src)) {
  errors.push('Webview 未把 localResourceRoots 收紧为空数组');
}

// ---- 4. 密码不得下发 ----
// load() 推送给 Webview 的连接对象里出现 password 字段即为泄漏。
const loadFn = /private load\([\s\S]*?\n  \}/.exec(src)?.[0] ?? '';
if (/password/i.test(loadFn)) {
  errors.push(
    'load() 中出现 password 字段——已保存的密码绝不能下发给 Webview（NFR-2.1）'
  );
}
if (/postMessage\(\{[^}]*password/s.test(src)) {
  errors.push('存在把 password 放进 postMessage 的代码路径');
}

// ---- 5. 不得把凭据拼进 HTML ----
if (/\$\{[^}]*password[^}]*\}/i.test(src)) {
  errors.push('HTML 模板中插值了 password');
}

if (errors.length > 0) {
  console.error('❌ Webview 安全检查未通过:');
  for (const e of errors) console.error('   - ' + e);
  process.exit(1);
}

console.log('✅ Webview 安全检查通过（CSP/nonce、资源根收紧、密码不下发）');
