# WebDAV Edit

[English](README.md) | [简体中文](README.zh-CN.md)

**WebDAV Edit** 可以把远程 WebDAV 目录作为原生 VS Code 工作区打开，无需将整个目录同步到本地，即可浏览、新建、编辑、重命名、复制和删除远程文件。

它适合轻量编辑 Nextcloud、ownCloud、AList、Apache WebDAV、NAS 等兼容服务中的配置文件、脚本、Markdown 笔记和静态资源。

> [!IMPORTANT]
> 本扩展仅支持桌面版 VS Code。浏览器版 VS Code 受 CORS 限制，而大多数 WebDAV 服务端默认不会开放所需的跨域响应头。

## 功能特性

- 通过 `webdav://` 虚拟工作区直接打开远程目录。
- 在活动栏的独立视图中管理多个 WebDAV 连接。
- 支持读取、写入、新建、删除、重命名和复制文件与目录。
- 使用 ETag 和 `If-Match` 检测保存冲突，避免覆盖他人修改。
- 支持 Basic、Digest、Bearer Token 和无认证模式。
- 密码和 Token 存入 VS Code `SecretStorage`，不会写进设置或工作区 URI。
- 支持 HTTP 代理及经过安全限制的自定义请求头。
- 可配置文件大小、并发数、重试、元数据缓存和目录轮询。
- 支持带深度和目录数量上限的递归文件名搜索。
- 提供自动脱敏的诊断日志，便于排查连接问题。

## 安装

### Visual Studio Marketplace

首次公开发布后，可以在 VS Code 扩展视图中搜索安装，或执行：

```bash
code --install-extension duskEdge.webdav-edit
```

### GitHub Release

