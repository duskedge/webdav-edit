# VSCode WebDAV 工作区扩展 - 需求规格说明书 (PRD)

> 版本：v1.2 ｜ 最后更新：2026-09-03
> 变更摘要：补充能力边界与非目标章节、NFR 编号与量化指标、WebDAV 动作映射与路径编码规则、激活时序约束、兼容性矩阵、风险与待决策项。
> v1.2 决议：明确**仅支持 VSCode Desktop**（8.2 关闭）；HTTP 传输层确定为**自研薄协议层**（8.3 关闭，设计见 5.8）。
> 配套文档：[开发计划](./development-plan.md)

## 1. 项目背景与目标

### 1.1 背景
在日常开发和运维过程中，开发者和用户经常需要直接编辑部署在远程服务器、NAS（如群晖、威联通）、网盘（如 Nextcloud、ownCloud、AList）上的文件。目前常见的解决方案包括操作系统级挂载（如 RaiDrive、WebDAV Drive）或通过 FTP/SFTP 插件手动同步，这些方式往往存在挂载不稳定、冲突严重或使用体验割裂的问题。

### 1.2 目标
开发一款 VSCode 扩展，允许用户配置 WebDAV 连接信息，并在远程目录中选择指定路径，直接将其作为原生 VSCode 工作区（Workspace Folder）打开。
借助 VSCode 原生 `FileSystemProvider` 机制，实现轻量的远程文件浏览、编辑、保存、创建及删除体验。

