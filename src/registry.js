import fs from 'node:fs';
import { config, ensureParentDir } from './config.js';

function normalizeWorker(raw) {
  const worker = {
    id: String(raw.id || '').trim(),
    name: String(raw.name || raw.id || '').trim(),
    type: String(raw.type || 'ollama').trim(),
    baseUrl: String(raw.baseUrl || '').replace(/\/+$/, ''),
    models: Array.isArray(raw.models) ? raw.models.map(String) : [],
    defaultModel: raw.defaultModel ? String(raw.defaultModel) : '',
    concurrency: Math.max(1, Number.parseInt(raw.concurrency, 10) || 1),
    enabled: raw.enabled !== false,
    apiKey: raw.apiKey ? String(raw.apiKey) : ''
  };

  if (!worker.id) throw new Error('worker.id is required');
  if (!worker.baseUrl) throw new Error(`worker ${worker.id} baseUrl is required`);
  if (!['ollama', 'openai-compatible'].includes(worker.type)) {
    throw new Error(`worker ${worker.id} type must be ollama or openai-compatible`);
  }
  return worker;
}

function publicWorker(worker, runtime = {}) {
  return {
    ...worker,
    apiKey: worker.apiKey ? '***' : '',
    active: runtime.active || 0,
    completed: runtime.completed || 0,
    failed: runtime.failed || 0,
    lastSuccessAt: runtime.lastSuccessAt || null,
    lastErrorAt: runtime.lastErrorAt || null,
    lastError: runtime.lastError || null
  };
}

export class WorkerRegistry {
  constructor(filePath = config.workerRegistryPath) {
    this.filePath = filePath;
    this.workers = [];
    this.runtime = new Map();
    this.load();
  }

  load() {
    ensureParentDir(this.filePath);
    if (!fs.existsSync(this.filePath)) {
      const examplePath = new URL('../data/workers.example.json', import.meta.url);
      fs.copyFileSync(examplePath, this.filePath);
    }

    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    this.workers = raw.map(normalizeWorker);
    for (const worker of this.workers) {
      if (!this.runtime.has(worker.id)) this.runtime.set(worker.id, { active: 0, completed: 0, failed: 0 });
    }
  }

  save() {
    ensureParentDir(this.filePath);
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.workers, null, 2)}\n`);
  }

  listPublic() {
    return this.workers.map((worker) => publicWorker(worker, this.runtime.get(worker.id)));
  }

  listEnabledForModel(model) {
    return this.workers.filter((worker) => {
      if (!worker.enabled) return false;
      if (!worker.models.length) return true;
      return worker.models.includes(model);
    });
  }

  get(id) {
    return this.workers.find((worker) => worker.id === id);
  }

  add(rawWorker) {
    const worker = normalizeWorker(rawWorker);
    if (this.get(worker.id)) throw new Error(`worker ${worker.id} already exists`);
    this.workers.push(worker);
    this.runtime.set(worker.id, { active: 0, completed: 0, failed: 0 });
    this.save();
    return publicWorker(worker, this.runtime.get(worker.id));
  }

  update(id, patch) {
    const index = this.workers.findIndex((worker) => worker.id === id);
    if (index < 0) throw new Error(`worker ${id} not found`);
    const merged = normalizeWorker({ ...this.workers[index], ...patch, id });
    this.workers[index] = merged;
    if (!this.runtime.has(id)) this.runtime.set(id, { active: 0, completed: 0, failed: 0 });
    this.save();
    return publicWorker(merged, this.runtime.get(id));
  }

  remove(id) {
    const index = this.workers.findIndex((worker) => worker.id === id);
    if (index < 0) throw new Error(`worker ${id} not found`);
    const [removed] = this.workers.splice(index, 1);
    this.runtime.delete(id);
    this.save();
    return publicWorker(removed);
  }

  markStart(id) {
    const stats = this.runtime.get(id) || { active: 0, completed: 0, failed: 0 };
    stats.active += 1;
    this.runtime.set(id, stats);
  }

  markSuccess(id) {
    const stats = this.runtime.get(id) || { active: 0, completed: 0, failed: 0 };
    stats.active = Math.max(0, stats.active - 1);
    stats.completed += 1;
    stats.lastSuccessAt = new Date().toISOString();
    stats.lastError = null;
    this.runtime.set(id, stats);
  }

  markFailure(id, error) {
    const stats = this.runtime.get(id) || { active: 0, completed: 0, failed: 0 };
    stats.active = Math.max(0, stats.active - 1);
    stats.failed += 1;
    stats.lastErrorAt = new Date().toISOString();
    stats.lastError = error?.message || String(error);
    this.runtime.set(id, stats);
  }

  getRuntime(id) {
    return this.runtime.get(id) || { active: 0, completed: 0, failed: 0 };
  }
}

