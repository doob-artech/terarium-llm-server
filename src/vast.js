import { config } from './config.js';

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

function scoreOffer(offer) {
  const price = offerPrice(offer);
  const vramGb = offerVramGb(offer);
  if (!Number.isFinite(price) || price <= 0 || vramGb <= 0) return Number.POSITIVE_INFINITY;
  const overspecPenalty = Math.max(0, vramGb - config.autoscale.minGpuVramGb) * 0.005;
  return price / vramGb + overspecPenalty;
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
    score: scoreOffer(offer),
    raw: offer
  };
}

export class VastProvider {
  async searchBestOffer() {
    const query = {
      verified: { eq: true },
      rentable: { eq: true },
      external: { eq: false },
      gpu_ram: { gte: config.autoscale.minGpuVramGb * 1024, lte: config.autoscale.maxGpuVramGb * 1024 },
      reliability2: { gte: config.autoscale.minReliability },
      dph_total: { lte: config.autoscale.maxDollarsPerHour },
      disk_space: { gte: config.autoscale.diskGb }
    };

    const data = await vastFetch('/bundles/', {
      method: 'POST',
      body: JSON.stringify({
        q: query,
        order: [['dph_total', 'asc']],
        limit: 50
      })
    });

    const offers = Array.isArray(data?.offers) ? data.offers : Array.isArray(data?.bundles) ? data.bundles : [];
    const normalized = offers.map(normalizeOffer).filter((offer) => offer.id);
    normalized.sort((a, b) => a.score - b.score);
    return normalized[0] || null;
  }

  async createInstance(offer) {
    const offerId = offer.id;
    const onstart = [
      'ollama serve &',
      'sleep 5',
      `ollama pull ${config.defaultModel}`,
      'wait'
    ].join('\n');

    const body = {
      client_id: 'me',
      image: config.autoscale.dockerImage,
      disk: config.autoscale.diskGb,
      label: `terarium-llm-${Date.now()}`,
      onstart,
      env: {
        OLLAMA_HOST: `0.0.0.0:${config.autoscale.instancePort}`
      },
      ports: [`${config.autoscale.instancePort}/tcp`]
    };
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

