import { config } from './config.js';

function nowMs() {
  return Date.now();
}

function heartbeatAgeMs(instance) {
  if (!instance?.lastHeartbeatAt) return Number.POSITIVE_INFINITY;
  return Math.max(0, nowMs() - new Date(instance.lastHeartbeatAt).getTime());
}

function instanceWorkerKey(instance) {
  return instance.providerInstanceId || instance.id;
}

export class InstanceMonitor {
  constructor({ instances, workers, healthMonitor, queue }) {
    this.instances = instances;
    this.workers = workers;
    this.healthMonitor = healthMonitor;
    this.queue = queue;
    this.timer = null;
    this.running = false;
    this.events = [];
  }

  start() {
    if (!config.instances.enabled || this.timer) return;
    this.runOnce().catch((error) => this.record('error', error.message || String(error)));
    this.timer = setInterval(() => {
      this.runOnce().catch((error) => this.record('error', error.message || String(error)));
    }, config.instances.intervalMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  record(type, message, details = {}) {
    const event = { at: new Date().toISOString(), type, message, details };
    this.events.unshift(event);
    this.events = this.events.slice(0, 50);
    return event;
  }

  relatedWorkers(instance) {
    const key = instanceWorkerKey(instance);
    return this.workers.listPublic().filter((worker) => worker.providerInstanceId === key);
  }

  async evaluate(instance) {
    const ageMs = heartbeatAgeMs(instance);
    const workers = this.relatedWorkers(instance);
    let healthStatus = 'healthy';
    let healthReason = 'ok';

    if (ageMs > config.instances.cleanupAfterMs) {
      healthStatus = 'stale';
      healthReason = `heartbeat older than ${config.instances.cleanupAfterMs}ms`;
    } else if (ageMs > config.instances.staleAfterMs) {
      healthStatus = 'stale';
      healthReason = `heartbeat older than ${config.instances.staleAfterMs}ms`;
    } else if (!workers.length) {
      healthStatus = 'unhealthy';
      healthReason = 'no registered workers';
    } else if (workers.every((worker) => worker.healthStatus === 'unhealthy' || !worker.available)) {
      healthStatus = 'unhealthy';
      healthReason = 'all workers unhealthy';
    }

    return this.instances.updateHealth(instance.id, { healthStatus, healthReason });
  }

  async cleanup(instance) {
    const workers = this.relatedWorkers(instance);
    const key = instanceWorkerKey(instance);

    if (config.instances.cleanupRemovesWorkers) {
      for (const worker of workers) {
        await this.workers.remove(worker.id).catch(() => null);
      }
    } else if (config.instances.deregisterMissingWorkers) {
      for (const worker of workers) {
        await this.workers.update(worker.id, { enabled: false, healthReason: `instance ${key} cleaned up` }).catch(() => null);
      }
    }

    await this.instances.remove(instance.id).catch(() => null);
    this.record('instance_cleaned', 'cleaned stale instance', {
      instanceId: instance.id,
      providerInstanceId: instance.providerInstanceId,
      workerIds: workers.map((worker) => worker.id)
    });
    this.queue.pump();
  }

  async runOnce() {
    if (this.running) return;
    this.running = true;
    try {
      const snapshot = [...this.instances.listPublic()];
      for (const instance of snapshot) {
        const updated = await this.evaluate(instance);
        if (heartbeatAgeMs(updated) > config.instances.cleanupAfterMs) {
          await this.cleanup(updated);
        }
      }
    } finally {
      this.running = false;
    }
  }

  status() {
    return {
      enabled: config.instances.enabled,
      interval_ms: config.instances.intervalMs,
      stale_after_ms: config.instances.staleAfterMs,
      cleanup_after_ms: config.instances.cleanupAfterMs,
      instances: this.instances.listPublic().map((instance) => ({
        ...instance,
        heartbeatAgeMs: Number.isFinite(heartbeatAgeMs(instance)) ? heartbeatAgeMs(instance) : null,
        workerCount: this.relatedWorkers(instance).length
      })),
      events: this.events
    };
  }
}
