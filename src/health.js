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

export async function checkWorkerHealth(worker) {
  if (worker.type === 'openai-compatible') {
    await fetchHealth(`${worker.baseUrl}/v1/models`, worker);
  } else {
    await fetchHealth(`${worker.baseUrl}/api/tags`, worker);
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
        healthStatus: worker.healthStatus,
        healthReason: worker.healthReason,
        lastHealthCheckAt: worker.lastHealthCheckAt,
        consecutiveFailures: worker.consecutiveFailures,
        consecutiveSuccesses: worker.consecutiveSuccesses
      }))
    };
  }
}

