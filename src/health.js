import { config } from './config.js';

function abortSignal(timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

async function fetchHealth(url, worker) {
  const { signal, cancel } = abortSignal(config.healthcheck.timeoutMs);
  const headers = {};
  if (worker.apiKey) headers.Authorization = `Bearer ${worker.apiKey}`;

  try {
    const response = await fetch(url, { method: 'GET', headers, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return true;
  } finally {
    cancel();
  }
}

async function fetchJsonHealth(url, worker) {
  const { signal, cancel } = abortSignal(config.healthcheck.timeoutMs);
  const headers = {};
  if (worker.apiKey) headers.Authorization = `Bearer ${worker.apiKey}`;

  try {
    const response = await fetch(url, { method: 'GET', headers, signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  } finally {
    cancel();
  }
}

function ollamaTagNames(data) {
  if (!Array.isArray(data?.models)) return [];
  return data.models.flatMap((model) => [model.name, model.model]).filter(Boolean);
}

function hasExpectedModel(modelNames, expectedModel) {
  if (!expectedModel) return modelNames.length > 0;
  return modelNames.some(
    (name) => name === expectedModel || name.startsWith(`${expectedModel}:`) || expectedModel.startsWith(`${name}:`)
  );
}

export async function checkWorkerHealth(worker) {
  if (worker.type === 'openai-compatible') {
    await fetchHealth(`${worker.baseUrl}/v1/models`, worker);
  } else {
    const data = await fetchJsonHealth(`${worker.baseUrl}/api/tags`, worker);
    const expectedModel = String(worker.defaultModel || config.defaultModel || '').trim();
    const modelNames = ollamaTagNames(data);
    if (!hasExpectedModel(modelNames, expectedModel)) {
      const available = modelNames.length > 0 ? modelNames.join(', ') : 'none';
      throw new Error(`model ${expectedModel || '(any)'} not pulled; available: ${available}`);
    }
  }
  return { ok: true, reason: 'ok' };
}

export class WorkerHealthMonitor {
  constructor(registry, { onWorkerRecovered } = {}) {
    this.registry = registry;
    this.onWorkerRecovered = onWorkerRecovered || (() => {});
    this.timer = null;
    this.running = false;
  }

  start() {
    if (!config.healthcheck.enabled || this.timer) return;
    this.runOnce().catch((error) => console.error(`worker healthcheck failed: ${error.message}`));
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => console.error(`worker healthcheck failed: ${error.message}`));
    }, config.healthcheck.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      await Promise.all(this.registry.workers.map((worker) => this.checkAndPersist(worker)));
    } finally {
      this.running = false;
    }
  }

  async checkOne(id) {
    const worker = this.registry.get(id);
    if (!worker) throw new Error(`worker ${id} not found`);
    return this.checkAndPersist(worker);
  }

  async checkAndPersist(worker) {
    const previousStatus = worker.healthStatus;

    try {
      await checkWorkerHealth(worker);
      const consecutiveSuccesses = worker.consecutiveSuccesses + 1;
      const healthStatus =
        consecutiveSuccesses >= config.healthcheck.healthyAfterSuccesses ? 'healthy' : worker.healthStatus;
      const updated = await this.registry.updateHealth(worker.id, {
        healthStatus,
        healthReason: 'ok',
        consecutiveSuccesses,
        consecutiveFailures: 0
      });
      if (previousStatus === 'unhealthy' && updated.healthStatus === 'healthy') this.onWorkerRecovered(updated);
      return updated;
    } catch (error) {
      const consecutiveFailures = worker.consecutiveFailures + 1;
      const healthStatus =
        consecutiveFailures >= config.healthcheck.unhealthyAfterFailures ? 'unhealthy' : worker.healthStatus;
      return this.registry.updateHealth(worker.id, {
        healthStatus,
        healthReason: error.message || String(error),
        consecutiveSuccesses: 0,
        consecutiveFailures
      });
    }
  }

  status() {
    return {
      enabled: config.healthcheck.enabled,
      interval_ms: config.healthcheck.intervalMs,
      timeout_ms: config.healthcheck.timeoutMs,
      unhealthy_after_failures: config.healthcheck.unhealthyAfterFailures,
      healthy_after_successes: config.healthcheck.healthyAfterSuccesses,
      workers: this.registry.listPublic().map((worker) => ({
        id: worker.id,
        name: worker.name,
        enabled: worker.enabled,
        available: worker.available,
        concurrency: worker.concurrency,
        active: worker.active,
        completed: worker.completed,
        failed: worker.failed,
        avgDurationMs: worker.avgDurationMs,
        lastDurationMs: worker.lastDurationMs,
        lastSuccessAt: worker.lastSuccessAt,
        lastErrorAt: worker.lastErrorAt,
        lastError: worker.lastError,
        healthStatus: worker.healthStatus,
        healthReason: worker.healthReason,
        lastHealthCheckAt: worker.lastHealthCheckAt,
        consecutiveFailures: worker.consecutiveFailures,
        consecutiveSuccesses: worker.consecutiveSuccesses
      }))
    };
  }
}
