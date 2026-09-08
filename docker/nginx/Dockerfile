# Nginx 原生 DAV —— **刻意的能力残缺场景**（开发计划 §2.2）。
#
# 官方 nginx 构建带 --with-http_dav_module，支持 PUT/DELETE/MKCOL/COPY/MOVE，
# 但 **不支持 PROPFIND**（需第三方 nginx-dav-ext-module）。
# 我们故意不安装该模块，以固化 PRD 风险表 A1 的检出路径：
# 连接测试须给出「需启用 nginx-dav-ext-module」的可操作提示，而非裸 405。
FROM nginx:1.27-alpine

RUN mkdir -p /var/www/webdav && chown -R nginx:nginx /var/www/webdav
COPY dav.conf /etc/nginx/conf.d/default.conf
