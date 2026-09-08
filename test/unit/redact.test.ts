/**
 * 脱敏单测（PRD NFR-2.4、FR-6.1）。
 * 凭据不得出现在任何日志、错误消息或异常堆栈中——这是安全要求，需要证明而非目测。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import { redactHeaders, redactText, redactUrl } from '../../src/log/redact.ts';
import { WebdavError } from '../../src/webdav/errors.ts';

test('redactHeaders: 敏感头被替换', () => {
  const out = redactHeaders({
    Authorization: 'Basic YWxpY2U6c2VjcmV0',
    'WWW-Authenticate': 'Digest realm="x", nonce="y"',
    Cookie: 'session=abc',
    'Content-Type': 'application/xml',
    Depth: '1',
  });
  assert.equal(out['Authorization'], '***');
  assert.equal(out['WWW-Authenticate'], '***');
  assert.equal(out['Cookie'], '***');
  // 非敏感头保留，否则日志失去诊断价值
  assert.equal(out['Content-Type'], 'application/xml');
  assert.equal(out['Depth'], '1');
});

test('redactHeaders: 头名大小写不敏感', () => {
  const out = redactHeaders({ authorization: 'Basic x', AUTHORIZATION: 'Basic y' });
  assert.equal(out['authorization'], '***');
  assert.equal(out['AUTHORIZATION'], '***');
});

test('redactUrl: 剥离 URL 中的 userinfo', () => {
  assert.equal(
    redactUrl('https://alice:hunter2@cloud.example.com/dav/a.txt'),
    'https://***@cloud.example.com/dav/a.txt'
  );
  // 无 userinfo 时原样保留
  assert.equal(
    redactUrl('https://cloud.example.com/dav/a.txt'),
    'https://cloud.example.com/dav/a.txt'
  );
});

test('redactText: 抹掉 Authorization 值', () => {
  assert.equal(redactText('header: Basic YWxpY2U6c2VjcmV0'), 'header: Basic ***');
  assert.equal(redactText('Bearer eyJhbGciOi.J9_x-y'), 'Bearer ***');
  assert.match(redactText('Digest username="u", response="abc"'), /Digest \*\*\*/);
});

test('redactText: 抹掉 password/token/secret 赋值形态', () => {
  assert.match(redactText('password=hunter2'), /password=\*\*\*/);
  assert.match(redactText('"token": "abc123"'), /"token": "\*\*\*/);
  assert.match(redactText('secret = s3cr3t;'), /secret = \*\*\*/);
  assert.match(redactText('passwd:pw'), /passwd:\*\*\*/);
});

test('redactText: 保留可诊断信息', () => {
  const msg = redactText('PROPFIND https://cloud.example.com/dav/ -> 401 123ms');
  assert.ok(msg.includes('PROPFIND'));
  assert.ok(msg.includes('401'));
  assert.ok(msg.includes('cloud.example.com'));
});

test('WebdavError.message 经过脱敏（异常堆栈不泄漏凭据）', () => {
  const err = new WebdavError('Unauthorized', '认证失败 password=hunter2');
  assert.ok(!err.message.includes('hunter2'), `泄漏: ${err.message}`);
  assert.match(err.message, /\*\*\*/);
});

test('WebdavError 携带 URL 凭据时同样被脱敏', () => {
  const err = new WebdavError('NetworkError', '请求 https://u:p@host/dav 失败');
  assert.ok(!err.message.includes('u:p@'), `泄漏: ${err.message}`);
});
