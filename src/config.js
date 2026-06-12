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

function splitList(value, fallback = []) {
  const items = String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  return items.length ? items : fallback;
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
  defaultWorkerPool: process.env.DEFAULT_WORKER_POOL || 'slm',
  workerPools: splitList(process.env.WORKER_POOLS, ['slm', 'llm']),
  corsAllowedOrigins: splitList(process.env.CORS_ALLOWED_ORIGINS, [
    'http://localhost:5176',
    'http://127.0.0.1:5176',
    'https://terarium-playground.vercel.app',
    'https://playground.team-doob.com'
  ]),
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
    scaleUpCooldownMs: parseIntEnv(process.env.AUTOSCALE_SCALE_UP_COOLDOWN_MS, 120000),
    failedOfferCooldownMs: parseIntEnv(process.env.AUTOSCALE_FAILED_OFFER_COOLDOWN_MS, 300000),
    pendingInstanceTimeoutMs: parseIntEnv(process.env.AUTOSCALE_PENDING_INSTANCE_TIMEOUT_MS, 180000),
    modelPullTimeoutMs: parseIntEnv(process.env.AUTOSCALE_MODEL_PULL_TIMEOUT_MS, 900000),
    sustainedBacklogMs: parseIntEnv(process.env.AUTOSCALE_SUSTAINED_BACKLOG_MS, 60000),
    scaleDownIdleMs: parseIntEnv(process.env.AUTOSCALE_SCALE_DOWN_IDLE_MS, 300000),
    minWorkers: parseIntEnv(process.env.AUTOSCALE_MIN_WORKERS, 0),
    maxWorkers: parseIntEnv(process.env.AUTOSCALE_MAX_WORKERS, 14),
    backlogPerWorker: parseIntEnv(process.env.AUTOSCALE_BACKLOG_PER_WORKER, 2),
    targetUtilization: Number.parseFloat(process.env.AUTOSCALE_TARGET_UTILIZATION || '0.82'),
    scaleDownUtilization: Number.parseFloat(process.env.AUTOSCALE_SCALE_DOWN_UTILIZATION || '0.25'),
    targetRequestsPerSecond: Number.parseFloat(process.env.AUTOSCALE_TARGET_REQUESTS_PER_SECOND || '2'),
    diskGb: parseIntEnv(process.env.AUTOSCALE_DISK_GB, 16),
    instancePort: parseIntEnv(process.env.AUTOSCALE_INSTANCE_PORT, 11434),
    routerPort: parseIntEnv(process.env.AUTOSCALE_ROUTER_PORT, 18080),
    ollamaBasePort: parseIntEnv(process.env.AUTOSCALE_OLLAMA_BASE_PORT, 11540),
    singleGpuOnly: parseBool(process.env.AUTOSCALE_SINGLE_GPU_ONLY, true),
    workerModel: process.env.AUTOSCALE_WORKER_MODEL || process.env.DEFAULT_MODEL || 'gemma4:e4b',
    registerPerGpu: parseBool(process.env.AUTOSCALE_REGISTER_PER_GPU, true),
    templateHashId: '',
    templateUsesRouter: false,
    dockerImage: process.env.AUTOSCALE_DOCKER_IMAGE || 'ollama/ollama:latest',
    apiKey: '',
    apiBaseUrl: '',
    providers: splitList(process.env.AUTOSCALE_PROVIDERS, ['runpod-community', 'runpod-secure']),
    workerPool: process.env.AUTOSCALE_WORKER_POOL || process.env.DEFAULT_WORKER_POOL || 'slm'
  },
  runpod: {
    apiKey: process.env.RUNPOD_API_KEY || '',
    restBaseUrl: (process.env.RUNPOD_REST_BASE_URL || 'https://rest.runpod.io/v1').replace(/\/+$/, ''),
    graphqlBaseUrl: (process.env.RUNPOD_GRAPHQL_BASE_URL || 'https://api.runpod.io/graphql').replace(/\/+$/, ''),
    communityGpuTypeIds: splitList(process.env.RUNPOD_COMMUNITY_GPU_TYPE_IDS, [
      'NVIDIA GeForce RTX 4090',
      'NVIDIA RTX A5000',
      'NVIDIA RTX A4500',
      'NVIDIA GeForce RTX 3090',
      'NVIDIA GeForce RTX 3090 Ti',
      'NVIDIA RTX 5000 Ada Generation',
      'NVIDIA RTX 4000 Ada Generation',
      'NVIDIA GeForce RTX 4080 SUPER',
      'NVIDIA GeForce RTX 4080',
      'NVIDIA GeForce RTX 5080'
    ]),
    secureGpuTypeIds: splitList(process.env.RUNPOD_SECURE_GPU_TYPE_IDS, [
      'NVIDIA RTX A5000',
      'NVIDIA GeForce RTX 4090',
      'NVIDIA RTX A4500',
      'NVIDIA GeForce RTX 3090',
      'NVIDIA RTX 4000 Ada Generation',
      'NVIDIA GeForce RTX 5090'
    ]),
    maxDollarsPerHour: Number.parseFloat(process.env.RUNPOD_MAX_DOLLARS_PER_HOUR || '0.40'),
    containerDiskGb: parseIntEnv(process.env.RUNPOD_CONTAINER_DISK_GB, 30),
    volumeGb: parseIntEnv(process.env.RUNPOD_VOLUME_GB, 0),
    minVcpuCount: parseIntEnv(process.env.RUNPOD_MIN_VCPU_COUNT, 2),
    minMemoryInGb: parseIntEnv(process.env.RUNPOD_MIN_MEMORY_GB, 15),
    dockerImage: process.env.RUNPOD_DOCKER_IMAGE || process.env.AUTOSCALE_DOCKER_IMAGE || 'ollama/ollama:latest'
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
  workerRegistrySeedExample: parseBool(process.env.WORKER_REGISTRY_SEED_EXAMPLE, true),
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
