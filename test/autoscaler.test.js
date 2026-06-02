import test from 'node:test';
import assert from 'node:assert/strict';
import { Autoscaler } from '../src/autoscaler.js';
import { config } from '../src/config.js';

function createAutoscaler(provider) {
  return new Autoscaler({
    providers: [provider],
    queue: {
      sample() {},
      recentSamples() {
        return [];
      }
    },
    registry: {
      listPublic() {
        return [];
      }
    },
    healthMonitor: {},
    instances: {
      listPublic() {
        return [];
      }
    }
  });
}

test('temporarily blocks an offer after RunPod reports stale capacity', async () => {
  const previousEnabled = config.autoscale.enabled;
  const previousDryRun = config.autoscale.dryRun;
  const previousCooldownMs = config.autoscale.failedOfferCooldownMs;
  config.autoscale.enabled = true;
  config.autoscale.dryRun = false;
  config.autoscale.failedOfferCooldownMs = 300000;

  let createCalls = 0;
  const offer = {
    id: 'SECURE:NVIDIA RTX A5000',
    provider: 'runpod',
    cloudType: 'SECURE',
    gpu_name: 'RTX A5000',
    gpu_vram_gb: 24,
    dollars_per_hour: 0.27,
    score: 0.27
  };
  const provider = {
    name: 'runpod-secure',
    label: 'RunPod Secure',
    async searchOffers() {
      return [offer];
    },
    async createInstance() {
      createCalls += 1;
      throw new Error('create pod: This machine does not have the resources to deploy your pod. Please try a different machine');
    }
  };

  try {
    const autoscaler = createAutoscaler(provider);
    await autoscaler.scaleUp({ reason: 'test' });
    await autoscaler.scaleUp({ reason: 'test again' });

    assert.equal(createCalls, 1);
    assert.equal(autoscaler.status().failed_offer_cooldowns.length, 1);
    assert.equal(autoscaler.status().failed_offer_cooldowns[0].offer.id, offer.id);
  } finally {
    config.autoscale.enabled = previousEnabled;
    config.autoscale.dryRun = previousDryRun;
    config.autoscale.failedOfferCooldownMs = previousCooldownMs;
  }
});

test('tries the next offer after cooling down a stale offer', async () => {
  const previousEnabled = config.autoscale.enabled;
  const previousDryRun = config.autoscale.dryRun;
  const previousCooldownMs = config.autoscale.failedOfferCooldownMs;
  config.autoscale.enabled = true;
  config.autoscale.dryRun = false;
  config.autoscale.failedOfferCooldownMs = 300000;

  const calls = [];
  const provider = {
    name: 'runpod-secure',
    label: 'RunPod Secure',
    async searchOffers() {
      return [
        { id: 'stale-a5000', provider: 'runpod', gpu_name: 'RTX A5000', gpu_vram_gb: 24, dollars_per_hour: 0.27, score: 0.27 },
        { id: 'live-3090', provider: 'runpod', gpu_name: 'RTX 3090', gpu_vram_gb: 24, dollars_per_hour: 0.31, score: 0.31 }
      ];
    },
    async createInstance(offer) {
      calls.push(offer.id);
      if (offer.id === 'stale-a5000') throw new Error('resource unavailable');
      return { id: 'pod-1', success: true };
    }
  };

  try {
    const autoscaler = createAutoscaler(provider);
    await autoscaler.scaleUp({ reason: 'test' });

    assert.deepEqual(calls, ['stale-a5000', 'live-3090']);
    assert.equal(autoscaler.lastOffer.id, 'live-3090');
    assert.equal(autoscaler.managedInstances.has('pod-1'), true);
  } finally {
    config.autoscale.enabled = previousEnabled;
    config.autoscale.dryRun = previousDryRun;
    config.autoscale.failedOfferCooldownMs = previousCooldownMs;
  }
});
