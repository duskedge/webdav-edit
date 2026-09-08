/**
 * 分层依赖检查（PRD NFR-4.1 / 开发计划 §3）。
 *
 * ESLint 的 `no-restricted-imports` 只能拦住**直接** `import 'vscode'`，
 * 拦不住「A 不导入 vscode，但 A 导入的 B 导入了」这种传递依赖——
 * 而后者同样会让该模块无法脱离扩展宿主单测（实际已踩过一次：
 * fs/poller.ts 通过 log/channel.ts 间接引入了 vscode）。
 *
 * 本脚本做完整的传递闭包检查，并在失败时打印出污染路径。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';

/** 必须能脱离 VSCode 宿主运行的模块（NFR-4.1）。 */
const PURE_ROOTS = [
  'src/webdav',
  'src/log/redact.ts',
  'src/connection/types.ts',
  'src/connection/presets.ts',
  'src/fs/cache.ts',
  'src/fs/poller.ts',
];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function expand(entry) {
  try {
    return statSync(entry).isDirectory() ? walk(entry) : [entry];
  } catch {
    return [];
  }
}

/**
 * 解析一个文件的**运行时**本地依赖。
 *
 * 关键：跳过 `import type` / `export type`——它们在编译期被完全擦除，
 * 不构成运行时依赖。把它们算进来会产生误报（如 poller.ts 只在类型层面
 * 引用 ConnectionResolver，运行时并不加载它）。
 */
function localImports(file) {
  const src = readFileSync(file, 'utf8');
  const deps = [];

  // 逐条 import/export 语句扫描，便于判断是否为 type-only
  const stmtRe = /(?:^|\n)\s*(import|export)(\s+type)?\s+([^;\n]*?)from\s+['"]([^'"]+)['"]/g;
  let m;
  while ((m = stmtRe.exec(src)) !== null) {
    const isTypeOnly = Boolean(m[2]);
    const clause = m[3] ?? '';
    const spec = m[4];
    // `import { type A, type B } from` 也是纯类型引用
    const allInlineType =
      clause.includes('{') &&
      clause
        .replace(/[{}]/g, '')
        .split(',')
        .filter((x) => x.trim())
        .every((x) => x.trim().startsWith('type '));

    if (isTypeOnly || allInlineType) continue;

    deps.push(spec.startsWith('.') ? resolve(dirname(file), spec) : spec);
  }

  // 副作用导入 `import 'x'`（无 from）
  const bareRe = /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g;
  while ((m = bareRe.exec(src)) !== null) {
    const spec = m[1];
    deps.push(spec.startsWith('.') ? resolve(dirname(file), spec) : spec);
  }

  return deps;
}

const errors = [];

for (const root of PURE_ROOTS) {
  for (const entry of expand(root)) {
    const seen = new Set();
    // DFS，记录路径以便报错时能指出污染链
    const stack = [{ file: resolve(entry), path: [relative('.', entry)] }];

    while (stack.length > 0) {
      const { file, path } = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);

      let deps;
      try {
        deps = localImports(file);
      } catch {
        continue;
      }

      for (const dep of deps) {
        if (dep === 'vscode') {
          errors.push(
            `${relative('.', entry)} 传递依赖了 vscode：\n       ` +
              path.join('\n         → ') +
              '\n         → vscode'
          );
          stack.length = 0;
          break;
        }
        if (dep.startsWith('/')) {
          stack.push({ file: dep, path: [...path, relative('.', dep)] });
        }
      }
    }
  }
}

if (errors.length > 0) {
  console.error('❌ 分层依赖检查未通过（NFR-4.1：协议层须能脱离扩展宿主单测）:');
  for (const e of errors) console.error('   - ' + e);
  process.exit(1);
}

console.log(`✅ 分层依赖检查通过（${PURE_ROOTS.length} 个纯净根，含传递依赖）`);
