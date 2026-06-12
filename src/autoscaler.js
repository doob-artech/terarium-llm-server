import { config } from './config.js';
import { RunPodProvider } from './runpod.js';

function nowIso() {
  return new Date().toISOString();
}

function publicOffer(offer) {
  if (!offer) return null;
  return {
    id: offer.id,
    provider: offer.provider,
    cloud_type: offer.cloudType,
    gpu_name: offer.gpu_name,
    gpu_vram_gb: offer.gpu_vram_gb,
    dollars_per_hour: offer.dollars_per_hour,
    vram_per_dollar_hour: offer.vram_per_dollar_hour,
    reliability: offer.reliability,
    compute_cap: offer.compute_cap,
    dlperf: offer.dlperf,
    dlperf_per_dollar_hour: offer.dlperf_per_dollar_hour,
    score: offer.score
  };
}

function publicCreatedInstance(instance) {
  return {
    success: Boolean(instance?.success),
    id: String(instance?.new_contract || instance?.instance_id || instance?.id || '')
  };
}

function publicInstanceCost(instance) {
  const costPerHour = Number(instance?.cost_per_hour || 0);
  const estimatedCost = Number(instance?.estimated_cost || 0);
  return {
    provider: instance?._autoscaleProvider || instance?.provider || '',
    provider_instance_id: String(instance?.id || instance?.instance_id || ''),
    label: String(instance?.label || instance?.name || ''),
    status: String(instance?.actual_status || instance?.status || ''),
    gpu_name: String(instance?.gpu_name || ''),
    cost_per_hour: Number.isFinite(costPerHour) ? costPerHour : 0,
    started_at: instance?.started_at || null,
    uptime_seconds: Number(instance?.uptime_seconds || 0),
    estimated_cost: Number.isFinite(estimatedCost) ? estimatedCost : 0
  };
}

function createProvider(name) {
  const normalized = String(name || '').trim().toLowerCase();
  if (normalized === 'runpod-community') return new RunPodProvider({ cloudType: 'COMMUNITY' });
  if (normalized === 'runpod-secure') return new RunPodProvider({ cloudType: 'SECURE' });
  return null;
}

function providerName(provider) {
  return String(provider?.name || 'runpod-community').trim();
}

function providerPrefix(providerOrName) {
  const name = typeof providerOrName === 'string' ? providerOrName : providerName(providerOrName);
  return String(name || 'runpod-community').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
}

function providerLabel(providerOrName) {
  if (typeof providerOrName !== 'string') return providerOrName?.label || providerName(providerOrName);
  if (providerOrName === 'runpod-community') return 'RunPod Community';
  if (providerOrName === 'runpod-secure') return 'RunPod Secure';
  if (providerOrName === 'runpod') return 'RunPod';
  return providerOrName;
}

function gpuCountFromInstance(instance) {
  const candidates = [
    instance?.gpu_count,
    instance?.num_gpus,
    instance?.gpus,
    instance?.gpu_num,
    instance?.n_gpus,
    instance?.machine?.gpu_count,
    instance?.machine?.num_gpus,
    instance?.gpuCount
  ];

  for (const value of candidates) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }

  const gpuNameList = instance?.gpu_names || instance?.gpu_name;
  if (Array.isArray(gpuNameList) && gpuNameList.length) return gpuNameList.length;
  return 1;
}

function instanceLabel(instance) {
  return String(instance?.label || instance?.name || instance?.id || instance?.instance_id || '').trim();
}

function providerCatalog() {
  return [
    {
      id: 'runpod-community',
      label: 'RunPod Community',
      role: 'cheap autoscale pool',
      gpu_types: config.runpod.communityGpuTypeIds,
      max_dollars_per_hour: config.runpod.maxDollarsPerHour,
      enabled: config.autoscale.providers.includes('runpod-community') && Boolean(config.runpod.apiKey)
    },
    {
      id: 'runpod-secure',
      label: 'RunPod Secure',
      role: 'stable autoscale pool',
      gpu_types: config.runpod.secureGpuTypeIds,
      max_dollars_per_hour: config.runpod.maxDollarsPerHour,
      enabled: config.autoscale.providers.includes('runpod-secure') && Boolean(config.runpod.apiKey)
    },
    {
      id: 'gpt-api',
      label: 'GPT API',
      role: 'quota fallback and high-quality reasoning',
      gpu_types: ['hosted API'],
      max_dollars_per_hour: null,
      enabled: true
    }
  ];
}

