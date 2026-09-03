# VSCode WebDAV 工作区扩展 - 需求规格说明书 (PRD)

## 1. 项目背景与目标

### 1.1 背景
在日常开发和运维过程中，开发者和用户经常需要直接编辑部署在远程服务器、NAS（如群晖、威联通）、网盘（如 Nextcloud、ownCloud、AList）上的文件。目前常见的解决方案包括操作系统级挂载（如 RaiDrive、WebDAV Drive）或通过 FTP/SFTP 插件手动同步，这些方式往往存在挂载不稳定、冲突严重或使用体验割裂的问题。

### 1.2 目标
开发一款 VSCode 扩展，允许用户配置 WebDAV 连接信息，并在远程目录中选择指定路径，直接将其作为原生 VSCode 工作区（Workspace Folder）打开。
借助 VSCode 原生 `FileSystemProvider` 机制，实现无感、轻量的远程文件浏览、编辑、保存、创建及删除体验。

---

## 2. 目标用户与使用场景

| 用户角色 | 典型使用场景 | 核心诉求 |
| :--- | :--- | :--- |
| **全栈/运维工程师** | 直接修改部署在远端 WebDAV 服务器上的脚本、配置或静态资源 | 免去 SSH/FTP 手动上传，像操作本地文件一样快捷保存 |
| **NAS / 私有云用户** | 维护 Nextcloud、AList、群晖等服务上的 Markdown 笔记、代码工程 | 集中式管理多台 WebDAV 连接，能快速切换不同目录工作区 |
| **轻量编辑者** | 不希望在本地安装庞大的挂载客户端（如 FUSE、第三方虚拟盘工具） | 纯前端/插件化解决，配置即用，跨平台一致（macOS/Windows/Linux） |

---

## 3. 功能需求 (Functional Requirements)

### 3.1 WebDAV 连接与凭据管理
- **FR-1.1 新增连接配置**：
  - 支持配置字段：连接名称/别名（Alias）、服务器地址（Host/URL）、端口（Port）、路径前缀（Path）、用户名（Username）、密码/Token、是否启用 HTTPS、是否允许自签名证书（Ignore SSL）。
- **FR-1.2 安全存储**：
  - 用户名、URL 等常规配置存放在扩展全局配置中。
  - 密码/Token **必须**使用 VSCode 原生 `SecretStorage` API 进行加密安全存储，严禁明文落盘。
- **FR-1.3 连接测试与校验**：
  - 保存前支持点击“测试连接”，验证网络连通性与鉴权有效性，给出明确的状态反馈（成功 / 401 认证失败 / 超时等）。
- **FR-1.4 连接列表管理**：
  - 支持对已保存的连接进行编辑、重命名、删除操作。

### 3.2 目录浏览与选择交互
- **FR-2.1 目录选择向导 (QuickPick)**：
  - 触发“打开 WebDAV 目录”命令后，先选择可用连接，随后逐级展现远程目录树（支持展开、返回上一级、选择当前目录）。
- **FR-2.2 侧边栏连接视图 (TreeView)**：
  - 在 VSCode 活动栏提供独立的 WebDAV 管理视图面板。
  - 列出所有已配置的服务器节点，展开可实时查看远程目录树。
  - 树节点支持上下文菜单：“在当前窗口作为工作区打开”、“在新窗口中打开”。
- **FR-2.3 快捷历史记录**：
  - 记录最近打开过的 WebDAV 目录路径，便于快速再次打开。

### 3.3 虚拟文件系统（Core: FileSystemProvider）
基于 `vscode.FileSystemProvider` 接口，注册自定义协议 `webdav://`。

- **FR-3.1 状态与元数据查询 (`stat`)**：
  - 获取指定路径的文件大小、创建时间、修改时间以及文件类型（File / Directory / SymbolicLink）。
- **FR-3.2 目录读取 (`readDirectory`)**：
  - 遍历目标目录下的直接子文件与子文件夹列表。
- **FR-3.3 文件读取 (`readFile`)**：
  - 下载远程文件二进制流，并在 VSCode 编辑器中展现。
- **FR-3.4 文件写入与保存 (`writeFile`)**：
  - 用户按下 `Ctrl+S` / `Cmd+S` 时，自动向 WebDAV 发起 `PUT` 请求更新远端内容。
- **FR-3.5 目录创建 (`createDirectory`)**：
  - 映射为 WebDAV 的 `MKCOL` 动作。
- **FR-3.6 资源删除 (`delete`)**：
  - 映射为 WebDAV 的 `DELETE` 动作，支持递归删除目录。
- **FR-3.7 移动与重命名 (`rename`)**：
  - 映射为 WebDAV 的 `MOVE` 动作。
- **FR-3.8 变更通知事件 (`onDidChangeFile`)**：
  - 触发文件变更事件，通知 VSCode 刷新对应文件树及编辑器视图。

### 3.4 用户体验与状态反馈
- **FR-4.1 传输进度提示**：
  - 大文件加载/保存时展示状态栏或右下角进度条通知。
