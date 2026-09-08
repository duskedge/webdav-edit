#!/usr/bin/env bash
#
# 复位测试数据集（开发计划 §2.3「可复位」约束）。
#
# 常驻服务的数据必然随测试累积漂移，无复位手段则结果不可信。
#
#   ./reset.sh            清理沙盒目录并重新播种基线数据（快速，日常用）
#   ./reset.sh --hard     销毁全部容器与数据卷后重建（慢，环境可疑时用）
set -euo pipefail

cd "$(dirname "$0")"

DAV_USER="${DAV_USER:-davtest}"
DAV_PASS="${DAV_PASS:-davtest-pw}"
HOST="${DAV_HOST:-127.0.0.1}"

log() { printf '\033[36m[reset]\033[0m %s\n' "$*"; }

if [[ "${1:-}" == "--hard" ]]; then
  log "销毁容器与数据卷…"
  docker compose down -v
  log "重建并启动…"
  docker compose up -d --build
  log "等待服务健康（Nextcloud 首次初始化较慢，最多 5 分钟）…"
  deadline=$(( $(date +%s) + 300 ))
  while (( $(date +%s) < deadline )); do
    if [[ -z "$(docker compose ps --status starting -q)" ]]; then
      break
    fi
    sleep 5
  done
  docker compose ps
  log "重新播种…"
  ./seed.sh
  log "完成（hard）。"
  exit 0
fi

# ── 软复位：只清沙盒，不动基线 ──
# 沙盒目录由 test/compat 每次运行创建（/dav-sandbox/<run-id>/），
# 破坏性用例只作用于其中；这里统一回收历史残留。
purge_sandbox() {
  local base="$1"
  shift
  local -a auth=("$@")
  curl -sS "${auth[@]}" -X DELETE "$base/dav-sandbox" >/dev/null 2>&1 || true
  curl -sS "${auth[@]}" -X MKCOL "$base/dav-sandbox" >/dev/null 2>&1 || true
}

log "清理各服务端的 /dav-sandbox …"
purge_sandbox "http://$HOST:8081/remote.php/dav/files/$DAV_USER" -u "$DAV_USER:$DAV_PASS"
purge_sandbox "http://$HOST:8082/remote.php/dav/files/$DAV_USER" -u "$DAV_USER:$DAV_PASS"
purge_sandbox "http://$HOST:8084/dav-basic" -u "$DAV_USER:$DAV_PASS"
purge_sandbox "http://$HOST:8084/dav" --digest -u "$DAV_USER:$DAV_PASS"
purge_sandbox "http://$HOST:8085/dav"

log "重新播种基线数据…"
./seed.sh >/dev/null

log "完成（soft）。如需彻底重建：./reset.sh --hard"