export class Autoscaler {
  constructor({ queue, registry, healthMonitor, instances, providers = null }) {
    this.queue = queue;
    this.registry = registry;
    this.healthMonitor = healthMonitor;
    this.instances = instances;
    this.providers = Array.isArray(providers) ? providers : config.autoscale.providers.map(createProvider).filter(Boolean);
    if (!this.providers.length) this.providers = [new RunPodProvider({ cloudType: 'COMMUNITY' })];
    this.timer = null;
    this.running = false;
    this.events = [];
    this.lastScaleUpAt = null;
    this.lastScaleDownAt = null;
    this.lastDecision = null;
    this.lastOffer = null;
    this.managedInstances = new Map();
    this.modelPulls = new Map();
    this.failedOfferCooldowns = new Map();
    this.providerInstanceCosts = new Map();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.record('error', error.message || String(error)));
    }, config.autoscale.intervalMs);
    this.timer.unref?.();
    if (!config.autoscale.enabled && !config.autoscale.dryRun) {
      this.resetAutoscaledCapacity().catch((error) => this.record('error', error.message || String(error)));
    } else {
      this.tick().catch((error) => this.record('error', error.message || String(error)));
    }
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  record(type, message, details = {}) {
    const event = { at: nowIso(), type, message, details };
    this.events.unshift(event);
    this.events = this.events.slice(0, 50);
    return event;
  }

  providerByName(name) {
    const normalized = String(name || '').trim();
    return this.providers.find((provider) => providerName(provider) === normalized)
      || this.providers.find((provider) => normalized === 'runpod' && providerName(provider).startsWith('runpod-'))
      || this.providers[0];
  }

  trackedProviderName(instanceId, fallback = 'runpod-community') {
    return this.managedInstances.get(String(instanceId || ''))?.provider || fallback;
  }

  offerCooldownKey(provider, offer) {
    return `${providerName(provider)}:${String(offer?.id || '')}`;
  }

  activeFailedOfferCooldowns() {
    const now = Date.now();
    const active = [];
    for (const [key, entry] of this.failedOfferCooldowns.entries()) {
      if (entry.expiresAtMs <= now) {
        this.failedOfferCooldowns.delete(key);
        continue;
      }
      active.push({
        key,
        provider: entry.provider,
        offer: publicOffer(entry.offer),
        reason: entry.reason,
        failed_at: entry.failedAt,
        expires_at: new Date(entry.expiresAtMs).toISOString()
      });
    }
    return active;
  }

  isOfferCoolingDown(provider, offer) {
    const key = this.offerCooldownKey(provider, offer);
    this.activeFailedOfferCooldowns();
    return this.failedOfferCooldowns.has(key);
  }

  coolDownFailedOffer(provider, offer, reason) {
    const cooldownMs = Math.max(0, Number(config.autoscale.failedOfferCooldownMs || 0));
    if (!cooldownMs) return;
    const key = this.offerCooldownKey(provider, offer);
    const failedAt = nowIso();
    const entry = {
      provider: providerName(provider),
      offer,
      reason,
      failedAt,
      expiresAtMs: Date.now() + cooldownMs
    };
    this.failedOfferCooldowns.set(key, entry);
    this.record('offer_cooldown_started', 'temporarily blocked failed GPU offer', {
      provider: entry.provider,
      offer: publicOffer(offer),
      reason,
      expires_at: new Date(entry.expiresAtMs).toISOString()
    });
  }

  capacity() {
    const workers = this.registry.listPublic();
    const instanceEntries = this.instances
      ? this.instances.listPublic().filter((instance) => instance.autoscaled)
      : [];
    const workerInstanceIds = new Set(workers.filter((worker) => worker.providerInstanceId).map((worker) => worker.providerInstanceId));
    const pendingInstances = instanceEntries.filter((instance) => instance.providerInstanceId && !workerInstanceIds.has(instance.providerInstanceId));
    const instanceIds = new Set([
      ...workers.filter((worker) => worker.providerInstanceId).map((worker) => worker.providerInstanceId),
      ...instanceEntries.map((instance) => instance.providerInstanceId).filter(Boolean)
    ]);
    return {
      totalWorkers: workers.length + pendingInstances.length,
      registeredWorkers: workers.length,
      pendingWorkers: pendingInstances.length,
      totalInstances: instanceIds.size,
      availableWorkers: workers.filter((worker) => worker.available).length,
      autoscaledWorkers: workers.filter((worker) => worker.autoscaled).length + pendingInstances.length,
      totalCapacity: workers.reduce((sum, worker) => sum + Number(worker.concurrency || 0), 0) + pendingInstances.length,
      availableCapacity: workers.reduce((sum, worker) => (worker.available ? sum + Number(worker.concurrency || 0) : sum), 0)
    };
  }

  pressure() {
    this.queue.sample();
    const samples = this.queue.recentSamples(config.autoscale.sustainedBacklogMs);
    const sustainedBacklog = samples.length > 0 && samples.every((sample) => sample.pending >= config.autoscale.backlogPerWorker);
    const sustainedHighUtilization =
      samples.length > 0 &&
      samples.every((sample) => sample.capacity > 0 && sample.utilization >= config.autoscale.targetUtilization);
    const scaleDownSamples = this.queue.recentSamples(config.autoscale.scaleDownIdleMs);
    const sustainedLowUtilization =
      scaleDownSamples.length > 0 &&
      scaleDownSamples.every((sample) => sample.pending === 0 && sample.utilization <= config.autoscale.scaleDownUtilization);
    const latest = samples[samples.length - 1] || null;
    const avgPending = samples.length
      ? samples.reduce((sum, sample) => sum + sample.pending, 0) / samples.length
      : 0;
    const avgRunning = samples.length
      ? samples.reduce((sum, sample) => sum + sample.running, 0) / samples.length
      : 0;
    const avgUtilization = samples.length
      ? samples.reduce((sum, sample) => sum + sample.utilization, 0) / samples.length
      : 0;
    const avgDurationMs = samples.length
      ? Math.round(samples.reduce((sum, sample) => sum + Number(sample.avgDurationMs || 0), 0) / samples.length)
      : 0;
    const targetWorkersByThroughput = avgDurationMs > 0
      ? Math.ceil((config.autoscale.targetRequestsPerSecond * avgDurationMs) / 1000 / Math.max(0.1, config.autoscale.targetUtilization))
      : 0;

    return {
      sustained: sustainedBacklog || sustainedHighUtilization,
      sustainedBacklog,
      sustainedHighUtilization,
      sustainedLowUtilization,
      avgPending,
      avgRunning,
      avgUtilization,
      avgDurationMs,
      latestPending: latest?.pending || 0,
      latestRunning: latest?.running || 0,
      latestCapacity: latest?.capacity || 0,
      latestUtilization: latest?.utilization || 0,
      targetRequestsPerSecond: config.autoscale.targetRequestsPerSecond,
      targetWorkersByThroughput,
      sampleCount: samples.length,
      scaleDownSampleCount: scaleDownSamples.length,
      windowMs: config.autoscale.sustainedBacklogMs
    };
  }

  workerIdForInstance(provider, instanceId, gpuIndex, gpuCount) {
    const prefix = providerPrefix(provider);
    return gpuCount > 1 || config.autoscale.registerPerGpu ? `${prefix}-${instanceId}-gpu${gpuIndex}` : `${prefix}-${instanceId}`;
  }

  workerBaseUrlForInstance(baseEndpoint, gpuIndex, gpuCount) {
    if (gpuCount > 1 || config.autoscale.registerPerGpu) {
      return `${baseEndpoint.replace(/\/+$/, '')}/gpu/${gpuIndex}`;
    }
    return baseEndpoint.replace(/\/+$/, '');
  }

  async tick() {
    if (this.running) return this.status();
    this.running = true;
    try {
      await this.syncManagedInstances();
      const pressure = this.pressure();
      const capacity = this.capacity();
      const decision = {
        at: nowIso(),
        enabled: config.autoscale.enabled,
        dryRun: config.autoscale.dryRun,
        action: 'hold',
        reason: 'no sustained pressure',
        pressure,
        capacity
      };

      const scaleUpCooldownActive =
        this.lastScaleUpAt && Date.now() - Date.parse(this.lastScaleUpAt) < config.autoscale.scaleUpCooldownMs;
      const belowMinimumWorkers = capacity.totalWorkers < config.autoscale.minWorkers;
      const underThroughputTarget =
        pressure.targetWorkersByThroughput > 0 &&
        capacity.availableCapacity < Math.min(config.autoscale.maxWorkers, pressure.targetWorkersByThroughput);

      if (belowMinimumWorkers && capacity.totalWorkers < config.autoscale.maxWorkers) {
        decision.action = 'scale_up';
        decision.reason = 'capacity below configured minimum workers';
        await this.scaleUp(decision);
      } else if (scaleUpCooldownActive) {
        decision.action = 'hold';
        decision.reason = 'scale-up cooldown active';
      } else if ((pressure.sustained || underThroughputTarget) && capacity.totalWorkers < config.autoscale.maxWorkers) {
        decision.action = 'scale_up';
        decision.reason = pressure.sustainedBacklog
          ? 'queue backlog sustained'
          : pressure.sustainedHighUtilization
            ? 'worker utilization sustained high'
            : 'average duration requires more workers for target throughput';
        await this.scaleUp(decision);
      } else if (pressure.sustainedLowUtilization && capacity.autoscaledWorkers > config.autoscale.minWorkers) {
        decision.action = 'scale_down_candidate';
        decision.reason = 'autoscaled capacity stayed under utilization target';
        await this.scaleDown(decision);
      }

      this.lastDecision = decision;
      return this.status();
    } finally {
      this.running = false;
    }
  }

  async scaleUp(decision) {
    if (!config.autoscale.enabled) {
      this.record('scale_up_skipped', 'autoscale disabled', decision);
      return;
    }
    if (config.autoscale.dryRun) {
      this.record('scale_up_dry_run', 'would search and create GPU worker instance', decision);
      return;
    }

    let offer = null;
    let instance = null;
    let selectedProvider = null;
    const failedOffers = [];

    for (const provider of this.providers) {
      const offers = await provider.searchOffers().catch((error) => {
        failedOffers.push({ provider: providerName(provider), error: error.message || String(error) });
        return [];
      });
      for (const candidate of offers.slice(0, 8)) {
        if (this.isOfferCoolingDown(provider, candidate)) {
          failedOffers.push({ provider: providerName(provider), offer: publicOffer(candidate), error: 'offer cooldown active' });
          continue;
        }
        this.lastOffer = candidate;
        try {
          instance = await provider.createInstance(candidate);
          offer = candidate;
          selectedProvider = provider;
          break;
        } catch (error) {
          const message = error.message || String(error);
          failedOffers.push({ provider: providerName(provider), offer: publicOffer(candidate), error: message });
          if (!/no_such_ask|not available|stock|capacity|resource|resources|deploy your pod|sold out/i.test(message)) throw error;
          this.coolDownFailedOffer(provider, candidate, message);
        }
      }
      if (instance && offer) break;
    }
    if (!instance || !offer) {
      this.record('scale_up_failed', 'no matching GPU worker offer could be created', { ...decision, failedOffers });
      return;
    }

    const instanceId = String(instance?.new_contract || instance?.instance_id || instance?.id || '');
    this.managedInstances.set(instanceId, { createdAtMs: Date.now(), offer, instance, provider: providerName(selectedProvider) });
    this.lastScaleUpAt = nowIso();
    this.record('scale_up_created', `created ${providerLabel(selectedProvider)} instance; waiting for port mapping and healthcheck`, {
      provider: providerName(selectedProvider),
      offer: publicOffer(offer),
      instance: publicCreatedInstance(instance)
    });
  }

  async manualScaleUp({ source = 'manual' } = {}) {
    if (this.running) {
      this.record('manual_scale_up_skipped', 'autoscale evaluation already running', { source });
      return this.status();
    }

    this.running = true;
    try {
      if (!config.autoscale.enabled) {
        config.autoscale.enabled = true;
        this.record('autoscale_enabled', 'GPU autoscale enabled for manual scale-up', { source, destroyCapacity: false });
      }

      const capacity = this.capacity();
      const decision = {
        at: nowIso(),
        action: 'manual_scale_up',
        reason: 'manual scale-up requested',
        source,
        capacity,
        pressure: this.pressure()
      };

      if (capacity.totalWorkers >= config.autoscale.maxWorkers) {
        decision.action = 'hold';
        decision.reason = 'max workers reached';
        this.lastDecision = decision;
        this.record('manual_scale_up_skipped', decision.reason, decision);
        return this.status();
      }

      await this.scaleUp(decision);
      this.lastDecision = decision;
      return this.status();
    } finally {
      this.running = false;
    }
  }

  async syncManagedInstances() {
    if (!config.autoscale.enabled || config.autoscale.dryRun) return;

    const instances = [];
    for (const provider of this.providers) {
      const providerInstances = await provider.listInstances().catch((error) => {
        this.record('provider_list_failed', `failed to list ${providerLabel(provider)} instances`, {
          provider: providerName(provider),
          error: error.message || String(error)
        });
        return [];
      });
      for (const instance of providerInstances) {
        instances.push({ ...instance, _autoscaleProvider: providerName(provider), provider: instance.provider || providerName(provider) });
      }
    }
    this.providerInstanceCosts.clear();
    for (const instance of instances) {
      const instanceId = String(instance?.id || instance?.instance_id || '');
      if (instanceId) this.providerInstanceCosts.set(instanceId, publicInstanceCost(instance));
    }
    for (const entry of this.instances?.listPublic?.() || []) {
      if (entry.autoscaled && entry.providerInstanceId && !this.managedInstances.has(entry.providerInstanceId)) {
        this.managedInstances.set(entry.providerInstanceId, {
          createdAtMs: Date.now(),
          recovered: true,
            provider: entry.provider || 'runpod-community'
        });
      }
    }
    for (const instance of instances) {
      const instanceId = String(instance?.id || instance?.instance_id || '');
      const label = String(instance?.label || instance?.name || '');
      if (instanceId && label.startsWith('terarium-llm-') && !this.managedInstances.has(instanceId)) {
        const startSeconds = Number(instance?.start_date || 0);
        this.managedInstances.set(instanceId, {
          createdAtMs: startSeconds > 0 ? Math.floor(startSeconds * 1000) : Date.now(),
          recovered: true,
          provider: instance._autoscaleProvider || instance.provider || 'runpod-community'
        });
        this.record('instance_recovered', 'recovered live autoscale instance after restart', {
          provider: instance._autoscaleProvider || instance.provider,
          instanceId,
          label
        });
      }
    }
    if (this.managedInstances.size === 0) return;

    for (const instance of instances) {
      const instanceId = String(instance?.id || instance?.instance_id || '');
      if (!this.managedInstances.has(instanceId)) continue;
      await this.registerInstanceWorkers(instanceId, instance);
    }

    const liveIds = new Set(instances.map((instance) => String(instance?.id || instance?.instance_id || '')).filter(Boolean));
    const staleWorkers = this.registry
      .listPublic()
      .filter((worker) => worker.autoscaled && worker.providerInstanceId && !liveIds.has(worker.providerInstanceId));

    for (const worker of staleWorkers) {
      await this.registry.remove(worker.id).catch(() => null);
      this.record('worker_removed', 'removed stale autoscale worker', { workerId: worker.id });
    }

    if (this.instances) {
      for (const entry of this.instances.listPublic().filter((item) => item.autoscaled && item.providerInstanceId)) {
        if (liveIds.has(entry.providerInstanceId)) continue;
        await this.instances.remove(entry.id).catch(() => null);
      }
    }

    await this.cleanupTimedOutPendingInstances();
  }

  async cleanupTimedOutPendingInstances() {
    const timeoutMs = config.autoscale.pendingInstanceTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return;

    for (const [instanceId, tracked] of this.managedInstances.entries()) {
      if (Date.now() - tracked.createdAtMs < timeoutMs) continue;
      const providerNameForInstance = tracked.provider || 'runpod-community';
      const provider = this.providerByName(providerNameForInstance);
      const workers = this.registry.listPublic().filter((worker) => worker.autoscaled && worker.providerInstanceId === instanceId);
      if (workers.some((worker) => worker.available || worker.active > 0)) continue;
      if (workers.some((worker) => this.modelPulls.has(worker.id))) continue;

      await provider.destroyInstance(instanceId).catch(() => null);
      for (const worker of workers) {
        await this.registry.remove(worker.id).catch(() => null);
      }
      if (this.instances) await this.instances.remove(`${providerPrefix(providerNameForInstance)}-${instanceId}`).catch(() => null);
      this.managedInstances.delete(instanceId);
      this.lastScaleDownAt = nowIso();
      this.record('scale_down_destroyed', 'destroyed pending autoscale instance without healthy workers', {
        provider: providerNameForInstance,
        instanceId,
        workerIds: workers.map((worker) => worker.id)
      });
    }
  }

  mappedPortFor(instance, targetPort) {
    const ports = instance?.ports || instance?.actual_ports || {};
    const portKey = `${targetPort}/tcp`;
    const mapped = ports[portKey] || ports[String(targetPort)] || ports[targetPort];
    return Array.isArray(mapped) ? mapped[0]?.HostPort || mapped[0] : mapped?.HostPort || mapped;
  }

  publicPortForWorker(instance, gpuIndex, gpuCount) {
    if (instance?.http_proxy_url) return '__runpod_http_proxy__';
    if (config.autoscale.templateHashId && config.autoscale.templateUsesRouter) {
      return this.mappedPortFor(instance, config.autoscale.routerPort);
    }
    if (gpuCount > 1 && config.autoscale.registerPerGpu) {
      return this.mappedPortFor(instance, config.autoscale.ollamaBasePort + gpuIndex);
    }
    return this.mappedPortFor(instance, config.autoscale.instancePort);
  }

  endpointFromInstance(instance) {
    if (instance?.http_proxy_url) return String(instance.http_proxy_url || '').replace(/\/+$/, '');
    const host = instance?.public_ipaddr || instance?.ssh_host || instance?.host || '';
    if (!host) return '';
    return `http://${host}`;
  }

  async registerInstanceWorkers(instanceId, instance) {
    if (!instanceId) return;

    const baseEndpoint = this.endpointFromInstance(instance);
    if (!baseEndpoint) return;

    const providerNameForInstance = instance._autoscaleProvider || this.trackedProviderName(instanceId, instance.provider || 'runpod-community');
    const prefix = providerPrefix(providerNameForInstance);
    const gpuCount = gpuCountFromInstance(instance);
    const label = instanceLabel(instance) || `${providerLabel(providerNameForInstance)} ${instanceId}`;
    const routerPort =
      config.autoscale.templateHashId && config.autoscale.templateUsesRouter
        ? this.mappedPortFor(instance, config.autoscale.routerPort)
        : '';
    const publicBaseUrl = routerPort ? `${baseEndpoint}:${routerPort}` : '';

    if (this.instances) {
      await this.instances
        .register({
          id: `${prefix}-${instanceId}`,
          label,
          provider: providerNameForInstance,
          providerInstanceId: instanceId,
          host: instance?.public_ipaddr || instance?.ssh_host || instance?.host || '',
          publicBaseUrl,
          gpuCount,
          autoscaled: true,
          status: 'running',
          healthStatus: 'unknown',
          healthReason: '',
          metadata: {
            source: 'autoscaler',
            workerPool: config.autoscale.workerPool,
            routerPort: config.autoscale.routerPort,
            templateHashId: config.autoscale.templateHashId || '',
            templateUsesRouter: config.autoscale.templateUsesRouter
          }
        })
        .catch(() => null);
    }

    for (let gpuIndex = 0; gpuIndex < gpuCount; gpuIndex += 1) {
      const workerId = this.workerIdForInstance(providerNameForInstance, instanceId, gpuIndex, gpuCount);
      const publicPort = this.publicPortForWorker(instance, gpuIndex, gpuCount);
      if (!publicPort) {
        this.record('worker_waiting_for_port', 'autoscale worker has no public port mapping yet', { workerId, provider: providerNameForInstance, instanceId, gpuIndex });
        continue;
      }
      let baseUrl;
      if (publicPort === '__runpod_http_proxy__') {
        baseUrl = baseEndpoint;
      } else if (config.autoscale.templateHashId && config.autoscale.templateUsesRouter) {
        baseUrl = this.workerBaseUrlForInstance(`${baseEndpoint}:${publicPort}`, gpuIndex, gpuCount);
      } else if (gpuCount > 1 && config.autoscale.registerPerGpu) {
        baseUrl = `${baseEndpoint}:${publicPort}`;
      } else {
        baseUrl = `${baseEndpoint}:${publicPort}`;
      }
      const payload = {
        id: workerId,
        name: `${label} GPU ${gpuIndex}`,
        type: 'ollama',
        baseUrl,
        models: [config.defaultModel],
        defaultModel: config.autoscale.workerModel,
        concurrency: 1,
        enabled: true,
        provider: providerNameForInstance,
        providerInstanceId: instanceId,
        autoscaled: true,
        workerPool: config.autoscale.workerPool
      };

      const previousWorker = this.registry.listPublic().find((worker) => worker.id === workerId);
      if (this.registry.get(workerId)) {
        await this.registry.update(workerId, payload);
      } else {
        await this.registry.add(payload);
      }

      const checked = await this.healthMonitor.checkOne(workerId).catch((error) => {
        this.record('worker_healthcheck_failed', 'registered autoscale worker failed healthcheck', {
          workerId,
          baseUrl,
          instanceId,
          gpuIndex,
          error: error.message || String(error)
        });
        return null;
      });
      if (checked?.available) {
        if (!previousWorker?.available) {
          this.record('worker_registered', 'registered healthy autoscale worker', { workerId, baseUrl, provider: providerNameForInstance, instanceId, gpuIndex });
        }
      } else if (checked?.healthReason && /not pulled|available:\s*none/i.test(checked.healthReason)) {
        this.ensureModelPulled({ ...payload, ...checked });
      }
    }
  }

  async pullOllamaModel(worker) {
    const model = String(worker.defaultModel || config.autoscale.workerModel || config.defaultModel || '').trim();
    if (!model) throw new Error('model name is required before pulling Ollama model');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(60000, config.autoscale.modelPullTimeoutMs));
    const headers = { 'Content-Type': 'application/json' };
    if (worker.apiKey) headers.Authorization = `Bearer ${worker.apiKey}`;
    try {
      const response = await fetch(`${worker.baseUrl}/api/pull`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, stream: false }),
        signal: controller.signal
      });
      const text = await response.text();
      let data = {};
      try {
        data = text ? JSON.parse(text) : {};
      } catch {
        data = { raw: text.slice(0, 500) };
      }
      if (!response.ok) {
        throw new Error(data?.error || data?.message || text || `Ollama pull HTTP ${response.status}`);
      }
      return data;
    } finally {
      clearTimeout(timer);
    }
  }

  ensureModelPulled(worker) {
    if (!worker?.id || !worker?.baseUrl) return;
    if (this.modelPulls.has(worker.id)) return;

    const pull = this.pullOllamaModel(worker)
      .then(async () => {
        this.record('worker_model_pulled', 'pulled Ollama model on autoscale worker', {
          workerId: worker.id,
          baseUrl: worker.baseUrl,
          model: worker.defaultModel || config.autoscale.workerModel || config.defaultModel
        });
        await this.healthMonitor.checkOne(worker.id).catch((error) => {
          this.record('worker_healthcheck_failed', 'healthcheck failed after model pull', {
            workerId: worker.id,
            error: error.message || String(error)
          });
        });
      })
      .catch((error) => {
        this.record('worker_model_pull_failed', 'failed to pull Ollama model on autoscale worker', {
          workerId: worker.id,
          baseUrl: worker.baseUrl,
          model: worker.defaultModel || config.autoscale.workerModel || config.defaultModel,
          error: error.message || String(error)
        });
      })
      .finally(() => {
        this.modelPulls.delete(worker.id);
      });
    this.modelPulls.set(worker.id, pull);
    this.record('worker_model_pull_started', 'started Ollama model pull on autoscale worker', {
      workerId: worker.id,
      baseUrl: worker.baseUrl,
      model: worker.defaultModel || config.autoscale.workerModel || config.defaultModel
    });
  }

  async scaleDown(decision) {
    if (!config.autoscale.enabled || config.autoscale.dryRun) return;

    const grouped = new Map();
    for (const worker of this.registry.listPublic()) {
      if (!(worker.autoscaled && worker.providerInstanceId)) continue;
      if (!grouped.has(worker.providerInstanceId)) grouped.set(worker.providerInstanceId, []);
      grouped.get(worker.providerInstanceId).push(worker);
    }

    const candidates = [...grouped.entries()]
      .map(([instanceId, workers]) => ({ instanceId, workers }))
      .filter(({ workers }) => workers.every((worker) => worker.active === 0))
      .sort((a, b) => {
        const aCreated = this.managedInstances.get(a.instanceId)?.createdAtMs || 0;
        const bCreated = this.managedInstances.get(b.instanceId)?.createdAtMs || 0;
        return aCreated - bCreated;
      });

    const candidate = candidates[0];
    if (!candidate) return;

    const providerNameForInstance = this.trackedProviderName(candidate.instanceId, candidate.workers[0]?.provider || 'runpod-community');
    await this.providerByName(providerNameForInstance).destroyInstance(candidate.instanceId);
    for (const worker of candidate.workers) {
      await this.registry.remove(worker.id).catch(() => null);
    }
    if (this.instances) await this.instances.remove(`${providerPrefix(providerNameForInstance)}-${candidate.instanceId}`).catch(() => null);
    this.managedInstances.delete(candidate.instanceId);
    this.lastScaleDownAt = nowIso();
    this.record('scale_down_destroyed', 'destroyed idle autoscale instance', {
      provider: providerNameForInstance,
      instanceId: candidate.instanceId,
      workerIds: candidate.workers.map((worker) => worker.id)
    });
  }

  async resetAutoscaledCapacity() {
    const providerInstanceIds = new Map();
    for (const worker of this.registry.listPublic()) {
      if (worker.autoscaled && worker.providerInstanceId) providerInstanceIds.set(worker.providerInstanceId, worker.provider || 'runpod-community');
    }
    if (this.instances) {
      for (const instance of this.instances.listPublic()) {
        if (instance.autoscaled && instance.providerInstanceId) providerInstanceIds.set(instance.providerInstanceId, instance.provider || 'runpod-community');
      }
    }
    for (const [instanceId, tracked] of this.managedInstances.entries()) {
      if (instanceId) providerInstanceIds.set(instanceId, tracked.provider || 'runpod-community');
    }

    for (const provider of this.providers) {
      const liveInstances = await provider.listInstances().catch(() => []);
      for (const instance of liveInstances) {
        const instanceId = String(instance?.id || instance?.instance_id || '');
        const label = String(instance?.label || instance?.name || '');
        if (instanceId && label.startsWith('terarium-llm-')) providerInstanceIds.set(instanceId, providerName(provider));
      }
    }

    const destroyed = [];
    const destroyFailed = [];
    for (const [instanceId, instanceProvider] of providerInstanceIds.entries()) {
      try {
        await this.providerByName(instanceProvider).destroyInstance(instanceId);
        destroyed.push(instanceId);
      } catch (error) {
        const message = error.message || String(error);
        if (!/not found/i.test(message)) destroyFailed.push({ instanceId, provider: instanceProvider, error: message });
      }
    }

    const removedWorkers = [];
    for (const worker of this.registry.listPublic()) {
      if (!worker.autoscaled) continue;
      await this.registry.remove(worker.id).catch(() => null);
      removedWorkers.push(worker.id);
    }
    if (this.instances) {
      for (const instance of this.instances.listPublic()) {
        if (!instance.autoscaled) continue;
        await this.instances.remove(instance.id).catch(() => null);
      }
    }

    this.managedInstances.clear();
    this.lastScaleDownAt = nowIso();
    this.record('autoscale_reset', 'destroyed all autoscale capacity', {
      destroyed,
      removedWorkers,
      destroyFailed
    });
    return { destroyed, removedWorkers, destroyFailed };
  }

  async setEnabled(enabled, { destroyCapacity = false } = {}) {
    config.autoscale.enabled = Boolean(enabled);
    let reset = null;
    if (!config.autoscale.enabled && destroyCapacity) {
      reset = await this.resetAutoscaledCapacity();
    }
    this.record(
      config.autoscale.enabled ? 'autoscale_enabled' : 'autoscale_disabled',
      config.autoscale.enabled ? 'GPU autoscale enabled' : 'GPU autoscale disabled',
      { destroyCapacity: Boolean(destroyCapacity), reset }
    );
    return this.status();
  }

  status() {
    return {
      enabled: config.autoscale.enabled,
      dryRun: config.autoscale.dryRun,
      providers: this.providers.map((provider) => providerName(provider)),
      worker_pools: config.workerPools,
      worker_pool: config.autoscale.workerPool,
      provider_catalog: providerCatalog(),
      interval_ms: config.autoscale.intervalMs,
      sustained_backlog_ms: config.autoscale.sustainedBacklogMs,
      scale_up_cooldown_ms: config.autoscale.scaleUpCooldownMs,
      failed_offer_cooldown_ms: config.autoscale.failedOfferCooldownMs,
      pending_instance_timeout_ms: config.autoscale.pendingInstanceTimeoutMs,
      backlog_per_worker: config.autoscale.backlogPerWorker,
      target_utilization: config.autoscale.targetUtilization,
      scale_down_utilization: config.autoscale.scaleDownUtilization,
      target_requests_per_second: config.autoscale.targetRequestsPerSecond,
      min_workers: config.autoscale.minWorkers,
      max_workers: config.autoscale.maxWorkers,
      single_gpu_only: config.autoscale.singleGpuOnly,
      worker_model: config.autoscale.workerModel,
      template_uses_router: config.autoscale.templateUsesRouter,
      router_port: config.autoscale.routerPort,
      register_per_gpu: config.autoscale.registerPerGpu,
      last_scale_up_at: this.lastScaleUpAt,
      last_scale_down_at: this.lastScaleDownAt,
      last_decision: this.lastDecision,
      last_offer: publicOffer(this.lastOffer),
      model_pulls: [...this.modelPulls.keys()],
      failed_offer_cooldowns: this.activeFailedOfferCooldowns(),
      provider_instance_costs: [...this.providerInstanceCosts.values()],
      capacity: this.capacity(),
      events: this.events
    };
  }
}
