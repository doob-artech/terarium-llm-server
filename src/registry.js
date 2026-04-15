import fs from 'node:fs';
import { Pool } from 'pg';
import { config, ensureParentDir } from './config.js';

export function normalizeWorker(raw) {
  const worker = {
    id: String(raw.id || '').trim(),
    name: String(raw.name || raw.id || '').trim(),
    type: String(raw.type || 'ollama').trim(),
    baseUrl: String(raw.baseUrl || raw.base_url || '').replace(/\/+$/, ''),
    models: Array.isArray(raw.models) ? raw.models.map(String) : [],
    defaultModel: raw.defaultModel || raw.default_model ? String(raw.defaultModel || raw.default_model) : '',
    concurrency: Math.max(1, Number.parseInt(raw.concurrency, 10) || 1),
    enabled: raw.enabled !== false,
    apiKey: raw.apiKey || raw.api_key ? String(raw.apiKey || raw.api_key) : ''
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

function seedWorkersFromExample() {
  const examplePath = new URL('../data/workers.example.json', import.meta.url);
  return JSON.parse(fs.readFileSync(examplePath, 'utf8')).map(normalizeWorker);
}

class BaseWorkerRegistry {
  constructor() {
    this.workers = [];
    this.runtime = new Map();
  }

  ensureRuntime(worker) {
    if (!this.runtime.has(worker.id)) this.runtime.set(worker.id, { active: 0, completed: 0, failed: 0 });
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

class FileWorkerRegistry extends BaseWorkerRegistry {
  constructor(filePath = config.workerRegistryPath) {
    super();
    this.filePath = filePath;
  }

  async init() {
    ensureParentDir(this.filePath);
    if (!fs.existsSync(this.filePath)) {
      const examplePath = new URL('../data/workers.example.json', import.meta.url);
      fs.copyFileSync(examplePath, this.filePath);
    }

    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    this.workers = raw.map(normalizeWorker);
    for (const worker of this.workers) this.ensureRuntime(worker);
  }

  save() {
    ensureParentDir(this.filePath);
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.workers, null, 2)}\n`);
  }

  async add(rawWorker) {
    const worker = normalizeWorker(rawWorker);
    if (this.get(worker.id)) throw new Error(`worker ${worker.id} already exists`);
    this.workers.push(worker);
    this.ensureRuntime(worker);
    this.save();
    return publicWorker(worker, this.runtime.get(worker.id));
  }

  async update(id, patch) {
    const index = this.workers.findIndex((worker) => worker.id === id);
    if (index < 0) throw new Error(`worker ${id} not found`);
    const merged = normalizeWorker({ ...this.workers[index], ...patch, id });
    this.workers[index] = merged;
    this.ensureRuntime(merged);
    this.save();
    return publicWorker(merged, this.runtime.get(id));
  }

  async remove(id) {
    const index = this.workers.findIndex((worker) => worker.id === id);
    if (index < 0) throw new Error(`worker ${id} not found`);
    const [removed] = this.workers.splice(index, 1);
    this.runtime.delete(id);
    this.save();
    return publicWorker(removed);
  }
}

class PostgresWorkerRegistry extends BaseWorkerRegistry {
  constructor(pgConfig = config.postgres) {
    super();
    this.pool = new Pool({
      host: pgConfig.host,
      port: pgConfig.port,
      database: pgConfig.database,
      user: pgConfig.user,
      password: pgConfig.password,
      ssl: pgConfig.ssl ? { rejectUnauthorized: false } : false
    });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS llm_workers (
        id text PRIMARY KEY,
        name text NOT NULL,
        type text NOT NULL CHECK (type IN ('ollama', 'openai-compatible')),
        base_url text NOT NULL,
        models jsonb NOT NULL DEFAULT '[]'::jsonb,
        default_model text NOT NULL DEFAULT '',
        concurrency integer NOT NULL DEFAULT 1 CHECK (concurrency > 0),
        enabled boolean NOT NULL DEFAULT true,
        api_key text NOT NULL DEFAULT '',
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);

    const count = await this.pool.query('SELECT count(*)::int AS count FROM llm_workers');
    if (count.rows[0].count === 0) {
      for (const worker of seedWorkersFromExample()) {
        await this.upsert(worker);
      }
    }

    await this.reload();
  }

  async reload() {
    const result = await this.pool.query(`
      SELECT id, name, type, base_url, models, default_model, concurrency, enabled, api_key
      FROM llm_workers
      ORDER BY id
    `);
    this.workers = result.rows.map(normalizeWorker);
    for (const worker of this.workers) this.ensureRuntime(worker);
  }

  async upsert(worker) {
    await this.pool.query(
      `
        INSERT INTO llm_workers
          (id, name, type, base_url, models, default_model, concurrency, enabled, api_key, updated_at)
        VALUES
          ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, now())
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          base_url = excluded.base_url,
          models = excluded.models,
          default_model = excluded.default_model,
          concurrency = excluded.concurrency,
          enabled = excluded.enabled,
          api_key = excluded.api_key,
          updated_at = now()
      `,
      [
        worker.id,
        worker.name,
        worker.type,
        worker.baseUrl,
        JSON.stringify(worker.models),
        worker.defaultModel,
        worker.concurrency,
        worker.enabled,
        worker.apiKey
      ]
    );
  }

  async add(rawWorker) {
    const worker = normalizeWorker(rawWorker);
    if (this.get(worker.id)) throw new Error(`worker ${worker.id} already exists`);
    await this.upsert(worker);
    await this.reload();
    return publicWorker(worker, this.runtime.get(worker.id));
  }

  async update(id, patch) {
    const existing = this.get(id);
    if (!existing) throw new Error(`worker ${id} not found`);
    const worker = normalizeWorker({ ...existing, ...patch, id });
    await this.upsert(worker);
    await this.reload();
    return publicWorker(worker, this.runtime.get(id));
  }

  async remove(id) {
    const existing = this.get(id);
    if (!existing) throw new Error(`worker ${id} not found`);
    await this.pool.query('DELETE FROM llm_workers WHERE id = $1', [id]);
    this.workers = this.workers.filter((worker) => worker.id !== id);
    this.runtime.delete(id);
    return publicWorker(existing);
  }

  async close() {
    await this.pool.end();
  }
}

export function createWorkerRegistry() {
  if (config.workerRegistryBackend === 'postgres') return new PostgresWorkerRegistry();
  if (config.workerRegistryBackend === 'file') return new FileWorkerRegistry();
  throw new Error(`Unsupported WORKER_REGISTRY_BACKEND: ${config.workerRegistryBackend}`);
}

