# terarium-llm-server

TERARiUM 월드에서 사용하는 LLM/SLM inference gateway입니다.

이 서버는 모델을 직접 실행하지 않습니다. 외부 클라이언트에는 OpenAI-compatible API를 제공하고, 실제 추론은 private network 뒤의 Ollama 또는 OpenAI-compatible worker로 라우팅합니다.

## 역할

- `world-server`, 운영 도구, playground의 LLM 요청을 큐로 받습니다.
- `slm`, `llm` worker pool별로 사용 가능한 worker를 선택합니다.
- worker healthcheck를 수행하고 unhealthy worker를 자동 제외합니다.
- RunPod autoscaling으로 LLM worker capacity를 확장합니다.
- worker/instance 등록, heartbeat, cleanup을 관리합니다.
- 공개 API와 관리자 API를 Bearer token으로 분리합니다.

## 운영 구조

```text
client / world-server / playground
  -> terarium-llm-server (/v1/chat/completions)
  -> private worker endpoints
  -> Ollama or OpenAI-compatible inference workers
```

현재 공식 worker pool은 두 개입니다.

| Pool | 용도 |
| --- | --- |
| `slm` | 기본 상시 추론 풀. 연구실 GPU, `gemma4:e4b` |
| `llm` | RunPod burst 풀. `gemma4:12b` |

현재 운영 기본값은 `slm`입니다.

```env
DEFAULT_WORKER_POOL=slm
WORKER_POOLS=slm,llm
AUTOSCALE_WORKER_POOL=llm
AUTOSCALE_WORKER_MODEL=gemma4:12b
```

## 네트워크 원칙

- `world-server`와 playground는 `terarium-llm-server`만 호출합니다.
- `llm.team-doob.com`은 LLM gateway ingress입니다.
- `llm_workers.base_url`에는 gateway 공개 주소를 넣지 않습니다.
- worker `baseUrl`은 Tailscale, private VPC, private LAN, provider internal endpoint 같은 private endpoint를 사용합니다.
- 긴 추론 요청을 Cloudflare를 거쳐 worker에 직접 보내면 timeout 위험이 큽니다.

잘못된 worker 예:

```json
{
  "baseUrl": "https://<llm-gateway-domain>/gpu/0"
}
```

권장 worker 예:

```json
{
  "baseUrl": "http://<private-worker-host>:<port>/gpu/0"
}
```

## 빠른 시작

```bash
cp .env.example .env
cp data/workers.example.json data/workers.json
npm install
npm start
```

Docker Compose:

```bash
cp .env.example .env
cp data/workers.example.json data/workers.json
docker compose up --build -d
```

systemd:

```bash
sudo cp ops/systemd/terarium-llm-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now terarium-llm-server
```

## Worker Registry

`WORKER_REGISTRY_BACKEND=postgres`이면 `llm_workers` 테이블이 실제 source of truth입니다.

테이블이 비어 있고 `WORKER_REGISTRY_SEED_EXAMPLE=true`일 때만 `data/workers.example.json`으로 seed합니다. 운영 환경에서는 실제 worker 주소와 API key를 DB 또는 관리자 API로 관리합니다.

Worker 예:

```json
{
  "id": "slm-gpu-0",
  "name": "SLM GPU 0",
  "type": "openai-compatible",
  "baseUrl": "http://<private-worker-host>:<port>/gpu/0",
  "models": ["gemma4:e4b"],
  "defaultModel": "gemma4:e4b",
  "concurrency": 1,
  "enabled": true,
  "workerPool": "slm",
  "apiKey": "change-me"
}
```

Worker type:

| Type | 호출 방식 |
| --- | --- |
| `ollama` | `${baseUrl}/api/chat`, `${baseUrl}/api/tags` |
| `openai-compatible` | `${baseUrl}/v1/chat/completions`, `${baseUrl}/v1/models` |

## Request Routing

기본 요청:

```http
POST /v1/chat/completions
Authorization: Bearer <LLM_SERVER_API_KEYS>
Content-Type: application/json
```

```json
{
  "model": "gemma4:e4b",
  "messages": [
    { "role": "user", "content": "hello" }
  ],
  "queue_worker_pool": "slm",
  "queue_priority": "interactive",
  "queue_source": "manual-test"
}
```

특정 worker로 보내는 playground/debug 요청:

```json
{
  "model": "gemma4:e4b",
  "queue_worker_pool": "slm",
  "queue_worker_id": "slm-gpu-0",
  "messages": [
    { "role": "user", "content": "Return OK." }
  ]
}
```

지원하는 queue metadata:

| Field | 설명 |
| --- | --- |
| `queue_worker_pool` / `worker_pool` | 대상 worker pool. 기본 `slm` |
| `queue_worker_id` / `worker_id` | 특정 worker 고정 라우팅 |
| `queue_priority` / `priority` | `interactive`, `high`, `normal`, `low`, `background` 등 |
| `queue_source` / `request_source` | status/debug용 요청 출처 |
| `queue_start_timeout_ms` | worker 배정 전 pending 허용 시간 |

## API

### Client API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible chat completions |
| `GET` | `/v1/models` | 등록된 모델 목록 |
| `GET` | `/health` | 기본 healthcheck |
| `GET` | `/v1/public/status` | 공개 상태 요약 |

