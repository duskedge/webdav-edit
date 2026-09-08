/**
 * PROPFIND 解析单测（PRD 5.3、风险 R2）。
 *
 * 样例刻意取自 5.6 矩阵中各服务端的真实响应形态差异：
 * 命名空间前缀、href 形态、尾斜杠、多 propstat、缺失属性。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  excludeSelf,
  findSelf,
  normalizeEtag,
  parseDate,
  parseMultiStatus,
} from '../../src/webdav/propfind.ts';
import { firstFailureStatus } from '../../src/webdav/client.ts';

/** Nextcloud 风格：`d:` 前缀、绝对路径 href、目录带尾斜杠。 */
const NEXTCLOUD = `<?xml version="1.0"?>
<d:multistatus xmlns:d="DAV:" xmlns:s="http://sabredav.org/ns" xmlns:oc="http://owncloud.org/ns">
  <d:response>
    <d:href>/remote.php/dav/files/alice/doc/</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype><d:collection/></d:resourcetype>
        <d:getlastmodified>Wed, 03 Sep 2025 10:00:00 GMT</d:getlastmodified>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
    <d:propstat>
      <d:prop><d:getcontentlength/></d:prop>
      <d:status>HTTP/1.1 404 Not Found</d:status>
    </d:propstat>
  </d:response>
  <d:response>
    <d:href>/remote.php/dav/files/alice/doc/%E7%AC%94%E8%AE%B0.md</d:href>
    <d:propstat>
      <d:prop>
        <d:resourcetype/>
        <d:getcontentlength>1234</d:getcontentlength>
        <d:getlastmodified>Wed, 03 Sep 2025 12:30:00 GMT</d:getlastmodified>
        <d:getetag>"abc123"</d:getetag>
      </d:prop>
      <d:status>HTTP/1.1 200 OK</d:status>
    </d:propstat>
  </d:response>
</d:multistatus>`;

test('Nextcloud 形态：解析条目并识别目录', () => {
  const entries = parseMultiStatus(NEXTCLOUD, '/remote.php/dav/files/alice/doc/');
  assert.equal(entries.length, 2);

  const dir = entries[0]!;
  assert.equal(dir.absPath, '/remote.php/dav/files/alice/doc/');
  assert.equal(dir.isDirectory, true);
  // 目录未返回 getcontentlength，须给缺省值而非抛错（FR-3.1）
  assert.equal(dir.size, 0);

  const file = entries[1]!;
  assert.equal(file.absPath, '/remote.php/dav/files/alice/doc/笔记.md');
  assert.equal(file.isDirectory, false);
  assert.equal(file.size, 1234);
  assert.equal(file.etag, 'abc123');
});

test('只取 2xx 的 propstat 分组，忽略 404 分组', () => {
  const entries = parseMultiStatus(NEXTCLOUD, '/remote.php/dav/files/alice/doc/');
  // 目录的 getcontentlength 在 404 分组里，不应被采纳
  assert.equal(entries[0]!.size, 0);
  assert.equal(entries[0]!.isDirectory, true);
});

test('excludeSelf: 剔除代表目录自身的条目（5.3 强制要求）', () => {
  const entries = parseMultiStatus(NEXTCLOUD, '/remote.php/dav/files/alice/doc/');
  const children = excludeSelf(entries, '/remote.php/dav/files/alice/doc');
  assert.equal(children.length, 1);
  assert.equal(children[0]!.absPath, '/remote.php/dav/files/alice/doc/笔记.md');
});

test('excludeSelf: 自身 href 不带尾斜杠时同样能剔除', () => {
  const xml = `<multistatus xmlns="DAV:">
    <response><href>/dav/sub</href><propstat><prop><resourcetype><collection/></resourcetype></prop><status>HTTP/1.1 200 OK</status></propstat></response>
    <response><href>/dav/sub/a.txt</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  </multistatus>`;
  const entries = parseMultiStatus(xml, '/dav/sub/');
  assert.equal(excludeSelf(entries, '/dav/sub/').length, 1);
  assert.equal(excludeSelf(entries, '/dav/sub').length, 1);
});

