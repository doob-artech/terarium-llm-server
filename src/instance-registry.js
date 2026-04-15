import fs from 'node:fs';
import { Pool } from 'pg';
import { config, ensureParentDir } from './config.js';

function asIso(value) {
  if (!value) return null;
  return new Date(value).toISOString();
}

export function normalizeInstance(raw) {
  const instance = {
    id: String(raw.id || '').trim(),
    label: String(raw.label || raw.name || raw.id || '').trim(),
    provider: String(raw.provider || '').trim(),
    providerInstanceId: String(raw.providerInstanceId || raw.provider_instance_id || '').trim(),
    host: String(raw.host || '').trim(),
    publicBaseUrl: String(raw.publicBaseUrl || raw.public_base_url || '').replace(/\/+$/, ''),
    gpuCount: Math.max(0, Number.parseInt(raw.gpuCount || raw.gpu_count, 10) || 0),
    autoscaled: raw.autoscaled === true || raw.autoscaled === 'true',
    status: String(raw.status || 'registered').trim(),
    healthStatus: String(raw.healthStatus || raw.health_status || 'unknown').trim(),
    healthReason: String(raw.healthReason || raw.health_reason || '').trim(),
    lastHeartbeatAt: asIso(raw.lastHeartbeatAt || raw.last_heartbeat_at),
    lastHealthCheckAt: asIso(raw.lastHealthCheckAt || raw.last_health_check_at),
    metadata: raw.metadata && typeof raw.metadata === 'object' ? raw.metadata : {}
  };

  if (!instance.id) throw new Error('instance.id is required');
  if (!['unknown', 'healthy', 'unhealthy', 'stale'].includes(instance.healthStatus)) {
    instance.healthStatus = 'unknown';
  }
  return instance;
}

function publicInstance(instance) {
  return { ...instance };
}

class BaseInstanceRegistry {
  constructor() {
    this.instances = [];
  }

  listPublic() {
    return this.instances.map(publicInstance);
  }

  get(id) {
    return this.instances.find((instance) => instance.id === id);
  }

  async register(rawInstance) {
    const instance = normalizeInstance({
      ...rawInstance,
      lastHeartbeatAt: rawInstance.lastHeartbeatAt || new Date().toISOString()
    });
    return this.upsert(instance);
  }

  applyHeartbeat(id, patch = {}) {
    const instance = this.get(id);
    if (!instance) throw new Error(`instance ${id} not found`);
    Object.assign(instance, patch, {
      lastHeartbeatAt: new Date().toISOString(),
      status: patch.status || instance.status || 'registered'
    });
    return publicInstance(instance);
  }

  applyHealth(id, patch = {}) {
    const instance = this.get(id);
    if (!instance) throw new Error(`instance ${id} not found`);
    Object.assign(instance, patch, {
      lastHealthCheckAt: new Date().toISOString()
    });
    return publicInstance(instance);
  }
}

class FileInstanceRegistry extends BaseInstanceRegistry {
  constructor(filePath = config.instanceRegistryPath) {
    super();
    this.filePath = filePath;
  }

  async init() {
    ensureParentDir(this.filePath);
    if (!fs.existsSync(this.filePath)) fs.writeFileSync(this.filePath, '[]\n');
    const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    this.instances = raw.map(normalizeInstance);
  }

