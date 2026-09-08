/**
 * WebdavError → vscode.FileSystemError 映射（PRD FR-4.2 映射表的落地）。
 *
 * 单独成文件的理由：这是 FR-4.2 表格的唯一实现处，独立后可对照表格逐行审查，
 * 也让 fs/provider.ts 专注于 FSP 语义。
 */
import * as vscode from 'vscode';
import { isWebdavError, type WebdavErrorCode } from '../webdav/errors.ts';
import { log } from '../log/channel.ts';

export function toFsError(err: unknown, uri: vscode.Uri): vscode.FileSystemError {
  if (!isWebdavError(err)) {
    log.error('未分类的异常', err);
    return vscode.FileSystemError.Unavailable(uri);
  }

  log.error(`${err.code} ${uri.toString()}`, err.userMessage);

  const mapping: Record<WebdavErrorCode, () => vscode.FileSystemError> = {
    // 404，以及 409（父目录不存在）——对 VSCode 而言都是「找不到」
    NotFound: () => vscode.FileSystemError.FileNotFound(uri),
    Conflict: () => vscode.FileSystemError.FileNotFound(uri),
    // 401/403/423 都表现为「不允许操作」
    Unauthorized: () => vscode.FileSystemError.NoPermissions(uri),
    Forbidden: () => vscode.FileSystemError.NoPermissions(uri),
    Locked: () => vscode.FileSystemError.NoPermissions(uri),
    // 其余一律 Unavailable，并把可操作的中文提示带给用户
    PreconditionFailed: () => vscode.FileSystemError.Unavailable(err.userMessage),
    NotSupported: () => vscode.FileSystemError.Unavailable(err.userMessage),
    InsufficientStorage: () => vscode.FileSystemError.Unavailable(err.userMessage),
    Timeout: () => vscode.FileSystemError.Unavailable(err.userMessage),
    NetworkError: () => vscode.FileSystemError.Unavailable(err.userMessage),
    CertificateError: () => vscode.FileSystemError.Unavailable(err.userMessage),
    TooLarge: () => vscode.FileSystemError.Unavailable(err.userMessage),
    ProtocolError: () => vscode.FileSystemError.Unavailable(err.userMessage),
    ServerError: () => vscode.FileSystemError.Unavailable(err.userMessage),
    Unknown: () => vscode.FileSystemError.Unavailable(err.userMessage),
  };

  return mapping[err.code]();
}
