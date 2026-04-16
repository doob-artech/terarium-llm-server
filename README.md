# terarium-llm-server

Terarium 월드에서 사용하는 LLM 요청 큐, 워커 라우팅, 헬스체크, 오토스케일링을 담당하는 서버입니다.

외부 클라이언트는 이 서버의 OpenAI-compatible API만 호출하고, 실제 추론은 내부 Ollama 또는 OpenAI-compatible 워커로 분산됩니다.

## 역할

- `world-server`, 튜토리얼, 배치 도구의 LLM 요청을 큐로 받습니다.
- 모델별로 사용 가능한 워커를 찾아 병렬 분산합니다.
- 워커 헬스체크를 수행하고, 장애 워커를 자동 제외합니다.
- Vast.ai 인스턴스 자동 등록과 오토스케일링을 지원합니다.
- 공개 API와 관리자 API를 분리합니다.

## 권장 구조

```text
terarium-world-server
  -> terarium-llm-server (/v1/chat/completions)
  -> private worker endpoints over Tailscale / private network
  -> Ollama / OpenAI-compatible inference workers
```

중요:

- `world-server` 는 `terarium-llm-server` 만 호출해야 합니다.
- `llm_workers.base_url` 은 Cloudflare 공개 주소가 아니라 내부망 주소를 써야 합니다.
- 현재 운영 패턴에서는 `100.80.215.107:18000/gpu/{index}` 같은 Tailscale 라우터 주소를 사용합니다.
- Cloudflare `llm.team-doob.com` 은 외부 ingress 용도로만 두는 것이 맞습니다.

## 왜 Cloudflare upstream을 피해야 하나

긴 추론 요청을 Cloudflare를 거쳐 직접 워커에 보내면 `524 timeout` 이 발생할 수 있습니다.

잘못된 예:

```json
{
  "baseUrl": "https://llm.team-doob.com/gpu/0"
}
```

권장 예:

```json
{
  "baseUrl": "http://100.80.215.107:18000/gpu/0"
}
```

다른 서버를 붙일 때도 같은 원칙입니다.

- 외부 공개 DNS: `llm.team-doob.com`
- 내부 워커 주소: `http://<tailscale-or-private-host>:<port>` 또는 `http://<tailscale-or-private-host>:18000/gpu/<index>`

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

## 환경 변수

| 변수 | 설명 |
| --- | --- |
| `PORT` | 서버 포트, 기본 `18200` |
| `HOST` | 바인드 주소, 기본 `0.0.0.0` |
| `LLM_SERVER_API_KEYS` | 클라이언트 요청용 Bearer 토큰 목록 |
| `LLM_SERVER_ADMIN_KEY` | 관리자 API Bearer 토큰 |
| `LLM_SERVER_INSTANCE_KEY` | 외부 인스턴스 자동 등록용 Bearer 토큰 |
| `DEFAULT_MODEL` | 기본 모델, 기본 `gemma4:e4b` |
| `REQUEST_TIMEOUT_MS` | 애플리케이션 레벨 요청 타임아웃, `0` 이면 제한 없음 |
| `WORKER_HEALTHCHECK_ENABLED` | 워커 자동 헬스체크 여부 |
| `WORKER_HEALTHCHECK_INTERVAL_MS` | 헬스체크 주기 |
| `WORKER_HEALTHCHECK_TIMEOUT_MS` | 헬스체크 요청 타임아웃 |
| `WORKER_UNHEALTHY_AFTER_FAILURES` | 연속 실패 시 unhealthy 전환 기준 |
| `WORKER_HEALTHY_AFTER_SUCCESSES` | 연속 성공 시 healthy 복귀 기준 |
| `WORKER_REGISTRY_BACKEND` | `postgres` 또는 `file` |
| `WORKER_REGISTRY_PATH` | 파일 레지스트리 경로 |
| `INSTANCE_REGISTRY_PATH` | 파일 인스턴스 레지스트리 경로 |
| `POSTGRES_HOST` | Postgres 호스트 |
| `POSTGRES_PORT` | Postgres 포트 |
| `POSTGRES_DB` | Postgres DB 이름 |
| `POSTGRES_USER` | Postgres 유저 |
| `POSTGRES_PASSWORD` | Postgres 비밀번호 |
| `POSTGRES_SSL` | Postgres SSL 사용 여부 |
| `AUTOSCALE_ENABLED` | 오토스케일 활성화 여부 |
| `AUTOSCALE_DRY_RUN` | 실제 생성/삭제 없이 판단만 수행 |
| `AUTOSCALE_MAX_WORKERS` | 최대 워커 수 |
| `AUTOSCALE_BACKLOG_PER_WORKER` | 워커 1개당 허용 backlog 기준 |
| `AUTOSCALE_MIN_GPU_VRAM_GB` | Vast 후보 최소 VRAM |
| `AUTOSCALE_MAX_GPU_VRAM_GB` | Vast 후보 최대 VRAM |
| `AUTOSCALE_MAX_DOLLARS_PER_HOUR` | Vast 후보 시간당 최대 비용 |
| `VAST_API_KEY` | Vast.ai API 키 |
| `VAST_TEMPLATE_HASH_ID` | Vast 템플릿 hash |
| `VAST_DOCKER_IMAGE` | Vast 인스턴스 기본 Docker 이미지 |
| `ALLOW_NO_AUTH` | 무인증 허용 여부 |

