import { config } from './config.js';

function extractBearer(req) {
  const header = req.get('authorization') || '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

export function requireClientKey(req, res, next) {
  if (config.allowNoAuth) return next();

  const token = extractBearer(req);
  if (token && config.apiKeys.includes(token)) return next();

  return res.status(401).json({
    error: {
      message: 'Missing or invalid API key',
      type: 'authentication_error'
    }
  });
}

export function requireAdminKey(req, res, next) {
  const token = extractBearer(req);
  if (config.adminKey && token === config.adminKey) return next();

  return res.status(401).json({
    error: {
      message: 'Missing or invalid admin key',
      type: 'authentication_error'
    }
  });
}

