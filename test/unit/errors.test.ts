/**
 * 错误分类单测（PRD FR-4.2 映射表逐行验证）。
 *
 * FR-4.2 是一张规格表格，这里按行覆盖，确保表与实现不漂移。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  fromNetworkError,
  fromStatus,
  isRetryable,
  isWebdavError,
  WebdavError,
} from '../../src/webdav/errors.ts';

test('fromStatus: 覆盖 FR-4.2 映射表全部状态码', () => {
  const cases: Array<[number, string]> = [
    [401, 'Unauthorized'],
    [403, 'Forbidden'],
    [404, 'NotFound'],
    [405, 'NotSupported'],
    [501, 'NotSupported'],
    [409, 'Conflict'],
    [412, 'PreconditionFailed'],
    [423, 'Locked'],
    [507, 'InsufficientStorage'],
  ];
  for (const [status, code] of cases) {
    const err = fromStatus(status, 'ctx');
    assert.equal(err.code, code, `HTTP ${status} 应映射为 ${code}`);
    assert.equal(err.status, status);
    assert.ok(err.userMessage.length > 0, `${status} 缺少用户提示`);
  }
});

test('fromStatus: 5xx 归为 ServerError', () => {
  assert.equal(fromStatus(500, 'x').code, 'ServerError');
  assert.equal(fromStatus(502, 'x').code, 'ServerError');
  assert.equal(fromStatus(503, 'x').code, 'ServerError');
  // 501 例外：属于「不支持该动作」，可降级而非重试
  assert.equal(fromStatus(501, 'x').code, 'NotSupported');
});

test('fromStatus: 其余 4xx 归为 Unknown 并带上状态码', () => {
  const err = fromStatus(418, 'x');
  assert.equal(err.code, 'Unknown');
  assert.match(err.userMessage, /418/);
});

test('fromStatus: context 出现在用户提示中', () => {
  assert.match(fromStatus(404, 'readFile').userMessage, /readFile/);
  // 空 context 不应留下空括号
  assert.doesNotMatch(fromStatus(404, '').userMessage, /（）/);
});

test('fromNetworkError: 超时', () => {
  for (const code of ['ETIMEDOUT', 'ESOCKETTIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']) {
    assert.equal(fromNetworkError({ code }, 'x').code, 'Timeout');
  }
});

test('fromNetworkError: TLS 证书类错误单独识别并给出可操作建议 (FR-4.2 末行)', () => {
  const certCodes = [
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'SELF_SIGNED_CERT_IN_CHAIN',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
    'CERT_HAS_EXPIRED',
    'ERR_TLS_CERT_ALTNAME_INVALID',
  ];
  for (const code of certCodes) {
    const err = fromNetworkError({ code }, 'x');
    assert.equal(err.code, 'CertificateError', code);
    // 必须引导到「允许自签名证书」开关，否则用户无从下手
    assert.match(err.userMessage, /自签名证书/);
  }
});

test('fromNetworkError: DNS 与连接类错误', () => {
  assert.equal(fromNetworkError({ code: 'ENOTFOUND' }, 'x').code, 'NetworkError');
  assert.match(fromNetworkError({ code: 'ENOTFOUND' }, 'x').userMessage, /域名/);
  assert.match(fromNetworkError({ code: 'ECONNREFUSED' }, 'x').userMessage, /端口/);
  assert.equal(fromNetworkError({ code: 'ECONNRESET' }, 'x').code, 'NetworkError');
  assert.equal(fromNetworkError({ code: 'EPIPE' }, 'x').code, 'NetworkError');
});

test('fromNetworkError: 未知错误兜底为 NetworkError，不抛出', () => {
  assert.equal(fromNetworkError(undefined, 'x').code, 'NetworkError');
  assert.equal(fromNetworkError(new Error('boom'), 'x').code, 'NetworkError');
  assert.equal(fromNetworkError({ code: 'WEIRD' }, 'x').code, 'NetworkError');
});

test('fromNetworkError: 保留 cause 便于诊断', () => {
  const cause = { code: 'ECONNRESET' };
  const err = fromNetworkError(cause, 'x');
  assert.equal((err as { cause?: unknown }).cause, cause);
});

test('isRetryable: 只重试瞬时性错误', () => {
  assert.equal(isRetryable(fromNetworkError({ code: 'ETIMEDOUT' }, 'x')), true);
  assert.equal(isRetryable(fromNetworkError({ code: 'ECONNRESET' }, 'x')), true);
  assert.equal(isRetryable(fromStatus(500, 'x')), true);
  // 以下重试无意义，重试只会放大问题
  assert.equal(isRetryable(fromStatus(401, 'x')), false);
  assert.equal(isRetryable(fromStatus(404, 'x')), false);
  assert.equal(isRetryable(fromStatus(409, 'x')), false);
  assert.equal(isRetryable(fromStatus(501, 'x')), false, '501 应降级而非重试');
});

test('isWebdavError 类型守卫', () => {
  assert.equal(isWebdavError(fromStatus(404, 'x')), true);
  assert.equal(isWebdavError(new Error('plain')), false);
  assert.equal(isWebdavError(undefined), false);
  assert.equal(isWebdavError('string'), false);
});

test('WebdavError 保留 code / status / userMessage', () => {
  const err = new WebdavError('TooLarge', '文件过大', { status: 413 });
  assert.equal(err.name, 'WebdavError');
  assert.equal(err.code, 'TooLarge');
  assert.equal(err.status, 413);
  assert.equal(err.userMessage, '文件过大');
  assert.ok(err instanceof Error);
});
