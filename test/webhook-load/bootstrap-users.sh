#!/usr/bin/env bash
set -euo pipefail

# ---- config ----
N_USERS="${N_USERS:-10}"
NS="${NS:-dw-webhook-loadtest}"
OUT="${OUT:-sa-tokens.json}"
DW_API_GROUP="workspace.devfile.io"
DW_RESOURCE="devworkspaces"
TOKEN_TTL="1h"
K6_SCRIPT="${K6_SCRIPT:-loadtest.js}"
DEV_WORKSPACE_READY_TIMEOUT_IN_SECONDS="600"
# ----------------

echo "🌐 Getting Kubernetes API server URL..."
KUBE_API=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
echo "Kubernetes API server: ${KUBE_API}"

echo "Creating namespace: ${NS}"
kubectl create namespace "${NS}" --dry-run=client -o yaml | kubectl apply -f -

echo "Creating RBAC..."
cat <<EOF | kubectl apply -f -
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: dw-user
  namespace: ${NS}
rules:
- apiGroups: ["${DW_API_GROUP}"]
  resources: ["${DW_RESOURCE}"]
  verbs: ["create", "get", "list", "watch", "update", "patch", "delete"]
- apiGroups: [""]
  resources: ["pods", "pods/exec"]
  verbs: ["get", "list", "create", "update", "patch"]
EOF

echo "[" > "${OUT}"

for i in $(seq 1 "${N_USERS}"); do
  SA="user-${i}"

  kubectl create serviceaccount "${SA}" -n "${NS}" --dry-run=client -o yaml | kubectl apply -f -

  kubectl create rolebinding "${SA}-rb" \
    --role=dw-user \
    --serviceaccount="${NS}:${SA}" \
    -n "${NS}" \
    --dry-run=client -o yaml | kubectl apply -f -

  TOKEN=$(kubectl create token "${SA}" -n "${NS}" --duration="${TOKEN_TTL}")

  cat <<EOF >> "${OUT}"
  {
    "user": "${SA}",
    "namespace": "${NS}",
    "token": "${TOKEN}"
  }$( [ "$i" -lt "$N_USERS" ] && echo "," )
EOF
done

echo "]" >> "${OUT}"

echo
echo "Done."
echo "Created ${N_USERS} service accounts"
echo "Tokens written to ${OUT}"

# ---- invoke k6 with environment variables ----

TOKENS_JSON=$(cat "${OUT}")
export K6_USERS_JSON="${TOKENS_JSON}"

echo "🚀 Running k6 load test..."
K6_USERS_JSON="${K6_USERS_JSON}" \
KUBE_API="${KUBE_API}" \
LOAD_TEST_NAMESPACE="${NS}" \
DEV_WORKSPACE_READY_TIMEOUT_IN_SECONDS="${DEV_WORKSPACE_READY_TIMEOUT_IN_SECONDS}" \
k6 run "${K6_SCRIPT}"

exit_code=$?
if [ $exit_code -ne 0 ]; then
    echo "⚠️ k6 load test failed with exit code $exit_code. Proceeding to cleanup."
fi

oc delete ns $NS
