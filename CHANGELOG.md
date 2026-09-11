# 更新日志

## 0.1.2

- 修复刷新连接根目录时未清除子目录缓存的问题
- 标题栏刷新现在会覆盖所有已配置连接，即使当前未打开 WebDAV 工作区

## 0.1.1

- 侧边栏连接缺少密码或 Token 时显示友好的重新输入引导
- 补充凭据后自动刷新连接，不再暴露内部 `MissingCredentialsError`

## 0.1.0

首个可用版本。

- 以 `webdav://` 协议把远程目录作为原生工作区打开
- 完整 `FileSystemProvider`：stat / readDirectory / readFile / writeFile /
  createDirectory / delete / rename / copy
- 连接管理：QuickPick 向导 + Webview 面板 + 侧边栏树，含服务端预设模板
- 认证：Basic / Digest / Bearer，凭据存于 `SecretStorage`
- HTTP 代理（含 CONNECT 隧道）、自定义请求头、只读连接
- 元数据 TTL 缓存与并发请求合并
- 保存冲突检测（ETag / `If-Match`）
- 按文件名查找；全文搜索给出明确的不可用说明
- 脱敏诊断日志

### 已实测的服务端差异

- Apache `mod_dav` 对无尾斜杠的集合 URL 返回 301 → 实现同源重定向跟随
- AList 对 `COPY` 返回 500（而非 405/501）→ 扩大降级条件
- 修正：连接超时曾被误用为整个请求期的 socket 空闲超时，导致慢链路上大文件传输被误杀
