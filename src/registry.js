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
    apiKey: raw.apiKey || raw.api_key ? String(raw.apiKey || raw.api_key) : '',
    healthStatus: raw.healthStatus || raw.health_status ? String(raw.healthStatus || raw.health_status) : 'unknown',
    healthReason: raw.healthReason || raw.health_reason ? String(raw.healthReason || raw.health_reason) : '',
    lastHealthCheckAt:
      raw.lastHealthCheckAt || raw.last_health_check_at
        ? new Date(raw.lastHealthCheckAt || raw.last_health_check_at).toISOString()
        : null,
    consecutiveFailures: Number.parseInt(raw.consecutiveFailures || raw.consecutive_failures, 10) || 0,
    consecutiveSuccesses: Number.parseInt(raw.consecutiveSuccesses || raw.consecutive_successes, 10) || 0,
    provider: raw.provider ? String(raw.provider) : '',
    providerInstanceId: raw.providerInstanceId || raw.provider_instance_id ? String(raw.providerInstanceId || raw.provider_instance_id) : '',
    autoscaled: raw.autoscaled === true || raw.autoscaled === 'true'
  };

  if (!worker.id) throw new Error('worker.id is required');
  if (!worker.baseUrl) throw new Error(`worker ${worker.id} baseUrl is required`);
  if (!['ollama', 'openai-compatible'].includes(worker.type)) {
    throw new Error(`worker ${worker.id} type must be ollama or openai-compatible`);
  }
  if (!['unknown', 'healthy', 'unhealthy'].includes(worker.healthStatus)) {
    worker.healthStatus = 'unknown';
  }
  return worker;
}

