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
  allowNoAuth: parseBool(process.env.ALLOW_NO_AUTH, false),
  apiKeys: splitKeys(process.env.LLM_SERVER_API_KEYS),
  adminKey: process.env.LLM_SERVER_ADMIN_KEY || '',
  workerRegistryBackend: process.env.WORKER_REGISTRY_BACKEND || 'file',
  workerRegistryPath: resolvePath(process.env.WORKER_REGISTRY_PATH || './data/workers.json'),
  postgres: {
    host: process.env.POSTGRES_HOST || '127.0.0.1',
    port: parseIntEnv(process.env.POSTGRES_PORT, 5432),
    database: process.env.POSTGRES_DB || 'terarium_memory',
    user: process.env.POSTGRES_USER || 'terarium',
    password: process.env.POSTGRES_PASSWORD || '',
    ssl: parseBool(process.env.POSTGRES_SSL, false)
  }
};
