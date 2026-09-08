/**
 * 代理解析与绕过规则单测（PRD FR-1.6 / T-3.5）。
 * CONNECT 隧道的端到端验证见 test/integration/proxy.integration.test.ts。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { parseProxyUrl, shouldBypass, createProxyAgent } from '../../src/webdav/proxy.ts';

test('parseProxyUrl: 基本形态与默认端口', () => {
  assert.deepEqual(parseProxyUrl('http://proxy.corp:8080'), {
    host: 'proxy.corp',
    port: 8080,
  });
  assert.equal(parseProxyUrl('http://proxy.corp')?.port, 80);
  assert.equal(parseProxyUrl('https://proxy.corp')?.port, 443);
});

test('parseProxyUrl: 带凭据时预生成 Proxy-Authorization', () => {
  const p = parseProxyUrl('http://alice:s3cret@proxy.corp:8080');
  assert.equal(p?.host, 'proxy.corp');
  assert.ok(p?.auth);
  assert.equal(Buffer.from(p.auth.slice(6), 'base64').toString('utf8'), 'alice:s3cret');
});

test('parseProxyUrl: 凭据中的百分号编码被还原', () => {
  const p = parseProxyUrl('http://user%40corp:p%40ss@proxy:8080');
  assert.equal(Buffer.from(p!.auth!.slice(6), 'base64').toString('utf8'), 'user@corp:p@ss');
});

test('parseProxyUrl: 非法输入一律返回 undefined（视为不走代理）', () => {
  assert.equal(parseProxyUrl(undefined), undefined);
  assert.equal(parseProxyUrl(''), undefined);
  assert.equal(parseProxyUrl('   '), undefined);
  assert.equal(parseProxyUrl('not a url'), undefined);
  assert.equal(parseProxyUrl('socks5://proxy:1080'), undefined, 'SOCKS 未实现，应判非法');
  assert.equal(parseProxyUrl('http://proxy:99999'), undefined, '端口越界');
});

test('shouldBypass: no_proxy 惯例', () => {
  assert.equal(shouldBypass('cloud.example.com', undefined), false);
  assert.equal(shouldBypass('cloud.example.com', ''), false);
  assert.equal(shouldBypass('cloud.example.com', '*'), true);
  assert.equal(shouldBypass('cloud.example.com', 'cloud.example.com'), true);
  assert.equal(shouldBypass('cloud.example.com', '.example.com'), true);
  assert.equal(shouldBypass('example.com', '.example.com'), true, '后缀规则应覆盖裸域');
  assert.equal(shouldBypass('cloud.example.com', 'other.com'), false);
});

test('shouldBypass: 大小写不敏感、忽略端口、容忍空白', () => {
  assert.equal(shouldBypass('Cloud.Example.COM', 'cloud.example.com'), true);
  assert.equal(shouldBypass('cloud.example.com', 'cloud.example.com:8080'), true);
  assert.equal(shouldBypass('cloud.example.com', ' localhost , cloud.example.com '), true);
  assert.equal(shouldBypass('cloud.example.com', ',,'), false);
});

test('shouldBypass: 不做子串误匹配', () => {
  assert.equal(shouldBypass('notexample.com', 'example.com'), false);
  assert.equal(shouldBypass('example.com.evil.net', 'example.com'), false);
});

test('createProxyAgent: 代理为空时返回 undefined（直连）', () => {
  const settings = { url: '', rejectUnauthorized: true, maxSockets: 6, timeoutMs: 5000 };
  assert.equal(createProxyAgent(false, settings), undefined);
  assert.equal(createProxyAgent(true, settings), undefined);
});

test('createProxyAgent: 明文目标用 absolute-form，TLS 目标走 CONNECT', () => {
  const settings = {
    url: 'http://alice:pw@proxy.corp:8080',
    rejectUnauthorized: true,
    maxSockets: 6,
    timeoutMs: 5000,
  };

  const plain = createProxyAgent(false, settings);
  assert.equal(plain?.useAbsoluteUri, true);
  assert.ok(plain?.proxyAuthHeader, '明文经代理须随请求发送 Proxy-Authorization');

  const secure = createProxyAgent(true, settings);
  assert.equal(secure?.useAbsoluteUri, false, 'TLS 走隧道，请求行仍是 origin-form');
  // 隧道场景下 Proxy-Authorization 只出现在 CONNECT 里，不应混进业务请求头
  assert.equal(secure?.proxyAuthHeader, undefined);
});
