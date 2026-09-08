/**
 * PRD 5.2 回归守卫：activate() 中 registerFileSystemProvider 必须在同步阶段完成。
 *
 * 违反该约束的后果是隐蔽的：扩展本身能正常打包运行，只有在用 webdav:// URI
 * 打开工作区触发窗口重载时，才会表现为「工作区空白」或直接报错——而这恰恰是
 * 产品的主路径。普通单测覆盖不到，因此用静态检查守住。
 */
import { readFileSync } from 'node:fs';

const FILE = 'src/extension.ts';
const src = readFileSync(FILE, 'utf8');

/** 去掉注释与字符串字面量，避免把文档里的 "await" 误判为代码。 */
function stripCommentsAndStrings(code) {
  let out = '';
  let i = 0;
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const next = code[i + 1];

    if (c === '/' && next === '*') {
      const end = code.indexOf('*/', i + 2);
      i = end < 0 ? n : end + 2;
      continue;
    }
    if (c === '/' && next === '/') {
      const end = code.indexOf('\n', i);
      i = end < 0 ? n : end;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < n && code[i] !== quote) {
        if (code[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      out += '""';
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

const clean = stripCommentsAndStrings(src);

const errors = [];

// 1) activate 不得是 async——async activate 会让 VSCode 在 provider 注册前就继续推进
if (/export\s+async\s+function\s+activate/.test(clean)) {
  errors.push('activate() 不得声明为 async（PRD 5.2 第 2 条）');
}

// 2) 提取 activate 函数体
// 同时匹配 async 形态，否则 async activate 会让下面的定位失败并报出误导性错误
const activateMatch = /export\s+(?:async\s+)?function\s+activate/.exec(clean);
const start = activateMatch ? activateMatch.index : -1;
if (start < 0) {
  errors.push(`未在 ${FILE} 中找到 activate() 定义`);
} else {
  let depth = 0;
  let bodyStart = -1;
  let bodyEnd = -1;
  for (let i = clean.indexOf('{', start); i < clean.length; i++) {
    if (clean[i] === '{') {
      if (depth === 0) bodyStart = i + 1;
      depth += 1;
    } else if (clean[i] === '}') {
      depth -= 1;
      if (depth === 0) {
        bodyEnd = i;
        break;
      }
    }
  }
  const body = clean.slice(bodyStart, bodyEnd);

  const regIdx = body.indexOf('registerFileSystemProvider');
  if (regIdx < 0) {
    errors.push('activate() 中未注册 FileSystemProvider');
  } else {
    // 3) 注册之前不得有 await / .then（两者都会把注册推迟到微任务之后）
    const before = body.slice(0, regIdx);
    if (/\bawait\b/.test(before)) {
      errors.push('registerFileSystemProvider 之前存在 await（PRD 5.2 第 2 条）');
    }
    if (/\.then\s*\(/.test(before)) {
      errors.push('registerFileSystemProvider 之前存在 .then()（PRD 5.2 第 2 条）');
    }
  }
}

if (errors.length > 0) {
  console.error('❌ 激活时序检查未通过（PRD 5.2）:');
  for (const e of errors) console.error('   - ' + e);
  process.exit(1);
}

console.log('✅ 激活时序检查通过：provider 在 activate() 同步阶段注册（PRD 5.2）');