- **FR-4.2 错误统一捕获与映射**：
  - 401 Unauthorized：提示认证失效，引导重新输入密码。
  - 403 Forbidden：映射为 `vscode.FileSystemError.NoPermissions()`。
  - 404 Not Found：映射为 `vscode.FileSystemError.FileNotFound()`。
  - 网络断开/超时：友好弹窗提示重试，避免编辑器静默卡死。
- **FR-4.3 状态栏指示器**：
  - 当当前工作区为 WebDAV 目录时，在 VSCode 状态栏显示连接状态及服务别名。

---

## 4. 非功能性需求 (Non-Functional Requirements)

### 4.1 性能与响应速度
- **元数据缓存 (Metadata Cache)**：
  - VSCode 文件树展开和搜索会高频触发 `stat` 和 `readDirectory`。系统必须实现基于 TTL（如 30-60 秒）的短时内存缓存，避免引发 HTTP PROPFIND 请求风暴。
- **防抖与节流**：
  - 对频繁保存操作做节流限制，避免并发写入导致远端文件覆盖冲突。

### 4.2 安全性要求
- **URI 凭证隔离**：
  - 严禁将账号密码拼入 URI（如 `webdav://user:pwd@host/path`），因为工作区 URI 会被 VSCode 写入最近打开记录（`storage.json`）并可能暴露。
  - 必须采用权威标识方案：`webdav://<connectionId>/<remotePath>`，底层通过 `connectionId` 索引凭据。
- **传输加密**：
  - 默认推荐并优先使用 HTTPS，对 HTTP 协议给予安全风险提示。

### 4.3 兼容性要求
- **服务端兼容**：
  - 兼容主流 WebDAV 服务端实现，包括但不限于 Nextcloud、ownCloud、Nginx HttpDavModule、Apache mod_dav、AList、群晖 DSM WebDAV Server。
- **客户端平台**：
  - 兼容 Windows、macOS、Linux 主流版本的 VSCode（VSCode 引擎版本 `>= 1.75.0`）。

---

## 5. 架构与流程设计

### 5.1 URI Scheme 设计
工作区根目录 URI 规范：
```text
webdav://[connectionId]/[remotePath]
```
- **Scheme**: `webdav`
- **Authority**: `connectionId`（对应配置项的唯一 UUID，避免暴露 IP/端口/鉴权）
- **Path**: WebDAV 服务器上的绝对路径，例如 `/documents/my-project`

### 5.2 核心业务流程图

```mermaid
sequenceDiagram
    autonumber
    actor User as 用户
    participant Ext as 扩展管理器
    participant Store as 配置与凭据存储(SecretStorage)
    participant FSP as WebdavFileSystemProvider
    participant Client as WebDAV Client
    participant Server as 远程 WebDAV 服务端

    User->>Ext: 执行命令: "连接并打开 WebDAV 目录"
    Ext->>Store: 读取已保存连接配置
    alt 用户选择已有连接 / 录入新配置
        Ext->>Client: 测试连接与鉴权
        Client->>Server: PROPFIND / (验证)
        Server-->>Client: 207 Multi-Status
        Client-->>Ext: 验证成功
    end

    Ext->>Client: 读取远程根目录/初始子目录
    Client->>Server: PROPFIND /subpath
    Server-->>Client: 返回目录项
    Ext-->>User: 弹出 QuickPick / 树形选择器供用户选择目录
    User->>Ext: 选中目标目录 (如 /projects/demo)

    Ext->>Ext: 拼接 URI: webdav://<connId>/projects/demo
    Ext->>Ext: vscode.commands.executeCommand('vscode.openFolder', uri)
    Note over Ext,FSP: VSCode 重载并以该 URI 作为 Workspace Folder

    VSCode->>FSP: stat(uri) / readDirectory(uri)
    FSP->>Client: 请求远程目录内容 (走缓存/请求)
    Client->>Server: PROPFIND /projects/demo
    Server-->>Client: 返回子文件列表
    FSP-->>VSCode: 返回 [name, FileType][]
    VSCode-->>User: 资源管理器展现完整项目树，可正常编辑与保存
```

---

## 6. 版本里程碑规划

### Phase 1: MVP 最小可行版本 (v0.1.0)
- [ ] 基础配置命令：输入 URL、用户名、密码。
- [ ] 凭证使用 `SecretStorage` 存储。
- [ ] 基础 `FileSystemProvider` 实现（`stat`, `readDirectory`, `readFile`, `writeFile`）。
- [ ] 支持通过命令输入远程目录路径并以工作区形式打开。

### Phase 2: 交互与体验完善 (v0.2.0)
- [ ] 目录选择交互：实现层级式 QuickPick 导航选择器。
- [ ] 侧边栏 TreeView 面板：直观展示已保存的 WebDAV 服务器列表。
- [ ] 补全 `FileSystemProvider` 完整接口（`createDirectory`, `delete`, `rename`）。
- [ ] 元数据内存缓存机制（减少重复 PROPFIND 请求）。

### Phase 3: 健壮性与高级功能 (v0.3.0)
- [ ] 大文件读写分块与进度通知条。
- [ ] 断网重连、401 鉴权过期自动重新登录机制。
- [ ] 多服务器管理界面（Webview 配置面板）。
- [ ] 文件保存冲突检测（基于 ETag / Last-Modified 简单校验）。
