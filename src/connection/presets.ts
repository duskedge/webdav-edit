/**
 * 服务端预设模板（PRD FR-1.1 增强 / 开发计划 T-3.8）。
 *
 * 存在的理由很具体：各服务端的 WebDAV base path 差异是新用户的首个卡点，
 * 而这些前缀既不直观也不易查（Nextcloud 的 `/remote.php/dav/files/<user>/`
 * 尤其如此）。把 5.6 兼容性矩阵里已知的前缀固化成模板，比让用户去翻文档可靠。
 *
 * 不依赖 `vscode`，可脱离扩展宿主单测（NFR-4.1）。
 */
import type { AuthType } from './types.ts';

export interface ServerPreset {
  id: string;
  label: string;
  /** 路径前缀模板，`{username}` 会被实际用户名替换。 */
  pathPrefix: string;
  defaultAuth: AuthType;
  /** 默认端口提示，仅用于 UI 占位符。 */
  portHint?: string;
  /** 展示给用户的注意事项，来自 5.6 矩阵的实测结论。 */
  note?: string;
  /** 该服务端已知的能力缺陷，需要在保存前警告。 */
  warning?: string;
}

export const PRESETS: ServerPreset[] = [
  {
    id: 'generic',
    label: '通用 WebDAV',
    pathPrefix: '/',
    defaultAuth: 'basic',
    note: '若不确定服务端类型，先用「测试连接」验证地址与前缀。',
  },
  {
    id: 'nextcloud',
    label: 'Nextcloud',
    pathPrefix: '/remote.php/dav/files/{username}',
    defaultAuth: 'basic',
    note: '强烈建议使用「应用专用密码」而非账户主密码（设置 → 安全 → 应用密码）。',
  },
  {
    id: 'owncloud',
    label: 'ownCloud',
    pathPrefix: '/remote.php/dav/files/{username}',
    defaultAuth: 'basic',
    note: '前缀随版本略有差异，保存前请用「测试连接」确认。',
  },
  {
    id: 'alist',
    label: 'AList',
    pathPrefix: '/dav',
    defaultAuth: 'basic',
    portHint: '5244',
    warning:
      '后端为对象存储时，MOVE / COPY 可能不受支持；扩展会自动降级为「下载 + 上传」。',
  },
  {
    id: 'synology',
    label: '群晖 DSM',
    pathPrefix: '/',
    defaultAuth: 'basic',
    portHint: '5005（HTTP）/ 5006（HTTPS）',
    note: '需先在「控制面板 → 文件服务 → WebDAV」中启用服务，HTTP 与 HTTPS 端口是分开的。',
  },
  {
    id: 'apache',
    label: 'Apache mod_dav',
    pathPrefix: '/dav',
    defaultAuth: 'digest',
    note: 'mod_dav 常见默认配置为 Digest 认证；若服务端用的是 Basic，请手动切换。',
  },
  {
    id: 'nginx',
    label: 'Nginx（原生 DAV）',
    pathPrefix: '/dav',
    defaultAuth: 'none',
    warning:
      'Nginx 原生 ngx_http_dav_module **不支持 PROPFIND**，无法列目录，因此无法作为工作区打开。' +
      '需在服务端额外启用 nginx-dav-ext-module。',
  },
];

export function findPreset(id: string): ServerPreset | undefined {
  return PRESETS.find((p) => p.id === id);
}

/**
 * 套用模板：替换 `{username}` 占位符并归一化前缀。
 * 用户名为空时保留占位符原样——半成品前缀比一个错误前缀更容易被发现。
 */
export function applyPreset(preset: ServerPreset, username: string): string {
  const prefix = username
    ? preset.pathPrefix.replace(/\{username\}/g, encodeURIComponent(username))
    : preset.pathPrefix;
  return normalizePrefix(prefix);
}

/** 前缀统一为以 `/` 开头、不以 `/` 结尾（根路径除外）。 */
export function normalizePrefix(prefix: string): string {
  const trimmed = (prefix || '/').trim();
  const withLead = trimmed.startsWith('/') ? trimmed : '/' + trimmed;
  const collapsed = withLead.replace(/\/{2,}/g, '/');
  return collapsed.length > 1 ? collapsed.replace(/\/+$/, '') : '/';
}

/**
 * 依据地址与前缀猜测服务端类型，用于「粘贴 URL 后自动选中模板」。
 * 猜不出时返回 generic——猜错比不猜更糟，所以只在特征明确时才下结论。
 */
export function detectPreset(baseUrl: string, pathPrefix: string): ServerPreset {
  const path = pathPrefix.toLowerCase();
  const url = baseUrl.toLowerCase();

  if (path.includes('/remote.php/dav')) {
    // Nextcloud 与 ownCloud 前缀相同，无法从路径区分；域名含 nextcloud 才判定
    return findPreset(url.includes('nextcloud') ? 'nextcloud' : 'owncloud')!;
  }
  if (path.startsWith('/dav') && /:5244(\b|\/)/.test(url)) return findPreset('alist')!;
  if (/:500[56](\b|\/)/.test(url)) return findPreset('synology')!;
  return findPreset('generic')!;
}
