import { defineConfig } from 'vitest/config';

/**
 * 性能基准（NFR-1.4 / T-3.7）。
 * 独立配置：基准耗时长且对并发敏感，不能混进默认门禁。
 */
export default defineConfig({
  test: {
    include: ['test/bench/**/*.bench.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    hookTimeout: 180_000,
    // 基准必须串行，否则互相争抢 CPU 与连接池，数字失去意义
    fileParallelism: false,
    sequence: { concurrent: false },
  },
});
