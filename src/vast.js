import { config } from './config.js';

export function gpuCountFromInstance(instance) {
  const candidates = [
    instance?.gpu_count,
    instance?.num_gpus,
    instance?.gpus,
    instance?.gpu_num,
    instance?.n_gpus,
    instance?.machine?.gpu_count,
    instance?.machine?.num_gpus
  ];

  for (const value of candidates) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const gpuNameList = instance?.gpu_names || instance?.gpu_name;
  if (Array.isArray(gpuNameList) && gpuNameList.length) return gpuNameList.length;
  return 1;
}

export function instanceLabel(instance) {
  return String(instance?.label || instance?.name || instance?.id || instance?.instance_id || '').trim();
}

function renderSingleGpuOnstart() {
  return [
    'set -e',
    `OLLAMA_HOST=0.0.0.0:${config.autoscale.instancePort} ollama serve >/tmp/ollama.log 2>&1 &`,
    'sleep 8',
    `OLLAMA_HOST=127.0.0.1:${config.autoscale.instancePort} ollama pull ${config.autoscale.workerModel}`,
    'wait'
  ].join('\n');
}

function renderMultiGpuOnstart(gpuCount) {
  const lines = ['set -e'];
  for (let gpuIndex = 0; gpuIndex < gpuCount; gpuIndex += 1) {
    const port = config.autoscale.ollamaBasePort + gpuIndex;
    lines.push(`CUDA_VISIBLE_DEVICES=${gpuIndex} OLLAMA_HOST=0.0.0.0:${port} ollama serve >/tmp/ollama-${gpuIndex}.log 2>&1 &`);
  }
  lines.push('sleep 8');
  for (let gpuIndex = 0; gpuIndex < gpuCount; gpuIndex += 1) {
    const port = config.autoscale.ollamaBasePort + gpuIndex;
    lines.push(`OLLAMA_HOST=127.0.0.1:${port} ollama pull ${config.autoscale.workerModel}`);
  }
  lines.push('wait');
  return lines.join('\n');
}

function requireVastKey() {
  if (!config.autoscale.apiKey) throw new Error('VAST_API_KEY is required for Vast.ai autoscaling');
}