## 워커 설정 원칙

`WORKER_REGISTRY_BACKEND=postgres` 이면 `llm_workers` 테이블이 실제 소스입니다.

테이블이 비어 있을 때만 `data/workers.example.json` 으로 seed 합니다.

즉 이 파일은 매우 중요합니다.

- 여기 값이 잘못되면 새 환경에서 같은 문제가 재발합니다.
- Cloudflare 공개 주소가 들어 있으면 안 됩니다.
- Tailscale 또는 private endpoint 를 넣어야 합니다.

현재 운영 예시는 다음과 같습니다.

```json
[
  {
    "id": "vilab-gpu-0",
    "name": "vilab tailscale GPU 0",
    "type": "openai-compatible",
    "baseUrl": "http://100.80.215.107:18000/gpu/0",
    "models": ["gemma4:e4b"],
    "defaultModel": "gemma4:e4b",
    "concurrency": 1,
    "enabled": true,
    "apiKey": "change-me"
  }
]
```

## API

### 클라이언트 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/v1/chat/completions` | OpenAI-compatible 채팅 완성 |
| `GET` | `/v1/models` | 사용 가능한 모델 목록 |
| `GET` | `/health` | 기본 헬스체크 |
| `GET` | `/v1/public/status` | 공개 상태 요약 |

### 관리자 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `GET` | `/v1/queue/status` | 큐 상태 조회 |
| `GET` | `/v1/workers` | 워커 목록 조회 |
| `GET` | `/v1/workers/health` | 워커 헬스 상태 조회 |
| `POST` | `/v1/workers/health/check` | 전체 워커 헬스체크 |
| `POST` | `/v1/workers/:id/health/check` | 특정 워커 헬스체크 |
| `POST` | `/v1/workers` | 워커 추가 |
| `PATCH` | `/v1/workers/:id` | 워커 수정 |
| `DELETE` | `/v1/workers/:id` | 워커 삭제 |
| `GET` | `/v1/autoscale/status` | 오토스케일 상태 |
| `POST` | `/v1/autoscale/tick` | 오토스케일 즉시 평가 |
| `GET` | `/v1/instances` | 인스턴스 상태 조회 |

### 인스턴스 등록 API

| 메서드 | 경로 | 설명 |
| --- | --- | --- |
| `POST` | `/v1/instances/register` | 인스턴스와 워커를 한 번에 등록 |
| `POST` | `/v1/instances/:id/heartbeat` | heartbeat 갱신 |
| `POST` | `/v1/instances/:id/deregister` | 인스턴스와 연결 워커 제거 |

## 운영 메모

- 큐 서버는 `REQUEST_TIMEOUT_MS=0` 으로 두고, upstream timeout 은 별도로 관리하는 편이 안전합니다.
- 워커는 가능한 한 private network 또는 Tailscale 주소를 사용합니다.
- 서버를 여러 대 붙일 때는 `llm1.team-doob.com`, `llm2.team-doob.com` 같은 서버 단위 DNS를 두고, 실제 worker 등록은 private endpoint 로 처리하는 것이 낫습니다.
- 장기적으로는 Redis 같은 외부 큐를 붙이면 다중 `terarium-llm-server` 인스턴스 운영이 쉬워집니다.
