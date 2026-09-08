/**
 * 协议层错误分类（PRD FR-4.2）。
 *
 * 本模块刻意不依赖 `vscode`，以便协议层可脱离扩展宿主单测（NFR-4.1）。
 * 到 `vscode.FileSystemError` 的映射在 fs/provider.ts 中完成。
 */
import { redactText } from '../log/redact.ts';

export type WebdavErrorCode =
  | 'Unauthorized' //  401
  | 'Forbidden' //     403
  | 'NotFound' //      404
  | 'NotSupported' //  405 / 501
  | 'Conflict' //      409 父目录不存在
  | 'PreconditionFailed' // 412 ETag 冲突
  | 'Locked' //        423
  | 'InsufficientStorage' // 507
  | 'Timeout'
  | 'NetworkError'
  | 'CertificateError'
  | 'TooLarge'
  | 'ProtocolError' // 响应无法解析
  | 'ServerError' //   5xx
  | 'Unknown';

export class WebdavError extends Error {
  readonly code: WebdavErrorCode;
  readonly status?: number;
  /** 面向用户的中文提示，已脱敏，可直接用于弹窗。 */
  readonly userMessage: string;

  constructor(
    code: WebdavErrorCode,
    userMessage: string,
    opts?: { status?: number; cause?: unknown }
  ) {
    super(redactText(`${code}: ${userMessage}`));
    this.name = 'WebdavError';
    this.code = code;
    this.userMessage = userMessage;
    this.status = opts?.status;
    if (opts?.cause !== undefined) {
      (this as { cause?: unknown }).cause = opts.cause;
    }
  }
}

export function isWebdavError(e: unknown): e is WebdavError {
  return e instanceof WebdavError;
}

/** HTTP 状态码 → 错误分类。`context` 用于拼出可操作的提示文案。 */
export function fromStatus(status: number, context: string): WebdavError {
  const at = context ? `（${context}）` : '';
  switch (status) {
    case 401:
      return new WebdavError('Unauthorized', `认证失败或凭据已失效${at}`, { status });
    case 403:
      return new WebdavError('Forbidden', `没有执行该操作的权限${at}`, { status });
    case 404:
      return new WebdavError('NotFound', `资源不存在${at}`, { status });
    case 405:
    case 501:
      return new WebdavError(
        'NotSupported',
        `服务端不支持该操作${at}，将尝试降级方案`,
        { status }
      );
    case 409:
      return new WebdavError('Conflict', `目标的父目录不存在${at}`, { status });
    case 412:
      return new WebdavError(
        'PreconditionFailed',
        `远端文件已被他人修改${at}`,
        { status }
      );
    case 423:
      return new WebdavError('Locked', `资源已被锁定${at}`, { status });
    case 507:
      return new WebdavError('InsufficientStorage', `远端存储空间不足${at}`, { status });
    default:
      if (status >= 500) {
        return new WebdavError('ServerError', `服务端错误 ${status}${at}`, { status });
      }
      return new WebdavError('Unknown', `请求失败，HTTP ${status}${at}`, { status });
  }
}

/** Node 网络层异常 → 错误分类，含 TLS 证书类的专门识别（FR-4.2 末两行）。 */
export function fromNetworkError(err: unknown, context: string): WebdavError {
  const at = context ? `（${context}）` : '';
  const code = (err as { code?: string } | undefined)?.code ?? '';

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return new WebdavError('Timeout', `连接超时${at}，请检查网络或服务器地址`, {
      cause: err,
    });
  }
  if (CERT_ERROR_CODES.has(code)) {
    return new WebdavError(
      'CertificateError',
      `TLS 证书校验失败${at}。若为自签名证书，可在连接配置中开启“允许自签名证书”`,
      { cause: err }
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new WebdavError('NetworkError', `无法解析服务器域名${at}`, { cause: err });
  }
  if (code === 'ECONNREFUSED') {
    return new WebdavError('NetworkError', `连接被拒绝${at}，请检查地址与端口`, {
      cause: err,
    });
  }
  if (code === 'ECONNRESET' || code === 'EPIPE') {
    return new WebdavError('NetworkError', `连接被重置${at}`, { cause: err });
  }
  return new WebdavError('NetworkError', `网络请求失败${at}`, { cause: err });
}

const CERT_ERROR_CODES = new Set([
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
]);

/** 该错误是否值得自动重试（幂等请求）。 */
export function isRetryable(e: WebdavError): boolean {
  return (
    e.code === 'Timeout' ||
    e.code === 'NetworkError' ||
    (e.code === 'ServerError' && e.status !== 501)
  );
}
