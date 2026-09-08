/**
 * 认证单测（PRD FR-1.5）。
 * Digest 用 RFC 2617 §3.5 的官方示例做黄金向量，确保实现符合规范。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  basicHeader,
  bearerHeader,
  digestHeader,
  parseDigestChallenge,
  canPreAuthenticate,
} from '../../src/webdav/auth/index.ts';
import type { DigestState } from '../../src/webdav/types.ts';

test('basicHeader: base64(user:pass)', () => {
  assert.equal(basicHeader({ username: 'alice', password: 'secret' }), 'Basic YWxpY2U6c2VjcmV0');
});

test('basicHeader: 非 ASCII 按 UTF-8 编码', () => {
  const h = basicHeader({ username: 'u', password: '密码' });
  assert.equal(Buffer.from(h.slice(6), 'base64').toString('utf8'), 'u:密码');
});

test('bearerHeader: token 取自 password 字段', () => {
  assert.equal(bearerHeader({ username: '', password: 'tok123' }), 'Bearer tok123');
});

test('parseDigestChallenge: 解析标准质询', () => {
  const state = parseDigestChallenge(
    'Digest realm="testrealm@host.com", qop="auth,auth-int", ' +
      'nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"'
  );
  assert.ok(state);
  assert.equal(state.realm, 'testrealm@host.com');
  assert.equal(state.nonce, 'dcd98b7102dd2f0e8b11d0f600bfb0c093');
  assert.equal(state.qop, 'auth,auth-int');
  assert.equal(state.opaque, '5ccc069c403ebaf9f0171e9517f40e41');
  assert.equal(state.algorithm, 'MD5');
  assert.equal(state.nc, 0);
});

test('parseDigestChallenge: 服务端同时给出 Basic 与 Digest 时只挑 Digest', () => {
  const state = parseDigestChallenge('Basic realm="x", Digest realm="y", nonce="n1"');
  assert.ok(state);
  assert.equal(state.realm, 'y');
  assert.equal(state.nonce, 'n1');
});

test('parseDigestChallenge: 非 Digest 或缺字段时返回 undefined', () => {
  assert.equal(parseDigestChallenge('Basic realm="x"'), undefined);
  assert.equal(parseDigestChallenge('Digest realm="x"'), undefined); // 缺 nonce
});

test('digestHeader: 匹配 RFC 2617 §3.5 官方测试向量', () => {
  const state: DigestState = {
    realm: 'testrealm@host.com',
    nonce: 'dcd98b7102dd2f0e8b11d0f600bfb0c093',
    qop: 'auth',
    opaque: '5ccc069c403ebaf9f0171e9517f40e41',
    algorithm: 'MD5',
    nc: 0,
    cnonce: '0a4f113b',
  };
  const header = digestHeader(
    state,
    { username: 'Mufasa', password: 'Circle Of Life' },
    'GET',
    '/dir/index.html'
  );

  assert.match(header, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(header, /nc=00000001/);
  assert.match(header, /qop=auth/);
  assert.match(header, /cnonce="0a4f113b"/);
  assert.match(header, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
});

test('digestHeader: nc 在同一 nonce 下单调递增（RFC 2617 要求）', () => {
  const state: DigestState = {
    realm: 'r',
    nonce: 'n',
    qop: 'auth',
    algorithm: 'MD5',
    nc: 0,
    cnonce: 'c',
  };
  const cred = { username: 'u', password: 'p' };
  assert.match(digestHeader(state, cred, 'GET', '/a'), /nc=00000001/);
  assert.match(digestHeader(state, cred, 'GET', '/a'), /nc=00000002/);
  assert.match(digestHeader(state, cred, 'GET', '/a'), /nc=00000003/);
});

test('digestHeader: 无 qop 时走 RFC 2069 简化算法', () => {
  const state: DigestState = {
    realm: 'r',
    nonce: 'n',
    algorithm: 'MD5',
    nc: 0,
    cnonce: 'c',
  };
  const header = digestHeader(state, { username: 'u', password: 'p' }, 'GET', '/a');
  assert.doesNotMatch(header, /qop=/);
  assert.doesNotMatch(header, /nc=/);
});

test('digestHeader: qop 列表中挑 auth，不支持 auth-int 时退回简化算法', () => {
  const withAuth: DigestState = {
    realm: 'r', nonce: 'n', qop: 'auth-int,auth', algorithm: 'MD5', nc: 0, cnonce: 'c',
  };
  assert.match(digestHeader(withAuth, { username: 'u', password: 'p' }, 'GET', '/a'), /qop=auth/);

  const onlyAuthInt: DigestState = {
    realm: 'r', nonce: 'n', qop: 'auth-int', algorithm: 'MD5', nc: 0, cnonce: 'c',
  };
  assert.doesNotMatch(
    digestHeader(onlyAuthInt, { username: 'u', password: 'p' }, 'GET', '/a'),
    /qop=/
  );
});

test('digestHeader: uri 必须是编码后路径，与请求行一致', () => {
  const state: DigestState = {
    realm: 'r', nonce: 'n', qop: 'auth', algorithm: 'MD5', nc: 0, cnonce: 'c',
  };
  const header = digestHeader(state, { username: 'u', password: 'p' }, 'GET', '/a%20b.txt');
  assert.match(header, /uri="\/a%20b\.txt"/);
});

test('digestHeader: 用户名中的引号被转义，避免头部注入', () => {
  const state: DigestState = {
    realm: 'r', nonce: 'n', qop: 'auth', algorithm: 'MD5', nc: 0, cnonce: 'c',
  };
  const header = digestHeader(state, { username: 'a"b', password: 'p' }, 'GET', '/a');
  assert.match(header, /username="a\\"b"/);
});

test('canPreAuthenticate: 只有 basic/bearer 能在首个请求携带凭据', () => {
  assert.equal(canPreAuthenticate('basic'), true);
  assert.equal(canPreAuthenticate('bearer'), true);
  assert.equal(canPreAuthenticate('digest'), false);
  assert.equal(canPreAuthenticate('none'), false);
});
