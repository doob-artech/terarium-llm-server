# terarium-llm-server

Terarium에서 사용하는 LLM 연산 서버를 큐 기반으로 관리하는 프로젝트입니다. `world-server`, 튜토리얼, 배치 도구는 이 서버의 OpenAI-compatible API(`/v1/chat/completions`)만 호출하고, 실제 Ollama/GPU 서버 선택과 병렬 실행은 이 프로젝트가 담당합니다.

## 역할

- `world-server`가 보내는 행동 판단/대화 판단 요청을 큐에 넣습니다.
- 등록된 LLM 워커의 동시 처리 수를 기준으로 요청을 분산합니다.
- 워커 작동 여부를 주기적으로 검사하고, 죽은 워커는 큐 대상에서 자동 제외합니다.
- 큐 적체가 지속되면 Vast.ai에서 저렴한 GPU 인스턴스를 찾고 자동 확장 판단을 내립니다.
- Ollama native API(`/api/chat`)와 OpenAI-compatible upstream(`/v1/chat/completions`)을 둘 다 지원합니다.
- 클라이언트 API 키와 관리자 API 키를 분리합니다.
- 현재 기본 모델은 `gemma4:e4b`입니다.

## 현재 권장 구조

`llm.team-doob.com`은 이 서버를 바라보게 두는 것이 맞습니다.

```text
terarium-world-server
  -> https://llm.team-doob.com/v1/chat/completions
  -> terarium-llm-server queue
  -> Ollama worker / GPU server
```

기존 `world-server`의 API 구조는 유지하는 편이 좋습니다. 이미 OpenAI-compatible 형태라서 모델/서버 교체와 큐 도입을 `world-server` 수정 없이 처리할 수 있습니다.

## 서버 배치 위치

운영 서버에서는 `/srv/terarium-llm-server`를 권장합니다.

| 경로 | 용도 |
| --- | --- |
| `/srv/terarium-llm-server` | 서비스 코드와 Docker Compose |
| `/srv/terarium-llm-server/.env` | 서비스 환경 변수 |
| `/srv/terarium-llm-server/data/workers.json` | 워커 레지스트리 |
| `journald` 또는 Docker logs | 실행 로그 |

`/home/ubuntu/Documents/...`는 개발/작업 디렉토리로는 괜찮지만, 계속 떠 있어야 하는 서비스 관리 위치로는 `/srv`가 더 명확합니다.

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

systemd로 관리할 때:

```bash
sudo cp ops/systemd/terarium-llm-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now terarium-llm-server
```

## 환경 변수

| 변수 | 설명 |
| --- | --- |
| `PORT` | 서버 포트, 기본 `18200` |
| `HOST` | 바인딩 호스트, 기본 `0.0.0.0` |
| `LLM_SERVER_API_KEYS` | 클라이언트용 Bearer 키 목록, 쉼표 구분 |
| `LLM_SERVER_ADMIN_KEY` | 워커/큐 관리용 Bearer 키 |
| `DEFAULT_MODEL` | 요청에 모델이 없을 때 사용할 모델, 기본 `gemma4:e4b` |
| `REQUEST_TIMEOUT_MS` | upstream 요청 타임아웃. `0`이면 앱 레벨 타임아웃 없음 |
| `WORKER_HEALTHCHECK_ENABLED` | 워커 자동 헬스체크 활성화 여부 |
| `WORKER_HEALTHCHECK_INTERVAL_MS` | 워커 헬스체크 주기 |
| `WORKER_HEALTHCHECK_TIMEOUT_MS` | 워커 헬스체크 요청 타임아웃 |
| `WORKER_UNHEALTHY_AFTER_FAILURES` | 몇 번 연속 실패하면 큐 대상에서 제외할지 |
| `WORKER_HEALTHY_AFTER_SUCCESSES` | 몇 번 연속 성공하면 다시 큐 대상에 넣을지 |
| `WORKER_REGISTRY_PATH` | 워커 JSON 저장 경로 |
| `AUTOSCALE_ENABLED` | 자동 인스턴스 생성/삭제 활성화 |
| `AUTOSCALE_DRY_RUN` | 실제 과금 액션 없이 판단만 수행 |
| `AUTOSCALE_SUSTAINED_BACKLOG_MS` | 큐 적체가 얼마나 지속되어야 scale-up할지 |
| `AUTOSCALE_MIN_GPU_VRAM_GB` | Vast.ai 후보 최소 VRAM |
| `AUTOSCALE_MAX_GPU_VRAM_GB` | Vast.ai 후보 최대 VRAM. 오버스펙 방지용 |
| `AUTOSCALE_MAX_DOLLARS_PER_HOUR` | 후보 최대 시간당 비용 |
| `VAST_API_KEY` | Vast.ai API 키. 저장소에 커밋 금지 |
| `VAST_TEMPLATE_HASH_ID` | 사용할 Vast.ai template hash |
| `VAST_DOCKER_IMAGE` | template 미사용 시 기본 이미지 |
| `ALLOW_NO_AUTH` | 개발용 무인증 허용 여부 |

