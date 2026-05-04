import { config } from './config.js';

function buildAbortSignal() {
  if (!config.requestTimeoutMs || config.requestTimeoutMs <= 0) return { signal: undefined, cancel: () => {} };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.requestTimeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer)
  };
}

function openAiResponse({ model, content, upstream = {}, workerId }) {
  return {
    id: upstream.id || `chatcmpl_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    object: 'chat.completion',
    created: upstream.created || Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: content || ''
        },
        finish_reason: upstream.finish_reason || 'stop'
      }
    ],
    usage: upstream.usage || {},
    worker_id: workerId
  };
}

async function fetchJson(url, options) {
  const { signal, cancel } = buildAbortSignal();
  try {
    const response = await fetch(url, { ...options, signal });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }

    if (!response.ok) {
      const message = data?.error?.message || data?.message || text || `Upstream HTTP ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.upstream = data;
      throw error;
    }
    return data;
  } finally {
    cancel();
  }
}

function modelFor(worker, requestModel) {
  return requestModel || worker.defaultModel || config.defaultModel;
}

function dataUrlToBase64(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (trimmed.startsWith('data:')) {
    const commaIndex = trimmed.indexOf(',');
    if (commaIndex === -1) return '';
    return trimmed.slice(commaIndex + 1).trim();
  }
  return trimmed;
}

function normalizeOllamaMessage(message = {}) {
  const rawContent = message.content;
  if (typeof rawContent === 'string') {
    return { role: message.role || 'user', content: rawContent };
  }

  if (!Array.isArray(rawContent)) {
    return { role: message.role || 'user', content: '' };
  }

  const textParts = [];
  const images = [];

  for (const item of rawContent) {
    if (!item || typeof item !== 'object') continue;

    if ((item.type === 'text' || item.type === 'input_text') && typeof item.text === 'string' && item.text.trim()) {
      textParts.push(item.text.trim());
      continue;
    }

    if (item.type === 'image_url') {
      const imageUrl =
        typeof item.image_url === 'string'
          ? item.image_url
          : typeof item.image_url?.url === 'string'
            ? item.image_url.url
            : '';
      const base64 = dataUrlToBase64(imageUrl);
      if (base64) images.push(base64);
      continue;
    }

    if (item.type === 'input_image') {
      const imageUrl = typeof item.image_url === 'string' ? item.image_url : '';
      const base64 = dataUrlToBase64(imageUrl);
      if (base64) images.push(base64);
    }
  }

  const normalized = {
    role: message.role || 'user',
    content: textParts.join('\n').trim()
  };

  if (images.length) normalized.images = images;
  return normalized;
}

export async function callWorker(worker, body) {
  if (worker.type === 'openai-compatible') return callOpenAiCompatible(worker, body);
  return callOllama(worker, body);
}

async function callOpenAiCompatible(worker, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (worker.apiKey) headers.Authorization = `Bearer ${worker.apiKey}`;

  const requestBody = {
    ...body,
    model: modelFor(worker, body.model)
  };

  const data = await fetchJson(`${worker.baseUrl}/v1/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(requestBody)
  });

  return {
    ...data,
    worker_id: worker.id
  };
}

async function callOllama(worker, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (worker.apiKey) headers.Authorization = `Bearer ${worker.apiKey}`;

  const model = worker.defaultModel || modelFor(worker, body.model);
  const ollamaBody = {
    model,
    messages: Array.isArray(body.messages) ? body.messages.map(normalizeOllamaMessage) : [],
    stream: false
  };

  const options = {};
  for (const key of ['temperature', 'top_p', 'seed', 'num_predict', 'repeat_penalty']) {
    if (body[key] !== undefined) options[key] = body[key];
  }
  if (Object.keys(options).length) ollamaBody.options = options;
  if (body?.response_format?.type === 'json_object' || body?.format === 'json') {
    ollamaBody.format = 'json';
  }

  const data = await fetchJson(`${worker.baseUrl}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify(ollamaBody)
  });

  return openAiResponse({
    model,
    content: data?.message?.content || data?.response || '',
    upstream: data,
    workerId: worker.id
  });
}
