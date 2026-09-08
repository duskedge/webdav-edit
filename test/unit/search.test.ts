/**
 * 按文件名查找单测（PRD FR-5.1 / T-3.9）。
 *
 * 重点在**限制生效且如实上报**——递归 PROPFIND 失控会把服务端拖垮，
 * 而假装「搜完了没找到」比明说「结果不完整」危害更大。
 */
import { test, expect } from 'vitest';
import assert from 'node:assert/strict';
import { describeTruncation, searchByName, DEFAULT_LIMITS } from '../../src/webdav/search.ts';
import type { DirEntry, IWebdavClient, Stat } from '../../src/webdav/types.ts';

function stat(isDirectory: boolean): Stat {
  return { isDirectory, size: 0, mtime: 0, ctime: 0 };
}

/** 用一棵内存目录树伪造 client，只需实现 list。 */
function fakeClient(tree: Record<string, string[]>): IWebdavClient & { calls: string[] } {
  const calls: string[] = [];
  const client = {
    calls,
    async list(path: string): Promise<DirEntry[]> {
      calls.push(path);
      const names = tree[path];
      if (!names) throw new Error(`ENOENT ${path}`);
      return names.map((n) => {
        const isDir = n.endsWith('/');
        const name = isDir ? n.slice(0, -1) : n;
        return { name, isDirectory: isDir, stat: stat(isDir) };
      });
    },
  } as unknown as IWebdavClient & { calls: string[] };
  return client;
}

const TREE: Record<string, string[]> = {
  '/': ['docs/', 'src/', 'readme.md'],
  '/docs': ['guide.md', 'api.md', 'images/'],
  '/docs/images': ['logo.png'],
  '/src': ['index.ts', 'config.ts', 'deep/'],
  '/src/deep': ['nested-config.json'],
};

test('查找命中文件与目录，大小写不敏感', async () => {
  const c = fakeClient(TREE);
  const out = await searchByName(c, '/', 'CONFIG');
  const paths = out.hits.map((h) => h.path).sort();
  assert.deepEqual(paths, ['/src/config.ts', '/src/deep/nested-config.json']);
  assert.equal(out.truncated, false);
});

test('目录也能被命中，并标记 isDirectory', async () => {
  const c = fakeClient(TREE);
  const out = await searchByName(c, '/', 'images');
  assert.equal(out.hits.length, 1);
  assert.equal(out.hits[0]!.isDirectory, true);
  assert.equal(out.hits[0]!.path, '/docs/images');
});

test('空查询直接返回，不产生任何请求', async () => {
  const c = fakeClient(TREE);
  const out = await searchByName(c, '/', '   ');
  assert.deepEqual(out.hits, []);
  assert.equal(c.calls.length, 0, '空查询不应触发 PROPFIND');
});

test('从子目录开始搜索', async () => {
  const c = fakeClient(TREE);
  const out = await searchByName(c, '/src', 'config');
  assert.deepEqual(
    out.hits.map((h) => h.path).sort(),
    ['/src/config.ts', '/src/deep/nested-config.json']
  );
});

test('maxDepth 生效并上报 truncated', async () => {
  const c = fakeClient(TREE);
  const out = await searchByName(c, '/', 'config', { limits: { maxDepth: 1 } });
  // /src/deep 在第 2 层，不应被访问
  assert.deepEqual(out.hits.map((h) => h.path), ['/src/config.ts']);
  assert.equal(out.truncated, true);
  assert.equal(out.reason, 'depth');
  assert.ok(!c.calls.includes('/src/deep'));
});

test('maxDirectories 生效并上报', async () => {
  const c = fakeClient(TREE);
  const out = await searchByName(c, '/', 'x', { limits: { maxDirectories: 2 } });
  assert.equal(out.truncated, true);
  assert.equal(out.reason, 'directories');
  assert.equal(out.directoriesVisited, 2);
});

test('maxResults 生效并立即返回', async () => {
  const c = fakeClient(TREE);
  const out = await searchByName(c, '/', '.', { limits: { maxResults: 2 } });
  assert.equal(out.hits.length, 2);
  assert.equal(out.truncated, true);
  assert.equal(out.reason, 'results');
});

test('单个目录不可读时跳过，不中断整次搜索', async () => {
  const broken = { ...TREE };
  delete broken['/docs']; // 该目录 list 会抛错
  const c = fakeClient(broken);
  const out = await searchByName(c, '/', 'config');
  // /src 下的结果仍应找到
  assert.ok(out.hits.some((h) => h.path === '/src/config.ts'));
});

test('AbortSignal 取消后停止并上报', async () => {
  const c = fakeClient(TREE);
  const controller = new AbortController();
  controller.abort();
  const out = await searchByName(c, '/', 'config', { signal: controller.signal });
  assert.equal(out.truncated, true);
  assert.equal(out.reason, 'cancelled');
  assert.equal(c.calls.length, 0);
});

test('onProgress 报告已扫描目录数', async () => {
  const c = fakeClient(TREE);
  const seen: number[] = [];
  await searchByName(c, '/', 'zzz', { onProgress: (n) => seen.push(n) });
  assert.deepEqual(seen, [1, 2, 3, 4, 5]);
});

test('BFS 顺序：浅层结果优先', async () => {
  const tree: Record<string, string[]> = {
    '/': ['a/', 'match-top.txt'],
    '/a': ['b/', 'match-mid.txt'],
    '/a/b': ['match-deep.txt'],
  };
  const out = await searchByName(fakeClient(tree), '/', 'match');
  assert.deepEqual(out.hits.map((h) => h.name), [
    'match-top.txt',
    'match-mid.txt',
    'match-deep.txt',
  ]);
});

test('describeTruncation 对每种原因都给出可操作说明', () => {
  for (const reason of ['depth', 'directories', 'results', 'timeout', 'cancelled'] as const) {
    const text = describeTruncation(
      { hits: [], truncated: true, reason, directoriesVisited: 3 },
      DEFAULT_LIMITS
    );
    expect(text.length).toBeGreaterThan(0);
    assert.ok(!text.includes('undefined'), `原因 ${reason} 的说明含 undefined`);
  }
});
