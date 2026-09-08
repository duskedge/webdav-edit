import { defineConfig } from 'vitest/config';

/**
 * 协议层为纯 Node 模块，无需 Electron 宿主即可测试（PRD NFR-4.1）。
 * FSP 与 UI 层的集成测试走 @vscode/test-cli，不在此配置内。
 */
export default defineConfig({
  test: {
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      // 需要 vscode 宿主的层不在此计覆盖率，由 @vscode/test-cli 覆盖
      exclude: [
        'src/extension.ts',
        'src/ui/**',
        'src/fs/provider.ts',
        'src/fs/errorMap.ts',
        'src/connection/store.ts',
        'src/connection/secrets.ts',
        'src/connection/resolver.ts',
        'src/log/channel.ts',
        'src/webdav/types.ts',
      ],
      reporter: ['text', 'html'],
      // NFR-4.2：协议层单测覆盖率 ≥ 70%
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 70,
        statements: 70,
        // T-1.1：path.ts 要求 ≥ 90%
        'src/webdav/path.ts': {
          lines: 90,
          functions: 90,
          branches: 90,
          statements: 90,
        },
      },
    },
  },
});
