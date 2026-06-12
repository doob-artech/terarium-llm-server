import express from 'express';
import { config } from './config.js';
import { requireAdminKey, requireClientKey, requireInstanceKey } from './auth.js';
import { createWorkerRegistry } from './registry.js';
import { createInstanceRegistry, normalizeInstance } from './instance-registry.js';
import { LlmQueue } from './queue.js';
import { WorkerHealthMonitor } from './health.js';
import { Autoscaler } from './autoscaler.js';
import { InstanceMonitor } from './instance-monitor.js';

const app = express();
const registry = createWorkerRegistry();
await registry.init();
const instances = createInstanceRegistry();
await instances.init();
const queue = new LlmQueue(registry);
const healthMonitor = new WorkerHealthMonitor(registry, { onWorkerRecovered: () => queue.pump() });
const autoscaler = new Autoscaler({ queue, registry, healthMonitor, instances });
const instanceMonitor = new InstanceMonitor({ instances, workers: registry, healthMonitor, queue });

app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (origin && config.corsAllowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
});

app.use(express.json({ limit: '2mb' }));

function instanceWorkerKey(instance) {
  return instance.providerInstanceId || instance.id;
}

function pickDefined(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

function resolveWorkerBaseUrl(instance, worker, index) {
  if (worker.baseUrl || worker.base_url) return String(worker.baseUrl || worker.base_url).replace(/\/+$/, '');
  const instanceBase = String(instance.publicBaseUrl || instance.public_base_url || '').replace(/\/+$/, '');
  if (!instanceBase) throw new Error('worker.baseUrl or instance.publicBaseUrl is required');
  if (worker.routePath || worker.route_path) {
    const routePath = String(worker.routePath || worker.route_path).replace(/^\/+/, '');
    return `${instanceBase}/${routePath}`;
  }
  if (worker.gpuIndex !== undefined || worker.gpu_index !== undefined) {
    if (Number(instance.gpuCount || 0) <= 1) return instanceBase;
    return `${instanceBase}/gpu/${Number.parseInt(pickDefined(worker.gpuIndex, worker.gpu_index), 10) || 0}`;
  }
  if (index > 0) return `${instanceBase}/gpu/${index}`;
  return instanceBase;
}

async function registerInstancePayload(payload) {
  const instance = normalizeInstance({
    ...(payload.instance || {}),
    lastHeartbeatAt: new Date().toISOString()
  });
  const key = instanceWorkerKey(instance);
  const registeredInstance = await instances.register(instance);
  const requestedWorkers =
    Array.isArray(payload.workers) && payload.workers.length
      ? payload.workers
      : Array.from({ length: Math.max(1, registeredInstance.gpuCount || 1) }, (_, gpuIndex) => ({
          gpuIndex,
          type: 'ollama',
          models: [config.defaultModel],
          defaultModel: config.defaultModel,
          concurrency: 1
        }));
  const workerIds = [];

  for (let index = 0; index < requestedWorkers.length; index += 1) {
    const worker = requestedWorkers[index] || {};
    const gpuIndex = Number.parseInt(pickDefined(worker.gpuIndex, worker.gpu_index), 10);
    const workerId =
      String(worker.id || '').trim() ||
      `${registeredInstance.id}-${Number.isFinite(gpuIndex) ? `gpu${gpuIndex}` : `worker${index}`}`;
    const normalized = {
      id: workerId,
      name:
        String(worker.name || '').trim() ||
        `${registeredInstance.label || registeredInstance.id} ${Number.isFinite(gpuIndex) ? `GPU ${gpuIndex}` : `Worker ${index}`}`,
      type: worker.type || 'ollama',
      baseUrl: resolveWorkerBaseUrl(registeredInstance, worker, index),
      models: Array.isArray(worker.models) && worker.models.length ? worker.models : [config.defaultModel],
      defaultModel: worker.defaultModel || worker.default_model || config.defaultModel,
      concurrency: worker.concurrency || 1,
      enabled: worker.enabled !== false,
      apiKey: worker.apiKey || worker.api_key || '',
      provider: registeredInstance.provider,
      providerInstanceId: key,
      autoscaled: registeredInstance.autoscaled
    };

    if (registry.get(workerId)) await registry.update(workerId, normalized);
    else await registry.add(normalized);
    workerIds.push(workerId);
  }

  if (config.instances.deregisterMissingWorkers) {
    for (const existing of registry.listPublic().filter((worker) => worker.providerInstanceId === key)) {
      if (workerIds.includes(existing.id)) continue;
      await registry.remove(existing.id).catch(() => null);
    }
  }

  await healthMonitor.runOnce().catch(() => null);
  queue.pump();
  return {
    instance: registeredInstance,
    workers: registry.listPublic().filter((worker) => worker.providerInstanceId === key)
  };
}

app.get('/health', (req, res) => {
  res.json({
    ok: true,
    service: 'terarium-llm-server',
    default_model: config.defaultModel,
    workers: registry.listPublic().length,
    worker_pools: registry.poolStatus(),
    instances: instances.listPublic().length,
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

app.get('/v1/public/status', (req, res) => {
  res.json({
    ok: true,
    queue: queue.status(),
    health: healthMonitor.status(),
    autoscale: autoscaler.status(),
    instances: instanceMonitor.status()
  });
});

app.get('/v1/queue/status', requireAdminKey, (req, res) => {
  res.json(queue.status());
});

app.get('/v1/autoscale/status', requireAdminKey, (req, res) => {
  res.json(autoscaler.status());
});

app.patch('/v1/autoscale/settings', requireAdminKey, async (req, res) => {
  try {
    const enabled = req.body?.enabled === true;
    const destroyCapacity = req.body?.destroyCapacity !== false;
    res.json({ ok: true, autoscale: await autoscaler.setEnabled(enabled, { destroyCapacity }) });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'autoscale_settings_failed' } });
  }
});

app.post('/v1/autoscale/tick', requireAdminKey, async (req, res) => {
  try {
    res.json(await autoscaler.tick());
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'autoscale_failed' } });
  }
});

