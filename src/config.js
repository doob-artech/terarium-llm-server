import fs from 'node:fs';
import path from 'node:path';
import 'dotenv/config';

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseIntEnv(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function splitKeys(value) {
  return String(value || '')
    .split(',')
    .map((key) => key.trim())
    .filter(Boolean);
}

export function resolvePath(inputPath) {
  if (path.isAbsolute(inputPath)) return inputPath;
  return path.resolve(process.cwd(), inputPath);
}

export function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export const config = {
  host: process.env.HOST || '0.0.0.0',
  port: parseIntEnv(process.env.PORT, 18200),
  defaultModel: process.env.DEFAULT_MODEL || 'gemma4:e4b',
  requestTimeoutMs: parseIntEnv(process.env.REQUEST_TIMEOUT_MS, 0),
  healthcheck: {
    enabled: parseBool(process.env.WORKER_HEALTHCHECK_ENABLED, true),
    intervalMs: parseIntEnv(process.env.WORKER_HEALTHCHECK_INTERVAL_MS, 15000),
    timeoutMs: parseIntEnv(process.env.WORKER_HEALTHCHECK_TIMEOUT_MS, 3000),
    unhealthyAfterFailures: parseIntEnv(process.env.WORKER_UNHEALTHY_AFTER_FAILURES, 2),
    healthyAfterSuccesses: parseIntEnv(process.env.WORKER_HEALTHY_AFTER_SUCCESSES, 1)
  },
  autoscale: {
    enabled: parseBool(process.env.AUTOSCALE_ENABLED, false),
    dryRun: parseBool(process.env.AUTOSCALE_DRY_RUN, true),
    intervalMs: parseIntEnv(process.env.AUTOSCALE_INTERVAL_MS, 5000),
    sustainedBacklogMs: parseIntEnv(process.env.AUTOSCALE_SUSTAINED_BACKLOG_MS, 60000),
    scaleDownIdleMs: parseIntEnv(process.env.AUTOSCALE_SCALE_DOWN_IDLE_MS, 300000),
    minWorkers: parseIntEnv(process.env.AUTOSCALE_MIN_WORKERS, 0),
    maxWorkers: parseIntEnv(process.env.AUTOSCALE_MAX_WORKERS, 14),
    backlogPerWorker: parseIntEnv(process.env.AUTOSCALE_BACKLOG_PER_WORKER, 2),
    minGpuVramGb: parseIntEnv(process.env.AUTOSCALE_MIN_GPU_VRAM_GB, 12),
    maxGpuVramGb: parseIntEnv(process.env.AUTOSCALE_MAX_GPU_VRAM_GB, 24),
    minReliability: Number.parseFloat(process.env.AUTOSCALE_MIN_RELIABILITY || '0.98'),
    maxDollarsPerHour: Number.parseFloat(process.env.AUTOSCALE_MAX_DOLLARS_PER_HOUR || '0.35'),
    diskGb: parseIntEnv(process.env.AUTOSCALE_DISK_GB, 16),
    instancePort: parseIntEnv(process.env.AUTOSCALE_INSTANCE_PORT, 11434),
    routerPort: parseIntEnv(process.env.AUTOSCALE_ROUTER_PORT, 18080),
    ollamaBasePort: parseIntEnv(process.env.AUTOSCALE_OLLAMA_BASE_PORT, 11540),
    registerPerGpu: parseBool(process.env.AUTOSCALE_REGISTER_PER_GPU, true),
    templateHashId: process.env.VAST_TEMPLATE_HASH_ID || '',
    dockerImage: process.env.VAST_DOCKER_IMAGE || 'ollama/ollama:latest',
    apiKey: process.env.VAST_API_KEY || '',
    apiBaseUrl: (process.env.VAST_API_BASE_URL || 'https://console.vast.ai/api/v0').replace(/\/+$/, '')
  },
  instances: {
    enabled: parseBool(process.env.INSTANCE_MONITOR_ENABLED, true),
    intervalMs: parseIntEnv(process.env.INSTANCE_MONITOR_INTERVAL_MS, 15000),
    staleAfterMs: parseIntEnv(process.env.INSTANCE_STALE_AFTER_MS, 60000),
    cleanupAfterMs: parseIntEnv(process.env.INSTANCE_CLEANUP_AFTER_MS, 180000),
    deregisterMissingWorkers: parseBool(process.env.INSTANCE_DEREGISTER_MISSING_WORKERS, true),
    cleanupRemovesWorkers: parseBool(process.env.INSTANCE_CLEANUP_REMOVES_WORKERS, true)
  },
  allowNoAuth: parseBool(process.env.ALLOW_NO_AUTH, false),
  apiKeys: splitKeys(process.env.LLM_SERVER_API_KEYS),
  adminKey: process.env.LLM_SERVER_ADMIN_KEY || '',
  instanceKey: process.env.LLM_SERVER_INSTANCE_KEY || process.env.LLM_SERVER_ADMIN_KEY || '',
  workerRegistryBackend: process.env.WORKER_REGISTRY_BACKEND || 'file',
  workerRegistryPath: resolvePath(process.env.WORKER_REGISTRY_PATH || './data/workers.json'),
  instanceRegistryPath: resolvePath(process.env.INSTANCE_REGISTRY_PATH || './data/instances.json'),
  postgres: {
    host: process.env.POSTGRES_HOST || '127.0.0.1',
    port: parseIntEnv(process.env.POSTGRES_PORT, 5432),
    database: process.env.POSTGRES_DB || 'terarium_memory',
    user: process.env.POSTGRES_USER || 'terarium',
    password: process.env.POSTGRES_PASSWORD || '',
    ssl: parseBool(process.env.POSTGRES_SSL, false)
  }
};