从 [GitHub 最新版本](https://github.com/duskedge/webdav-edit/releases/latest) 下载 `.vsix` 文件，然后执行：

```bash
code --install-extension webdav-edit-<version>.vsix
```

也可以打开 VS Code 扩展视图，选择右上角的 **更多操作…**，然后点击 **从 VSIX 安装…**。

## 快速开始

1. 打开命令面板，运行 **WebDAV: 新增连接**，或点击活动栏中的 WebDAV 图标。
2. 粘贴完整的 WebDAV URL，例如 `https://cloud.example.com/remote.php/dav/files/alice/`。
3. 点击 **解析地址**，自动拆解 URL 并应用匹配的服务端预设。
4. 测试连接，确认成功后保存。
5. 运行 **WebDAV: 连接并打开远程目录**，逐级选择目录并作为工作区打开。

密码和 Bearer Token 通过 VS Code `SecretStorage` 保存，不会写入 `settings.json`、工作区 URI、最近打开记录或日志。

## 虚拟工作区限制

通过 `webdav://` 打开的目录属于 VS Code 虚拟工作区。部分功能依赖本地文件系统，因此不可用或会受到限制：

| 能力 | 状态 |
| :--- | :--- |
| 集成终端、调试和任务 | 不可用 |
| Git 源代码管理 | 不可用 |
| 依赖本地路径的语言服务 | 通常不可用或能力降级 |
| 工作区全文搜索 | 不可用；请使用 **WebDAV: 按文件名查找** |
| 即时检测外部修改 | 不可用；请手动刷新或启用轮询 |

本扩展适合远程文件浏览和轻量编辑。需要完整远程开发环境时，请使用 Remote SSH 或 Dev Containers。

## 服务端兼容性

| 服务端 | 状态 | 说明 |
| :--- | :--- | :--- |
| Nextcloud | 已测试 | 建议使用应用专用密码。 |
| ownCloud | 已测试 | 支持基础 WebDAV 文件操作。 |
| Apache `mod_dav` | 已测试 | 已覆盖 Basic、Digest 和自签名 TLS 配置。 |
| AList | 已测试 | 不支持 `COPY` 时自动降级为下载后上传。 |
| Nginx 原生 DAV 模块 | 不支持 | 原生模块没有实现 `PROPFIND`，需使用 `nginx-dav-ext-module`。 |
| 群晖 DSM | 尚未验证 | 欢迎社区反馈兼容情况。 |

## 配置项

通常应通过扩展界面管理连接。连接元数据保存在设置中，密码等凭据始终保存在 `SecretStorage` 中。

| 配置项 | 默认值 | 用途 |
| :--- | :--- | :--- |
| `webdavEdit.cacheTtlSeconds` | `30` | 元数据缓存时长（秒）；设为 `0` 可禁用。 |
| `webdavEdit.maxFileSizeMB` | `50` | 允许在内存中读取或写入的最大文件大小。 |
| `webdavEdit.maxConcurrentRequests` | `6` | 单个连接的最大并发请求数。 |
| `webdavEdit.connectTimeoutMs` | `10000` | 建立连接超时时间（毫秒）。 |
| `webdavEdit.requestTimeoutMs` | `60000` | 请求超时时间（毫秒）。 |
| `webdavEdit.maxRetries` | `2` | 幂等请求重试次数；写操作永不自动重试。 |
| `webdavEdit.proxy` | 空 | HTTP 代理地址；留空时继承 VS Code 和环境变量设置。 |
| `webdavEdit.noProxy` | 空 | 不经过代理的主机列表，以逗号分隔。 |
| `webdavEdit.search.maxDepth` | `6` | 按文件名搜索的最大递归深度。 |
| `webdavEdit.search.maxDirectories` | `200` | 按文件名搜索最多扫描的目录数。 |
| `webdavEdit.pollIntervalSeconds` | `0` | 目录轮询间隔；`0` 表示关闭。 |
| `webdavEdit.logLevel` | `info` | 诊断日志级别：`off`、`error`、`info` 或 `debug`。 |

## 问题排查

运行 **WebDAV: 显示诊断日志**。需要更多细节时，将 `webdavEdit.logLevel` 设为 `debug`。凭据和认证请求头会在诊断输出中自动脱敏。

常见检查项：

- 确认 URL 指向 WebDAV 服务端点，而不是普通网页入口。
- 建议始终使用 HTTPS，尤其是 Basic 认证模式。
- Nextcloud 建议使用应用专用密码，不要直接使用账号密码。
- 使用自签名证书时，仅对可信连接开启忽略证书校验。
- 在 VS Code 外修改文件后，如果目录没有更新，请手动刷新或启用轮询。

## 本地开发

环境要求：Node.js 20+ 和 npm。

```bash
git clone git@github.com:duskedge/webdav-edit.git
cd webdav-edit
npm ci
npm run check
npm test
npm run package
```

`npm run package` 会生成 `webdav-edit-<version>.vsix`。本地安装可以运行：

```bash
npm run install-local
```

## 自动发布

推送符合 SemVer 格式的版本标签后，GitHub Actions 会依次执行校验、测试、打包、发布到 Visual Studio Marketplace，并将生成的 VSIX 添加到 GitHub Release。

首次发布前，需要在 Visual Studio Marketplace 创建 `duskEdge` Publisher，并在 GitHub 仓库中添加名为 `VSCE_PAT` 的 Secret。对应 PAT 必须具有 **Marketplace: Manage** 权限。

`package.json` 中的版本必须和 Git 标签一致：

```bash
npm version patch -m "发布 %s"
git push origin main --follow-tags
```

例如 `package.json` 版本为 `0.1.0` 时，标签必须是 `v0.1.0`。

## 安全建议

- 不要提交 WebDAV 密码、Bearer Token、Cookie、代理凭据或 `.env` 文件。
- 优先使用 HTTPS，并使用权限尽可能小的应用密码或 Token。
- 忽略证书校验只能作为单连接例外，不应作为默认配置。
- 发布前检查 VSIX 中实际包含的文件列表。

## 许可证

[MIT](LICENSE)
