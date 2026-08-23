#!/usr/bin/env bash
# verify-k8s-e2e.sh — dinh nghia "XONG" khach quan cho feature Kubernetes (ORC playbook §2/§6).
# "Xong" = hanh vi quan sat duoc, KHONG phai test xanh. Read-only tren cluster that cua user;
# write path chi kiem bang --dry-run=server (khong mutate production).
#
# Chay: bash orc/k8s/verify-k8s-e2e.sh
set -uo pipefail
REPO="/Users/ngocchanh/Project/private/organisations/hdc/jagentdesk"
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

# [1.3] cluster RPC domain dang ky trong protocol
grep -rqE "cluster\.(contexts|import|list|connect|resources|logs|write)" packages/protocol/src 2>/dev/null \
  && ok "cluster RPC domain co trong protocol" || no "chua co cluster RPC trong protocol"

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

echo "═══════════ S2 · cluster = workspace + add/connect ═══════════"
grep -rqE "\"cluster\"|'cluster'" packages/app/src/**/*workspace* 2>/dev/null \
  && ok "workspace kind cluster co dau vet trong app" || no "chua co workspace kind cluster"
grep -rqiE "Connect a Kubernetes cluster|Add cluster" packages/app/src 2>/dev/null \
  && ok "UI Add/Connect cluster co chuoi" || no "chua co UI Add/Connect cluster"

echo "═══════════ S3 · workloads panel + resource detail + edit YAML ═══════════"
grep -rqE "register.*cluster|panelKind.*cluster|\"cluster\"" packages/app/src/**/register-panels* 2>/dev/null \
  && ok "panel kind cluster dang ky" || no "chua dang ky panel kind cluster"

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
