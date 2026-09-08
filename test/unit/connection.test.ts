/**
 * 连接模型单测（PRD FR-1.1、5.1）。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  describe as describeConn,
  generateConnectionId,
  isSecure,
  isValidConnectionId,
  parseServerUrl,
  type ConnectionConfig,
} from '../../src/connection/types.ts';

test('connectionId 必须是小写 [a-z0-9-]（5.1 authority 归一化约束）', () => {
  assert.equal(isValidConnectionId('a1b2c3-d4e5'), true);
  assert.equal(isValidConnectionId('ABC'), false, '大写会因 authority 归一化而查找失败');
  assert.equal(isValidConnectionId('a_b'), false);
  assert.equal(isValidConnectionId('a.b'), false);
  assert.equal(isValidConnectionId(''), false);
});

test('generateConnectionId 产出合法且唯一的 id', () => {
  const ids = new Set<string>();
  for (let i = 0; i < 200; i++) {
    const id = generateConnectionId();
    assert.ok(isValidConnectionId(id), `非法 id: ${id}`);
    assert.equal(id, id.toLowerCase());
    ids.add(id);
  }
  assert.equal(ids.size, 200, 'id 必须唯一');
});

test('generateConnectionId 是标准 UUID v4 形态', () => {
  assert.match(
    generateConnectionId(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
  );
});

test('parseServerUrl: 拆解 Nextcloud 风格完整 URL (FR-1.1 一键解析)', () => {
  const r = parseServerUrl('https://cloud.example.com/remote.php/dav/files/alice/');
  assert.deepEqual(r, {
    baseUrl: 'https://cloud.example.com',
    pathPrefix: '/remote.php/dav/files/alice/',
    secure: true,
  });
});

test('parseServerUrl: 带端口与 http', () => {
  const r = parseServerUrl('http://192.168.1.2:5005/dav');
  assert.equal(r?.baseUrl, 'http://192.168.1.2:5005');
  assert.equal(r?.pathPrefix, '/dav');
  assert.equal(r?.secure, false);
});

test('parseServerUrl: 缺协议时默认补 https', () => {
  const r = parseServerUrl('cloud.example.com/dav');
  assert.equal(r?.baseUrl, 'https://cloud.example.com');
  assert.equal(r?.secure, true);
});

test('parseServerUrl: 无路径时前缀为 /', () => {
  assert.equal(parseServerUrl('https://cloud.example.com')?.pathPrefix, '/');
  assert.equal(parseServerUrl('https://cloud.example.com/')?.pathPrefix, '/');
});

test('parseServerUrl: 非法输入返回 undefined', () => {
  assert.equal(parseServerUrl(''), undefined);
  assert.equal(parseServerUrl('   '), undefined);
  assert.equal(parseServerUrl('ftp://host/dav'), undefined);
  assert.equal(parseServerUrl('not a url'), undefined);
});

const CONN: ConnectionConfig = {
  id: 'abc-1',
  alias: '测试',
  baseUrl: 'https://cloud.example.com',
  pathPrefix: '/dav',
  username: 'alice',
  authType: 'basic',
  ignoreSsl: false,
  readonly: false,
};

test('isSecure 识别 HTTPS', () => {
  assert.equal(isSecure(CONN), true);
  assert.equal(isSecure({ ...CONN, baseUrl: 'http://x.com' }), false);
});

test('describe 不含任何凭据 (NFR-2.4)', () => {
  const text = describeConn({ ...CONN, username: 'alice' });
  assert.ok(text.includes('测试'));
  assert.ok(text.includes('cloud.example.com'));
  assert.ok(!text.includes('alice'), '描述中不应出现用户名以外的凭据信息');
});
