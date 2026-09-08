/**
 * 兼容性冒烟用例集（PRD 5.6 / 开发计划 §2.2、§2.3）。
 *
 * 对真实服务端逐个跑通 PRD 5.6 要求的七步：
 *   连接测试 → 列目录（含中文/空格文件名）→ 读 → 写 → 新建目录 → 重命名 → 删除
 * 并顺带采集 5.6 矩阵的各列（Depth:0 / MOVE / COPY / ETag 稳定性）。
 *
 * 两条来自 §2.3 的硬约束：
 *   1. **沙盒隔离**：所有破坏性操作只作用于 /dav-sandbox/<run-id>/，
 *      绝不触碰共享的基线数据。
 *   2. **可复位**：用例自行清理沙盒；残留由 docker/reset.sh 兜底。
 *
 * 服务端不可达时**跳过而非失败**——没有 docker 环境的开发者仍应能跑 `npm test`。
 * 可达性在模块加载期探测（顶层 await），以便用 `describe.skipIf` 在收集阶段就跳过，
 * 而不是让用例带着未初始化的客户端跑进断言。
 *
 * 本文件不在默认 `vitest run` 范围内，需 `npm run test:compat`。
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { HttpClient } from '../../src/webdav/request.ts';
import { WebdavClient } from '../../src/webdav/client.ts';
import { isWebdavError } from '../../src/webdav/errors.ts';
import { selectedTargets, type CompatTarget } from './targets.ts';
import { recordRow, writeReport, type MatrixRow } from './report.ts';

const RUN_ID = `run-${Date.now().toString(36)}`;
const SANDBOX = `/dav-sandbox/${RUN_ID}`;

function makeClient(t: CompatTarget): { dav: WebdavClient; http: HttpClient } {
  const http = new HttpClient({
    baseUrl: t.baseUrl,
    authType: t.authType,
    ignoreSsl: t.ignoreSsl ?? false,
    connectTimeoutMs: 8000,
    requestTimeoutMs: 20000,
    maxConcurrent: 4,
    getCredentials: async () => ({ username: t.username, password: t.password }),
  });
  return { dav: new WebdavClient(http, t.pathPrefix, t.baseUrl), http };
}

async function probe(t: CompatTarget): Promise<boolean> {
  const { dav, http } = makeClient(t);
  try {
    await dav.stat('/');
    return true;
  } catch (err) {
    // 已知不支持 PROPFIND 的目标仍算「可达」，由专门用例断言其降级行为
    return Boolean(t.expectNoPropfind && isWebdavError(err) && err.code === 'NotSupported');
  } finally {
    http.dispose();
  }
}

const targets = selectedTargets();

// 顶层探测：结果供 describe.skipIf 在收集阶段使用
const reachable = new Map<string, boolean>(
  await Promise.all(
    targets.map(async (t): Promise<[string, boolean]> => [t.name, await probe(t)])
  )
);

const unreachable = targets.filter((t) => !reachable.get(t.name));
if (unreachable.length > 0) {
  // 直接写 stderr：vitest 会捕获 console.*，而全部跳过时那些输出不会被打印出来，
  // 结果是开发者只看到一片「skipped」却不知为何——正是要避免的静默失败。
  process.stderr.write(
    `\n[compat] 以下服务端不可达，相关用例已跳过：\n` +
      unreachable.map((t) => `  - ${t.name} (${t.baseUrl})`).join('\n') +
      `\n  启动测试环境： cd docker && docker compose up -d && ./seed.sh` +
      `\n  或指向内网常驻环境： DAV_HOST=<home-debian> npm run test:compat\n\n`
  );
  for (const t of unreachable) {
    recordRow({ name: t.name, basePath: t.pathPrefix, reachable: false });
  }
}

// 全部目标都不可达时，下面的 describe 会被整体跳过，afterAll 也就不会执行。
// 此处先落一版报告，保证矩阵不会停留在上一次运行的陈旧结论上。
if (unreachable.length === targets.length) {
  writeReport();
}

afterAll(() => {
  writeReport();
});

for (const target of targets) {
  const live = reachable.get(target.name) === true;

  describe.skipIf(!live)(target.name, () => {
    let dav: WebdavClient;
    let http: HttpClient;
    const row: MatrixRow = {
      name: target.name,
      basePath: target.pathPrefix,
      reachable: true,
    };

    beforeAll(async () => {
      ({ dav, http } = makeClient(target));
      if (!target.expectNoPropfind) {
        await dav.mkcol('/dav-sandbox').catch(() => undefined);
        await dav.mkcol(SANDBOX).catch(() => undefined);
      }
    });

    afterAll(async () => {
      // §2.3 可复位：用例自行清理沙盒
      if (!target.expectNoPropfind) {
        await dav.remove(SANDBOX, true).catch(() => undefined);
      }
      http.dispose();
      recordRow(row);
    });

    // ── 能力残缺目标：只验证检出路径可读（PRD 风险表 A1）──
    test.runIf(target.expectNoPropfind)(
      'PROPFIND 不受支持时，连接测试给出可操作提示而非裸 405',
      async () => {
        await expect(dav.testConnection()).rejects.toThrow(/nginx-dav-ext-module/);
        row.propfind = '✗ 不支持（已正确检出）';
      }
    );

    // ── 常规目标：PRD 5.6 要求的七步冒烟 ──
    const smoke = test.skipIf(target.expectNoPropfind);

    smoke('① 连接测试成功并回显服务端信息', async () => {
      const info = await dav.testConnection();
      row.server = info.server ?? '(未回显)';
      row.davLevel = info.dav ?? '(未回显)';
      expect(info).toBeTruthy();
    });

    smoke('② OPTIONS 能力探测', async () => {
      try {
        const caps = await dav.options('/');
        row.allow = caps.allow.join(' ');
      } catch (err) {
        row.allow = `OPTIONS 失败: ${describeErr(err)}`;
      }
    });

    smoke('③ stat 支持 Depth:0（失败则走父目录回退）', async () => {
      const stat = await dav.stat('/');
      expect(stat.isDirectory).toBe(true);
      row.depth0 = '✓';
    });

    smoke('④ 列目录，含中文与空格文件名', async () => {
      const entries = await dav.list('/');
      row.listCount = entries.length;
      // 基线数据集由 docker/seed.sh 播种
      const names = entries.map((e) => e.name);
      row.cjkNames = names.some((n) => /[一-龥]/.test(n))
        ? '✓'
        : '未见（种子数据缺失？）';
      row.spaceNames = names.some((n) => n.includes(' '))
        ? '✓'
        : '未见（种子数据缺失？）';
    });

    smoke('⑤ 写入 → 读回，内容与 ETag 一致（含难字符文件名）', async () => {
      const path = `${SANDBOX}/写入 测试 (1)#&+.txt`;
      const body = Buffer.from('冒烟内容 smoke\n', 'utf8');

      const putEtag = await dav.write(path, body);
      const read = await dav.read(path);
      expect(read.data.toString('utf8')).toBe(body.toString('utf8'));

      row.roundTrip = '✓';
      row.etag = read.etag ? '✓' : '未返回 ETag';
      // 部分服务端 PUT 不回 ETag，需 GET 才有——记录差异供 FR-4.4 参考
      row.etagOnPut = putEtag ? '✓' : '仅 GET 返回';
    });

    smoke('⑥ 新建目录 → 重命名（MOVE）', async () => {
      const from = `${SANDBOX}/目录 A`;
      const to = `${SANDBOX}/目录 B`;
      await dav.mkcol(from);
      try {
        await dav.move(from, to, true);
        expect((await dav.stat(to)).isDirectory).toBe(true);
        row.move = '✓';
      } catch (err) {
        row.move = `✗ ${describeErr(err)}`;
      }
    });

    smoke('⑦ 复制（COPY），不支持时应报 NotSupported 供上层降级', async () => {
      const src = `${SANDBOX}/copy-src.txt`;
      const dst = `${SANDBOX}/copy-dst.txt`;
      await dav.write(src, Buffer.from('copy me', 'utf8'));
      try {
        await dav.copy(src, dst, true);
        expect((await dav.read(dst)).data.toString()).toBe('copy me');
        row.copy = '✓';
      } catch (err) {
        row.copy =
          isWebdavError(err) && err.code === 'NotSupported'
            ? '✗ 不支持（已正确检出，可降级）'
            : `✗ ${describeErr(err)}`;
      }
    });

    smoke('⑧ 删除（递归）', async () => {
      const dir = `${SANDBOX}/del`;
      await dav.mkcol(dir);
      await dav.write(`${dir}/a.txt`, Buffer.from('a', 'utf8'));
      await dav.remove(dir, true);
      await expect(dav.stat(dir)).rejects.toThrow();
      row.deleteRecursive = '✓';
    });

    smoke('⑨ 不存在的路径映射为 NotFound', async () => {
      await expect(dav.stat(`${SANDBOX}/missing-${RUN_ID}.txt`)).rejects.toSatisfy(
        (err: unknown) => isWebdavError(err) && err.code === 'NotFound'
      );
    });
  });
}

function describeErr(err: unknown): string {
  return isWebdavError(err) ? `${err.code}(${err.status ?? '-'})` : String(err);
}
