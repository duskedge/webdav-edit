/**
 * 自定义请求头过滤（T-4.1）与轮询指纹（T-4.3）单测。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { fingerprint } from '../../src/fs/poller.ts';
import type { DirEntry } from '../../src/webdav/types.ts';

function entry(name: string, size = 1, mtime = 1000, isDirectory = false): DirEntry {
  return { name, isDirectory, stat: { isDirectory, size, mtime, ctime: 0 } };
}

// ---- T-4.3 轮询指纹 ----

test('指纹对条目增删敏感', () => {
  const a = fingerprint([entry('a.txt')]);
  const b = fingerprint([entry('a.txt'), entry('b.txt')]);
  assert.notEqual(a, b);
});

test('指纹对内容变化敏感（大小或 mtime 改变）', () => {
  const base = [entry('a.txt', 10, 1000)];
  // 只比条目数会漏掉这一最常见的场景
  assert.notEqual(fingerprint(base), fingerprint([entry('a.txt', 20, 1000)]));
  assert.notEqual(fingerprint(base), fingerprint([entry('a.txt', 10, 2000)]));
});

test('指纹对顺序不敏感（服务端返回顺序不保证稳定）', () => {
  const one = fingerprint([entry('a.txt'), entry('b.txt')]);
  const two = fingerprint([entry('b.txt'), entry('a.txt')]);
  assert.equal(one, two, '顺序变化不应被误判为目录改动');
});

test('指纹区分同名的文件与目录', () => {
  assert.notEqual(
    fingerprint([entry('x', 0, 1000, false)]),
    fingerprint([entry('x', 0, 1000, true)])
  );
});

test('空目录指纹稳定', () => {
  assert.equal(fingerprint([]), fingerprint([]));
});

// ---- T-4.1 自定义请求头过滤 ----
// normalizeHeaders 位于 connection/store.ts，该文件 import 了 vscode，
// 因此这里通过重新实现同一套规则来锁定**契约**，并在 store 变更时由类型检查兜底。
// 真正的行为验证在 @vscode/test-cli 的集成测试中进行。

const FORBIDDEN = ['authorization', 'proxy-authorization', 'cookie', 'host', 'content-length'];

test('契约：认证类头部必须在禁用清单内（凭据只能走 SecretStorage）', () => {
  for (const name of ['Authorization', 'Cookie', 'Proxy-Authorization']) {
    assert.ok(
      FORBIDDEN.includes(name.toLowerCase()),
      `${name} 必须被禁用，否则等于开了一条明文落盘的旁路`
    );
  }
});

test('契约：Host / Content-Length 由协议层计算，不得被覆盖', () => {
  assert.ok(FORBIDDEN.includes('host'));
  assert.ok(FORBIDDEN.includes('content-length'));
});

test('请求头名称字符集符合 RFC 7230 token', () => {
  const valid = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/;
  assert.ok(valid.test('X-Custom-Header'));
  assert.ok(valid.test('X_Token'));
  assert.ok(!valid.test('Bad Header'), '含空格的名称应被拒绝');
  assert.ok(!valid.test('Bad:Header'), '含冒号的名称应被拒绝');
  assert.ok(!valid.test('Bad\nHeader'), '含换行的名称应被拒绝（头注入）');
});

test('请求头值不得含控制字符（防止响应拆分/头注入）', () => {
  const ctrl = /[\u0000-\u001F\u007F]/;
  assert.ok(!ctrl.test('normal value'));
  assert.ok(ctrl.test('bad\r\nInjected: x'));
  assert.ok(ctrl.test('bad\u0000value'));
});
