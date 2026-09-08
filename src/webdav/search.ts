/**
 * 按文件名递归查找（PRD FR-5.1 v1.0 方案 / 开发计划 T-3.9）。
 *
 * 为什么不是全文搜索：`FileSearchProvider` / `TextSearchProvider` 至今仍是
 * proposed API，使用后无法发布到 Marketplace（PRD FR-5.1）。因此 v1.0 只做
 * 文件名查找，并在搜索入口明确告知全文搜索不可用——**关键是不能静默无结果**。
 *
 * 递归 PROPFIND 在大目录树上代价极高，因此三重限制缺一不可：
 * 最大深度、最大访问目录数、超时。命中上限时如实上报 truncated，
 * 让 UI 能说明「结果不完整」而不是假装搜完了。
 *
 * 不依赖 `vscode`，可脱离扩展宿主单测（NFR-4.1）。
 */
import type { IWebdavClient } from './types.ts';

export interface SearchLimits {
  /** 相对于起始目录的最大递归深度。 */
  maxDepth: number;
  /** 最多访问多少个目录（真正的成本上限）。 */
  maxDirectories: number;
  /** 最多返回多少条结果。 */
  maxResults: number;
  timeoutMs: number;
}

export const DEFAULT_LIMITS: SearchLimits = {
  maxDepth: 6,
  maxDirectories: 200,
  maxResults: 200,
  timeoutMs: 15_000,
};

export interface SearchHit {
  path: string;
  name: string;
  isDirectory: boolean;
}

export interface SearchOutcome {
  hits: SearchHit[];
  /** 因触达任一限制而提前结束——UI 必须据此说明结果不完整。 */
  truncated: boolean;
  /** 触发截断的原因，便于给出可操作提示。 */
  reason?: 'depth' | 'directories' | 'results' | 'timeout' | 'cancelled';
  directoriesVisited: number;
}

export interface SearchOptions {
  limits?: Partial<SearchLimits>;
  signal?: AbortSignal;
  /** 每访问一个目录回调一次，供 UI 显示进度。 */
  onProgress?: (visited: number, current: string) => void;
}

/**
 * 广度优先递归查找文件名包含 `query` 的条目（大小写不敏感）。
 *
 * 用 BFS 而非 DFS：浅层结果通常更相关，触达上限时留下的也是更有用的那批。
 */
export async function searchByName(
  client: IWebdavClient,
  root: string,
  query: string,
  options: SearchOptions = {}
): Promise<SearchOutcome> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const needle = query.trim().toLowerCase();
  const hits: SearchHit[] = [];

  if (!needle) {
    return { hits, truncated: false, directoriesVisited: 0 };
  }

  const deadline = Date.now() + limits.timeoutMs;
  let queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
  let visited = 0;
  let truncated = false;
  let reason: SearchOutcome['reason'];

  while (queue.length > 0) {
    if (options.signal?.aborted) {
      truncated = true;
      reason = 'cancelled';
      break;
    }
    if (Date.now() > deadline) {
      truncated = true;
      reason = 'timeout';
      break;
    }
    if (visited >= limits.maxDirectories) {
      truncated = true;
      reason = 'directories';
      break;
    }

    const next = queue.shift();
    if (!next) break;

    visited += 1;
    options.onProgress?.(visited, next.path);

    let entries;
    try {
      entries = await client.list(next.path, '按文件名查找');
    } catch {
      // 单个目录不可读（权限等）不应中断整次搜索
      continue;
    }

    for (const entry of entries) {
      const path = next.path === '/' ? `/${entry.name}` : `${next.path}/${entry.name}`;

      if (entry.name.toLowerCase().includes(needle)) {
        hits.push({ path, name: entry.name, isDirectory: entry.isDirectory });
        if (hits.length >= limits.maxResults) {
          return {
            hits,
            truncated: true,
            reason: 'results',
            directoriesVisited: visited,
          };
        }
      }

      if (entry.isDirectory) {
        if (next.depth + 1 <= limits.maxDepth) {
          queue.push({ path, depth: next.depth + 1 });
        } else {
          truncated = true;
          reason = reason ?? 'depth';
        }
      }
    }
  }

  // 队列未清空说明是被上面某个限制打断的
  if (queue.length > 0) truncated = true;

  return {
    hits,
    truncated,
    ...(reason !== undefined ? { reason } : {}),
    directoriesVisited: visited,
  };
}

/** 把截断原因翻译成可操作的中文说明。 */
export function describeTruncation(outcome: SearchOutcome, limits = DEFAULT_LIMITS): string {
  switch (outcome.reason) {
    case 'depth':
      return `已达最大深度 ${limits.maxDepth} 层，更深的目录未搜索`;
    case 'directories':
      return `已扫描 ${outcome.directoriesVisited} 个目录并达到上限，结果不完整`;
    case 'results':
      return `结果超过 ${limits.maxResults} 条，仅显示前一批`;
    case 'timeout':
      return `搜索超时（${Math.round(limits.timeoutMs / 1000)} 秒），结果不完整`;
    case 'cancelled':
      return '搜索已取消，结果不完整';
    default:
      return '结果不完整';
  }
}
