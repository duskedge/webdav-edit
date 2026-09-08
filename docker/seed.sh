#!/usr/bin/env bash
#
# 播种测试数据集（开发计划 T-0.2 / §2.3）。
#
# 数据集刻意包含 PRD 5.3 列出的全部「难字符」，因为路径编码是此类客户端
# 历史上的首要 Bug 来源——若种子数据只有 ASCII，编码缺陷不会在冒烟阶段暴露。
#
#   ./seed.sh              播种全部服务端
#   ./seed.sh nextcloud    只播种指定服务端
set -euo pipefail

cd "$(dirname "$0")"

DAV_USER="${DAV_USER:-davtest}"
DAV_PASS="${DAV_PASS:-davtest-pw}"
HOST="${DAV_HOST:-127.0.0.1}"

# 基线数据集：名称覆盖空格、中文、#、&、+、括号、百分号
declare -a FILES=(
  "readme.txt|hello webdav"
  "中文文件.md|# 中文内容"
  "with space.txt|has space"
  "hash#and&plus+.txt|special chars"
  "括号 (1).log|parens"
  "100%.dat|percent"
)
declare -a DIRS=(
  "docs"
  "docs/子目录"
  "空 目录"
)

log() { printf '\033[36m[seed]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[seed]\033[0m %s\n' "$*" >&2; }

# 用 curl 对一个 WebDAV 端点播种。
# $1 base URL（含路径前缀，不含尾斜杠）  $2 认证参数
seed_dav() {
  local base="$1"
  shift
  local -a auth=("$@")

  for d in "${DIRS[@]}"; do
    curl -sS -f "${auth[@]}" -X MKCOL "$base/$(urlenc "$d")" >/dev/null 2>&1 || true
  done

  for entry in "${FILES[@]}"; do
    local name="${entry%%|*}"
    local body="${entry#*|}"
    printf '%s\n' "$body" \
      | curl -sS -f "${auth[@]}" -T - "$base/$(urlenc "$name")" >/dev/null 2>&1 \
      || warn "  写入失败: $name"
    printf '%s\n' "$body" \
      | curl -sS -f "${auth[@]}" -T - "$base/docs/$(urlenc "$name")" >/dev/null 2>&1 || true
  done
}

# 逐段百分号编码，输出与 src/webdav/path.ts 的出站规则完全一致。
#
# 注意：非 ASCII 必须按 **UTF-8 字节**编码。用 `printf '%%%02X' "'$c"` 会得到
# 字符的码点（括 → %62EC）而非 UTF-8 字节（%E6%8B%AC），服务端将解析出错误的文件名。
urlenc() {
  local s="$1" out="" c i
  for ((i = 0; i < ${#s}; i++)); do
    c="${s:i:1}"
    case "$c" in
      [a-zA-Z0-9.~_-]) out+="$c" ;;
      /) out+="/" ;;
      *)
        out+="$(printf '%s' "$c" \
          | od -An -tx1 -v \
          | tr -d ' \n' \
          | sed 's/../%&/g' \
          | tr '[:lower:]' '[:upper:]')"
        ;;
    esac
  done
  printf '%s' "$out"
}

seed_nextcloud() {
  log "Nextcloud → http://$HOST:8081"
  seed_dav "http://$HOST:8081/remote.php/dav/files/$DAV_USER" -u "$DAV_USER:$DAV_PASS"
}

seed_owncloud() {
  log "ownCloud → http://$HOST:8082"
  seed_dav "http://$HOST:8082/remote.php/dav/files/$DAV_USER" -u "$DAV_USER:$DAV_PASS"
}

seed_apache() {
  log "Apache mod_dav (Basic) → http://$HOST:8084/dav-basic"
  seed_dav "http://$HOST:8084/dav-basic" -u "$DAV_USER:$DAV_PASS"
  log "Apache mod_dav (Digest) → http://$HOST:8084/dav"
  seed_dav "http://$HOST:8084/dav" --digest -u "$DAV_USER:$DAV_PASS"
}

seed_nginx() {
  # Nginx 原生 DAV 无 PROPFIND，但 PUT/MKCOL 可用——种子仍可写入。
  log "Nginx 原生 DAV → http://$HOST:8085/dav（预期不支持 PROPFIND）"
  seed_dav "http://$HOST:8085/dav"
}

seed_alist() {
  log "AList → http://$HOST:8083"
  warn "  AList 需先在 Web UI 完成存储挂载配置，种子数据请在挂载后手动放置。"
  warn "  取管理员密码： docker exec wd-alist ./alist admin random"
}

target="${1:-all}"
case "$target" in
  all)
    seed_nextcloud
    seed_owncloud
    seed_apache
    seed_nginx
    seed_alist
    ;;
  nextcloud) seed_nextcloud ;;
  owncloud) seed_owncloud ;;
  apache) seed_apache ;;
  nginx) seed_nginx ;;
  alist) seed_alist ;;
  *)
    echo "用法: $0 [all|nextcloud|owncloud|apache|nginx|alist]" >&2
    exit 2
    ;;
esac

log "完成。"
