import { config } from './config.js';
import { callWorker } from './upstreams.js';

const PRIORITY_SCORES = new Map([
  ['interactive', 100],
  ['user', 100],
  ['tutorial', 100],
  ['urgent', 100],
  ['high', 50],
  ['normal', 0],
  ['default', 0],
  ['low', -50],
  ['background', -100]
]);

function normalizePriority(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return {
      label: String(value),
      score: Math.max(-100, Math.min(100, Math.round(value)))
    };
  }
  const label = String(value || 'normal').trim().toLowerCase();
  return {
    label: PRIORITY_SCORES.has(label) ? label : 'normal',
    score: PRIORITY_SCORES.get(label) ?? 0
  };
}

function normalizeStartTimeoutMs(value) {
  if (value === undefined || value === null || value === '') return 0;
  const timeoutMs = Math.round(Number(value));
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return 0;
  return Math.max(1000, Math.min(timeoutMs, 30 * 60 * 1000));
}

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
    this.recentDurations = [];
    this.sequence = 0;
  }

  enqueueChatCompletion(body) {
    const model = body.model || config.defaultModel;
    const priority = normalizePriority(body.queue_priority ?? body.priority);
    const source = String(body.queue_source || body.request_source || '').trim().slice(0, 120);
    const workerPool = String(body.queue_worker_pool || body.worker_pool || '').trim().slice(0, 80);
    const startTimeoutMs = normalizeStartTimeoutMs(body.queue_start_timeout_ms);
    const {
      queue_priority,
      priority: _priority,
      queue_source,
      request_source,
      queue_worker_pool,
      worker_pool,
      queue_start_timeout_ms,
      ...workerBody
    } = body;
    const request = {
      id: `llm_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      model,
      body: { ...workerBody, model },
      enqueuedAt: new Date().toISOString(),
      priority: priority.score,
      priorityLabel: priority.label,
      workerPool,
      source,
      startTimeoutMs,
      sequence: this.sequence++
    };

    const promise = new Promise((resolve, reject) => {
      request.resolve = resolve;
      request.reject = reject;
    });

    if (startTimeoutMs > 0) {
      request.startTimeoutHandle = setTimeout(() => {
        this.expirePendingRequest(request.id);
      }, startTimeoutMs);
    }

    this.pending.push(request);
    this.pending.sort((a, b) => b.priority - a.priority || a.sequence - b.sequence);
    this.pump();
    return promise;
  }

  clearStartTimeout(request) {
    if (request?.startTimeoutHandle) {
      clearTimeout(request.startTimeoutHandle);
      request.startTimeoutHandle = null;
    }
  }

  expirePendingRequest(requestId) {
    const index = this.pending.findIndex((request) => request.id === requestId);
    if (index === -1) return false;
    const [request] = this.pending.splice(index, 1);
    this.clearStartTimeout(request);
    this.failed += 1;
    this.lastErrorAt = new Date().toISOString();
    this.lastError = `queue start timeout after ${request.startTimeoutMs}ms before worker assignment`;
    request.reject(new Error(this.lastError));
    return true;
  }

  chooseWorker(model, workerPool = '') {
    const workers = this.registry.listEnabledForModel(model, workerPool);
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
      const worker = this.chooseWorker(request.model, request.workerPool);
      if (!worker) continue;

      this.pending.splice(index, 1);
      this.clearStartTimeout(request);
      index -= 1;
      this.runRequest(worker, request);
      scheduled = true;
    }

    return scheduled;
  }

  async runRequest(worker, request) {
    const startedAtMs = Date.now();
    this.registry.markStart(worker.id);
    this.running.set(request.id, {
      id: request.id,
      model: request.model,
      workerId: worker.id,
      startedAt: new Date(startedAtMs).toISOString(),
      priority: request.priorityLabel,
      workerPool: request.workerPool || '',
      source: request.source
    });

    try {
      const response = await callWorker(worker, request.body);
      const durationMs = Date.now() - startedAtMs;
      this.recordDuration(durationMs);
      this.registry.markSuccess(worker.id, durationMs);
      this.completed += 1;
      this.lastSuccessAt = new Date().toISOString();
      request.resolve(response);
    } catch (error) {
      const durationMs = Date.now() - startedAtMs;
      this.recordDuration(durationMs);
      this.registry.markFailure(worker.id, error, durationMs);
      this.failed += 1;
      this.lastErrorAt = new Date().toISOString();
      this.lastError = error?.message || String(error);
      request.reject(error);
    } finally {
      this.running.delete(request.id);
      setImmediate(() => this.pump());
    }
  }

  recordDuration(durationMs) {
    const value = Math.max(0, Math.round(Number(durationMs) || 0));
    this.recentDurations.push({ atMs: Date.now(), durationMs: value });
    const cutoff = Date.now() - 10 * 60 * 1000;
    this.recentDurations = this.recentDurations.filter((item) => item.atMs >= cutoff).slice(-500);
  }

  durationStats(windowMs = 5 * 60 * 1000) {
    const cutoff = Date.now() - windowMs;
    const items = this.recentDurations.filter((item) => item.atMs >= cutoff);
    const count = items.length;
    const avgMs = count ? Math.round(items.reduce((sum, item) => sum + item.durationMs, 0) / count) : 0;
    return { count, avg_ms: avgMs };
  }

  status() {
    const duration = this.durationStats();
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
      avg_duration_ms: duration.avg_ms,
      duration_sample_count: duration.count,
      running_requests: Array.from(this.running.values()),
      pending_requests: this.pending.map((request) => ({
        id: request.id,
        model: request.model,
        enqueuedAt: request.enqueuedAt,
        priority: request.priorityLabel,
        workerPool: request.workerPool || '',
        source: request.source,
        startTimeoutMs: request.startTimeoutMs
      }))
    };
  }

  sample() {
    const now = Date.now();
    const capacity = this.registry.listPublic().reduce((sum, worker) => {
      if (!worker.available) return sum;
      return sum + Number(worker.concurrency || 0);
    }, 0);
    const duration = this.durationStats();
    const item = {
      at: new Date(now).toISOString(),
      atMs: now,
      pending: this.pending.length,
      running: this.running.size,
      capacity,
      utilization: capacity > 0 ? this.running.size / capacity : 0,
      avgDurationMs: duration.avg_ms,
      durationSampleCount: duration.count
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
