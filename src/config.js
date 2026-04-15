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
  allowNoAuth: parseBool(process.env.ALLOW_NO_AUTH, false),
  apiKeys: splitKeys(process.env.LLM_SERVER_API_KEYS),
  adminKey: process.env.LLM_SERVER_ADMIN_KEY || '',
  workerRegistryPath: resolvePath(process.env.WORKER_REGISTRY_PATH || './data/workers.json')
};
