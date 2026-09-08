import { defineConfig } from 'vitest/config';

/**
 * 兼容性冒烟用例（PRD 5.6）。
 *
 * 独立配置的理由：这些用例需要真实 WebDAV 服务端（docker/compose.yml），
 * 不能进入默认 `npm test` 的门禁——否则没有 docker 环境的开发者无法跑测试。
 */
export default defineConfig({
  test: {
    include: ['test/compat/**/*.compat.test.ts'],
    environment: 'node',
    // 真实网络往返比内存服务端慢得多
    testTimeout: 30_000,
    hookTimeout: 60_000,
    // 共享常驻环境下并发写同一沙盒会互相干扰（开发计划 §2.3）
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
