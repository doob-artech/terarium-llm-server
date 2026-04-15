#!/usr/bin/env bash
set -euo pipefail

STACK_DIR="${TERARIUM_STACK_DIR:-/opt/terarium-vast-llm}"
MODEL="${TERARIUM_WORKER_MODEL:-gemma4:e4b}"
ROUTER_PORT="${TERARIUM_ROUTER_PORT:-18080}"
OLLAMA_BASE_PORT="${TERARIUM_OLLAMA_BASE_PORT:-11540}"
OLLAMA_IMAGE="${TERARIUM_OLLAMA_IMAGE:-ollama/ollama:latest}"
GPU_COUNT="${TERARIUM_GPU_COUNT:-$(nvidia-smi -L | wc -l | tr -d ' ')}"
LLM_SERVER_URL="${TERARIUM_LLM_SERVER_URL:-}"
INSTANCE_KEY="${TERARIUM_INSTANCE_KEY:-}"
INSTANCE_ID="${TERARIUM_INSTANCE_ID:-$(hostname)}"
PROVIDER="${TERARIUM_PROVIDER:-vast}"
PROVIDER_INSTANCE_ID="${TERARIUM_PROVIDER_INSTANCE_ID:-${INSTANCE_ID}}"
INSTANCE_LABEL="${TERARIUM_INSTANCE_LABEL:-${INSTANCE_ID}}"
HEARTBEAT_INTERVAL_SEC="${TERARIUM_HEARTBEAT_INTERVAL_SEC:-15}"

if [[ -z "${GPU_COUNT}" || "${GPU_COUNT}" -lt 1 ]]; then
  echo "No GPUs detected"
  exit 1
fi

mkdir -p "${STACK_DIR}/nginx"
cat > "${STACK_DIR}/docker-compose.yml" <<YAML
services:
YAML

for ((i=0; i<GPU_COUNT; i++)); do
  port=$((OLLAMA_BASE_PORT + i))
  cat >> "${STACK_DIR}/docker-compose.yml" <<YAML
  ollama-gpu-${i}:
    image: ${OLLAMA_IMAGE}
    restart: unless-stopped
    environment:
      OLLAMA_HOST: 0.0.0.0:${port}
      CUDA_VISIBLE_DEVICES: "${i}"
    command: ["serve"]
    volumes:
      - ./data/ollama-${i}:/root/.ollama
    ports:
      - "127.0.0.1:${port}:${port}"
YAML
done

cat >> "${STACK_DIR}/docker-compose.yml" <<YAML
  router:
    image: nginx:alpine
    restart: unless-stopped
    depends_on:
YAML

for ((i=0; i<GPU_COUNT; i++)); do
  cat >> "${STACK_DIR}/docker-compose.yml" <<YAML
      - ollama-gpu-${i}
YAML
done

cat >> "${STACK_DIR}/docker-compose.yml" <<YAML
    ports:
      - "${ROUTER_PORT}:${ROUTER_PORT}"
    extra_hosts:
      - "host.docker.internal:host-gateway"
    volumes:
      - ./nginx/default.conf:/etc/nginx/conf.d/default.conf:ro
YAML

cat > "${STACK_DIR}/nginx/default.conf" <<EOF
server {
  listen ${ROUTER_PORT};
  client_max_body_size 32m;

  location = /health {
    add_header Content-Type text/plain;
    return 200 "ok";
  }
EOF

for ((i=0; i<GPU_COUNT; i++)); do
  port=$((OLLAMA_BASE_PORT + i))
  cat >> "${STACK_DIR}/nginx/default.conf" <<EOF

  location /gpu/${i}/ {
    rewrite ^/gpu/${i}/(.*)$ /\$1 break;
    proxy_http_version 1.1;
    proxy_set_header Host \$host;
    proxy_set_header Connection "";
    proxy_buffering off;
    proxy_pass http://host.docker.internal:${port}/;
  }
EOF
done

cat >> "${STACK_DIR}/nginx/default.conf" <<EOF
}
EOF

cd "${STACK_DIR}"
docker compose up -d

for ((i=0; i<GPU_COUNT; i++)); do
  container="ollama-gpu-${i}"
  for attempt in {1..30}; do
    if docker compose exec -T "${container}" ollama list >/dev/null 2>&1; then
      break
    fi
    sleep 2
  done
  docker compose exec -T "${container}" ollama pull "${MODEL}"
done

echo "Ready: ${GPU_COUNT} GPU workers on port ${ROUTER_PORT}"

if [[ -n "${LLM_SERVER_URL}" && -n "${INSTANCE_KEY}" ]]; then
  PUBLIC_IP="${TERARIUM_PUBLIC_IP:-$(curl -fsSL https://api.ipify.org || true)}"
  PUBLIC_BASE_URL="${TERARIUM_PUBLIC_BASE_URL:-http://${PUBLIC_IP}:${ROUTER_PORT}}"
  REGISTER_JSON="${STACK_DIR}/register-instance.json"

  {
    printf '{\n'
    printf '  "instance": {\n'
    printf '    "id": "%s",\n' "${INSTANCE_ID}"
    printf '    "label": "%s",\n' "${INSTANCE_LABEL}"
    printf '    "provider": "%s",\n' "${PROVIDER}"
    printf '    "providerInstanceId": "%s",\n' "${PROVIDER_INSTANCE_ID}"
    printf '    "host": "%s",\n' "${PUBLIC_IP}"
    printf '    "publicBaseUrl": "%s",\n' "${PUBLIC_BASE_URL}"
    printf '    "gpuCount": %s,\n' "${GPU_COUNT}"
    printf '    "autoscaled": %s,\n' "${TERARIUM_AUTOSCALED:-true}"
    printf '    "metadata": {"model": "%s", "routerPort": %s}\n' "${MODEL}" "${ROUTER_PORT}"
    printf '  },\n'
    printf '  "workers": [\n'
    for ((i=0; i<GPU_COUNT; i++)); do
      comma=","
      if [[ "$i" -eq $((GPU_COUNT - 1)) ]]; then
        comma=""
      fi
      printf '    {"id":"%s-gpu%s","name":"%s GPU %s","gpuIndex":%s,"type":"ollama","models":["%s"],"defaultModel":"%s","concurrency":1}%s\n' \
        "${INSTANCE_ID}" "${i}" "${INSTANCE_LABEL}" "${i}" "${i}" "${MODEL}" "${MODEL}" "${comma}"
    done
    printf '  ]\n'
    printf '}\n'
  } > "${REGISTER_JSON}"

  curl -fsSL \
    -H "Authorization: Bearer ${INSTANCE_KEY}" \
    -H "Content-Type: application/json" \
    -X POST \
    --data @"${REGISTER_JSON}" \
    "${LLM_SERVER_URL%/}/v1/instances/register"

  nohup bash -lc "
    while true; do
      curl -fsSL \
        -H 'Authorization: Bearer ${INSTANCE_KEY}' \
        -H 'Content-Type: application/json' \
        -X POST \
        --data '{\"label\":\"${INSTANCE_LABEL}\",\"host\":\"${PUBLIC_IP}\",\"publicBaseUrl\":\"${PUBLIC_BASE_URL}\",\"status\":\"running\",\"healthReason\":\"heartbeat ok\"}' \
        '${LLM_SERVER_URL%/}/v1/instances/${INSTANCE_ID}/heartbeat' >/dev/null 2>&1 || true
      sleep ${HEARTBEAT_INTERVAL_SEC}
    done
  " >"${STACK_DIR}/heartbeat.log" 2>&1 &
fi
