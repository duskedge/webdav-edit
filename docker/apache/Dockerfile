# Apache mod_dav —— 测试集群中唯一提供 Digest 认证的服务端（FR-1.5 P1）。
# 同时暴露 TLS 端点（自签名证书），用于验证 NFR-2.3 的「按连接放行证书」。
FROM httpd:2.4

ARG DAV_USER=davtest
ARG DAV_PASS=davtest-pw
ARG DAV_REALM=webdav-test

# 构建期代理（可选）。deb.debian.org 在部分网络下极慢——实测直连拉取包索引
# 需要 883 秒，经代理仅 1.5 秒。这两个 ARG 由 Docker 特殊对待：
# 不会写入镜像环境变量，也不会出现在 docker history 中。
ARG http_proxy
ARG https_proxy

# 只装 openssl（用于生成自签名证书）。healthcheck 改用 bash 的 /dev/tcp，
# 无需 curl —— 少一个包就少一次网络往返。
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*

# 打开 DAV / Digest / SSL 所需模块。注意不启用发行版自带的 httpd-ssl.conf，
# 它引用的证书路径与本镜像不一致；TLS vhost 在 dav.conf 中自带。
RUN set -eux; \
    sed -i \
      -e 's|^#\(LoadModule dav_module\)|\1|' \
      -e 's|^#\(LoadModule dav_fs_module\)|\1|' \
      -e 's|^#\(LoadModule auth_digest_module\)|\1|' \
      -e 's|^#\(LoadModule ssl_module\)|\1|' \
      -e 's|^#\(LoadModule socache_shmcb_module\)|\1|' \
      /usr/local/apache2/conf/httpd.conf; \
    mkdir -p /var/www/webdav /usr/local/apache2/var; \
    chown -R www-data:www-data /var/www/webdav /usr/local/apache2/var

# htdigest 文件格式为 `user:realm:MD5(user:realm:password)`。
# 直接生成而非调用交互式的 htdigest 工具，构建才是确定性的。
# realm 必须与 dav.conf 中的 AuthName 完全一致，否则质询校验必然失败
# ——这正是 FR-1.5 P1 要覆盖的坑。
RUN set -eux; \
    hash="$(printf '%s:%s:%s' "$DAV_USER" "$DAV_REALM" "$DAV_PASS" | md5sum | cut -d' ' -f1)"; \
    printf '%s:%s:%s\n' "$DAV_USER" "$DAV_REALM" "$hash" > /usr/local/apache2/conf/dav.htdigest; \
    htpasswd -bc /usr/local/apache2/conf/dav.htpasswd "$DAV_USER" "$DAV_PASS"

# 自签名证书（NFR-2.3）：让客户端必然走到「证书不受信」分支。
RUN openssl req -x509 -newkey rsa:2048 -nodes -days 3650 \
      -keyout /usr/local/apache2/conf/server.key \
      -out /usr/local/apache2/conf/server.crt \
      -subj "/CN=webdav-test-selfsigned" 2>/dev/null

COPY dav.conf /usr/local/apache2/conf/extra/httpd-dav-test.conf
RUN echo 'Include conf/extra/httpd-dav-test.conf' >> /usr/local/apache2/conf/httpd.conf