### Admin API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/v1/queue/status` | 큐 상태 |
| `GET` | `/v1/workers` | worker 목록 |
| `GET` | `/v1/workers/health` | worker health 상태 |
| `POST` | `/v1/workers/health/check` | 전체 worker healthcheck |
| `POST` | `/v1/workers/:id/health/check` | 특정 worker healthcheck |
| `POST` | `/v1/workers` | worker 추가 |
| `PATCH` | `/v1/workers/:id` | worker 수정 |
| `DELETE` | `/v1/workers/:id` | worker 삭제 |
| `GET` | `/v1/autoscale/status` | autoscale 상태 |
| `PATCH` | `/v1/autoscale/settings` | autoscale 활성화/비활성화 |
| `POST` | `/v1/autoscale/tick` | autoscale 즉시 평가 |
| `POST` | `/v1/autoscale/reset` | autoscaled capacity 제거 |
| `GET` | `/v1/instances` | instance 상태 |

### Instance API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/v1/instances/register` | instance와 worker 등록 |
| `POST` | `/v1/instances/:id/heartbeat` | heartbeat 갱신 |
| `POST` | `/v1/instances/:id/deregister` | instance와 연결 worker 제거 |

## 환경 변수

| 변수 | 설명 |
| --- | --- |
| `PORT` | 서버 포트. 기본 `18200` |
| `HOST` | 바인드 주소. 기본 `0.0.0.0` |
| `LLM_SERVER_API_KEYS` | client API Bearer token 목록 |
| `LLM_SERVER_ADMIN_KEY` | admin API Bearer token |
| `LLM_SERVER_INSTANCE_KEY` | instance registration Bearer token |
| `DEFAULT_MODEL` | 기본 모델. 운영 기본 `gemma4:e4b` |
| `DEFAULT_WORKER_POOL` | 기본 worker pool. 기본 `slm` |
| `WORKER_POOLS` | 공개 상태에 표시할 pool 목록. 기본 `slm,llm` |
| `REQUEST_TIMEOUT_MS` | worker upstream 요청 timeout. `0`이면 앱 레벨 timeout 없음 |
| `CORS_ALLOWED_ORIGINS` | browser client 허용 origin 목록 |
| `WORKER_HEALTHCHECK_ENABLED` | worker healthcheck 활성화 |
| `WORKER_HEALTHCHECK_INTERVAL_MS` | healthcheck 주기 |
| `WORKER_HEALTHCHECK_TIMEOUT_MS` | healthcheck timeout |
| `WORKER_UNHEALTHY_AFTER_FAILURES` | unhealthy 전환 실패 횟수 |
| `WORKER_HEALTHY_AFTER_SUCCESSES` | healthy 복귀 성공 횟수 |
| `WORKER_REGISTRY_BACKEND` | `postgres` 또는 `file` |
| `WORKER_REGISTRY_SEED_EXAMPLE` | 빈 registry에 example worker seed 여부 |
| `WORKER_REGISTRY_PATH` | file backend worker registry 경로 |
| `INSTANCE_REGISTRY_PATH` | file backend instance registry 경로 |
| `POSTGRES_HOST` | Postgres host |
| `POSTGRES_PORT` | Postgres port |
| `POSTGRES_DB` | Postgres database |
| `POSTGRES_USER` | Postgres user |
| `POSTGRES_PASSWORD` | Postgres password |
| `POSTGRES_SSL` | Postgres SSL 사용 여부 |
| `AUTOSCALE_ENABLED` | autoscale 활성화 |
| `AUTOSCALE_DRY_RUN` | 실제 생성/삭제 없이 판단만 수행 |
| `AUTOSCALE_WORKER_POOL` | autoscale worker가 등록될 pool. 운영 기본 `llm` |
| `AUTOSCALE_WORKER_MODEL` | autoscale worker 기본 모델 |
| `AUTOSCALE_MIN_WORKERS` | 최소 autoscaled 포함 worker 수 |
| `AUTOSCALE_MAX_WORKERS` | 최대 worker 수 |
| `AUTOSCALE_BACKLOG_PER_WORKER` | worker 1개당 backlog 기준 |
| `AUTOSCALE_TARGET_UTILIZATION` | scale-up 기준 utilization |
| `AUTOSCALE_SCALE_DOWN_UTILIZATION` | scale-down 기준 utilization |
| `AUTOSCALE_PROVIDERS` | `runpod-community,runpod-secure` 등 provider 순서 |
| `RUNPOD_API_KEY` | RunPod API key |
| `RUNPOD_*` | RunPod 후보 GPU, 비용, disk/memory 조건 |
| `ALLOW_NO_AUTH` | client API 무인증 허용. 운영에서는 `false` |

## 운영 메모

- 운영 기본 worker pool은 `slm`입니다.
- RunPod autoscaling은 현재 `llm` capacity 확장용입니다.
- `slm` pool은 연구실 GPU에서 공식 Gemma 4 E4B 모델을 처리하는 상시 풀입니다.
- 큐 서버는 `REQUEST_TIMEOUT_MS=0`으로 두고, world-server나 caller에서 task별 timeout을 관리하는 편이 안전합니다.
- 다중 `terarium-llm-server` 인스턴스를 운영하려면 Redis 같은 외부 queue가 필요합니다.
- Playground는 로컬 개발 시 Vite proxy가 client key를 주입할 수 있습니다. 브라우저에 token을 직접 넣지 않아도 됩니다.
