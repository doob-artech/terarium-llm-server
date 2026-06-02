import { config } from './config.js';

function requireRunPodKey() {
  if (!config.runpod.apiKey) throw new Error('RUNPOD_API_KEY is required for RunPod autoscaling');
}

async function runpodRest(path, options = {}) {
  requireRunPodKey();
  const response = await fetch(`${config.runpod.restBaseUrl}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.runpod.apiKey}`,
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text.slice(0, 500) };
  }
  if (!response.ok) throw new Error(data?.message || data?.error || data?.errors?.[0]?.message || `RunPod HTTP ${response.status}`);
  return data;
}

async function runpodGraphql(query, variables = {}) {
  requireRunPodKey();
  const response = await fetch(`${config.runpod.graphqlBaseUrl}?api_key=${encodeURIComponent(config.runpod.apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables })
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || data?.errors?.length) {
    throw new Error(data?.errors?.[0]?.message || `RunPod GraphQL HTTP ${response.status}`);
  }
  return data?.data || {};
}

function podId(pod) {
  return String(pod?.id || pod?.podId || '').trim();
}

function podLabel(pod) {
  return String(pod?.name || pod?.label || pod?.id || '').trim();
}

function podGpuName(pod) {
  return String(pod?.gpuTypeId || pod?.machine?.gpuTypeId || pod?.gpu?.displayName || pod?.gpuDisplayName || '').trim();
}

function podPublicIp(pod) {
  return String(
    pod?.publicIp ||
      pod?.public_ip ||
      pod?.publicIpAddress ||
      pod?.runtime?.ports?.[0]?.ip ||
      pod?.ports?.[0]?.ip ||
      ''
  ).trim();
}

function mappedPortFrom(value, targetPort) {
  if (!value) return '';
  const target = String(targetPort);
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized === target || normalized === `${target}/tcp`) return target;
    const portMatch = normalized.match(/^(\d+)(?:\/tcp)?$/i);
    return portMatch ? portMatch[1] : '';
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const port = mappedPortFrom(item, targetPort);
      if (port) return port;
    }
    return '';
  }
  const direct = value[`${target}/tcp`] || value[target] || value[targetPort];
  if (direct) return mappedPortFrom(direct, targetPort);
  if (String(value.containerPort || value.privatePort || value.port || '') === target) {
    return String(value.hostPort || value.publicPort || value.externalPort || value.port || '');
  }
  return '';
}

export function normalizeRunPodPod(pod) {
  const publicIp = podPublicIp(pod);
  const id = podId(pod);
  const httpProxyUrl = id ? `https://${id}-${config.autoscale.instancePort}.proxy.runpod.net` : '';
  const mappedPort = mappedPortFrom(pod?.ports, config.autoscale.instancePort)
    || mappedPortFrom(pod?.portMappings, config.autoscale.instancePort)
    || mappedPortFrom(pod?.runtime?.ports, config.autoscale.instancePort)
    || mappedPortFrom(pod?.runtime?.portMappings, config.autoscale.instancePort);
  return {
    id,
    instance_id: id,
    label: podLabel(pod),
    provider: 'runpod',
    actual_status: pod?.desiredStatus || pod?.status || pod?.runtime?.container?.status || '',
    public_ipaddr: publicIp,
    http_proxy_url: httpProxyUrl,
    ports: mappedPort ? { [`${config.autoscale.instancePort}/tcp`]: mappedPort } : {},
    actual_ports: mappedPort ? { [`${config.autoscale.instancePort}/tcp`]: mappedPort } : {},
    gpu_name: podGpuName(pod),
    gpu_count: Number.parseInt(pod?.gpuCount || 1, 10) || 1,
    raw: pod
  };
}

function normalizeRunPodOffer({ gpu, cloudType, price }) {
  return {
    id: `${cloudType}:${gpu.id}`,
    provider: 'runpod',
    cloudType,
    gpuTypeId: gpu.id,
    gpu_name: gpu.displayName || gpu.id,
    gpu_vram_gb: Number(gpu.memoryInGb || 0),
    dollars_per_hour: Number(price || 0),
    vram_per_dollar_hour: Number(price || 0) > 0 ? Number(gpu.memoryInGb || 0) / Number(price) : 0,
    reliability: 1,
    compute_cap: 0,
    dlperf: 0,
    dlperf_per_dollar_hour: 0,
    score: Number(price || Number.POSITIVE_INFINITY),
    raw: gpu
  };
}

export class RunPodProvider {
  constructor({ cloudType = 'COMMUNITY' } = {}) {
    this.cloudType = cloudType.toUpperCase() === 'SECURE' ? 'SECURE' : 'COMMUNITY';
    this.name = this.cloudType === 'SECURE' ? 'runpod-secure' : 'runpod-community';
    this.label = this.cloudType === 'SECURE' ? 'RunPod Secure' : 'RunPod Community';
    this.instancePrefix = this.name;
  }

  gpuTypeIds() {
    return this.cloudType === 'SECURE'
      ? config.runpod.secureGpuTypeIds
      : config.runpod.communityGpuTypeIds;
  }

  async searchOffers() {
    const query = `
      query CheckGpuStock($id: String!, $secure: Boolean!) {
        gpuTypes(input: { id: $id }) {
          id
          displayName
          memoryInGb
          lowestPrice(input: { gpuCount: 1, secureCloud: $secure }) {
            stockStatus
            uninterruptablePrice
          }
        }
      }
    `;
    const offers = [];
    for (const id of this.gpuTypeIds()) {
      const data = await runpodGraphql(query, { id, secure: this.cloudType === 'SECURE' });
      const gpu = Array.isArray(data?.gpuTypes) ? data.gpuTypes[0] : null;
      const price = Number(gpu?.lowestPrice?.uninterruptablePrice || 0);
      const stock = String(gpu?.lowestPrice?.stockStatus || '').trim().toLowerCase();
      if (!gpu || !price || price > config.runpod.maxDollarsPerHour || !stock) continue;
      offers.push(normalizeRunPodOffer({ gpu, cloudType: this.cloudType, price }));
    }
    offers.sort((a, b) => a.score - b.score);
    return offers;
  }

  async createInstance(offer) {
    const body = {
      cloudType: this.cloudType,
      computeType: 'GPU',
      gpuTypeIds: [offer.gpuTypeId],
      gpuTypePriority: 'availability',
      gpuCount: 1,
      containerDiskInGb: config.runpod.containerDiskGb,
      minVCPUPerGPU: config.runpod.minVcpuCount,
      minRAMPerGPU: config.runpod.minMemoryInGb,
      imageName: config.runpod.dockerImage,
      name: `terarium-llm-${this.name}-${Date.now()}`,
      env: {
        OLLAMA_HOST: `0.0.0.0:${config.autoscale.instancePort}`,
        TERARIUM_WORKER_MODEL: config.autoscale.workerModel
      },
      ports: [`${config.autoscale.instancePort}/http`],
      dockerStartCmd: ['serve'],
      globalNetworking: true,
      supportPublicIp: true,
      interruptible: false,
      locked: false
    };
    if (config.runpod.volumeGb > 0) body.volumeInGb = config.runpod.volumeGb;
    const created = await runpodRest('/pods', { method: 'POST', body: JSON.stringify(body) });
    return {
      success: true,
      id: created?.id || created?.pod?.id || created?.value?.id || '',
      instance_id: created?.id || created?.pod?.id || created?.value?.id || '',
      raw: created
    };
  }

  async destroyInstance(instanceId) {
    return runpodRest(`/pods/${encodeURIComponent(instanceId)}`, { method: 'DELETE' });
  }

  async listInstances() {
    const data = await runpodRest('/pods', { method: 'GET' });
    const pods = Array.isArray(data?.value) ? data.value : Array.isArray(data?.pods) ? data.pods : Array.isArray(data) ? data : [];
    return pods
      .filter((pod) => podLabel(pod).startsWith(`terarium-llm-${this.name}-`))
      .map(normalizeRunPodPod);
  }
}
