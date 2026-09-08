/**
 * 兼容性矩阵的目标服务端清单（PRD 5.6 / 开发计划 §2.2）。
 *
 * 默认指向 `docker/compose.yml` 起的本地集群；设 `DAV_HOST` 可指向内网
 * home-debian 常驻环境（NFR-1.4 的性能基准须在真实局域网测得）。
 */
import type { AuthType } from '../../src/connection/types.ts';

const HOST = process.env['DAV_HOST'] ?? '127.0.0.1';
const USER = process.env['DAV_USER'] ?? 'davtest';
const PASS = process.env['DAV_PASS'] ?? 'davtest-pw';

export interface CompatTarget {
  /** 矩阵中的行名。 */
  name: string;
  baseUrl: string;
  pathPrefix: string;
  authType: AuthType;
  username: string;
  password: string;
  ignoreSsl?: boolean;
  /**
   * 已知不支持 PROPFIND（Nginx 原生 DAV）。
   * 这类目标只跑「能力检出」用例，不跑读写冒烟。
   */
  expectNoPropfind?: boolean;
}

export const TARGETS: CompatTarget[] = [
  {
    name: 'Nextcloud',
    baseUrl: `http://${HOST}:8081`,
    pathPrefix: `/remote.php/dav/files/${USER}`,
    authType: 'basic',
    username: USER,
    password: PASS,
  },
  {
    name: 'ownCloud',
    baseUrl: `http://${HOST}:8082`,
    pathPrefix: `/remote.php/dav/files/${USER}`,
    authType: 'basic',
    username: USER,
    password: PASS,
  },
  {
    // AList 的账号固定为 admin（其用户体系不支持在容器启动时指定用户名）
    name: 'AList',
    baseUrl: `http://${HOST}:8083`,
    pathPrefix: '/dav/test',
    authType: 'basic',
    username: process.env['ALIST_USER'] ?? 'admin',
    password: PASS,
  },
  {
    name: 'Apache mod_dav (Digest)',
    baseUrl: `http://${HOST}:8084`,
    pathPrefix: '/dav',
    authType: 'digest',
    username: USER,
    password: PASS,
  },
  {
    name: 'Apache mod_dav (Basic)',
    baseUrl: `http://${HOST}:8084`,
    pathPrefix: '/dav-basic',
    authType: 'basic',
    username: USER,
    password: PASS,
  },
  {
    name: 'Apache mod_dav (TLS 自签名)',
    baseUrl: `https://${HOST}:8443`,
    pathPrefix: '/dav-basic',
    authType: 'basic',
    username: USER,
    password: PASS,
    ignoreSsl: true,
  },
  {
    name: 'Nginx 原生 DAV',
    baseUrl: `http://${HOST}:8085`,
    pathPrefix: '/dav',
    authType: 'none',
    username: '',
    password: '',
    expectNoPropfind: true,
  },
];

/** 只跑指定目标：`DAV_TARGETS="Nextcloud,AList" npm run test:compat` */
export function selectedTargets(): CompatTarget[] {
  const filter = process.env['DAV_TARGETS'];
  if (!filter) return TARGETS;
  const wanted = filter.split(',').map((s) => s.trim().toLowerCase());
  return TARGETS.filter((t) => wanted.some((w) => t.name.toLowerCase().includes(w)));
}