> **定位澄清**：本扩展的目标场景是**远程文件的浏览与轻量编辑**（配置文件、脚本、Markdown 笔记、静态资源），**不是**完整的远程开发环境（该场景应使用 Remote-SSH / Dev Containers）。原因见 [2.4 能力边界](#24-能力边界虚拟工作区限制)。

---

## 2. 目标用户与使用场景

### 2.1 用户角色

| 用户角色 | 典型使用场景 | 核心诉求 |
| :--- | :--- | :--- |
| **全栈/运维工程师** | 直接修改部署在远端 WebDAV 服务器上的脚本、配置或静态资源 | 免去 SSH/FTP 手动上传，像操作本地文件一样快捷保存 |
| **NAS / 私有云用户** | 维护 Nextcloud、AList、群晖等服务上的 Markdown 笔记、文本资料 | 集中式管理多台 WebDAV 连接，能快速切换不同目录工作区 |
| **轻量编辑者** | 不希望在本地安装庞大的挂载客户端（如 FUSE、第三方虚拟盘工具） | 纯插件化解决，配置即用，跨平台一致（macOS/Windows/Linux） |

### 2.2 核心用户旅程
1. 安装扩展 → 侧边栏新增 WebDAV 面板。
2. 新建连接 → 填写地址与凭据 → 点击"测试连接"得到明确反馈。
3. 展开服务器节点浏览远程目录 → 右键"作为工作区打开"。
4. VSCode 重载，资源管理器展现远程目录树 → 编辑文件 → `Cmd+S` 直接写回远端。
5. 状态栏常驻显示当前连接别名与在线状态。

### 2.3 关键设计原则
- **凭据零暴露**：任何情况下密码不得出现在 URI、日志、遥测或工作区记录中。
- **失败可见**：网络类操作不得静默失败，必须给出可操作的错误提示。
- **能力诚实**：对平台不支持的能力（见 2.4）主动提示，而非让用户在使用中意外发现。

### 2.4 能力边界（虚拟工作区限制）

> **本节为最高优先级约束，直接决定产品定位与用户预期管理。**

以 `webdav://` 打开的工作区属于 VSCode 的**虚拟工作区（Virtual Workspace）**。在该模式下，VSCode 平台层面会禁用或降级以下能力，**扩展本身无法绕过**：

| 能力 | 虚拟工作区下的状态 | 产品应对 |
| :--- | :--- | :--- |
| 集成终端 | 不可用（无本地工作目录） | 首次打开时提示说明 |
| 调试 / Tasks | 不可用 | 同上 |
| Git 源代码管理 | 不可用 | 同上 |
| 依赖本地路径的语言服务（TS/Python/Java 等 LSP） | 大多不可用或功能降级 | 文档中明示；语法高亮、括号匹配等纯文本能力正常 |
| 全文搜索（`Ctrl+Shift+F`） | ripgrep 不可用，需扩展自行实现 | 见 FR-5.1 |
| 文件监听（外部变更自动刷新） | WebDAV 协议无推送能力 | 见 FR-3.9、FR-2.4 |

**必须在 `package.json` 中显式声明能力**，否则 VSCode 行为不可预期：
```jsonc
{
  "capabilities": {
    "virtualWorkspaces": true,
    "untrustedWorkspaces": { "supported": "limited", "description": "远程文件内容不受信任，不执行工作区脚本" }
  }
}
```

### 2.5 超出范围（Out of Scope）
以下能力在 v1.0 前**明确不做**，避免范围蔓延：
- 本地离线镜像、双向同步、冲突三方合并。
- Git 集成（含虚拟 SCM Provider）。
- 断点续传、大文件分片上传（受限于 FSP API，见 5.5）。
- WebDAV 锁（`LOCK`/`UNLOCK`）与多用户协同编辑。
- CalDAV / CardDAV 等 WebDAV 扩展协议。
- 远程终端、远程调试、远程语言服务（属于 Remote-SSH 场景）。
- Web 版 VSCode（vscode.dev / github.dev）支持，理由见 NFR-3.3 与 8.2。

---

## 3. 功能需求 (Functional Requirements)

### 3.1 WebDAV 连接与凭据管理
- **FR-1.1 新增连接配置**：
  - 支持配置字段：连接名称/别名（Alias）、服务器地址（Host/URL）、端口（Port）、路径前缀（Path）、用户名（Username）、密码/Token、是否启用 HTTPS、是否允许自签名证书（Ignore SSL）、是否只读（Read-only）。
  - 支持从完整 URL 一键解析填充（粘贴 `https://host:port/remote.php/dav/files/user/` 自动拆解各字段）。
- **FR-1.2 安全存储**：
  - 用户名、URL 等常规配置存放在扩展全局配置中。
  - 密码/Token **必须**使用 VSCode 原生 `SecretStorage` API 进行加密安全存储，严禁明文落盘。
  - **SecretStorage 不参与 Settings Sync**：配置同步到新设备后凭据为空，扩展必须识别该状态并引导用户重新输入，而非报网络错误。
- **FR-1.3 连接测试与校验**：
  - 保存前支持点击"测试连接"，验证网络连通性与鉴权有效性，给出明确的状态反馈（成功 / 401 认证失败 / 403 无权限 / 404 路径不存在 / 证书错误 / 超时）。
  - 测试成功时回显服务端识别信息（如 `DAV` 响应头声明的合规等级、`Server` 头），便于用户确认连对了服务。
- **FR-1.4 连接列表管理**：
  - 支持对已保存的连接进行编辑、重命名、删除、复制（Duplicate）操作。
  - 删除连接时同步清理 `SecretStorage` 中的对应凭据。
- **FR-1.5 认证方式支持**：
  - **P0**：HTTP Basic（用户名 + 密码 / 应用专用密码）。
  - **P1**：HTTP Digest（Apache `mod_dav` 常见默认配置）、Bearer Token（`Authorization: Bearer <token>`）。
  - **P2**：自定义请求头（键值对列表，覆盖网关鉴权等长尾场景）。
- **FR-1.6 网络代理**：
  - 默认继承 VSCode 的 `http.proxy` / `http.proxyStrictSSL` 设置（企业网络必需）。
  - 支持按连接覆盖代理地址。
- **FR-1.7 只读连接**：
  - 连接标记为只读时，以 `registerFileSystemProvider(scheme, provider, { isReadonly: true })` 注册，由 VSCode 在 UI 层禁用编辑与删除，而非依赖运行期报错。

### 3.2 目录浏览与选择交互
- **FR-2.1 目录选择向导 (QuickPick)**：
  - 触发"打开 WebDAV 目录"命令后，先选择可用连接，随后逐级展现远程目录树（支持展开、返回上一级、选择当前目录、手动输入路径跳转）。
- **FR-2.2 侧边栏连接视图 (TreeView)**：
  - 在 VSCode 活动栏提供独立的 WebDAV 管理视图面板。
  - 列出所有已配置的服务器节点，展开可实时查看远程目录树。
  - 树节点支持上下文菜单："在当前窗口作为工作区打开"、"在新窗口中打开"、"添加到当前工作区"（多根工作区）、"复制远程路径"。
- **FR-2.3 快捷历史记录**：
  - 记录最近打开过的 WebDAV 目录路径（`connectionId` + 路径，**不含任何凭据**），便于快速再次打开。
- **FR-2.4 手动刷新**：
  - 提供"刷新"命令与 TreeView 标题栏按钮，清除指定路径（及其子树）的元数据缓存并重新拉取。
  - **理由**：NFR-1.1 的 TTL 缓存会导致外部修改在缓存期内不可见，必须提供确定性的失效入口。

### 3.3 虚拟文件系统（Core: FileSystemProvider）
基于 `vscode.FileSystemProvider` 接口，注册自定义协议 `webdav://`。各方法与 WebDAV 动作的完整映射见 [5.3](#53-webdav-动作映射与协议约束)。

- **FR-3.1 状态与元数据查询 (`stat`)**：
  - 获取指定路径的文件大小、创建时间、修改时间以及文件类型（File / Directory / SymbolicLink）。
  - 服务端未返回 `getcontentlength`（目录常见）或 `creationdate` 时，须给出合理缺省值而非抛错。
- **FR-3.2 目录读取 (`readDirectory`)**：
  - 遍历目标目录下的直接子文件与子文件夹列表（`PROPFIND` + `Depth: 1`）。
  - 必须过滤掉响应中代表**目录自身**的那一条 `<response>` 条目。
- **FR-3.3 文件读取 (`readFile`)**：
  - 下载远程文件二进制流，并在 VSCode 编辑器中展现。
  - 超过阈值（默认 50MB，可配置）时拒绝打开并提示原因，避免撑爆扩展宿主内存（见 5.5）。
- **FR-3.4 文件写入与保存 (`writeFile`)**：
  - 用户按下 `Ctrl+S` / `Cmd+S` 时，自动向 WebDAV 发起 `PUT` 请求更新远端内容。
  - 必须按 `options: { create, overwrite }` 组合正确处理边界：目标不存在且 `create=false` → `FileNotFound`；目标已存在且 `overwrite=false` → `FileExists`。否则"新建文件/另存为"行为异常。
- **FR-3.5 目录创建 (`createDirectory`)**：
  - 映射为 WebDAV 的 `MKCOL` 动作。父目录不存在时服务端返回 `409`，须映射为 `FileNotFound`。
- **FR-3.6 资源删除 (`delete`)**：
  - 映射为 WebDAV 的 `DELETE` 动作，删除目录时携带 `Depth: infinity` 实现递归删除。
- **FR-3.7 移动与重命名 (`rename`)**：
  - 映射为 WebDAV 的 `MOVE` 动作，携带 `Destination`（绝对 URL，需正确百分号编码）与 `Overwrite: T/F` 头。
- **FR-3.8 复制 (`copy`)**：
  - 实现 `FileSystemProvider` 的可选 `copy()` 方法，映射为 WebDAV `COPY` 动作。
  - **理由**：不实现时 VSCode 会回退为"下载 + 上传"，大目录复制会产生大量冗余流量。服务端不支持 `COPY` 时再回退到默认行为。
- **FR-3.9 变更通知事件 (`onDidChangeFile` / `watch`)**：
  - WebDAV 协议**无变更推送能力**，因此 `watch()` 实现为 no-op（返回空 `Disposable`）。
  - 扩展**仅在自身发起写操作后**（write/create/delete/rename/copy）主动 fire 对应事件，并同步失效相关缓存，保证 VSCode 视图即时刷新。
  - 外部变更依赖 FR-2.4 的手动刷新。轮询探测（可选、默认关闭）列为 P2。

### 3.4 用户体验与状态反馈
- **FR-4.1 传输进度提示**：
  - 单次传输预计超过 1 秒或文件大于 1MB 时，展示进度通知（`withProgress`），并支持取消。
- **FR-4.2 错误统一捕获与映射**：

  | HTTP 状态 | 映射 | 用户提示 |
  | :--- | :--- | :--- |
  | 401 Unauthorized | `NoPermissions` | 认证失效，引导重新输入密码 |
  | 403 Forbidden | `FileSystemError.NoPermissions()` | 无操作权限 |
  | 404 Not Found | `FileSystemError.FileNotFound()` | 资源不存在 |
  | 405 / 501 | `Unavailable` | 服务端不支持该动作（如 `COPY`），提示降级方案 |
  | 409 Conflict | `FileNotFound`（父目录缺失） | 目标父目录不存在 |
  | 412 Precondition Failed | 冲突提示 | ETag 校验失败，远端已被他人修改（见 FR-4.4） |
  | 423 Locked | `NoPermissions` | 资源被锁定 |
  | 507 Insufficient Storage | `Unavailable` | 远端空间不足 |
  | 网络断开 / 超时 / DNS 失败 | `Unavailable` | 友好弹窗提示重试，避免编辑器静默卡死 |
  | 证书校验失败 | `Unavailable` | 明确提示证书问题，引导开启"允许自签名证书" |

- **FR-4.3 状态栏指示器**：
  - 当当前工作区为 WebDAV 目录时，在 VSCode 状态栏显示连接状态及服务别名；点击可打开连接管理面板。
- **FR-4.4 保存冲突检测**：
  - `readFile` 时记录 `ETag` / `Last-Modified`；`writeFile` 时带 `If-Match` 条件请求。
  - 返回 `412` 时弹出选择：覆盖远端 / 放弃本地修改并重载 / 另存为新文件。
- **FR-4.5 首次打开能力提示**：
  - 首次以 `webdav://` 打开工作区时，展示一次性提示，说明 2.4 中的能力限制（可勾选"不再提示"）。

### 3.5 搜索
- **FR-5.1 搜索能力决策（P1）**：
  - VSCode 正式 API 中 `FileSearchProvider` / `TextSearchProvider` 仍为 proposed API，**使用后无法发布到 Marketplace**，因此不能作为 v1.0 方案。
  - v1.0 方案：拦截搜索入口，明确提示"虚拟工作区暂不支持全文搜索"，并提供替代入口（"按文件名查找"基于递归 `PROPFIND` 实现，限制最大深度与条目数）。
  - v2.0 方案：待 proposed API 稳定后接入，或提供"下载到本地临时目录后搜索"的显式操作。

### 3.6 诊断与日志
- **FR-6.1 输出通道**：
  - 提供 `WebDAV` 专属 `OutputChannel`，可配置日志级别（off / error / info / debug）。
  - debug 级别记录每次 HTTP 请求的方法、URL、状态码、耗时、关键响应头。
  - **脱敏强制要求**：`Authorization` 头、密码、Token 一律以 `***` 替代；请求体不落日志。
  - **理由**：本类扩展的问题绝大多数源于服务端实现差异，无请求日志则无法远程定位，属必备能力而非可选项。
- **FR-6.2 无遥测**：不采集任何用户数据；如未来引入需遵循 VSCode 遥测开关。

---

## 4. 非功能性需求 (Non-Functional Requirements)

### 4.1 性能与响应速度
- **NFR-1.1 元数据缓存 (Metadata Cache)**：
  - VSCode 文件树展开和搜索会高频触发 `stat` 和 `readDirectory`。系统必须实现基于 TTL（默认 30 秒，可配置 0–300 秒）的短时内存缓存，避免引发 HTTP PROPFIND 请求风暴。
  - `readDirectory` 的结果须同时回填其子项的 `stat` 缓存（一次 `Depth:1` 请求即可满足后续 N 次 `stat`）。
  - 任何写操作（write/create/delete/rename/copy）必须**同步失效**目标路径及其父目录缓存。
- **NFR-1.2 请求合并**：对同一路径的并发 `stat`/`readDirectory` 请求需去重合并（in-flight promise 复用）。
- **NFR-1.3 并发与节流**：
  - 单连接并发 HTTP 请求数上限可配置（默认 6），避免打爆 NAS 类低性能服务端。
  - 对频繁保存操作做节流限制，避免并发写入导致远端文件覆盖冲突；同一文件的写请求必须串行化。
- **NFR-1.4 量化指标**（在 100Mbps 局域网、服务端为 Nextcloud 的基准环境下）：

  | 场景 | 指标 |
  | :--- | :--- |
  | 含 1000 个条目的目录首次展开 | P95 < 2s |
  | 缓存命中的 `stat` | P95 < 100ms（不产生网络请求） |
  | 打开 1MB 文本文件 | P95 < 1.5s |
  | 保存 5MB 文件 | P95 < 3s |
  | 扩展激活到 provider 注册完成 | < 50ms（不含任何网络与 SecretStorage 等待） |

- **NFR-1.5 超时**：所有请求设置可配置超时（默认连接 10s / 读写 60s），超时须抛出可识别错误而非无限挂起。

### 4.2 安全性要求
- **NFR-2.1 URI 凭证隔离**：
  - 严禁将账号密码拼入 URI（如 `webdav://user:pwd@host/path`），因为工作区 URI 会被 VSCode 写入最近打开记录（`storage.json`）并可能暴露。
  - 必须采用间接标识方案：`webdav://<connectionId>/<remotePath>`，底层通过 `connectionId` 索引凭据。
- **NFR-2.2 传输加密**：默认推荐并优先使用 HTTPS；配置 HTTP 明文连接时必须给出显式安全风险提示并要求二次确认。
- **NFR-2.3 自签名证书**：`Ignore SSL` 只能按**单个连接**粒度生效，严禁全局修改 `NODE_TLS_REJECT_UNAUTHORIZED`；开启时在连接列表与状态栏标注风险图标。
- **NFR-2.4 日志脱敏**：见 FR-6.1，凭据不得出现在任何日志、错误消息或异常堆栈中。
- **NFR-2.5 不信任远端内容**：远端文件内容与文件名视为不可信输入；文件名须防御路径穿越（`..`、绝对路径、控制字符），不得据此拼接出目标目录之外的请求路径。

### 4.3 兼容性要求
- **NFR-3.1 服务端兼容**：兼容主流 WebDAV 服务端实现，逐项差异与验证结果记录于 [5.6 兼容性矩阵](#56-兼容性矩阵)，该矩阵为发布验收物之一。
- **NFR-3.2 客户端平台**：兼容 Windows、macOS、Linux 主流版本的 VSCode（VSCode 引擎版本 `>= 1.75.0`）。
- **NFR-3.3 运行环境**：**仅支持 VSCode Desktop 的 Node.js 扩展宿主**。
  - `package.json` 只声明 `"main"` 入口，**不得**声明 `"browser"` 入口，使扩展在 vscode.dev / github.dev 中自动标记为不可用，避免用户安装后遇到无法解释的失败。
  - 决策理由见 [8.2](#82-已决策不支持-web-版-vscode)。

### 4.4 可维护性
- **NFR-4.1 分层**：WebDAV 协议层（HTTP + XML 解析）、连接与凭据层、FileSystemProvider 适配层、UI 层必须解耦，协议层可脱离 VSCode 单元测试。
- **NFR-4.2 测试**：协议层单测覆盖率 ≥ 70%；针对 5.6 矩阵中每个服务端提供可重复执行的冒烟用例集。

---

## 5. 架构与流程设计

### 5.1 URI Scheme 设计
工作区根目录 URI 规范：
```text
webdav://[connectionId]/[remotePath]
```
- **Scheme**: `webdav`
- **Authority**: `connectionId`（对应配置项的唯一标识，避免暴露 IP/端口/鉴权）
- **Path**: WebDAV 服务器上的路径（相对于连接配置的路径前缀），例如 `/documents/my-project`

**约束**：
- URI 的 authority 在 RFC 3986 中大小写不敏感，且可能被 URI 解析层归一化。因此 `connectionId` **必须限定为 `[a-z0-9-]`**（UUID v4 的标准小写形式天然满足），避免大小写归一化导致连接索引查找失败。
- 完整远端 URL 由 `连接配置的 baseUrl + pathPrefix + URI.path` 拼接得到，`URI.path` 中**不承载**任何主机与前缀信息，便于服务器迁移时仅改连接配置即可。

### 5.2 扩展激活与初始化时序（关键约束）

`vscode.openFolder` 到 `webdav://` URI 会触发窗口重载。重载后 VSCode 会**立即**向 provider 请求 `stat`/`readDirectory`，若此时 provider 尚未注册，工作区会表现为空或直接报错。因此：

1. `package.json` 必须声明 `"activationEvents": ["onFileSystem:webdav"]`。
2. `activate()` 中 **`registerFileSystemProvider` 必须在同步阶段完成**，不得置于任何 `await` 之后（尤其是 `SecretStorage.get()` 与网络请求之后）。
3. 凭据与连接配置采用**懒加载**：provider 内部持有一个 `Promise<Credentials>`，首次 IO 时才 await；并发调用复用同一 promise。
4. 凭据缺失时（FR-1.2 的 Sync 场景）抛出可识别错误并触发一次性的重新输入引导，而非反复弹窗。

```ts
// 正确顺序示意
export function activate(ctx: vscode.ExtensionContext) {
  const provider = new WebdavFS(ctx); // 构造函数内不做任何 await
  ctx.subscriptions.push(
    vscode.workspace.registerFileSystemProvider('webdav', provider, {
      isCaseSensitive: true, // 见 8.1 待决策
    })
  );
  // 其余 UI / 命令注册可异步
  void initUi(ctx, provider);
}
```

### 5.3 WebDAV 动作映射与协议约束

| FSP 方法 | HTTP 动作 | 必需请求头 | 关键约束 |
| :--- | :--- | :--- | :--- |
| `stat` | `PROPFIND` | `Depth: 0` | 部分服务端对 `Depth:0` 支持不佳，需可回退到父目录 `Depth:1` 后筛选 |
| `readDirectory` | `PROPFIND` | `Depth: 1` | 必须过滤代表自身的 `<response>` 条目 |
| `readFile` | `GET` | — | 记录 `ETag` / `Last-Modified` 供 FR-4.4 使用 |
| `writeFile` | `PUT` | `If-Match`（可选） | 需按 `{create, overwrite}` 处理边界；同一文件写请求串行化 |
| `createDirectory` | `MKCOL` | — | `409` → 父目录不存在 |
| `delete` | `DELETE` | `Depth: infinity`（目录） | 部分服务端返回 `207`，须逐条解析子状态判断是否全部成功 |
| `rename` | `MOVE` | `Destination`、`Overwrite: T/F` | `Destination` 必须为**绝对 URL** 且正确百分号编码 |
| `copy` | `COPY` | `Destination`、`Overwrite`、`Depth: infinity` | `405/501` 时回退为 read + write |

**路径编码规则（一等公民，历史上此类客户端的首要 Bug 来源）**：
- **出站**：按路径段（segment）逐段 `encodeURIComponent`，保留 `/` 作为分隔符。必须正确处理空格、中文、`#`、`?`、`&`、`+`、`%`。
- **入站**：`PROPFIND` 响应中的 `<D:href>` 在不同服务端可能是**绝对 URL、绝对路径或相对路径**，且已被百分号编码。必须先归一化为绝对路径、再解码、再剥离 `pathPrefix`，最后与请求路径比对以识别"自身条目"。
- **目录尾斜杠**：不同服务端对目录 `href` 是否带尾 `/` 表现不一，比对前须统一归一化。
- 编码/解码逻辑必须有独立单元测试，并覆盖上述全部字符样例。

### 5.4 缓存与失效模型

```text
CacheKey = connectionId + normalizedPath
Entry    = { stat, children?, etag?, expireAt }
```
- 读路径：`stat`/`readDirectory` 先查缓存（未过期即返回），否则发起请求并回填；`readDirectory` 一次回填全部子项 `stat`。
- 写路径：任何写操作**立即**失效目标路径 + 其父目录的 children；`delete`/`rename` 额外递归失效子树。
- 手动失效：FR-2.4 的刷新命令按子树清除。
- 连接配置变更或凭据更新时，清空该 `connectionId` 的全部缓存。

### 5.5 大文件与内存约束

`FileSystemProvider.readFile` / `writeFile` 的正式 API 签名分别返回和接收完整的 `Uint8Array`，**不提供流式接口**。因此：
- **不存在**"分块读写"的实现空间——原 PRD 中该项已修订为下述可落地方案。
- 读：超过阈值（默认 50MB）直接拒绝并提示，避免扩展宿主进程 OOM。
- 写：同样受整块内存约束，阈值一致。
- 传输过程的进度提示可在 HTTP 层通过响应/请求流的字节计数实现（不改变 FSP 接口语义）。
- 若未来确有大文件需求，方向是提供"下载到本地临时文件后编辑并回传"的显式命令，而非试图流式化 FSP。

### 5.6 兼容性矩阵

> **已于 2026-09-08 在 `home-debian`（nas-debian）实测**，由 `npm run test:compat` 自动采集。
> 完整报告见 [compat-matrix.generated.md](./compat-matrix.generated.md)，勿手工编辑。

| 服务端 | Base Path | PROPFIND | Depth:0 | MOVE | COPY | ETag | 中文/空格名 | 递归删除 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Nextcloud 29 | `/remote.php/dav/files/<user>/` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ownCloud 10.15 | `/remote.php/dav/files/<user>/` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| AList | `/dav/<挂载点>` | ✓ | ✓ | ✓ | **✗ 500** | ✓ | ✓ | ✓ |
| Apache mod_dav (Digest) | 自定义 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Apache mod_dav (Basic) | 自定义 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Apache mod_dav (TLS 自签名) | 自定义 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Nginx 原生 DAV | 自定义 | **✗ 405** | — | — | — | — | — | — |
| 群晖 DSM | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |

**实测暴露的三处服务端差异（均已在代码中处理）**：

1. **Apache mod_dav 对无尾斜杠的集合 URL 返回 301**，而 Nextcloud 直接返回 207。
   客户端原先不跟随重定向，会导致**所有 Apache/mod_dav 用户完全不可用**。
   已实现同源重定向跟随（跨源一律拒绝，否则 `Authorization` 会被发往其他主机）。
2. **AList 对 `COPY` 返回裸 500**，而非规范建议的 405/501。
   原降级条件只覆盖 `NotSupported`，已扩大到 `ServerError`（见 FR-3.8）。
3. **Apache 返回小写百分号编码**（`%e4%b8%ad`）且不编码 `+`、`()`，
   与 Nextcloud 的大写编码并存——解码逻辑须大小写无关（已由 5.3 单测覆盖）。

**群晖 DSM**：无容器化途径，维持「社区反馈驱动」，不得默认为可用。

### 5.7 核心业务流程图

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
    Client->>Server: PROPFIND /subpath (Depth: 1)
    Server-->>Client: 返回目录项
    Ext-->>User: 弹出 QuickPick / 树形选择器供用户选择目录
    User->>Ext: 选中目标目录 (如 /projects/demo)

    Ext->>Ext: 拼接 URI: webdav://<connId>/projects/demo
    Ext->>Ext: vscode.commands.executeCommand('vscode.openFolder', uri)
    Note over Ext,FSP: VSCode 重载。激活事件 onFileSystem:webdav 触发，<br/>provider 必须在同步阶段完成注册（见 5.2）

    VSCode->>FSP: stat(uri) / readDirectory(uri)
    FSP->>Store: 懒加载凭据（首次 IO 时 await）
    FSP->>Client: 请求远程目录内容 (走缓存/请求)
    Client->>Server: PROPFIND /projects/demo
    Server-->>Client: 返回子文件列表
    FSP->>FSP: 回填 children 与各子项 stat 缓存
    FSP-->>VSCode: 返回 [name, FileType][]
    VSCode-->>User: 资源管理器展现目录树，可编辑与保存
```

### 5.8 HTTP 传输层设计（对应 8.3 决议）

**决议：自研薄协议层，基于 Node 内置 `node:https` / `node:http`，XML 解析复用 `fast-xml-parser`。不引入 `webdav` npm 包。**

#### 5.8.1 决策理由
本 PRD 中被列为核心风险与核心需求的能力，恰好全部落在 HTTP 层，且都是"用库要绕、自研是顺手"的：

| 需求 | 自研 `node:https` | 引入 `webdav` 包 |
| :--- | :--- | :--- |
| NFR-2.3 自签名证书**按连接**生效 | 每连接一个 `https.Agent({ rejectUnauthorized })`，天然隔离 | 需依赖库是否透传 agent；且不得触碰全局 TLS 开关 |
| FR-1.6 代理（继承 `http.proxy`） | 自选 proxy agent 并注入 | 同上，受库的透传能力约束 |
| FR-6.1 请求级脱敏日志 | 在唯一出口处统一埋点 | 需 hook 库内部或依赖其日志能力 |
| FR-4.1 字节级进度 + 取消 | 直接消费 `IncomingMessage` 流、`req.destroy()` 取消 | 库以 Buffer 为单位返回，进度粒度受限 |
| NFR-1.3 并发上限与写串行化 | 自有请求队列 | 需在库外再包一层 |
| 5.3 `href` 归一化与路径编码 | 逻辑自持，可按 5.6 矩阵逐服务端加回退 | 归一化在库内部，遇到兼容性差异只能 patch 或绕过 |
| NFR-4.1 协议层脱离 VSCode 单测 | 纯 Node 模块，注入 `http.request` 即可测 | 需 mock 库行为，测的是库不是自己的逻辑 |

补充事实（已实测 npm 元数据）：
- `webdav@5.10.0` 为 `"type": "module"` 纯 ESM，带 14 个运行时依赖（含 ESM-only 的 `node-fetch@3`、`@buttercup/fetch`）。可用 esbuild 打成 CJS，但引入了不必要的打包不确定性与依赖面。
- `webdav@4.11.5`（v4 末版）为 CJS，但依赖 `axios@0.x` 老分支，且 v4 已进入维护状态。

WebDAV 在本项目中实际使用的协议子集很小——8 个动作、一种 `multistatus` 响应结构，自研规模约 600–900 行，**换来的是 5.6 兼容性矩阵上的全部调试与回退自由度**，这正是 R2（服务端实现差异）的主要缓解手段。

#### 5.8.2 附带收益
- 依赖数从 15+ 降到 1（`fast-xml-parser`），显著降低供应链与 VSIX 体积风险。
- 不依赖全局 `fetch`（Node 18+ 才有），因此 `engines.vscode` 可稳定保持在 `>= 1.75.0`（NFR-3.2），无需为运行时特性抬高下限。
- 打包简单：`esbuild --bundle --platform=node --format=cjs --external:vscode`，无 ESM/CJS 互操作问题。

#### 5.8.3 实现约束
- **单一出口**：所有 HTTP 请求必须经由唯一的 `request()` 函数，认证、重试、超时、日志脱敏、进度、取消、并发队列全部在此实现，禁止旁路。
- **接口隔离**：协议层对外暴露 `WebdavClient` 接口（`propfind` / `get` / `put` / `mkcol` / `delete` / `move` / `copy` / `options`），FileSystemProvider 只依赖该接口。若自研成本超预期，可在不改上层的前提下换回第三方实现——保留这条退路。
- **不自研的部分**：XML 解析用 `fast-xml-parser`；Digest 认证（FR-1.5 P1）如自研成本高，可单独引入体积极小的算法库或参考实现，不影响整体决策。
- **参考而非依赖**：`webdav` 包与各服务端文档可作为兼容性 quirk 的参考来源，遇到 5.6 矩阵中的差异优先查阅其历史 issue。

#### 5.8.4 验证节点
Phase 1 开工首周完成一个约 200 行的最小 spike：对 Nextcloud 与 Apache `mod_dav` 各跑通 `PROPFIND Depth:1`（含中文与空格文件名）→ `GET` → `PUT`。若 spike 暴露出预期外的协议复杂度，则回退到"`webdav@5` + esbuild 打包 CJS"方案并回写本节。

---

## 6. 版本里程碑规划

每条均标注对应需求编号，便于追溯。

### Phase 1: MVP 最小可行版本 (v0.1.0)
- [ ] **【首周】协议层 spike**：验证自研 HTTP 传输层可行性（5.8.4），通过后方可展开后续开发。
- [ ] 基础配置命令：输入 URL、用户名、密码（FR-1.1、FR-1.5 P0）。
- [ ] 凭证使用 `SecretStorage` 存储（FR-1.2、NFR-2.1）。
- [ ] `package.json` 声明 `virtualWorkspaces` 能力与 `onFileSystem:webdav` 激活事件（NFR-3.1、5.2）。
- [ ] 基础 `FileSystemProvider` 实现（FR-3.1 ~ FR-3.4），含路径编码规则与单测（5.3）。
- [ ] 支持通过命令输入远程目录路径并以工作区形式打开（FR-2.1 简化版）。
- [ ] 诊断输出通道与脱敏日志（FR-6.1）——**前置到 MVP**，否则早期兼容性问题无法定位。
- [ ] 错误映射基础版（FR-4.2 中 401/403/404/超时四类）。

### Phase 2: 交互与体验完善 (v0.2.0)
- [ ] 目录选择交互：实现层级式 QuickPick 导航选择器（FR-2.1 完整版）。
- [ ] 侧边栏 TreeView 面板（FR-2.2）与最近打开历史（FR-2.3）。
- [ ] 补全 `FileSystemProvider` 接口：`createDirectory`、`delete`、`rename`、`copy`、`watch` 语义（FR-3.5 ~ FR-3.9）。
- [ ] 元数据内存缓存与失效模型（NFR-1.1、NFR-1.2、FR-2.4 刷新命令）。
- [ ] 连接测试与列表管理（FR-1.3、FR-1.4）。
- [ ] 状态栏指示器与首次能力提示（FR-4.3、FR-4.5）。
- [ ] 完成 5.6 兼容性矩阵首轮实测。

### Phase 3: 健壮性与高级功能 (v0.3.0)
- [ ] 传输进度通知与取消、大文件阈值保护（FR-4.1、FR-3.3、5.5）。
  > 原"分块读写"因 FSP API 不支持流式已修订，见 5.5。
- [ ] 401 鉴权过期的重新认证流程与请求重试（FR-1.2、FR-4.2）。
- [ ] 保存冲突检测（ETag / `If-Match` / 412 处理，FR-4.4）。
- [ ] Digest 与 Bearer 认证、代理支持（FR-1.5 P1、FR-1.6）。
- [ ] 并发与节流控制（NFR-1.3）、性能指标达标验证（NFR-1.4）。
- [ ] 多服务器管理界面（Webview 配置面板，FR-1.1 增强）。
- [ ] 按文件名查找（FR-5.1 v1.0 方案）。

### Phase 4: 长尾与增强 (v0.4.0+)
- [ ] 自定义请求头（FR-1.5 P2）、只读连接（FR-1.7）。
- [ ] 可选的目录轮询刷新（FR-3.9 P2）。
- [ ] 全文搜索能力接入（FR-5.1 v2.0 方案，视 proposed API 状态）。

---

## 7. 风险与假设

| # | 风险 / 假设 | 影响 | 应对 |
| :--- | :--- | :--- | :--- |
| R1 | 用户预期"远程开发"，实际受虚拟工作区限制 | 高：差评主因 | 2.4 能力边界 + FR-4.5 首次提示 + 商店描述明示 |
| R2 | 各服务端 WebDAV 实现差异大（尤其 `href` 格式、`Depth` 行为、`MOVE`/`COPY` 支持） | 高 | 5.6 矩阵 + FR-6.1 日志 + 协议层可回退设计 |
| R3 | 全文搜索缺失 | 中高 | FR-5.1 分阶段方案，MVP 阶段明确提示 |
| R4 | 高延迟网络下 `stat` 风暴导致编辑器卡顿 | 中 | NFR-1.1 缓存 + NFR-1.2 请求合并 + NFR-1.3 并发上限 |
| R5 | 无锁机制，多人同时编辑同一文件将互相覆盖 | 中 | FR-4.4 ETag 冲突检测（检测而非预防）；`LOCK` 明确列入 2.5 非目标 |
| R6 | 自研协议层低估了服务端兼容性复杂度，拖慢 Phase 1 | 中 | 5.8.4 首周 spike 验证；协议层接口隔离，保留换回第三方库的退路 |
| A1 | 假设：目标服务端均支持 `PROPFIND`（Nginx 原生 DAV 模块不支持） | — | 连接测试阶段即检出并明确提示所需模块 |
| A2 | 假设：用户可接受远端文件无本地备份 | — | 文档明示；冲突时提供"另存为"出口 |

---

## 8. 已决策项与待决策项

### 8.1 待决策项
> 以下需在对应 Phase 开工前给出结论并回写本文档。

- ~~**8.1.1 路径大小写敏感性**~~ ✅ **已决策（2026-09-08）：维持 `isCaseSensitive: true`。**
  - 5.6 矩阵中六个可测服务端（Nextcloud / ownCloud / AList / Apache ×3）全部运行于 Linux 后端，路径大小写敏感，与该设置一致。
  - `isCaseSensitive` 是 provider 级一次性选项，无法按连接配置；若未来需支持大小写不敏感后端（如 Windows 或部分对象存储），须整体评估而非按连接切换。
- **8.1.2 多根工作区支持范围**：是否允许"本地目录 + 远程目录"混合的 `.code-workspace`；混合后 VSCode 的虚拟工作区判定与能力降级行为需实测。
- **8.1.3 `pathPrefix` 的归属**：路径前缀放在连接配置中（URI 更短、迁移友好）还是放入 URI path（更直观）。当前 5.1 采用前者，需确认无歧义场景。

### 8.2 【已决策】不支持 Web 版 VSCode
- **结论**：v1.0 及后续版本均**仅支持 Desktop**，不提供 Web 扩展宿主构建。
- **理由**：Web 宿主中的网络请求受浏览器 CORS 约束，而绝大多数 WebDAV 服务端（Nextcloud、AList、群晖、`mod_dav`）默认不下发 CORS 响应头，用户无法自行修复；勉强支持只会产出大面积"连不上"的失败体验。
- **落地要求**：`package.json` 仅声明 `"main"`，不声明 `"browser"`（见 NFR-3.3）；Marketplace 描述中注明"仅支持桌面版 VSCode"。

### 8.3 【已决策】HTTP 传输层自研，不引入 `webdav` npm 包
- **结论**：基于 `node:https` / `node:http` 自研薄协议层，XML 解析复用 `fast-xml-parser`。
- **理由与实现约束**：见 [5.8 HTTP 传输层设计](#58-http-传输层设计对应-83-决议)。
- **退出条件**：Phase 1 首周 spike（5.8.4）未通过时，回退到 `webdav@5` + esbuild 打包 CJS。

---

## 附录 A：需求编号索引

- **FR-1.x** 连接与凭据管理（1.1 新增 / 1.2 安全存储 / 1.3 测试 / 1.4 列表 / 1.5 认证方式 / 1.6 代理 / 1.7 只读）
- **FR-2.x** 目录浏览与选择（2.1 QuickPick / 2.2 TreeView / 2.3 历史 / 2.4 刷新）
- **FR-3.x** 虚拟文件系统（3.1 stat / 3.2 readDirectory / 3.3 readFile / 3.4 writeFile / 3.5 createDirectory / 3.6 delete / 3.7 rename / 3.8 copy / 3.9 watch）
- **FR-4.x** 体验与反馈（4.1 进度 / 4.2 错误映射 / 4.3 状态栏 / 4.4 冲突检测 / 4.5 能力提示）
- **FR-5.x** 搜索（5.1 搜索决策）
- **FR-6.x** 诊断（6.1 日志 / 6.2 遥测）
- **NFR-1.x** 性能 ｜ **NFR-2.x** 安全 ｜ **NFR-3.x** 兼容 ｜ **NFR-4.x** 可维护