function publicWorker(worker, runtime = {}) {
  const completed = runtime.completed || 0;
  const failed = runtime.failed || 0;
  const totalFinished = completed + failed;
  const totalDurationMs = runtime.totalDurationMs || 0;
  return {
    ...worker,
    apiKey: worker.apiKey ? '***' : '',
    active: runtime.active || 0,
    completed,
    failed,
    totalDurationMs,
    avgDurationMs: totalFinished > 0 ? Math.round(totalDurationMs / totalFinished) : 0,
    lastDurationMs: runtime.lastDurationMs || 0,
    lastSuccessAt: runtime.lastSuccessAt || null,
    lastErrorAt: runtime.lastErrorAt || null,
    lastError: runtime.lastError || null,
    available: worker.enabled && worker.healthStatus === 'healthy'
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
    if (!this.runtime.has(worker.id)) this.runtime.set(worker.id, { active: 0, completed: 0, failed: 0, totalDurationMs: 0, lastDurationMs: 0 });
  }

  listPublic() {
    return this.workers.map((worker) => publicWorker(worker, this.runtime.get(worker.id)));
  }

  listEnabledForModel(model) {
    return this.workers.filter((worker) => {
      if (!worker.enabled) return false;
      if (worker.healthStatus !== 'healthy') return false;
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

  markSuccess(id, durationMs = 0) {
    const stats = this.runtime.get(id) || { active: 0, completed: 0, failed: 0, totalDurationMs: 0, lastDurationMs: 0 };
    stats.active = Math.max(0, stats.active - 1);
    stats.completed += 1;
    stats.lastDurationMs = Math.max(0, Math.round(Number(durationMs) || 0));
    stats.totalDurationMs = Math.max(0, Math.round(Number(stats.totalDurationMs || 0) + stats.lastDurationMs));
    stats.lastSuccessAt = new Date().toISOString();
    stats.lastError = null;
    this.runtime.set(id, stats);
  }

  markFailure(id, error, durationMs = 0) {
    const stats = this.runtime.get(id) || { active: 0, completed: 0, failed: 0, totalDurationMs: 0, lastDurationMs: 0 };
    stats.active = Math.max(0, stats.active - 1);
    stats.failed += 1;
    stats.lastDurationMs = Math.max(0, Math.round(Number(durationMs) || 0));
    stats.totalDurationMs = Math.max(0, Math.round(Number(stats.totalDurationMs || 0) + stats.lastDurationMs));
    stats.lastErrorAt = new Date().toISOString();
    stats.lastError = error?.message || String(error);
    this.runtime.set(id, stats);
  }

  getRuntime(id) {
    return this.runtime.get(id) || { active: 0, completed: 0, failed: 0 };
  }

  applyHealth(id, patch) {
    const worker = this.get(id);
    if (!worker) throw new Error(`worker ${id} not found`);
    Object.assign(worker, patch, { lastHealthCheckAt: new Date().toISOString() });
    this.ensureRuntime(worker);
    return publicWorker(worker, this.runtime.get(id));
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

  async updateHealth(id, patch) {
    const worker = this.applyHealth(id, patch);
    this.save();
    return worker;
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
        health_status text NOT NULL DEFAULT 'unknown' CHECK (health_status IN ('unknown', 'healthy', 'unhealthy')),
        health_reason text NOT NULL DEFAULT '',
        last_health_check_at timestamptz,
        consecutive_failures integer NOT NULL DEFAULT 0,
        consecutive_successes integer NOT NULL DEFAULT 0,
        provider text NOT NULL DEFAULT '',
        provider_instance_id text NOT NULL DEFAULT '',
        autoscaled boolean NOT NULL DEFAULT false,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query("ALTER TABLE llm_workers ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'unknown'");
    await this.pool.query("ALTER TABLE llm_workers ADD COLUMN IF NOT EXISTS health_reason text NOT NULL DEFAULT ''");
    await this.pool.query('ALTER TABLE llm_workers ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz');
    await this.pool.query('ALTER TABLE llm_workers ADD COLUMN IF NOT EXISTS consecutive_failures integer NOT NULL DEFAULT 0');
    await this.pool.query('ALTER TABLE llm_workers ADD COLUMN IF NOT EXISTS consecutive_successes integer NOT NULL DEFAULT 0');
    await this.pool.query("ALTER TABLE llm_workers ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT ''");
    await this.pool.query("ALTER TABLE llm_workers ADD COLUMN IF NOT EXISTS provider_instance_id text NOT NULL DEFAULT ''");
    await this.pool.query('ALTER TABLE llm_workers ADD COLUMN IF NOT EXISTS autoscaled boolean NOT NULL DEFAULT false');

    const count = await this.pool.query('SELECT count(*)::int AS count FROM llm_workers');
    if (count.rows[0].count === 0 && config.workerRegistrySeedExample) {
      for (const worker of seedWorkersFromExample()) {
        await this.upsert(worker);
      }
    }

    await this.reload();
  }

  async reload() {
    const result = await this.pool.query(`
      SELECT
        id, name, type, base_url, models, default_model, concurrency, enabled, api_key,
        health_status, health_reason, last_health_check_at, consecutive_failures, consecutive_successes,
        provider, provider_instance_id, autoscaled
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
          (id, name, type, base_url, models, default_model, concurrency, enabled, api_key, provider, provider_instance_id, autoscaled, updated_at)
        VALUES
          ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, now())
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          base_url = excluded.base_url,
          models = excluded.models,
          default_model = excluded.default_model,
          concurrency = excluded.concurrency,
          enabled = excluded.enabled,
          api_key = excluded.api_key,
          provider = excluded.provider,
          provider_instance_id = excluded.provider_instance_id,
          autoscaled = excluded.autoscaled,
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
        worker.apiKey,
        worker.provider,
        worker.providerInstanceId,
        worker.autoscaled
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

  async updateHealth(id, patch) {
    const worker = this.applyHealth(id, patch);
    await this.pool.query(
      `
        UPDATE llm_workers SET
          health_status = $2,
          health_reason = $3,
          last_health_check_at = $4,
          consecutive_failures = $5,
          consecutive_successes = $6,
          updated_at = now()
        WHERE id = $1
      `,
      [
        id,
        worker.healthStatus,
        worker.healthReason,
        worker.lastHealthCheckAt,
        worker.consecutiveFailures,
        worker.consecutiveSuccesses
      ]
    );
    return worker;
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