## 서버 정보 저장 방식

운영 기본값은 PostgreSQL입니다.

| 정보 | 저장 위치 |
| --- | --- |
| API 키, 기본 모델, DB 접속 정보 | `.env` |
| LLM 워커 서버 목록 | PostgreSQL `llm_workers` 테이블 |
| 로컬 fallback 워커 목록 | `data/workers.json` |

`WORKER_REGISTRY_BACKEND=postgres`이면 서버 시작 시 `llm_workers` 테이블을 자동 생성합니다. 테이블이 비어 있으면 `data/workers.example.json`의 기본 워커를 seed합니다.

로컬 파일 방식이 필요하면 `.env`에서 다음처럼 바꾸면 됩니다.

```env
WORKER_REGISTRY_BACKEND=file
WORKER_REGISTRY_PATH=./data/workers.json
```

## DB 스키마

```sql
CREATE TABLE IF NOT EXISTS llm_workers (
  id text PRIMARY KEY,
  name text NOT NULL,
  type text NOT NULL CHECK (type IN ('ollama', 'openai-compatible')),
  base_url text NOT NULL,
  models jsonb NOT NULL DEFAULT '[]'::jsonb,
  default_model text NOT NULL DEFAULT '',
  concurrency integer NOT NULL DEFAULT 1 CHECK (concurrency > 0),
  enabled boolean NOT NULL DEFAULT true,
  api_key text NOT NULL DEFAULT '',
  health_status text NOT NULL DEFAULT 'unknown',
  health_reason text NOT NULL DEFAULT '',
  last_health_check_at timestamptz,
  consecutive_failures integer NOT NULL DEFAULT 0,
  consecutive_successes integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

## 자동 활성/비활성 판단

`enabled`는 관리자가 수동으로 켜고 끄는 플래그입니다. 자동 헬스체크는 이 값을 덮어쓰지 않고 `health_status`를 갱신합니다.

| 상태 | 의미 |
| --- | --- |
| `enabled=false` | 관리자가 끈 워커. 헬스체크 성공 여부와 관계없이 큐 대상 제외 |
| `enabled=true`, `health_status=healthy` | 정상 워커. 큐 대상 |
| `enabled=true`, `health_status=unknown` | 아직 판단 전. 큐 대상 |
| `enabled=true`, `health_status=unhealthy` | 자동 비활성 워커. 큐 대상 제외 |

Ollama 워커는 `GET /api/tags`, OpenAI-compatible 워커는 `GET /v1/models`로 헬스체크합니다.

## 워커 설정

현재 165.194.161.38에서 Ollama가 떠 있고 7개 병렬 슬롯을 쓸 수 있다면 DB에는 다음 값이 들어갑니다.

```json
[
  {
    "id": "vilab-ollama-165-194-161-38",
    "name": "165.194.161.38 Ollama",
    "type": "ollama",
    "baseUrl": "http://165.194.161.38:11434",
    "models": ["gemma4:e4b"],
    "defaultModel": "gemma4:e4b",
    "concurrency": 7,
    "enabled": true,
    "apiKey": ""
  }
]
```

GPU마다 Ollama 포트가 다르면 워커를 7개로 나누고 각 `concurrency`를 `1`로 두면 됩니다.

## 주요 API

### 클라이언트 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible 채팅 완료 요청 |
| `GET` | `/v1/models` | 사용 가능한 모델 목록 |
| `GET` | `/health` | 헬스체크 |
| `GET` | `/v1/public/status` | 월드 뷰어용 공개 상태. 큐/워커/오토스케일 요약 |

요청 예시:

```bash
curl -X POST http://localhost:18200/v1/chat/completions \
  -H "Authorization: Bearer $LLM_SERVER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma4:e4b",
    "messages": [
      { "role": "system", "content": "JSON only." },
      { "role": "user", "content": "{\"ping\":true}" }
    ]
  }'