test('无命名空间前缀的响应（默认 xmlns）', () => {
  const xml = `<multistatus xmlns="DAV:">
    <response>
      <href>/dav/a.txt</href>
      <propstat><prop><resourcetype/><getcontentlength>7</getcontentlength></prop><status>HTTP/1.1 200 OK</status></propstat>
    </response>
  </multistatus>`;
  const entries = parseMultiStatus(xml, '/dav/');
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.size, 7);
  assert.equal(entries[0]!.isDirectory, false);
});

test('非常规前缀（lp1:/D:）与绝对 URL href', () => {
  const xml = `<D:multistatus xmlns:D="DAV:" xmlns:lp1="DAV:">
    <D:response>
      <D:href>http://192.168.1.2:5005/dav/%E4%B8%AD%E6%96%87/</D:href>
      <D:propstat>
        <D:prop><lp1:resourcetype><D:collection/></lp1:resourcetype></D:prop>
        <D:status>HTTP/1.1 200 OK</D:status>
      </D:propstat>
    </D:response>
  </D:multistatus>`;
  const entries = parseMultiStatus(xml, '/dav/');
  assert.equal(entries[0]!.absPath, '/dav/中文/');
  assert.equal(entries[0]!.isDirectory, true);
});

test('相对 href（部分服务端）', () => {
  const xml = `<multistatus xmlns="DAV:">
    <response><href>a%20b.txt</href><propstat><prop><resourcetype/></prop><status>HTTP/1.1 200 OK</status></propstat></response>
  </multistatus>`;
  const entries = parseMultiStatus(xml, '/dav/sub/');
  assert.equal(entries[0]!.absPath, '/dav/sub/a b.txt');
});

test('缺少 status 的 propstat 仍被采纳（宽松解析）', () => {
  const xml = `<multistatus xmlns="DAV:">
    <response><href>/dav/a.txt</href><propstat><prop><resourcetype/><getcontentlength>3</getcontentlength></prop></propstat></response>
  </multistatus>`;
  assert.equal(parseMultiStatus(xml, '/dav/')[0]!.size, 3);
});

test('findSelf: 用于 stat 与 Depth:0 回退', () => {
  const entries = parseMultiStatus(NEXTCLOUD, '/remote.php/dav/files/alice/doc/');
  const self = findSelf(entries, '/remote.php/dav/files/alice/doc');
  assert.ok(self);
  assert.equal(self.isDirectory, true);
  assert.equal(findSelf(entries, '/nope'), undefined);
});

test('非法 XML 抛 ProtocolError 而非崩溃', () => {
  assert.throws(() => parseMultiStatus('<not-multistatus/>', '/dav/'), /ProtocolError/);
});

test('parseDate: RFC1123 与 ISO8601 都能解析，失败返回 0', () => {
  assert.equal(parseDate('Wed, 03 Sep 2025 10:00:00 GMT'), Date.parse('2025-09-03T10:00:00Z'));
  assert.equal(parseDate('2025-09-03T10:00:00Z'), Date.parse('2025-09-03T10:00:00Z'));
  assert.equal(parseDate('garbage'), 0);
  assert.equal(parseDate(undefined), 0);
});

test('normalizeEtag: 去掉弱标记与引号', () => {
  assert.equal(normalizeEtag('"abc"'), 'abc');
  assert.equal(normalizeEtag('W/"abc"'), 'abc');
  assert.equal(normalizeEtag('abc'), 'abc');
  assert.equal(normalizeEtag(undefined), undefined);
  assert.equal(normalizeEtag('""'), undefined);
});

test('firstFailureStatus: 207 中逐条判定子状态（5.3 DELETE 约束）', () => {
  const allOk = `<multistatus xmlns="DAV:">
    <response><href>/a</href><status>HTTP/1.1 200 OK</status></response>
  </multistatus>`;
  assert.equal(firstFailureStatus(allOk), undefined);

  const partial = `<d:multistatus xmlns:d="DAV:">
    <d:response><d:href>/a</d:href><d:status>HTTP/1.1 200 OK</d:status></d:response>
    <d:response><d:href>/b</d:href><d:status>HTTP/1.1 423 Locked</d:status></d:response>
  </d:multistatus>`;
  assert.equal(firstFailureStatus(partial), 423);
});
