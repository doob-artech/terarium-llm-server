# Vast.ai Multi-GPU Template

Vast.ai에서 멀티 GPU 인스턴스를 띄웠을 때 `GPU 1개 = LLM worker 1개`로 분해하기 위한 부트스트랩 템플릿입니다.

## 목표

- 인스턴스 1대가 아니라 GPU 슬롯 단위로 워커를 등록합니다.
- 외부에는 `ROUTER_PORT` 하나만 열고, 내부에서 `/gpu/0`, `/gpu/1` 식으로 나눕니다.
- `terarium-llm-server` autoscaler는 이 라우터를 보고 `vast-<instance>-gpu0` 같은 워커를 생성합니다.

## 파일

| 파일 | 역할 |
| --- | --- |
| `bootstrap-multigpu.sh` | Vast 인스턴스 시작 시 실행할 부트스트랩 스크립트 |

## 필수 환경 변수

| 변수 | 기본값 | 설명 |
| --- | --- | --- |
| `TERARIUM_WORKER_MODEL` | `gemma4:e4b` | 각 GPU worker가 pull할 모델 |
| `TERARIUM_ROUTER_PORT` | `18080` | 외부에 노출할 단일 HTTP 포트 |
| `TERARIUM_OLLAMA_BASE_PORT` | `11540` | 내부 GPU별 Ollama 포트 시작값 |
| `TERARIUM_OLLAMA_IMAGE` | `ollama/ollama:latest` | Ollama 이미지 |
| `TERARIUM_GPU_COUNT` | 자동 감지 | 강제 GPU 개수 |
| `TERARIUM_STACK_DIR` | `/opt/terarium-vast-llm` | 생성될 compose 스택 경로 |
| `TERARIUM_LLM_SERVER_URL` | 없음 | 등록할 `terarium-llm-server` URL |
| `TERARIUM_INSTANCE_KEY` | 없음 | `/v1/instances/register`용 Bearer 키 |
| `TERARIUM_INSTANCE_ID` | `hostname` | llm-server에서 사용할 인스턴스 id |
| `TERARIUM_PROVIDER_INSTANCE_ID` | `TERARIUM_INSTANCE_ID` | provider가 가진 실제 instance id |
| `TERARIUM_INSTANCE_LABEL` | `TERARIUM_INSTANCE_ID` | UI/로그에 보일 라벨 |
| `TERARIUM_HEARTBEAT_INTERVAL_SEC` | `15` | heartbeat 간격 |

## 동작 방식

예를 들어 4 GPU 인스턴스라면 아래처럼 올라갑니다.

```text
router :18080
  -> /gpu/0 -> ollama-gpu-0 :11540
  -> /gpu/1 -> ollama-gpu-1 :11541
  -> /gpu/2 -> ollama-gpu-2 :11542
  -> /gpu/3 -> ollama-gpu-3 :11543
```

`terarium-llm-server`는 각 경로를 별도 worker로 등록합니다. `TERARIUM_LLM_SERVER_URL`과 `TERARIUM_INSTANCE_KEY`가 있으면 bootstrap 스크립트가 등록과 heartbeat까지 자동으로 수행합니다.

```text
vast-<instance-id>-gpu0
vast-<instance-id>-gpu1
vast-<instance-id>-gpu2
vast-<instance-id>-gpu3
```

## Vast Template에 넣는 방법

가장 단순한 방법은 Vast template의 `on-start` 또는 startup script에 아래처럼 넣는 것입니다.

```bash
curl -fsSL https://raw.githubusercontent.com/doob-artech/terarium-llm-server/main/ops/vast/bootstrap-multigpu.sh -o /root/bootstrap-multigpu.sh
chmod +x /root/bootstrap-multigpu.sh
TERARIUM_WORKER_MODEL=gemma4:e4b \
TERARIUM_ROUTER_PORT=18080 \
TERARIUM_OLLAMA_BASE_PORT=11540 \
/root/bootstrap-multigpu.sh
```

실제 운영에서는 raw URL 대신 이 저장소를 clone하거나, 템플릿 이미지 안에 스크립트를 baked-in 하는 편이 더 안정적입니다.

## 주의

- 이 스크립트는 Docker와 Nvidia runtime이 이미 준비된 환경을 전제로 합니다.
- router는 포트 1개만 외부에 열고, GPU별 Ollama 포트는 loopback으로만 바인딩합니다.
- 모델 pull이 오래 걸릴 수 있으므로 초기 ready 시간은 길게 보는 편이 맞습니다.