```

### 관리자 API

관리자 API는 `LLM_SERVER_ADMIN_KEY` Bearer 토큰이 필요합니다. `WORKER_REGISTRY_BACKEND=postgres`에서는 아래 API가 곧바로 `llm_workers` 테이블을 변경합니다.

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/v1/queue/status` | 대기/실행/성공/실패 상태 조회 |
| `GET` | `/v1/workers` | 워커 목록 조회 |
| `GET` | `/v1/workers/health` | 워커 헬스 상태 조회 |
| `POST` | `/v1/workers/health/check` | 전체 워커 즉시 헬스체크 |
| `POST` | `/v1/workers/:id/health/check` | 특정 워커 즉시 헬스체크 |
| `GET` | `/v1/autoscale/status` | 오토스케일 상태 조회 |
| `POST` | `/v1/autoscale/tick` | 오토스케일 판단 즉시 실행 |
| `POST` | `/v1/workers` | 워커 추가 |
| `PATCH` | `/v1/workers/:id` | 워커 수정 |
| `DELETE` | `/v1/workers/:id` | 워커 삭제 |

워커 추가 예시:

```bash
curl -X POST http://localhost:18200/v1/workers \
  -H "Authorization: Bearer $LLM_SERVER_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "gpu-server-2",
    "name": "Second GPU Server",
    "type": "ollama",
    "baseUrl": "http://10.0.0.20:11434",
    "models": ["gemma4:e4b"],
    "defaultModel": "gemma4:e4b",
    "concurrency": 4,
    "enabled": true
  }'
```

## 운영 메모

- `REQUEST_TIMEOUT_MS=0`으로 두면 앱이 임의로 LLM 요청을 끊지 않습니다.
- Cloudflare Tunnel, Nginx, Ollama 자체 timeout은 별도로 확인해야 합니다.
- Vast.ai API 키는 `.env`의 `VAST_API_KEY`로만 주입합니다.
- `AUTOSCALE_DRY_RUN=true`일 때는 후보 검색/생성/삭제를 실제 실행하지 않고 판단 이벤트만 남깁니다.
- 실제 과금 액션은 `AUTOSCALE_ENABLED=true`, `AUTOSCALE_DRY_RUN=false`일 때만 실행됩니다.
- 워커 목록은 PostgreSQL에 저장됩니다.
- 워커 자동 헬스 상태도 PostgreSQL에 저장됩니다.
- 큐는 아직 프로세스 메모리 기반입니다. 서버 재시작 시 대기 중인 요청은 사라집니다.
- 다음 단계에서 Redis 기반 영속 큐로 바꾸면 멀티 인스턴스 스케일링이 쉬워집니다.

## 다음 확장 방향

- Redis 기반 글로벌 큐와 여러 `terarium-llm-server` 인스턴스 간 분산 처리
- 워커 헬스체크와 자동 disable
- 모델별 라우팅 정책
- 요청 우선순위
- Prometheus 메트릭
