# WebDAV Edit

[English](README.md) | [简体中文](README.zh-CN.md)

**WebDAV Edit** opens a remote WebDAV directory as a native VS Code workspace. Browse, create, edit, rename, copy, and delete remote files without synchronizing the entire directory to your computer.

It is designed for lightweight remote editing of configuration files, scripts, Markdown notes, and static assets hosted by Nextcloud, ownCloud, AList, Apache WebDAV, NAS devices, and other compatible servers.

> [!IMPORTANT]
> This extension supports desktop VS Code only. Browser-hosted VS Code is subject to CORS restrictions that most WebDAV servers do not enable.

## Highlights

- Open remote directories directly as `webdav://` virtual workspaces.
- Manage multiple connections from a dedicated Activity Bar view.
- Read, write, create, delete, rename, and copy files and directories.
- Download individual remote files to a chosen local path from the tree context menu.
- Detect conflicting saves with ETag and `If-Match` validation.
- Authenticate with Basic, Digest, Bearer token, or no authentication.
- Store passwords and tokens in VS Code `SecretStorage`, never in settings or workspace URIs.
- Connect through HTTP proxies and configure safe custom request headers.
- Limit file size, concurrency, retries, metadata caching, and optional directory polling.
- Search recursively by file name with bounded depth and directory limits.
- Inspect credential-redacted diagnostic logs when troubleshooting.

## Installation

### Visual Studio Marketplace

After the first public release, install the extension from the Extensions view in VS Code or run:

```bash
code --install-extension duskEdge.webdav-edit
```

### GitHub release

Download the `.vsix` file from the [latest GitHub release](https://github.com/duskedge/webdav-edit/releases/latest), then run:

```bash
code --install-extension webdav-edit-<version>.vsix
```

You can also open the Extensions view, choose **Views and More Actions…**, and select **Install from VSIX…**.

## Quick start

1. Open the Command Palette and run **WebDAV: 新增连接** (Add Connection), or select the WebDAV icon in the Activity Bar.
2. Paste a complete WebDAV URL, such as `https://cloud.example.com/remote.php/dav/files/alice/`.
3. Select **解析地址** to split the URL and apply a matching server preset.
4. Test the connection, then save it.
5. Run **WebDAV: 连接并打开远程目录**, browse to a directory, and open it as a workspace.

Passwords and bearer tokens are stored with VS Code `SecretStorage`. They are not written to `settings.json`, workspace URIs, recent-workspace records, or logs.

## Virtual workspace limitations

A `webdav://` folder is a VS Code virtual workspace. Some desktop workspace features require a local filesystem and are therefore unavailable or limited:

| Capability | Status |
| :--- | :--- |
| Integrated terminal, debugging, and tasks | Unavailable |
| Git source control | Unavailable |
| Language services that require local paths | Often unavailable or degraded |
| Full-text workspace search | Unavailable; use **WebDAV: 按文件名查找** |
| Instant detection of external changes | Unavailable; refresh manually or enable polling |

Use this extension for browsing and lightweight editing. For a complete remote development environment, use Remote SSH or Dev Containers instead.

## Server compatibility

| Server | Status | Notes |
| :--- | :--- | :--- |
| Nextcloud | Tested | An application password is recommended. |
| ownCloud | Tested | Basic WebDAV operations are supported. |
| Apache `mod_dav` | Tested | Basic, Digest, and self-signed TLS configurations are covered. |
| AList | Tested | Copy falls back to download and upload when `COPY` is unsupported. |
| Native Nginx DAV module | Unsupported | It does not implement `PROPFIND`; use `nginx-dav-ext-module`. |
| Synology DSM | Not yet verified | Community compatibility reports are welcome. |

## Configuration

Connections should normally be managed through the extension UI. Connection metadata is stored in settings, while credentials remain in `SecretStorage`.

| Setting | Default | Purpose |
| :--- | :--- | :--- |
| `webdavEdit.cacheTtlSeconds` | `30` | Metadata cache lifetime in seconds; set to `0` to disable. |
| `webdavEdit.maxFileSizeMB` | `50` | Maximum size of a file read or written in memory. |
| `webdavEdit.maxConcurrentRequests` | `6` | Maximum concurrent requests for each connection. |
| `webdavEdit.connectTimeoutMs` | `10000` | Connection timeout in milliseconds. |
| `webdavEdit.requestTimeoutMs` | `60000` | Request timeout in milliseconds. |
| `webdavEdit.maxRetries` | `2` | Retries for idempotent requests; write operations are never retried automatically. |
| `webdavEdit.proxy` | empty | HTTP proxy URL; falls back to VS Code and environment proxy settings. |
| `webdavEdit.noProxy` | empty | Comma-separated hosts that bypass the proxy. |
| `webdavEdit.search.maxDepth` | `6` | Maximum recursive depth for file-name search. |
| `webdavEdit.search.maxDirectories` | `200` | Maximum number of directories scanned by file-name search. |
| `webdavEdit.pollIntervalSeconds` | `0` | Directory polling interval; `0` disables polling. |
| `webdavEdit.logLevel` | `info` | Diagnostic log level: `off`, `error`, `info`, or `debug`. |

## Troubleshooting

Run **WebDAV: 显示诊断日志** and set `webdavEdit.logLevel` to `debug` when more detail is needed. Credentials and authentication headers are redacted from diagnostic output.

Common checks:

- Confirm that the URL points to the WebDAV endpoint, not the normal browser interface.
- Prefer HTTPS, especially with Basic authentication.
- For Nextcloud, use an application password instead of the account password.
- If a self-signed server is used, enable certificate bypass only for a connection you trust.
- If changes made outside VS Code are not visible, refresh the directory or enable polling.

## Development

Requirements: Node.js 20+ and npm.

```bash
git clone git@github.com:duskedge/webdav-edit.git
cd webdav-edit
npm ci
npm run check
npm test
npm run package
```

`npm run package` produces `webdav-edit-<version>.vsix`. Install it locally with:

```bash
npm run install-local
```

## Publishing

The GitHub Actions release workflow validates, tests, packages, publishes to the Visual Studio Marketplace, and attaches the generated VSIX to a GitHub release when a matching SemVer tag is pushed.

Before the first release, create the `duskEdge` publisher in the Visual Studio Marketplace and add a repository secret named `VSCE_PAT` with **Marketplace: Manage** permission.

Keep the version in `package.json` and the Git tag identical:

```bash
npm version patch -m "发布 %s"
git push origin main --follow-tags
```

For example, version `0.1.0` must use tag `v0.1.0`.

## Security notes

- Never commit WebDAV credentials, bearer tokens, cookies, proxy credentials, or `.env` files.
- Prefer HTTPS and narrowly scoped application passwords or tokens.
- Treat certificate verification bypass as a per-connection exception, not a default.
- Review the packaged file list before publishing a release.

## License

[MIT](LICENSE)
