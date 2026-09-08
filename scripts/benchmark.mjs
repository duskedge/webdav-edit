/**
 * 性能基准（PRD NFR-1.4 / 开发计划 T-3.7）。
 *
 * 逐项验证 NFR-1.4 的五个指标并给出 P95。
 *
 *   node scripts/benchmark.mjs                 # 对内置内存服务端跑（相对基线）
 *   DAV_HOST=nas-debian node scripts/benchmark.mjs   # 对内网真机跑（正式基线）
 *
 * ⚠ 重要前提：NFR-1.4 的指标定义在「100Mbps 局域网 + Nextcloud」环境下。
 * 对 localhost 内存服务端跑出来的数字是**失真的乐观值**，只能用于回归比较，
 * 不能作为达标依据——脚本会在报告中明确标注这一点。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

const HOST = process.env.DAV_HOST;
const ITERATIONS = Number(process.env.BENCH_ITERATIONS ?? 20);

if (!existsSync('dist/extension.js')) {
  console.error('请先执行 npm run build');
  process.exit(1);
}

// 用 vitest 跑基准用例：复用其 TS 加载能力，避免自己搭一套
const result = spawnSync(
  'npx',
  ['vitest', 'run', '--config', 'vitest.bench.config.mts'],
  {
    stdio: 'inherit',
    env: {
      ...process.env,
      BENCH_ITERATIONS: String(ITERATIONS),
      ...(HOST ? { DAV_HOST: HOST } : {}),
    },
  }
);

if (result.status !== 0) {
  console.error('\n基准未达标或执行失败。');
  process.exit(result.status ?? 1);
}

if (!HOST) {
  console.log(
    '\n⚠ 本次针对本地内存服务端运行，数字偏乐观，仅可用于回归比较。\n' +
      '  正式达标验证须在 100Mbps 局域网环境执行：DAV_HOST=<home-debian> node scripts/benchmark.mjs'
  );
}
