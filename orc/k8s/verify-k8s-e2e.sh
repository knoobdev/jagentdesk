#!/usr/bin/env bash
# verify-k8s-e2e.sh — dinh nghia "XONG" khach quan cho feature Kubernetes (ORC playbook §2/§6).
# "Xong" = hanh vi quan sat duoc, KHONG phai test xanh. Read-only tren cluster that cua user;
# write path chi kiem bang --dry-run=server (khong mutate production).
#
# Chay: bash orc/k8s/verify-k8s-e2e.sh
set -uo pipefail
# Repo root computed from this script's location (orc/k8s/ → ../../), no hardcoded path.
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$REPO" || exit 2
pass=0; fail=0; skip=0
ok(){ echo "  ✅ $1"; pass=$((pass+1)); }
no(){ echo "  ❌ $1"; fail=$((fail+1)); }
sk(){ echo "  ⏭️  $1"; skip=$((skip+1)); }
have(){ [ -e "$1" ]; }

echo "═══════════ S1 · daemon kube-client + cluster RPC ═══════════"
# [1.1] module ton tai (khong grep .d.ts — kiem file nguon that)
CDIR="packages/server/src/server/cluster"
{ have "$CDIR/kube-config-source.ts" && have "$CDIR/kube-client.ts" \
  && have "$CDIR/cluster-registry.ts" && have "$CDIR/cluster-dto.ts"; } \
  && ok "module cluster co du 4 file nguon" || no "thieu file module cluster ($CDIR)"

# [1.2] dependency that trong package.json (khong phai chi import)
node -e "process.exit(require('./packages/server/package.json').dependencies?.['@kubernetes/client-node']?0:1)" 2>/dev/null \
  && ok "dep @kubernetes/client-node khai bao" || no "chua khai bao @kubernetes/client-node"

# [1.3] cluster RPC domain dang ky trong protocol (slash-namespace)
grep -rqE "cluster/(contexts|import|list|connect|resources|kinds)" packages/protocol/src 2>/dev/null \
  && ok "cluster RPC domain co trong protocol" || no "chua co cluster RPC trong protocol"

# [1.3b] generic engine + generic RPC (S1c/S1b-ext)
grep -rq "GENERIC_KINDS" packages/server/src/server/cluster/kube-client.ts 2>/dev/null \
  && grep -rqE "cluster/resource/list|cluster/kinds" packages/protocol/src 2>/dev/null \
  && ok "generic engine + generic RPC (any kind)" || no "chua co generic engine/RPC"

# [1.4] typecheck server (tsgo, khong build Go bridge)
( cd packages/server && npx tsgo -p tsconfig.server.typecheck.json --noEmit ) >/tmp/k8s-tc.log 2>&1 \
  && ok "server typecheck xanh" || no "server typecheck fail (xem /tmp/k8s-tc.log)"

# [1.5] OBSERVABLE read-only: list context + pod THAT tu kubeconfig hien hanh (data that, khong mock)
if command -v kubectl >/dev/null && kubectl config current-context >/dev/null 2>&1; then
  # dung chinh module kube-config-source qua tsx neu module co san
  if have "$CDIR/kube-config-source.ts"; then
    npx tsx orc/k8s/probe-read.ts >/tmp/k8s-probe.log 2>&1 \
      && grep -q "PROBE_OK pods=" /tmp/k8s-probe.log \
      && ok "kube-client liet ke pod THAT read-only ($(grep -o 'PROBE_OK pods=[0-9]*' /tmp/k8s-probe.log))" \
      || no "probe read-only fail (xem /tmp/k8s-probe.log)"
  else
    no "chua co module de probe read-only"
  fi
else
  sk "khong co kubectl/context — bo qua probe read-only (khong the verify data that)"
fi

# [1.6] credential KHONG roi daemon: DTO tra ra client khong chua token/certificate-data
if have "$CDIR/cluster-dto.ts"; then
  ! grep -qiE "token|certificate-authority-data|client-key-data|bearer" "$CDIR/cluster-dto.ts" \
    && ok "DTO khong lo credential" || no "DTO co the lo credential (grep token/cert)"
else no "chua co cluster-dto.ts"; fi

echo "═══════════ S2a · Clusters screen (add/connect UI) ═══════════"
{ [ -f packages/app/src/screens/clusters-screen.tsx ] && grep -rqE "clusterConnect|clusterImport" packages/app/src/screens/clusters-screen.tsx; } \
  && ok "Clusters screen goi connect/import RPC" || no "chua co Clusters screen"

echo "═══════════ S3 · generic resource browser (moi kind) ═══════════"
{ [ -f packages/app/src/components/cluster-resource-browser.tsx ] && grep -rqE "clusterKinds|clusterResourceList" packages/app/src/components/cluster-resource-browser.tsx; } \
  && ok "resource browser goi clusterKinds/resourceList" || no "chua co resource browser"

echo "═══════════ S2b · cluster = workspace kind + panel (TODO) ═══════════"
grep -rqE "kind: \"cluster\"" packages/app/src/workspace-tabs 2>/dev/null \
  && ok "panel kind cluster dang ky" || no "chua dang ky panel kind cluster (S2b TODO)"

echo "═══════════ S4 · agent kubectl tool + permission ═══════════"
grep -rqiE "kubectl|kube-tool|cluster.*tool" packages/server/src/server/agent 2>/dev/null \
  && ok "agent co dau vet kube tool" || no "chua co agent kube tool"

echo "═══════════ S5 · mobile ═══════════"
grep -rqiE "cluster" packages/app/src/mobile-panels 2>/dev/null \
  && ok "mobile panels cham cluster" || no "chua co mobile cluster"

echo "═══════════════════════════════════════════════"
echo "═══ $pass đạt / $fail chưa / $skip bỏ qua ═══"
[ $fail -eq 0 ] && echo "🟢 CHẠY ĐƯỢC (trang thai THAT)" || echo "🔴 CHƯA ($fail buoc) — trang thai THAT, khong mock"
exit $([ $fail -eq 0 ] && echo 0 || echo 1)
