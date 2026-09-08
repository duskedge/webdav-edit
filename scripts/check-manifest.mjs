/**
 * package.json 清单一致性检查。
 *
 * 三类问题都无法被 tsc 或单测发现，只会在用户点击时才暴露：
 *   1. 命令已注册但未在 contributes 声明 → 命令面板里根本找不到。
 *   2. 命令已声明但代码未注册 → 点击报「command not found」。
 *   3. menus 引用了不存在的命令 → 菜单项点击无效。
 *
 * 另外守住两条 PRD 硬约束：
 *   - 8.2：仅支持 Desktop，不得声明 `browser` 入口。
 *   - 2.4：必须声明 virtualWorkspaces 能力，否则 VSCode 行为不可预期。
 */
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const src = readFileSync('src/ui/commands.ts', 'utf8');

const errors = [];

// ---- 命令声明 vs 注册 ----
const declared = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));
const registered = new Set([...src.matchAll(/reg\('([\w.]+)'/g)].map((m) => m[1]));

for (const cmd of registered) {
  if (!declared.has(cmd)) {
    errors.push(`命令 "${cmd}" 已注册但未在 contributes.commands 声明（命令面板中不可见）`);
  }
}
for (const cmd of declared) {
  if (!registered.has(cmd)) {
    errors.push(`命令 "${cmd}" 已声明但代码未注册（点击将报 command not found）`);
  }
}

// ---- menus 引用的命令必须已声明 ----
for (const [menu, items] of Object.entries(pkg.contributes?.menus ?? {})) {
  for (const item of items) {
    if (item.command && !declared.has(item.command)) {
      errors.push(`menus.${menu} 引用了未声明的命令 "${item.command}"`);
    }
  }
}

// ---- views 必须有对应的 viewsContainers ----
const containers = new Set(
  Object.values(pkg.contributes?.viewsContainers ?? {})
    .flat()
    .map((c) => c.id)
);
for (const containerId of Object.keys(pkg.contributes?.views ?? {})) {
  if (!containers.has(containerId)) {
    errors.push(`views 使用了未定义的容器 "${containerId}"`);
  }
}

// ---- PRD 8.2：仅 Desktop ----
if (pkg.browser) {
  errors.push('声明了 browser 入口，违反 PRD 8.2（仅支持 Desktop，Web 宿主受 CORS 限制）');
}

// ---- PRD 2.4：虚拟工作区能力声明 ----
if (pkg.capabilities?.virtualWorkspaces !== true) {
  errors.push('未声明 capabilities.virtualWorkspaces=true（PRD 2.4）');
}
if (!pkg.capabilities?.untrustedWorkspaces) {
  errors.push('未声明 capabilities.untrustedWorkspaces（PRD 2.4）');
}

// ---- 依赖红线：运行时依赖仅允许 fast-xml-parser（开发计划 §1）----
const deps = Object.keys(pkg.dependencies ?? {});
const extra = deps.filter((d) => d !== 'fast-xml-parser');
if (extra.length > 0) {
  errors.push(
    `新增了运行时依赖 ${extra.join(', ')}。开发计划 §1 的依赖红线要求仅 fast-xml-parser；` +
      `如确有必要，需在 PR 中说明理由并更新 PRD 5.8.2。`
  );
}

if (errors.length > 0) {
  console.error('❌ 清单一致性检查未通过:');
  for (const e of errors) console.error('   - ' + e);
  process.exit(1);
}

console.log(
  `✅ 清单一致性检查通过（命令 ${declared.size} 个，运行时依赖 ${deps.length} 个）`
);