app.post('/v1/autoscale/reset', requireAdminKey, async (req, res) => {
  try {
    res.json({ ok: true, ...(await autoscaler.resetAutoscaledCapacity()) });
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'autoscale_reset_failed' } });
  }
});

app.get('/v1/workers', requireAdminKey, (req, res) => {
  res.json({ workers: registry.listPublic() });
});

app.get('/v1/instances', requireAdminKey, (req, res) => {
  res.json(instanceMonitor.status());
});

app.post('/v1/instances/register', requireInstanceKey, async (req, res) => {
  try {
    const result = await registerInstancePayload(req.body || {});
    res.status(201).json(result);
  } catch (error) {
    res.status(400).json({ error: { message: error.message, type: 'invalid_instance' } });
  }
});

app.post('/v1/instances/:id/heartbeat', requireInstanceKey, async (req, res) => {
  try {
    const existing = instances.get(req.params.id);
    if (!existing) throw new Error(`instance ${req.params.id} not found`);
    const updated = await instances.heartbeat(req.params.id, req.body || {});
    queue.pump();
    res.json(updated);
  } catch (error) {
    res.status(404).json({ error: { message: error.message, type: 'instance_not_found' } });
  }
});

app.post('/v1/instances/:id/deregister', requireInstanceKey, async (req, res) => {
  try {
    const instance = instances.get(req.params.id);
    if (!instance) throw new Error(`instance ${req.params.id} not found`);
    const key = instanceWorkerKey(instance);
    for (const worker of registry.listPublic().filter((item) => item.providerInstanceId === key)) {
      await registry.remove(worker.id).catch(() => null);
    }
    await instances.remove(req.params.id);
    queue.pump();
    res.json({ ok: true, id: req.params.id });
  } catch (error) {
    res.status(404).json({ error: { message: error.message, type: 'instance_not_found' } });
  }
});

app.get('/v1/workers/health', requireAdminKey, (req, res) => {
  res.json(healthMonitor.status());
});

app.post('/v1/workers/health/check', requireAdminKey, async (req, res) => {
  try {
    await healthMonitor.runOnce();
    queue.pump();
    res.json(healthMonitor.status());
  } catch (error) {
    res.status(500).json({ error: { message: error.message, type: 'healthcheck_failed' } });
  }
});

app.post('/v1/workers/:id/health/check', requireAdminKey, async (req, res) => {
  try {
    const worker = await healthMonitor.checkOne(req.params.id);
    queue.pump();
    res.json(worker);
  } catch (error) {
    res.status(404).json({ error: { message: error.message, type: 'healthcheck_failed' } });
  }
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
  console.log(`worker healthcheck: ${config.healthcheck.enabled ? 'enabled' : 'disabled'}`);
  console.log(`instance monitor: ${config.instances.enabled ? 'enabled' : 'disabled'}`);
  healthMonitor.start();
  autoscaler.start();
  instanceMonitor.start();
});

async function shutdown() {
  healthMonitor.stop();
  autoscaler.stop();
  instanceMonitor.stop();
  server.close(async () => {
    if (registry.close) await registry.close();
    if (instances.close) await instances.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
