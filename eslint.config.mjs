import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';

/**
 * 开发计划 T-0.1 / PRD NFR-4.1：
 * 协议层（src/webdav/**）必须能脱离 VSCode 扩展宿主独立单测，
 * 因此**禁止 import 'vscode'**。该约束由下方规则强制，而非靠自觉。
 */
export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'out/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: tsParser,
      ecmaVersion: 2022,
      sourceType: 'module',
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-console': 'error',
    },
  },
  {
    // 协议层与其依赖：零 vscode 依赖
    files: ['src/webdav/**/*.ts', 'src/log/redact.ts', 'src/connection/types.ts', 'src/fs/cache.ts', 'src/fs/poller.ts', 'src/connection/presets.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: 'vscode',
              message:
                '协议层禁止 import vscode（PRD NFR-4.1）：该层必须能脱离扩展宿主单测。' +
                '需要 VSCode API 时，把逻辑上移到 fs/ 或 ui/ 层。',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs', 'test/**/*.ts'],
    rules: { 'no-console': 'off' },
  },
];
