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

  const model = modelFor(worker, body.model);
  const ollamaBody = {
    model,
    messages: body.messages || [],
    stream: false
  };

  const options = {};
  for (const key of ['temperature', 'top_p', 'seed', 'num_predict', 'repeat_penalty']) {
    if (body[key] !== undefined) options[key] = body[key];
  }
  if (Object.keys(options).length) ollamaBody.options = options;

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

