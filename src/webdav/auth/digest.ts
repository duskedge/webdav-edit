/**
 * HTTP Digest 认证（PRD FR-1.5 P1）。
 *
 * Apache `mod_dav` 的常见默认配置，5.6 矩阵中唯一需要 Digest 的环境。
 * 实现对照 RFC 2617，单测以其 §3.5 官方向量为黄金标准。
 */
import { createHash, randomBytes } from 'crypto';
import type { Credentials, DigestState } from '../types.ts';

/**
 * 解析 `WWW-Authenticate: Digest ...` 质询。
 * 服务端可能同时给出多种 scheme，这里只挑 Digest。
 */
export function parseDigestChallenge(header: string): DigestState | undefined {
  const idx = header.toLowerCase().indexOf('digest ');
  if (idx < 0) return undefined;
  const params = header.slice(idx + 7);

  const get = (key: string): string | undefined => {
    const quoted = new RegExp(`${key}\\s*=\\s*"([^"]*)"`, 'i').exec(params);
    if (quoted) return quoted[1];
    const bare = new RegExp(`${key}\\s*=\\s*([^,\\s]+)`, 'i').exec(params);
    return bare ? bare[1] : undefined;
  };

  const realm = get('realm');
  const nonce = get('nonce');
  if (realm === undefined || nonce === undefined) return undefined;

  return {
    realm,
    nonce,
    qop: get('qop'),
    opaque: get('opaque'),
    algorithm: (get('algorithm') ?? 'MD5').toUpperCase(),
    nc: 0,
    cnonce: randomBytes(8).toString('hex'),
  };
}

/**
 * 依据质询生成 `Authorization: Digest ...`。
 * 会就地递增 `state.nc`（RFC 2617 要求同一 nonce 下计数单调递增）。
 */
export function digestHeader(
  state: DigestState,
  cred: Credentials,
  method: string,
  /** 请求目标的**编码后**路径，须与实际请求行一致，否则校验必失败。 */
  encodedUri: string
): string {
  const algo = state.algorithm.replace('-SESS', '');
  const hash = (s: string): string =>
    createHash(algo === 'SHA-256' ? 'sha256' : 'md5')
      .update(s, 'utf8')
      .digest('hex');

  state.nc += 1;
  const nc = state.nc.toString(16).padStart(8, '0');

  let ha1 = hash(`${cred.username}:${state.realm}:${cred.password}`);
  if (state.algorithm.endsWith('-SESS')) {
    ha1 = hash(`${ha1}:${state.nonce}:${state.cnonce}`);
  }
  const ha2 = hash(`${method}:${encodedUri}`);

  const qop = pickQop(state.qop);
  const response = qop
    ? hash(`${ha1}:${state.nonce}:${nc}:${state.cnonce}:${qop}:${ha2}`)
    : hash(`${ha1}:${state.nonce}:${ha2}`);

  const parts = [
    `username="${escapeQuoted(cred.username)}"`,
    `realm="${escapeQuoted(state.realm)}"`,
    `nonce="${escapeQuoted(state.nonce)}"`,
    `uri="${encodedUri}"`,
    `response="${response}"`,
    `algorithm=${state.algorithm}`,
  ];
  if (qop) {
    parts.push(`qop=${qop}`, `nc=${nc}`, `cnonce="${state.cnonce}"`);
  }
  if (state.opaque !== undefined) {
    parts.push(`opaque="${escapeQuoted(state.opaque)}"`);
  }
  return 'Digest ' + parts.join(', ');
}

/** qop 可能是 `auth,auth-int` 列表；我们只实现 auth。 */
function pickQop(qop: string | undefined): string | undefined {
  if (!qop) return undefined;
  const options = qop.split(',').map((s) => s.trim().toLowerCase());
  return options.includes('auth') ? 'auth' : undefined;
}

function escapeQuoted(s: string): string {
  return s.replace(/(["\\])/g, '\\$1');
}
