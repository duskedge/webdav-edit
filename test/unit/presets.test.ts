/**
 * 服务端预设模板单测（PRD FR-1.1 增强 / T-3.8）。
 *
 * 模板的价值在于「前缀写对」，因此重点覆盖占位符替换与归一化——
 * 一个错误的前缀会让用户看到「连不上」却完全不知道该改哪里。
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  applyPreset,
  detectPreset,
  findPreset,
  normalizePrefix,
  PRESETS,
} from '../../src/connection/presets.ts';

test('每个预设都有唯一 id、标签与合法前缀', () => {
  const ids = new Set<string>();
  for (const p of PRESETS) {
    assert.ok(p.id && p.label, `预设缺少 id 或 label: ${JSON.stringify(p)}`);
    assert.ok(!ids.has(p.id), `预设 id 重复: ${p.id}`);
    ids.add(p.id);
    assert.ok(p.pathPrefix.startsWith('/'), `${p.id} 的前缀须以 / 开头`);
  }
  assert.ok(ids.has('generic'), '必须存在 generic 兜底预设');
});

test('5.6 矩阵中的服务端都有对应预设', () => {
  for (const id of ['nextcloud', 'owncloud', 'alist', 'synology', 'apache', 'nginx']) {
    assert.ok(findPreset(id), `缺少 ${id} 预设`);
  }
});

test('applyPreset: 替换 {username} 占位符', () => {
  const nc = findPreset('nextcloud')!;
  assert.equal(applyPreset(nc, 'alice'), '/remote.php/dav/files/alice');
});

test('applyPreset: 用户名做百分号编码，避免前缀被特殊字符破坏', () => {
  const nc = findPreset('nextcloud')!;
  assert.equal(applyPreset(nc, 'a b'), '/remote.php/dav/files/a%20b');
  assert.equal(applyPreset(nc, '张三'), '/remote.php/dav/files/%E5%BC%A0%E4%B8%89');
});

test('applyPreset: 用户名为空时保留占位符（半成品比错误前缀更易被发现）', () => {
  const nc = findPreset('nextcloud')!;
  assert.ok(applyPreset(nc, '').includes('{username}'));
});

test('applyPreset: 无占位符的预设原样返回', () => {
  assert.equal(applyPreset(findPreset('alist')!, 'alice'), '/dav');
  assert.equal(applyPreset(findPreset('synology')!, 'alice'), '/');
});

test('normalizePrefix: 统一为前导斜杠、无尾斜杠', () => {
  assert.equal(normalizePrefix('dav'), '/dav');
  assert.equal(normalizePrefix('/dav/'), '/dav');
  assert.equal(normalizePrefix('/dav//sub//'), '/dav/sub');
  assert.equal(normalizePrefix('/'), '/');
  assert.equal(normalizePrefix(''), '/');
  assert.equal(normalizePrefix('   /dav/  '), '/dav');
});

test('detectPreset: 识别 Nextcloud / ownCloud', () => {
  assert.equal(
    detectPreset('https://nextcloud.example.com', '/remote.php/dav/files/alice').id,
    'nextcloud'
  );
  // 域名无 nextcloud 特征时判为 ownCloud（两者前缀相同，无法从路径区分）
  assert.equal(
    detectPreset('https://cloud.example.com', '/remote.php/dav/files/alice').id,
    'owncloud'
  );
});

test('detectPreset: 按端口识别 AList 与群晖', () => {
  assert.equal(detectPreset('http://192.168.1.2:5244', '/dav').id, 'alist');
  assert.equal(detectPreset('http://192.168.1.9:5005', '/').id, 'synology');
  assert.equal(detectPreset('https://192.168.1.9:5006', '/').id, 'synology');
});

test('detectPreset: 特征不明确时退回 generic（猜错比不猜更糟）', () => {
  assert.equal(detectPreset('https://example.com', '/').id, 'generic');
  assert.equal(detectPreset('https://example.com', '/webdav').id, 'generic');
});

test('已知能力缺陷的服务端必须带 warning', () => {
  // Nginx 原生模块不支持 PROPFIND，用户必须在保存前就知道
  assert.match(findPreset('nginx')!.warning ?? '', /PROPFIND/);
  // AList 后端可能不支持 MOVE/COPY
  assert.match(findPreset('alist')!.warning ?? '', /MOVE|COPY/);
});

test('Nextcloud 预设提示使用应用专用密码（安全实践）', () => {
  assert.match(findPreset('nextcloud')!.note ?? '', /应用专用密码/);
});
