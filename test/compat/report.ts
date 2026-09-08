/**
 * 兼容性矩阵报告生成（PRD 5.6）。
 *
 * PRD 5.6 的表格目前全是「待验证」，且要求「空白项代表尚未验证，不得默认为可用」。
 * 手工维护这张表必然漂移，因此由冒烟用例自动采集并生成 Markdown，
 * 直接粘回 PRD 5.6 即可。
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

export interface MatrixRow {
  name: string;
  basePath?: string;
  reachable?: boolean;
  server?: string;
  davLevel?: string;
  allow?: string;
  depth0?: string;
  /** 能力残缺目标（Nginx 原生 DAV）的 PROPFIND 检出结论。 */
  propfind?: string;
  move?: string;
  copy?: string;
  etag?: string;
  etagOnPut?: string;
  roundTrip?: string;
  cjkNames?: string;
  spaceNames?: string;
  listCount?: number;
  deleteRecursive?: string;
}

const rows = new Map<string, MatrixRow>();

export function recordRow(row: MatrixRow): void {
  rows.set(row.name, { ...rows.get(row.name), ...row });
}

const OUT = resolve(process.cwd(), 'doc/compat-matrix.generated.md');

export function writeReport(): void {
  if (rows.size === 0) return;

  const cell = (v: string | number | undefined): string => {
    if (v === undefined || v === '') return '待验证';
    return String(v).replace(/\|/g, '\\|');
  };

  const header = [
    '| 服务端 | 可达 | Base Path | Server | PROPFIND | Depth:0 | MOVE | COPY | ETag | 中文名 | 空格名 | 递归删除 |',
    '| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |',
  ];

  const body = [...rows.values()].map((r) =>
    [
      r.name,
      r.reachable === undefined ? '待验证' : r.reachable ? '✓' : '✗ 不可达',
      cell(r.basePath),
      cell(r.server),
      cell(r.propfind ?? (r.depth0 ? '✓' : undefined)),
      cell(r.depth0),
      cell(r.move),
      cell(r.copy),
      cell(r.etag),
      cell(r.cjkNames),
      cell(r.spaceNames),
      cell(r.deleteRecursive),
    ]
      .map((c) => ` ${c} `)
      .join('|')
  ).map((line) => `|${line}|`);

  const doc = [
    '<!-- 由 `npm run test:compat` 自动生成，请勿手工编辑。 -->',
    '<!-- 生成后可整体替换 PRD 5.6 的表格主体。 -->',
    '',
    `# WebDAV 服务端兼容性矩阵`,
    '',
    `> 生成时间：${new Date().toISOString()}`,
    `> 「待验证」表示该项本次运行未采集到结论——**不得默认为可用**（PRD 5.6）。`,
    '',
    ...header,
    ...body,
    '',
    '## 采集到的 Allow 头',
    '',
    ...[...rows.values()].map((r) => `- **${r.name}**：${r.allow ?? '待验证'}`),
    '',
    '## DAV 合规等级',
    '',
    ...[...rows.values()].map((r) => `- **${r.name}**：${r.davLevel ?? '待验证'}`),
    '',
    '## 未覆盖项',
    '',
    '- **群晖 DSM**：无容器化途径，需真机手工验证或降级为社区反馈驱动（开发计划 §2.2）。',
    '',
  ].join('\n');

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, doc, 'utf8');
  console.log(`\n[compat] 矩阵已写入 ${OUT}`);
}
