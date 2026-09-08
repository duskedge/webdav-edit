<!-- 由 `npm run test:compat` 自动生成，请勿手工编辑。 -->
<!-- 生成后可整体替换 PRD 5.6 的表格主体。 -->

# WebDAV 服务端兼容性矩阵

> 生成时间：2026-09-08T08:42:30.222Z
> 「待验证」表示该项本次运行未采集到结论——**不得默认为可用**（PRD 5.6）。

| 服务端 | 可达 | Base Path | Server | PROPFIND | Depth:0 | MOVE | COPY | ETag | 中文名 | 空格名 | 递归删除 |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| Nextcloud | ✓ | /remote.php/dav/files/davtest | Apache/2.4.62 (Debian) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| ownCloud | ✓ | /remote.php/dav/files/davtest | Apache | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| AList | ✓ | /dav/test | (未回显) | ✓ | ✓ | ✓ | ✗ ServerError(500) | ✓ | ✓ | ✓ | ✓ |
| Apache mod_dav (Digest) | ✓ | /dav | Apache/2.4.68 (Unix) OpenSSL/3.5.7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Apache mod_dav (Basic) | ✓ | /dav-basic | Apache/2.4.68 (Unix) OpenSSL/3.5.7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Apache mod_dav (TLS 自签名) | ✓ | /dav-basic | Apache/2.4.68 (Unix) OpenSSL/3.5.7 | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Nginx 原生 DAV | ✓ | /dav | 待验证 | ✗ 不支持（已正确检出） | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 | 待验证 |

## 采集到的 Allow 头

- **Nextcloud**：OPTIONS GET HEAD DELETE PROPFIND PUT PROPPATCH COPY MOVE REPORT
- **ownCloud**：OPTIONS GET HEAD DELETE PROPFIND PUT PROPPATCH COPY MOVE REPORT LOCK UNLOCK
- **AList**：OPTIONS LOCK DELETE PROPPATCH COPY MOVE UNLOCK PROPFIND
- **Apache mod_dav (Digest)**：OPTIONS GET HEAD POST DELETE TRACE PROPFIND PROPPATCH COPY MOVE LOCK UNLOCK
- **Apache mod_dav (Basic)**：OPTIONS GET HEAD POST DELETE TRACE PROPFIND PROPPATCH COPY MOVE LOCK UNLOCK
- **Apache mod_dav (TLS 自签名)**：OPTIONS GET HEAD POST DELETE TRACE PROPFIND PROPPATCH COPY MOVE LOCK UNLOCK
- **Nginx 原生 DAV**：待验证

## DAV 合规等级

- **Nextcloud**：1, 3, extended-mkcol, access-control, calendarserver-principal-property-search, nextcloud-checksum-update, nc-calendar-search, nc-enable-birthday-calendar
- **ownCloud**：1, 3, extended-mkcol, 2
- **AList**：(未回显)
- **Apache mod_dav (Digest)**：(未回显)
- **Apache mod_dav (Basic)**：(未回显)
- **Apache mod_dav (TLS 自签名)**：(未回显)
- **Nginx 原生 DAV**：待验证

## 未覆盖项

- **群晖 DSM**：无容器化途径，需真机手工验证或降级为社区反馈驱动（开发计划 §2.2）。
