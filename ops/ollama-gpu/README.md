# GPU별 SLM 워커 실행

이 문서는 한 서버의 여러 GPU를 각각 독립 SLM worker로 실행하는 운영 패턴을 설명합니다.

현재 예시는 GPU 7개 서버를 기준으로 합니다.

| GPU | 컨테이너 | 호스트 포트 | `llm_workers.id` |
| --- | --- | --- | --- |
| 0 | `ollama-gpu-0` | `11434` | `slm-gpu-0` |
| 1 | `ollama-gpu-1` | `11435` | `slm-gpu-1` |
| 2 | `ollama-gpu-2` | `11436` | `slm-gpu-2` |
| 3 | `ollama-gpu-3` | `11437` | `slm-gpu-3` |
| 4 | `ollama-gpu-4` | `11438` | `slm-gpu-4` |
| 5 | `ollama-gpu-5` | `11439` | `slm-gpu-5` |
| 6 | `ollama-gpu-6` | `11440` | `slm-gpu-6` |

## 실행

```bash
cd /srv/terarium-llm-server/ops/ollama-gpu
docker compose -f docker-compose.7gpu.yml up -d
```

모델은 공유 볼륨 `terarium_ollama_models` 기준으로 한 번만 받아도 됩니다.

```bash
docker exec ollama-gpu-0 ollama pull gemma4:e4b
```

## 확인

```bash
nvidia-smi
ss -ltnp | grep 114
curl http://127.0.0.1:11434/api/tags
curl http://127.0.0.1:11440/api/tags
```

## 운영 원칙

- 각 컨테이너는 서로 다른 GPU만 보도록 분리해야 합니다.
- `terarium-llm-server` 는 GPU별 워커를 각각 다른 `id` 로 등록해야 합니다.
- 소형 GPU worker는 기본적으로 `workerPool: "slm"`으로 등록합니다.
- 외부에서 직접 `11434~11440` 을 노출할 필요는 없습니다.
- 가능하면 nginx 또는 라우터를 앞에 두고 Tailscale/private network 로만 접근하게 두는 편이 낫습니다.

예:

```json
[
  {
    "id": "slm-gpu-0",
    "name": "SLM GPU 0",
    "type": "openai-compatible",
    "baseUrl": "http://<private-router-host>:<router-port>/gpu/0",
    "models": ["gemma4:e4b"],
    "defaultModel": "gemma4:e4b",
    "concurrency": 1,
    "enabled": true,
    "workerPool": "slm",
    "apiKey": "change-me"
  }
]
```
