import express from 'express';
import { config } from './config.js';
import { requireAdminKey, requireClientKey } from './auth.js';
import { createWorkerRegistry } from './registry.js';
import { LlmQueue } from './queue.js';

const app = express();
const registry = createWorkerRegistry();
await registry.init();
const queue = new LlmQueue(registry);

app.use(express.json({ limit: '2mb' }));

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'terarium-llm-server',
    default_model: config.defaultModel,
    workers: registry.listPublic().length,
    queue: {
      pending: queue.status().pending,
      running: queue.status().running
    }
  });
});

app.post('/v1/chat/completions', requireClientKey, async (req, res) => {
  try {
    if (!Array.isArray(req.body?.messages)) {
      return res.status(400).json({
        error: {
          message: 'messages array is required',
          type: 'invalid_request_error'
        }
      });
    }

    const response = await queue.enqueueChatCompletion(req.body);
    return res.json(response);
  } catch (error) {
    return res.status(error.status || 502).json({
      error: {
        message: error.message || 'LLM request failed',
        type: 'upstream_error'
      }
    });
  }
});

app.get('/v1/models', requireClientKey, (req, res) => {
  const models = new Set([config.defaultModel]);
  for (const worker of registry.listPublic()) {
    for (const model of worker.models || []) models.add(model);
  }
  res.json({
    object: 'list',
    data: Array.from(models).map((id) => ({ id, object: 'model', owned_by: 'terarium' }))
  });
});

app.get('/v1/queue/status', requireAdminKey, (req, res) => {
  res.json(queue.status());
});

app.get('/v1/workers', requireAdminKey, (req, res) => {
  res.json({ workers: registry.listPublic() });
});

app.post('/v1/workers', requireAdminKey, async (req, res) => {
  try {
    const worker = await registry.add(req.body);
    queue.pump();
    res.status(201).json(worker);
  } catch (error) {
    res.status(400).json({ error: { message: error.message, type: 'invalid_worker' } });
  }
});

app.patch('/v1/workers/:id', requireAdminKey, async (req, res) => {
  try {
    const worker = await registry.update(req.params.id, req.body);
    queue.pump();
    res.json(worker);
  } catch (error) {
    res.status(400).json({ error: { message: error.message, type: 'invalid_worker' } });
  }
});

app.delete('/v1/workers/:id', requireAdminKey, async (req, res) => {
  try {
    const worker = await registry.remove(req.params.id);
    res.json(worker);
  } catch (error) {
    res.status(404).json({ error: { message: error.message, type: 'not_found' } });
  }
});

app.use((err, req, res, next) => {
  if (err?.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { message: 'Invalid JSON body', type: 'invalid_request_error' } });
  }
  return next(err);
});

const server = app.listen(config.port, config.host, () => {
  console.log(`terarium-llm-server listening on ${config.host}:${config.port}`);
  console.log(`default model: ${config.defaultModel}`);
  console.log(`worker registry backend: ${config.workerRegistryBackend}`);
  if (config.workerRegistryBackend === 'file') console.log(`worker registry: ${config.workerRegistryPath}`);
});

async function shutdown() {
  server.close(async () => {
    if (registry.close) await registry.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