  save() {
    ensureParentDir(this.filePath);
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.instances, null, 2)}\n`);
  }

  async upsert(rawInstance) {
    const instance = normalizeInstance(rawInstance);
    const index = this.instances.findIndex((item) => item.id === instance.id);
    if (index >= 0) this.instances[index] = instance;
    else this.instances.push(instance);
    this.save();
    return publicInstance(instance);
  }

  async heartbeat(id, patch = {}) {
    const instance = this.applyHeartbeat(id, patch);
    this.save();
    return instance;
  }

  async updateHealth(id, patch = {}) {
    const instance = this.applyHealth(id, patch);
    this.save();
    return instance;
  }

  async remove(id) {
    const existing = this.get(id);
    if (!existing) throw new Error(`instance ${id} not found`);
    this.instances = this.instances.filter((instance) => instance.id !== id);
    this.save();
    return publicInstance(existing);
  }
}

class PostgresInstanceRegistry extends BaseInstanceRegistry {
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
      CREATE TABLE IF NOT EXISTS llm_instances (
        id text PRIMARY KEY,
        label text NOT NULL,
        provider text NOT NULL DEFAULT '',
        provider_instance_id text NOT NULL DEFAULT '',
        host text NOT NULL DEFAULT '',
        public_base_url text NOT NULL DEFAULT '',
        gpu_count integer NOT NULL DEFAULT 0,
        autoscaled boolean NOT NULL DEFAULT false,
        status text NOT NULL DEFAULT 'registered',
        health_status text NOT NULL DEFAULT 'unknown',
        health_reason text NOT NULL DEFAULT '',
        last_heartbeat_at timestamptz,
        last_health_check_at timestamptz,
        metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
        created_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now()
      )
    `);
    await this.pool.query("ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT ''");
    await this.pool.query("ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS provider_instance_id text NOT NULL DEFAULT ''");
    await this.pool.query("ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS host text NOT NULL DEFAULT ''");
    await this.pool.query("ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS public_base_url text NOT NULL DEFAULT ''");
    await this.pool.query('ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS gpu_count integer NOT NULL DEFAULT 0');
    await this.pool.query('ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS autoscaled boolean NOT NULL DEFAULT false');
    await this.pool.query("ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'registered'");
    await this.pool.query("ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS health_status text NOT NULL DEFAULT 'unknown'");
    await this.pool.query("ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS health_reason text NOT NULL DEFAULT ''");
    await this.pool.query('ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz');
    await this.pool.query('ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS last_health_check_at timestamptz');
    await this.pool.query("ALTER TABLE llm_instances ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb");
    await this.reload();
  }

  async reload() {
    const result = await this.pool.query(`
      SELECT
        id, label, provider, provider_instance_id, host, public_base_url, gpu_count,
        autoscaled, status, health_status, health_reason, last_heartbeat_at, last_health_check_at, metadata
      FROM llm_instances
      ORDER BY id
    `);
    this.instances = result.rows.map(normalizeInstance);
  }

  async upsert(rawInstance) {
    const instance = normalizeInstance(rawInstance);
    await this.pool.query(
      `
        INSERT INTO llm_instances
          (id, label, provider, provider_instance_id, host, public_base_url, gpu_count, autoscaled, status,
           health_status, health_reason, last_heartbeat_at, last_health_check_at, metadata, updated_at)
        VALUES
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, now())
        ON CONFLICT (id) DO UPDATE SET
          label = excluded.label,
          provider = excluded.provider,
          provider_instance_id = excluded.provider_instance_id,
          host = excluded.host,
          public_base_url = excluded.public_base_url,
          gpu_count = excluded.gpu_count,
          autoscaled = excluded.autoscaled,
          status = excluded.status,
          health_status = excluded.health_status,
          health_reason = excluded.health_reason,
          last_heartbeat_at = excluded.last_heartbeat_at,
          last_health_check_at = excluded.last_health_check_at,
          metadata = excluded.metadata,
          updated_at = now()
      `,
      [
        instance.id,
        instance.label,
        instance.provider,
        instance.providerInstanceId,
        instance.host,
        instance.publicBaseUrl,
        instance.gpuCount,
        instance.autoscaled,
        instance.status,
        instance.healthStatus,
        instance.healthReason,
        instance.lastHeartbeatAt,
        instance.lastHealthCheckAt,
        JSON.stringify(instance.metadata || {})
      ]
    );
    await this.reload();
    return publicInstance(this.get(instance.id));
  }

  async heartbeat(id, patch = {}) {
    const instance = this.applyHeartbeat(id, patch);
    await this.pool.query(
      `
        UPDATE llm_instances SET
          label = $2,
          host = $3,
          public_base_url = $4,
          status = $5,
          health_reason = $6,
          metadata = $7::jsonb,
          last_heartbeat_at = $8,
          updated_at = now()
        WHERE id = $1
      `,
      [
        id,
        instance.label,
        instance.host,
        instance.publicBaseUrl,
        instance.status,
        instance.healthReason,
        JSON.stringify(instance.metadata || {}),
        instance.lastHeartbeatAt
      ]
    );
    return instance;
  }

  async updateHealth(id, patch = {}) {
    const instance = this.applyHealth(id, patch);
    await this.pool.query(
      `
        UPDATE llm_instances SET
          health_status = $2,
          health_reason = $3,
          last_health_check_at = $4,
          updated_at = now()
        WHERE id = $1
      `,
      [id, instance.healthStatus, instance.healthReason, instance.lastHealthCheckAt]
    );
    return instance;
  }

  async remove(id) {
    const existing = this.get(id);
    if (!existing) throw new Error(`instance ${id} not found`);
    await this.pool.query('DELETE FROM llm_instances WHERE id = $1', [id]);
    this.instances = this.instances.filter((instance) => instance.id !== id);
    return publicInstance(existing);
  }

  async close() {
    await this.pool.end();
  }
}

export function createInstanceRegistry() {
  if (config.workerRegistryBackend === 'postgres') return new PostgresInstanceRegistry();
  if (config.workerRegistryBackend === 'file') return new FileInstanceRegistry();
  throw new Error(`Unsupported WORKER_REGISTRY_BACKEND: ${config.workerRegistryBackend}`);
}
