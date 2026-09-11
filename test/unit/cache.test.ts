/**
 * 缓存与失效模型单测（PRD NFR-1.1、NFR-1.2、5.4）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { MetadataCache } from '../../src/fs/cache.ts';
import type { DirEntry, Stat } from '../../src/webdav/client.ts';

const CONN = 'conn-1';

function stat(isDirectory: boolean, size = 0): Stat {
  return { isDirectory, size, mtime: 1000, ctime: 1000 };
}

function entry(name: string, isDirectory = false, size = 1): DirEntry {
  return { name, isDirectory, stat: stat(isDirectory, size) };
}

test('setStat / getStat 基本读写', () => {
  const c = new MetadataCache(30);
  c.setStat(CONN, '/a.txt', stat(false, 5));
  assert.equal(c.getStat(CONN, '/a.txt')?.size, 5);
  assert.equal(c.getStat(CONN, '/other.txt'), undefined);
});

test('路径尾斜杠归一化：/dir 与 /dir/ 命中同一条目', () => {
  const c = new MetadataCache(30);
  c.setStat(CONN, '/dir', stat(true));
  assert.ok(c.getStat(CONN, '/dir/'));
});

test('连接隔离：不同 connectionId 互不干扰', () => {
  const c = new MetadataCache(30);
  c.setStat(CONN, '/a.txt', stat(false, 1));
  c.setStat('conn-2', '/a.txt', stat(false, 2));
  assert.equal(c.getStat(CONN, '/a.txt')?.size, 1);
  assert.equal(c.getStat('conn-2', '/a.txt')?.size, 2);
});

test('setChildren 一次性回填全部子项 stat (NFR-1.1 核心)', () => {
  const c = new MetadataCache(30);
  c.setChildren(CONN, '/dir', [entry('a.txt', false, 10), entry('sub', true)]);

  // 后续 stat 无需再发请求
  assert.equal(c.getStat(CONN, '/dir/a.txt')?.size, 10);
  assert.equal(c.getStat(CONN, '/dir/sub')?.isDirectory, true);
  assert.equal(c.getChildren(CONN, '/dir')?.length, 2);
});

test('setChildren 在根目录下的路径拼接正确', () => {
  const c = new MetadataCache(30);
  c.setChildren(CONN, '/', [entry('top.txt')]);
  assert.ok(c.getStat(CONN, '/top.txt'));
});

test('TTL 过期后不再命中', async () => {
  const c = new MetadataCache(0.05); // 50ms
  c.setStat(CONN, '/a.txt', stat(false, 1));
  assert.ok(c.getStat(CONN, '/a.txt'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(c.getStat(CONN, '/a.txt'), undefined);
});

test('TTL=0 时禁用缓存（调试用）', () => {
  const c = new MetadataCache(0);
  c.setStat(CONN, '/a.txt', stat(false, 1));
  c.setChildren(CONN, '/dir', [entry('x')]);
  assert.equal(c.getStat(CONN, '/a.txt'), undefined);
  assert.equal(c.getChildren(CONN, '/dir'), undefined);
});

test('invalidate 同时清掉自身与父目录的 children (5.4 写路径)', () => {
  const c = new MetadataCache(30);
  c.setChildren(CONN, '/dir', [entry('a.txt')]);
  c.setStat(CONN, '/dir', stat(true));

  c.invalidate(CONN, '/dir/a.txt');

  assert.equal(c.getStat(CONN, '/dir/a.txt'), undefined);
  // 父目录列表失效——否则新建的文件不会出现在资源管理器里
  assert.equal(c.getChildren(CONN, '/dir'), undefined);
  // 但父目录自身的 stat 保留
  assert.ok(c.getStat(CONN, '/dir'));
});

test('invalidateSubtree 递归清理，用于 delete / rename (5.4)', () => {
  const c = new MetadataCache(30);
  c.setStat(CONN, '/dir', stat(true));
  c.setChildren(CONN, '/dir', [entry('a.txt'), entry('sub', true)]);
  c.setChildren(CONN, '/dir/sub', [entry('deep.txt')]);

  c.invalidateSubtree(CONN, '/dir');

  assert.equal(c.getStat(CONN, '/dir'), undefined);
  assert.equal(c.getStat(CONN, '/dir/a.txt'), undefined);
  assert.equal(c.getStat(CONN, '/dir/sub/deep.txt'), undefined);
});

test('invalidateSubtree 不误伤同前缀的兄弟路径', () => {
  const c = new MetadataCache(30);
  c.setStat(CONN, '/dir', stat(true));
  c.setStat(CONN, '/dirextra', stat(true));
  c.setStat(CONN, '/dir/a.txt', stat(false));

  c.invalidateSubtree(CONN, '/dir');

  assert.equal(c.getStat(CONN, '/dir/a.txt'), undefined);
  // /dirextra 只是字符串前缀相同，不属于子树
  assert.ok(c.getStat(CONN, '/dirextra'));
});

test('invalidateSubtree 刷新根目录时清空该连接的全部子目录缓存', () => {
  const c = new MetadataCache(30);
  c.setChildren(CONN, '/', [entry('docker', true)]);
  c.setChildren(CONN, '/docker', [entry('existing', true)]);
  c.setChildren(CONN, '/docker/existing', [entry('file.txt')]);
  c.setChildren('conn-2', '/', [entry('keep', true)]);

  c.invalidateSubtree(CONN, '/');

  assert.equal(c.getChildren(CONN, '/'), undefined);
  assert.equal(c.getChildren(CONN, '/docker'), undefined);
  assert.equal(c.getChildren(CONN, '/docker/existing'), undefined);
  assert.ok(c.getChildren('conn-2', '/'), '其他连接的缓存不应被清除');
});

test('clearConnection 只清目标连接 (5.4 配置变更)', () => {
  const c = new MetadataCache(30);
  c.setStat(CONN, '/a.txt', stat(false));
  c.setStat('conn-2', '/a.txt', stat(false));

  c.clearConnection(CONN);

  assert.equal(c.getStat(CONN, '/a.txt'), undefined);
  assert.ok(c.getStat('conn-2', '/a.txt'));
});

test('dedupe: 并发同 key 复用同一 promise (NFR-1.2)', async () => {
  const c = new MetadataCache(30);
  let calls = 0;
  const fn = async (): Promise<number> => {
    calls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return 42;
  };

  const results = await Promise.all([
    c.dedupe('k', fn),
    c.dedupe('k', fn),
    c.dedupe('k', fn),
  ]);

  assert.deepEqual(results, [42, 42, 42]);
  assert.equal(calls, 1, '三次并发只应发起一次请求');
});

test('dedupe: 不同 key 不合并', async () => {
  const c = new MetadataCache(30);
  let calls = 0;
  const fn = async (): Promise<void> => {
    calls += 1;
  };
  await Promise.all([c.dedupe('a', fn), c.dedupe('b', fn)]);
  assert.equal(calls, 2);
});

test('dedupe: 失败后清理在途记录，不做负缓存', async () => {
  const c = new MetadataCache(30);
  let calls = 0;
  const failing = async (): Promise<void> => {
    calls += 1;
    throw new Error('boom');
  };

  await assert.rejects(() => c.dedupe('k', failing));
  await assert.rejects(() => c.dedupe('k', failing));
  assert.equal(calls, 2, '失败不应被缓存，第二次须重新发起');
});

test('setTtl(0) 清空既有缓存', () => {
  const c = new MetadataCache(30);
  c.setStat(CONN, '/a.txt', stat(false));
  assert.ok(c.getStat(CONN, '/a.txt'));
  c.setTtl(0);
  assert.equal(c.size, 0);
});
