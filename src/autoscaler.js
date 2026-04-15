import { config } from './config.js';
import { VastProvider } from './vast.js';

function nowIso() {
  return new Date().toISOString();
}

export class Autoscaler {
  constructor({ queue, registry, healthMonitor }) {
    this.queue = queue;
    this.registry = registry;
    this.healthMonitor = healthMonitor;
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
    await this.registerInstanceWorker(instanceId, instance);
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
      await this.registerInstanceWorker(instanceId, instance);
    }
  }

  endpointFromInstance(instance) {
    const host = instance?.public_ipaddr || instance?.ssh_host || instance?.host || '';
    if (!host) return '';

    const ports = instance?.ports || instance?.actual_ports || {};
    const portKey = `${config.autoscale.instancePort}/tcp`;
    const mapped = ports[portKey] || ports[String(config.autoscale.instancePort)] || ports[config.autoscale.instancePort];
    const publicPort = Array.isArray(mapped) ? mapped[0]?.HostPort || mapped[0] : mapped?.HostPort || mapped;
    return `http://${host}:${publicPort || config.autoscale.instancePort}`;
  }

  async registerInstanceWorker(instanceId, instance) {
    if (!instanceId || this.registry.get(`vast-${instanceId}`)) return;
    const baseUrl = this.endpointFromInstance(instance);
    if (!baseUrl) return;

    const worker = await this.registry.add({
      id: `vast-${instanceId}`,
      name: `Vast.ai ${instanceId}`,
      type: 'ollama',
      baseUrl,
      models: [config.defaultModel],
      defaultModel: config.defaultModel,
      concurrency: 1,
      enabled: true,
      provider: 'vast',
      providerInstanceId: instanceId,
      autoscaled: true
    });
    await this.healthMonitor.checkOne(worker.id).catch(() => null);
    this.record('worker_registered', 'registered Vast.ai worker', { workerId: worker.id, baseUrl });
  }

  async scaleDown(decision) {
    if (!config.autoscale.enabled || config.autoscale.dryRun) return;

    const candidates = this.registry
      .listPublic()
      .filter((worker) => worker.autoscaled && worker.active === 0 && worker.provider === 'vast' && worker.providerInstanceId);

    const candidate = candidates[0];
    if (!candidate) return;

    await this.provider.destroyInstance(candidate.providerInstanceId);
    await this.registry.remove(candidate.id);
    this.lastScaleDownAt = nowIso();
    this.record('scale_down_destroyed', 'destroyed idle Vast.ai instance', { workerId: candidate.id });
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