async function vastFetch(path, options = {}) {
  requireVastKey();
  const response = await fetch(`${config.autoscale.apiBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.autoscale.apiKey}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data?.msg || data?.error || `Vast.ai HTTP ${response.status}`);
  }
  return data;
}

function offerPrice(offer) {
  return Number(
    offer?.dph_total ??
      offer?.total_flph ??
      offer?.search?.totalHour ??
      offer?.search?.discountedTotalPerHour ??
      offer?.rentable?.discountedTotalPerHour ??
      offer?.discounted_total_per_hour ??
      Number.POSITIVE_INFINITY
  );
}

function offerVramGb(offer) {
  const raw = offer?.gpu_ram ?? offer?.gpu_totalram ?? offer?.gpu_vram ?? offer?.gpu_mem;
  const value = Number(raw || 0);
  if (!Number.isFinite(value)) return 0;
  return value > 256 ? value / 1024 : value;
}

function offerReliability(offer) {
  return Number(offer?.reliability2 ?? offer?.reliability ?? offer?.machine?.reliability ?? 0);
}

function offerDlperf(offer) {
  return Number(offer?.dlperf ?? offer?.machine?.dlperf ?? 0);
}

function offerComputeCap(offer) {
  return Number(offer?.compute_cap ?? offer?.machine?.compute_cap ?? 0);
}

function excludedGpuRegex() {
  const pattern = String(config.autoscale.excludeGpuRegex || '').trim();
  if (!pattern) return null;
  return new RegExp(pattern, 'i');
}

function scoreOffer(offer) {
  const price = offerPrice(offer);
  const vramGb = offerVramGb(offer);
  const dlperf = offerDlperf(offer);
  if (!Number.isFinite(price) || price <= 0 || vramGb <= 0 || dlperf <= 0) return Number.POSITIVE_INFINITY;
  const overspecPenalty = Math.max(0, vramGb - config.autoscale.minGpuVramGb) * 0.00005;
  return price / dlperf + overspecPenalty;
}

export function normalizeOffer(offer) {
  const price = offerPrice(offer);
  const vramGb = offerVramGb(offer);
  return {
    id: offer?.id ?? offer?.ask_contract_id ?? offer?.ask_id,
    gpu_name: offer?.gpu_name || offer?.gpu_names || '',
    gpu_vram_gb: vramGb,
    dollars_per_hour: price,
    vram_per_dollar_hour: Number.isFinite(price) && price > 0 ? vramGb / price : 0,
    reliability: offerReliability(offer),
    compute_cap: offerComputeCap(offer),
    dlperf: offerDlperf(offer),
    dlperf_per_dollar_hour: Number(offer?.dlperf_per_dphtotal ?? 0),
    score: scoreOffer(offer),
    raw: offer
  };
}

export class VastProvider {
  async searchOffers() {
    const body = {
      limit: 50,
      type: 'ondemand',
      verified: { eq: true },
      rentable: { eq: true },
      rented: { eq: false },
      external: { eq: false },
      num_gpus: config.autoscale.singleGpuOnly ? { eq: 1 } : undefined,
      direct_port_count: { gte: 2 },
      gpu_ram: { gte: config.autoscale.minGpuVramGb * 1024, lte: config.autoscale.maxGpuVramGb * 1024 },
      compute_cap: { gte: config.autoscale.minComputeCap },
      dlperf: { gte: config.autoscale.minDlperf },
      reliability2: { gte: config.autoscale.minReliability },
      dph_total: { lte: config.autoscale.maxDollarsPerHour },
      disk_space: { gte: config.autoscale.diskGb },
      order: [['dph_total', 'asc']]
    };

    for (const key of Object.keys(body)) {
      if (body[key] === undefined) delete body[key];
    }

    const data = await vastFetch('/bundles/', {
      method: 'POST',
      body: JSON.stringify(body)
    });

    const offers = Array.isArray(data?.offers) ? data.offers : Array.isArray(data?.bundles) ? data.bundles : [];
    const excluded = excludedGpuRegex();
    const normalized = offers
      .map(normalizeOffer)
      .filter((offer) => offer.id)
      .filter((offer) => !excluded || !excluded.test(String(offer.gpu_name || '')));
    normalized.sort((a, b) => a.score - b.score);
    return normalized;
  }

  async searchBestOffer() {
    const normalized = await this.searchOffers();
    return normalized[0] || null;
  }

  async createInstance(offer) {
    const offerId = offer.id;
    const useTemplate = Boolean(config.autoscale.templateHashId);
    const gpuCount = gpuCountFromInstance(offer.raw || offer);
    const usePortSplit = !useTemplate && config.autoscale.registerPerGpu && gpuCount > 1;
    const onstart = usePortSplit ? renderMultiGpuOnstart(gpuCount) : renderSingleGpuOnstart();
    const ports = useTemplate
      ? [`${config.autoscale.templateUsesRouter ? config.autoscale.routerPort : config.autoscale.instancePort}/tcp`]
      : usePortSplit
        ? Array.from({ length: gpuCount }, (_, index) => `${config.autoscale.ollamaBasePort + index}/tcp`)
        : [`${config.autoscale.instancePort}/tcp`];
    const portEnv = Object.fromEntries(
      ports.map((port) => {
        const containerPort = String(port).replace(/\/tcp$/i, '');
        return [`-p ${containerPort}:${containerPort}`, '1'];
      })
    );

    const body = {
      client_id: 'me',
      image: config.autoscale.dockerImage,
      disk: config.autoscale.diskGb,
      label: `terarium-llm-${Date.now()}`,
      runtype: 'ssh_direct',
      env: {
        OLLAMA_HOST: `0.0.0.0:${config.autoscale.instancePort}`,
        TERARIUM_WORKER_MODEL: config.autoscale.workerModel,
        TERARIUM_ROUTER_PORT: String(config.autoscale.routerPort),
        TERARIUM_OLLAMA_BASE_PORT: String(config.autoscale.ollamaBasePort),
        TERARIUM_REGISTER_PER_GPU: String(config.autoscale.registerPerGpu),
        ...portEnv
      },
    };
    if (onstart) body.onstart = onstart;
    if (config.autoscale.templateHashId) body.template_hash_id = config.autoscale.templateHashId;

    return vastFetch(`/asks/${offerId}/`, {
      method: 'PUT',
      body: JSON.stringify(body)
    });
  }

  async destroyInstance(instanceId) {
    return vastFetch(`/instances/${instanceId}/`, { method: 'DELETE' });
  }

  async listInstances() {
    const data = await vastFetch('/instances/', { method: 'GET' });
    return Array.isArray(data?.instances) ? data.instances : [];
  }
}
