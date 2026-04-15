# GPU별 Ollama 병렬 실행

이 구성은 GPU 7개가 있는 서버에서 Ollama 인스턴스를 GPU마다 하나씩 띄웁니다.

llm-server의 기본 워커 DB 설정과 포트가 맞습니다.

| GPU | 컨테이너 | 호스트 포트 | llm_workers id |
| --- | --- | --- | --- |
| 0 | `ollama-gpu-0` | `11434` | `vilab-gpu-0` |
| 1 | `ollama-gpu-1` | `11435` | `vilab-gpu-1` |
| 2 | `ollama-gpu-2` | `11436` | `vilab-gpu-2` |
| 3 | `ollama-gpu-3` | `11437` | `vilab-gpu-3` |
| 4 | `ollama-gpu-4` | `11438` | `vilab-gpu-4` |
| 5 | `ollama-gpu-5` | `11439` | `vilab-gpu-5` |
| 6 | `ollama-gpu-6` | `11440` | `vilab-gpu-6` |

## 실행

```bash
cd /srv/terarium-llm-server/ops/ollama-gpu
docker compose -f docker-compose.7gpu.yml up -d
```

모델은 공유 볼륨 `terarium_ollama_models`에 한 번만 받습니다.

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

각 컨테이너는 `NVIDIA_VISIBLE_DEVICES`와 compose GPU reservation으로 서로 다른 GPU만 봅니다. 이렇게 해야 llm-server가 7개 워커에 요청을 분산할 때 실제 GPU 병렬성이 보장됩니다.

