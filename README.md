# WebDAV Workspace

把远程 WebDAV 目录作为原生 VSCode 工作区打开，直接浏览与编辑远程文件。

> **仅支持桌面版 VSCode**。Web 宿主中的请求受浏览器 CORS 约束，而绝大多数
> WebDAV 服务端默认不下发 CORS 响应头，用户无法自行修复。

## 请先了解：这是「虚拟工作区」

以 `webdav://` 打开的工作区是 VSCode 的**虚拟工作区**。平台层面会禁用以下能力，
**扩展无法绕过**：

| 能力 | 状态 |
| :--- | :--- |
| 集成终端 / 调试 / 任务 | 不可用 |
| Git 源代码管理 | 不可用 |
| 依赖本地路径的语言服务（TS/Python/Java…） | 多数不可用或降级 |
| 全文搜索（`Ctrl+Shift+F`） | 不可用，改用「按文件名查找」 |
| 外部变更自动刷新 | WebDAV 无推送能力，需手动刷新 |

**适合**：配置文件、脚本、Markdown 笔记、静态资源的浏览与轻量编辑。
**不适合**：完整的远程开发（那是 Remote-SSH / Dev Containers 的场景）。

## 快速开始

1. 命令面板 → **WebDAV: 新增连接**，或点击活动栏的 WebDAV 图标。
2. 粘贴完整 WebDAV URL（如 `https://cloud.example.com/remote.php/dav/files/alice/`），
   点「解析地址」自动拆解，并按服务端类型套用预设模板。
3. 「测试连接」确认可用后保存。
4. **WebDAV: 连接并打开远程目录** → 逐级浏览 → 选中目录打开。

密码经 VSCode `SecretStorage` 加密存储，**不会写入设置文件**，也不会出现在
工作区 URI、最近打开记录或日志中。

## 支持的服务端

已实测（见 `doc/compat-matrix.generated.md`）：

| 服务端 | 状态 | 备注 |
| :--- | :--- | :--- |
| Nextcloud | ✅ | 建议使用应用专用密码 |
| ownCloud | ✅ | |
| Apache `mod_dav` | ✅ | Basic / Digest / 自签名 TLS 均通过 |
| AList | ✅ | `COPY` 不受支持时自动降级为下载+上传 |
| Nginx 原生 DAV | ❌ | 原生模块不支持 `PROPFIND`，需 `nginx-dav-ext-module` |
| 群晖 DSM | 未验证 | 社区反馈驱动 |

## 主要功能

- 侧边栏连接树 + 层级目录选择器
- 完整文件操作：读、写、新建、删除、重命名、复制
- 保存冲突检测（ETag / `If-Match`），冲突时可选择覆盖 / 重载 / 另存
- Basic / Digest / Bearer 认证，支持 HTTP 代理与自定义请求头
- 元数据缓存（默认 30s TTL），避免展开目录时的请求风暴
- 脱敏诊断日志：**WebDAV: 显示诊断日志**

## 常用设置

| 配置项 | 默认 | 说明 |
| :--- | :--- | :--- |
| `webdavEdit.cacheTtlSeconds` | 30 | 元数据缓存时长，0 为禁用 |
| `webdavEdit.maxFileSizeMB` | 50 | 单文件大小上限（API 不支持流式读写） |
| `webdavEdit.maxConcurrentRequests` | 6 | 单连接并发上限 |
| `webdavEdit.pollIntervalSeconds` | 0 | 目录轮询，0 为关闭 |
| `webdavEdit.logLevel` | info | 设为 `debug` 可记录每次 HTTP 往返 |

## 排查问题

出问题时先看 **WebDAV: 显示诊断日志**（设为 `debug` 级别）。日志中的凭据一律
脱敏，可以安全贴出来。

## 许可

MIT
