/**
 * 路径编码 / 解码单测（PRD 5.3 要求：必须覆盖全部列出的字符样例）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  basename,
  decodePath,
  dirname,
  encodePath,
  encodeSegment,
  hrefToAbsolutePath,
  isSafeName,
  joinPrefix,
  normalizeSlashes,
  stripPrefix,
  stripTrailingSlash,
} from '../../src/webdav/path.ts';

test('encodePath: 保留 / 作分隔符，逐段编码', () => {
  assert.equal(encodePath('/a/b/c.txt'), '/a/b/c.txt');
  assert.equal(encodePath('a/b'), '/a/b');
});

test('encodePath: 覆盖 5.3 列出的全部字符样例', () => {
  // 空格
  assert.equal(encodePath('/my docs/a b.txt'), '/my%20docs/a%20b.txt');
  // 中文
  assert.equal(encodePath('/文档/笔记.md'), '/%E6%96%87%E6%A1%A3/%E7%AC%94%E8%AE%B0.md');
  // # ? & + %
  assert.equal(encodeSegment('a#b'), 'a%23b');
  assert.equal(encodeSegment('a?b'), 'a%3Fb');
  assert.equal(encodeSegment('a&b'), 'a%26b');
  assert.equal(encodeSegment('a+b'), 'a%2Bb');
  assert.equal(encodeSegment('100%'), '100%25');
});

test('encodeSegment: 额外编码 encodeURIComponent 漏掉的 !\'()*', () => {
  assert.equal(encodeSegment("it's"), 'it%27s');
  assert.equal(encodeSegment('a(1)'), 'a%281%29');
  assert.equal(encodeSegment('a!b'), 'a%21b');
  assert.equal(encodeSegment('a*b'), 'a%2Ab');
});

test('encode/decode 往返一致', () => {
  for (const p of [
    '/文档/my file (1).md',
    "/a b/it's #1 & 100%.txt",
    '/plain/path.txt',
    '/加号+与空格 /x.txt',
  ]) {
    assert.equal(decodePath(encodePath(p)), p, `往返失败: ${p}`);
  }
});

test('decodePath: 非法百分号序列不抛错', () => {
  assert.equal(decodePath('/a%ZZb'), '/a%ZZb');
  assert.equal(decodePath('/ok%20here/%E4%B8%AD'), '/ok here/中');
});

test('normalizeSlashes: 折叠重复斜杠并补前导斜杠', () => {
  assert.equal(normalizeSlashes('a//b///c'), '/a/b/c');
  assert.equal(normalizeSlashes('/a/b'), '/a/b');
  assert.equal(normalizeSlashes('/'), '/');
});

test('stripTrailingSlash: 根路径不受影响', () => {
  assert.equal(stripTrailingSlash('/a/b/'), '/a/b');
  assert.equal(stripTrailingSlash('/a/b//'), '/a/b');
  assert.equal(stripTrailingSlash('/'), '/');
  assert.equal(stripTrailingSlash('/a'), '/a');
});

test('hrefToAbsolutePath: 绝对 URL 形态', () => {
  assert.equal(
    hrefToAbsolutePath('https://cloud.example.com/dav/%E4%B8%AD/a.txt', '/dav/'),
    '/dav/中/a.txt'
  );
  // 带端口
  assert.equal(
    hrefToAbsolutePath('http://192.168.1.2:5005/dav/a%20b.txt', '/dav/'),
    '/dav/a b.txt'
  );
});

test('hrefToAbsolutePath: 绝对路径形态', () => {
  assert.equal(hrefToAbsolutePath('/dav/%E4%B8%AD/a.txt', '/dav/'), '/dav/中/a.txt');
});

test('hrefToAbsolutePath: 相对路径形态，以请求路径所在目录为基准', () => {
  assert.equal(hrefToAbsolutePath('a.txt', '/dav/sub/'), '/dav/sub/a.txt');
  // 请求路径不以 / 结尾时，基准为其父目录
  assert.equal(hrefToAbsolutePath('b.txt', '/dav/sub'), '/dav/b.txt');
});

test('hrefToAbsolutePath: 目录 href 的尾斜杠被保留，比对交给 stripTrailingSlash', () => {
  assert.equal(hrefToAbsolutePath('/dav/sub/', '/dav/'), '/dav/sub/');
  assert.equal(
    stripTrailingSlash(hrefToAbsolutePath('/dav/sub/', '/dav/')),
    stripTrailingSlash(hrefToAbsolutePath('/dav/sub', '/dav/'))
  );
});

test('stripPrefix: 剥离 pathPrefix', () => {
  assert.equal(stripPrefix('/remote.php/dav/files/alice/doc/a.txt', '/remote.php/dav/files/alice'), '/doc/a.txt');
  assert.equal(stripPrefix('/remote.php/dav/files/alice', '/remote.php/dav/files/alice/'), '/');
  assert.equal(stripPrefix('/dav/a.txt', '/'), '/dav/a.txt');
});

test('stripPrefix: 前缀不匹配返回 undefined', () => {
  assert.equal(stripPrefix('/other/a.txt', '/dav'), undefined);
  // 前缀必须在路径边界上匹配，不能是字符串前缀
  assert.equal(stripPrefix('/davextra/a.txt', '/dav'), undefined);
});

test('joinPrefix: 与 stripPrefix 互逆', () => {
  const prefix = '/remote.php/dav/files/alice';
  for (const p of ['/', '/doc', '/doc/a.txt', '/文档/b.md']) {
    assert.equal(stripPrefix(joinPrefix(prefix, p), prefix), stripTrailingSlash(p));
  }
});

test('joinPrefix: 根前缀', () => {
  assert.equal(joinPrefix('/', '/a.txt'), '/a.txt');
  assert.equal(joinPrefix('/', '/'), '/');
  assert.equal(joinPrefix('/dav', '/'), '/dav');
});

test('dirname / basename', () => {
  assert.equal(dirname('/a/b/c.txt'), '/a/b');
  assert.equal(dirname('/a'), '/');
  assert.equal(dirname('/'), '/');
  assert.equal(basename('/a/b/c.txt'), 'c.txt');
  assert.equal(basename('/a/b/'), 'b');
  assert.equal(basename('/'), '');
});

test('isSafeName: 防御路径穿越与控制字符 (NFR-2.5)', () => {
  assert.equal(isSafeName('normal.txt'), true);
  assert.equal(isSafeName('中文 文件 (1).md'), true);
  assert.equal(isSafeName('..'), false);
  assert.equal(isSafeName('.'), false);
  assert.equal(isSafeName(''), false);
  assert.equal(isSafeName('a/b'), false);
  assert.equal(isSafeName('a\\b'), false);
  assert.equal(isSafeName('a\u0000b'), false);
  assert.equal(isSafeName('a\u001Fb'), false);
  assert.equal(isSafeName('a\u007Fb'), false);
});
