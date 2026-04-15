import { config } from './config.js';
import { callWorker } from './upstreams.js';

export class LlmQueue {
  constructor(registry) {
    this.registry = registry;
    this.pending = [];
    this.running = new Map();
    this.completed = 0;
    this.failed = 0;
    this.lastSuccessAt = null;
    this.lastErrorAt = null;
    this.lastError = null;
    this.samples = [];
  }

  enqueueChatCompletion(body) {
    const model = body.model || config.defaultModel;
    const request = {
      id: `llm_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      model,
      body: { ...body, model },
      enqueuedAt: new Date().toISOString()
    };

    const promise = new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
    });

    this.pending.push(request);
    this.pump();
    return promise;
  }

  chooseWorker(model) {
    const workers = this.registry.listEnabledForModel(model);
    let best = null;
    let bestLoad = Number.POSITIVE_INFINITY;

    for (const worker of workers) {
      const runtime = this.registry.getRuntime(worker.id);
      if (runtime.active >= worker.concurrency) continue;

      const load = runtime.active / worker.concurrency;
      if (load < bestLoad) {
        best = worker;
        bestLoad = load;
      }
    }

    return best;
  }

  pump() {
    let scheduled = false;

    for (let index = 0; index < this.pending.length; index += 1) {
      const request = this.pending[index];
      const worker = this.chooseWorker(request.model);
      if (!worker) continue;

      this.pending.splice(index, 1);
      index -= 1;
      this.runRequest(worker, request);
      scheduled = true;
    }

    return scheduled;
  }

  async runRequest(worker, request) {
    this.registry.markStart(worker.id);
    this.running.set(request.id, {
      id: request.id,
      model: request.model,
      workerId: worker.id,
      startedAt: new Date().toISOString()
    });

    try {
      const response = await callWorker(worker, request.body);
      this.registry.markSuccess(worker.id);
      this.completed += 1;
      this.lastSuccessAt = new Date().toISOString();
      request.resolve(response);
    } catch (error) {
      this.registry.markFailure(worker.id, error);
      this.failed += 1;
      this.lastErrorAt = new Date().toISOString();
      this.lastError = error?.message || String(error);
      request.reject(error);
    } finally {
      this.running.delete(request.id);
      setImmediate(() => this.pump());
    }
  }

  status() {
    return {
      default_model: config.defaultModel,
      timeout_ms: config.requestTimeoutMs,
      pending: this.pending.length,
      running: this.running.size,
      completed: this.completed,
      failed: this.failed,
      last_success_at: this.lastSuccessAt,
      last_error_at: this.lastErrorAt,
      last_error: this.lastError,
      running_requests: Array.from(this.running.values()),
      pending_requests: this.pending.map((request) => ({
        id: request.id,
        model: request.model,
        enqueuedAt: request.enqueuedAt
      }))
    };
  }

  sample() {
    const now = Date.now();
    const item = {
      at: new Date(now).toISOString(),
      atMs: now,
      pending: this.pending.length,
      running: this.running.size,
      capacity: this.registry.listPublic().reduce((sum, worker) => {
        if (!worker.available) return sum;
        return sum + Number(worker.concurrency || 0);
      }, 0)
    };
    this.samples.push(item);
    this.samples = this.samples.filter((sample) => now - sample.atMs <= 10 * 60 * 1000);
    return item;
  }

  recentSamples(windowMs) {
    const cutoff = Date.now() - windowMs;
    return this.samples.filter((sample) => sample.atMs >= cutoff);
  }
}
