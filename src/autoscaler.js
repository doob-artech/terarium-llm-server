import { config } from './config.js';
import { VastProvider, gpuCountFromInstance, instanceLabel } from './vast.js';

function nowIso() {
  return new Date().toISOString();
}

export class Autoscaler {
  constructor({ queue, registry, healthMonitor, instances }) {
    this.queue = queue;
    this.registry = registry;
    this.healthMonitor = healthMonitor;
    this.instances = instances;
    this.provider = new VastProvider();
    this.timer = null;
    this.running = false;
    this.events = [];
    this.lastScaleUpAt = null;
    this.lastScaleDownAt = null;
    this.lastDecision = null;
    this.lastOffer = null;
    this.managedInstances = new Map();
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.record('error', error.message || String(error)));
    }, config.autoscale.intervalMs);
    this.timer.unref?.();
    this.tick().catch((error) => this.record('error', error.message || String(error)));
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

  capacity() {
    const workers = this.registry.listPublic();
    return {
      totalWorkers: workers.length,
      totalInstances: new Set(workers.filter((worker) => worker.providerInstanceId).map((worker) => worker.providerInstanceId))
        .size,
      availableWorkers: workers.filter((worker) => worker.available).length,
      autoscaledWorkers: workers.filter((worker) => worker.autoscaled).length,
      totalCapacity: workers.reduce((sum, worker) => sum + Number(worker.concurrency || 0), 0),
      availableCapacity: workers.reduce((sum, worker) => (worker.available ? sum + Number(worker.concurrency || 0) : sum), 0)
    };
  }

  pressure() {
    this.queue.sample();
    const samples = this.queue.recentSamples(config.autoscale.sustainedBacklogMs);
    const sustained = samples.length > 0 && samples.every((sample) => sample.pending >= config.autoscale.backlogPerWorker);
    const latest = samples[samples.length - 1] || null;
    const avgPending = samples.length
      ? samples.reduce((sum, sample) => sum + sample.pending, 0) / samples.length
      : 0;

    return {
      sustained,
      avgPending,
      latestPending: latest?.pending || 0,
      sampleCount: samples.length,
      windowMs: config.autoscale.sustainedBacklogMs
    };
  }

  workerIdForInstance(instanceId, gpuIndex, gpuCount) {
    return gpuCount > 1 || config.autoscale.registerPerGpu ? `vast-${instanceId}-gpu${gpuIndex}` : `vast-${instanceId}`;
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
        reason: 'no sustained backlog',
        pressure,
        capacity
      };

      if (pressure.sustained && capacity.totalWorkers < config.autoscale.maxWorkers) {
        decision.action = 'scale_up';
        decision.reason = 'queue backlog sustained';
        await this.scaleUp(decision);
      } else if (!pressure.sustained && capacity.autoscaledWorkers > config.autoscale.minWorkers) {
        decision.action = 'scale_down_candidate';
        decision.reason = 'autoscaled capacity is idle';
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
      this.record('scale_up_dry_run', 'would search and create Vast.ai instance', decision);
      return;
    }

    const offer = await this.provider.searchBestOffer();
    this.lastOffer = offer;
    if (!offer) {
      this.record('scale_up_failed', 'no matching Vast.ai offer found', decision);
      return;
    }

    const instance = await this.provider.createInstance(offer);
    const instanceId = String(instance?.new_contract || instance?.instance_id || instance?.id || '');
    this.managedInstances.set(instanceId, { createdAtMs: Date.now(), offer, instance });
    await this.registerInstanceWorkers(instanceId, instance);
    this.lastScaleUpAt = nowIso();
    this.record('scale_up_created', 'created Vast.ai instance', { offer, instance });
  }

  async syncManagedInstances() {
    if (!config.autoscale.enabled || config.autoscale.dryRun) return;
    if (this.managedInstances.size === 0) return;

    const instances = await this.provider.listInstances();
    for (const instance of instances) {
      const instanceId = String(instance?.id || instance?.instance_id || '');
      if (!this.managedInstances.has(instanceId)) continue;
      await this.registerInstanceWorkers(instanceId, instance);
    }

    const liveIds = new Set(instances.map((instance) => String(instance?.id || instance?.instance_id || '')).filter(Boolean));
    const staleWorkers = this.registry
      .listPublic()
      .filter((worker) => worker.provider === 'vast' && worker.providerInstanceId && !liveIds.has(worker.providerInstanceId));

    for (const worker of staleWorkers) {
      await this.registry.remove(worker.id).catch(() => null);
      this.record('worker_removed', 'removed stale Vast.ai worker', { workerId: worker.id });
    }

    if (this.instances) {
      for (const entry of this.instances.listPublic().filter((item) => item.provider === 'vast' && item.providerInstanceId)) {
        if (liveIds.has(entry.providerInstanceId)) continue;
        await this.instances.remove(entry.id).catch(() => null);
      }
    }
  }

  mappedPortFor(instance, targetPort) {
    const ports = instance?.ports || instance?.actual_ports || {};
    const portKey = `${targetPort}/tcp`;
    const mapped = ports[portKey] || ports[String(targetPort)] || ports[targetPort];
    return Array.isArray(mapped) ? mapped[0]?.HostPort || mapped[0] : mapped?.HostPort || mapped;
  }

  endpointFromInstance(instance) {
    const host = instance?.public_ipaddr || instance?.ssh_host || instance?.host || '';
    if (!host) return '';
    return `http://${host}`;
  }

  async registerInstanceWorkers(instanceId, instance) {
    if (!instanceId) return;

    const baseEndpoint = this.endpointFromInstance(instance);
    if (!baseEndpoint) return;

    const gpuCount = gpuCountFromInstance(instance);
    const label = instanceLabel(instance) || `Vast.ai ${instanceId}`;
    const publicBaseUrl = config.autoscale.templateHashId
      ? `${baseEndpoint}:${this.mappedPortFor(instance, config.autoscale.routerPort) || config.autoscale.routerPort}`
      : '';

    if (this.instances) {
      await this.instances
        .register({
          id: `vast-${instanceId}`,
          label,
          provider: 'vast',
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
            routerPort: config.autoscale.routerPort,
            templateHashId: config.autoscale.templateHashId || ''
          }
        })
        .catch(() => null);
    }

    for (let gpuIndex = 0; gpuIndex < gpuCount; gpuIndex += 1) {
      const workerId = this.workerIdForInstance(instanceId, gpuIndex, gpuCount);
      let baseUrl;
      if (config.autoscale.templateHashId) {
        const publicPort = this.mappedPortFor(instance, config.autoscale.routerPort) || config.autoscale.routerPort;
        baseUrl = this.workerBaseUrlForInstance(`${baseEndpoint}:${publicPort}`, gpuIndex, gpuCount);
      } else if (gpuCount > 1 && config.autoscale.registerPerGpu) {
        const targetPort = config.autoscale.ollamaBasePort + gpuIndex;
        const publicPort = this.mappedPortFor(instance, targetPort) || targetPort;
        baseUrl = `${baseEndpoint}:${publicPort}`;
      } else {
        const publicPort = this.mappedPortFor(instance, config.autoscale.instancePort) || config.autoscale.instancePort;
        baseUrl = `${baseEndpoint}:${publicPort}`;
      }
      const payload = {
        id: workerId,
        name: `${label} GPU ${gpuIndex}`,
        type: 'ollama',
        baseUrl,
        models: [config.defaultModel],
        defaultModel: config.defaultModel,
        concurrency: 1,
        enabled: true,
        provider: 'vast',
        providerInstanceId: instanceId,
        autoscaled: true
      };

      if (this.registry.get(workerId)) {
        await this.registry.update(workerId, payload);
      } else {
        await this.registry.add(payload);
      }

      await this.healthMonitor.checkOne(workerId).catch(() => null);
      this.record('worker_registered', 'registered Vast.ai worker', { workerId, baseUrl, instanceId, gpuIndex });
    }
  }

  async scaleDown(decision) {
    if (!config.autoscale.enabled || config.autoscale.dryRun) return;

    const grouped = new Map();
    for (const worker of this.registry.listPublic()) {
      if (!(worker.autoscaled && worker.provider === 'vast' && worker.providerInstanceId)) continue;
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

    await this.provider.destroyInstance(candidate.instanceId);
    for (const worker of candidate.workers) {
      await this.registry.remove(worker.id).catch(() => null);
    }
    if (this.instances) await this.instances.remove(`vast-${candidate.instanceId}`).catch(() => null);
    this.managedInstances.delete(candidate.instanceId);
    this.lastScaleDownAt = nowIso();
    this.record('scale_down_destroyed', 'destroyed idle Vast.ai instance', {
      instanceId: candidate.instanceId,
      workerIds: candidate.workers.map((worker) => worker.id)
    });
  }

  status() {
    return {
      enabled: config.autoscale.enabled,
      dryRun: config.autoscale.dryRun,
      interval_ms: config.autoscale.intervalMs,
      sustained_backlog_ms: config.autoscale.sustainedBacklogMs,
      backlog_per_worker: config.autoscale.backlogPerWorker,
      min_workers: config.autoscale.minWorkers,
      max_workers: config.autoscale.maxWorkers,
      min_gpu_vram_gb: config.autoscale.minGpuVramGb,
      max_gpu_vram_gb: config.autoscale.maxGpuVramGb,
      max_dollars_per_hour: config.autoscale.maxDollarsPerHour,
      router_port: config.autoscale.routerPort,
      register_per_gpu: config.autoscale.registerPerGpu,
      last_scale_up_at: this.lastScaleUpAt,
      last_scale_down_at: this.lastScaleDownAt,
      last_decision: this.lastDecision,
      last_offer: this.lastOffer
        ? {
            id: this.lastOffer.id,
            gpu_name: this.lastOffer.gpu_name,
            gpu_vram_gb: this.lastOffer.gpu_vram_gb,
            dollars_per_hour: this.lastOffer.dollars_per_hour,
            vram_per_dollar_hour: this.lastOffer.vram_per_dollar_hour,
            reliability: this.lastOffer.reliability,
            score: this.lastOffer.score
          }
        : null,
      capacity: this.capacity(),
      events: this.events
    };
  }
}
