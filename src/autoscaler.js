import { config } from './config.js';
import { VastProvider, gpuCountFromInstance, instanceLabel } from './vast.js';

function nowIso() {
  return new Date().toISOString();
}

function publicOffer(offer) {
  if (!offer) return null;
  return {
    id: offer.id,
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
    this.lastScaleUpAt = nowIso();
    this.record('scale_up_created', 'created Vast.ai instance; waiting for port mapping and healthcheck', {
      offer: publicOffer(offer),
      instance: publicCreatedInstance(instance)
    });
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

    await this.cleanupTimedOutPendingInstances();
  }

  async cleanupTimedOutPendingInstances() {
    const timeoutMs = config.autoscale.pendingInstanceTimeoutMs;
    if (!timeoutMs || timeoutMs <= 0) return;

    for (const [instanceId, tracked] of this.managedInstances.entries()) {
      if (Date.now() - tracked.createdAtMs < timeoutMs) continue;
      const workers = this.registry.listPublic().filter((worker) => worker.provider === 'vast' && worker.providerInstanceId === instanceId);
      if (workers.some((worker) => worker.available || worker.active > 0)) continue;

      await this.provider.destroyInstance(instanceId).catch(() => null);
      for (const worker of workers) {
        await this.registry.remove(worker.id).catch(() => null);
      }
      if (this.instances) await this.instances.remove(`vast-${instanceId}`).catch(() => null);
      this.managedInstances.delete(instanceId);
      this.lastScaleDownAt = nowIso();
      this.record('scale_down_destroyed', 'destroyed pending Vast.ai instance without healthy workers', {
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
    if (config.autoscale.templateHashId && config.autoscale.templateUsesRouter) {
      return this.mappedPortFor(instance, config.autoscale.routerPort);
    }
    if (gpuCount > 1 && config.autoscale.registerPerGpu) {
      return this.mappedPortFor(instance, config.autoscale.ollamaBasePort + gpuIndex);
    }
    return this.mappedPortFor(instance, config.autoscale.instancePort);
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
    const routerPort =
      config.autoscale.templateHashId && config.autoscale.templateUsesRouter
        ? this.mappedPortFor(instance, config.autoscale.routerPort)
        : '';
    const publicBaseUrl = routerPort ? `${baseEndpoint}:${routerPort}` : '';

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
            templateHashId: config.autoscale.templateHashId || '',
            templateUsesRouter: config.autoscale.templateUsesRouter
          }
        })
        .catch(() => null);
    }

    for (let gpuIndex = 0; gpuIndex < gpuCount; gpuIndex += 1) {
      const workerId = this.workerIdForInstance(instanceId, gpuIndex, gpuCount);
      const publicPort = this.publicPortForWorker(instance, gpuIndex, gpuCount);
      if (!publicPort) {
        this.record('worker_waiting_for_port', 'Vast.ai worker has no public port mapping yet', { workerId, instanceId, gpuIndex });
        continue;
      }
      let baseUrl;
      if (config.autoscale.templateHashId && config.autoscale.templateUsesRouter) {
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
        provider: 'vast',
        providerInstanceId: instanceId,
        autoscaled: true
      };

      if (this.registry.get(workerId)) {
        await this.registry.update(workerId, payload);
      } else {
        await this.registry.add(payload);
      }

      const checked = await this.healthMonitor.checkOne(workerId).catch((error) => {
        this.record('worker_healthcheck_failed', 'registered Vast.ai worker failed healthcheck', {
          workerId,
          baseUrl,
          instanceId,
          gpuIndex,
          error: error.message || String(error)
        });
        return null;
      });
      if (checked?.available) {
        this.record('worker_registered', 'registered healthy Vast.ai worker', { workerId, baseUrl, instanceId, gpuIndex });
      }
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

  async resetAutoscaledCapacity() {
    const providerInstanceIds = new Set();
    for (const worker of this.registry.listPublic()) {
      if (worker.provider === 'vast' && worker.providerInstanceId) providerInstanceIds.add(worker.providerInstanceId);
    }
    if (this.instances) {
      for (const instance of this.instances.listPublic()) {
        if (instance.provider === 'vast' && instance.providerInstanceId) providerInstanceIds.add(instance.providerInstanceId);
      }
    }
    for (const instanceId of this.managedInstances.keys()) {
      if (instanceId) providerInstanceIds.add(instanceId);
    }

    const liveInstances = await this.provider.listInstances().catch(() => []);
    for (const instance of liveInstances) {
      const instanceId = String(instance?.id || instance?.instance_id || '');
      const label = String(instance?.label || instance?.name || '');
      if (instanceId && label.startsWith('terarium-llm-')) providerInstanceIds.add(instanceId);
    }

    const destroyed = [];
    const destroyFailed = [];
    for (const instanceId of providerInstanceIds) {
      try {
        await this.provider.destroyInstance(instanceId);
        destroyed.push(instanceId);
      } catch (error) {
        const message = error.message || String(error);
        if (!/not found/i.test(message)) destroyFailed.push({ instanceId, error: message });
      }
    }

    const removedWorkers = [];
    for (const worker of this.registry.listPublic()) {
      if (worker.provider !== 'vast' && !String(worker.id || '').startsWith('vast-')) continue;
      await this.registry.remove(worker.id).catch(() => null);
      removedWorkers.push(worker.id);
    }
    if (this.instances) {
      for (const instance of this.instances.listPublic()) {
        if (instance.provider !== 'vast' && !String(instance.id || '').startsWith('vast-')) continue;
        await this.instances.remove(instance.id).catch(() => null);
      }
    }

    this.managedInstances.clear();
    this.lastScaleDownAt = nowIso();
    this.record('autoscale_reset', 'destroyed all Vast.ai autoscale capacity', {
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
      config.autoscale.enabled ? 'Vast.ai autoscale enabled' : 'Vast.ai autoscale disabled',
      { destroyCapacity: Boolean(destroyCapacity), reset }
    );
    return this.status();
  }

  status() {
    return {
      enabled: config.autoscale.enabled,
      dryRun: config.autoscale.dryRun,
      interval_ms: config.autoscale.intervalMs,
      sustained_backlog_ms: config.autoscale.sustainedBacklogMs,
      scale_up_cooldown_ms: config.autoscale.scaleUpCooldownMs,
      pending_instance_timeout_ms: config.autoscale.pendingInstanceTimeoutMs,
      backlog_per_worker: config.autoscale.backlogPerWorker,
      target_utilization: config.autoscale.targetUtilization,
      scale_down_utilization: config.autoscale.scaleDownUtilization,
      target_requests_per_second: config.autoscale.targetRequestsPerSecond,
      min_workers: config.autoscale.minWorkers,
      max_workers: config.autoscale.maxWorkers,
      min_gpu_vram_gb: config.autoscale.minGpuVramGb,
      max_gpu_vram_gb: config.autoscale.maxGpuVramGb,
      min_compute_cap: config.autoscale.minComputeCap,
      min_dlperf: config.autoscale.minDlperf,
      exclude_gpu_regex: config.autoscale.excludeGpuRegex,
      max_dollars_per_hour: config.autoscale.maxDollarsPerHour,
      single_gpu_only: config.autoscale.singleGpuOnly,
      worker_model: config.autoscale.workerModel,
      template_uses_router: config.autoscale.templateUsesRouter,
      router_port: config.autoscale.routerPort,
      register_per_gpu: config.autoscale.registerPerGpu,
      last_scale_up_at: this.lastScaleUpAt,
      last_scale_down_at: this.lastScaleDownAt,
      last_decision: this.lastDecision,
      last_offer: publicOffer(this.lastOffer),
      capacity: this.capacity(),
      events: this.events
    };
  }
}
