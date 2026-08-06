import { coreComponentCapacity } from "./coreService.ts";
import {
  evaluateServiceGraph,
  type ServiceContract,
  type ServiceEvaluation,
  type SimulationGraph,
  type TierCapacity,
} from "./graph.ts";

export const infrastructureComponentCapacity = {
  ...coreComponentCapacity,
  geoIndex: 3_200,
  objectStorage: 5_000,
  cdn: 4_000,
} as const;

export type SpecializedWorkloadOptions = {
  demand: number;
  latencySlo: number;
  errorSlo: number;
};

export type SpecializedEvaluation = ServiceEvaluation & {
  routeCapacities: {
    request: number;
    delivery?: number;
    background?: number;
  };
};

function withEffectiveCapacity(evaluation: ServiceEvaluation): SpecializedEvaluation {
  const backgroundCapacity = evaluation.backgroundMode === "none"
    ? Number.POSITIVE_INFINITY
    : evaluation.backgroundCapacity;
  const capacity = Math.min(evaluation.requestCapacity, backgroundCapacity);
  return {
    ...evaluation,
    capacity,
    meetsContract: evaluation.meetsContract,
    routeCapacities: {
      request: evaluation.requestCapacity,
      background: evaluation.backgroundMode === "none" ? undefined : evaluation.backgroundCapacity,
    },
  };
}

export function createMatchingContract(options: SpecializedWorkloadOptions): ServiceContract {
  return {
    ...options,
    entryKinds: ["loadBalancer"],
    responseSinkKinds: ["postgres"],
    requiredResponseKinds: ["loadBalancer", "api", "geoIndex", "postgres"],
    tierLatencyMs: {
      loadBalancer: 5,
      api: 18,
      geoIndex: 12,
      postgres: 85,
    },
    cache: {
      kind: "redis",
      backingKind: "postgres",
      backingCapacityMultiplier: 3.125,
      latencyMs: 7,
      backingLatencyWhenCachedMs: 8,
    },
    loadPenaltyThreshold: 0.72,
    loadPenaltyMs: 74,
    replicaKind: "api",
    replicaLatencyBenefitMs: 2,
    maximumReplicaLatencyBenefitMs: 10,
  };
}

export function evaluateMatchingGraph(
  graph: SimulationGraph,
  options: SpecializedWorkloadOptions,
): SpecializedEvaluation {
  return withEffectiveCapacity(evaluateServiceGraph(graph, createMatchingContract(options)));
}

export function createDispatchContract(options: SpecializedWorkloadOptions): ServiceContract {
  return {
    ...options,
    entryKinds: ["loadBalancer"],
    responseSinkKinds: ["postgres"],
    requiredResponseKinds: ["loadBalancer", "api", "geoIndex", "postgres"],
    tierLatencyMs: {
      loadBalancer: 4,
      api: 12,
      geoIndex: 7,
      postgres: 80,
    },
    cache: {
      kind: "redis",
      backingKind: "postgres",
      backingCapacityMultiplier: 3.125,
      latencyMs: 6,
      backingLatencyWhenCachedMs: 7,
    },
    background: {
      sourceKind: "api",
      queueKind: "queue",
      processorKind: "worker",
      sinkKinds: ["postgres"],
      trafficFraction: 0.42,
      synchronousLatencyMs: 70,
      asynchronousLatencyBenefitMs: 7,
    },
    loadPenaltyThreshold: 0.72,
    loadPenaltyMs: 68,
    replicaKind: "api",
    replicaLatencyBenefitMs: 1.5,
    maximumReplicaLatencyBenefitMs: 9,
  };
}

export function evaluateDispatchGraph(
  graph: SimulationGraph,
  options: SpecializedWorkloadOptions,
): SpecializedEvaluation {
  return withEffectiveCapacity(evaluateServiceGraph(graph, createDispatchContract(options)));
}

const streamingTraffic = {
  metadata: 0.22,
  playback: 0.78,
  mediaJobs: 0.18,
} as const;

function scaleTiers(tiers: TierCapacity[], divisor: number) {
  return tiers.map((tier) => ({ ...tier, capacity: tier.capacity / divisor }));
}

/**
 * Streaming has two independent user-facing paths and one asynchronous write
 * path. Evaluating them separately allows a CDN to offload playback without
 * pretending that it also scales metadata APIs or video transcoding.
 */
export function evaluateStreamingGraph(
  graph: SimulationGraph,
  options: SpecializedWorkloadOptions,
): SpecializedEvaluation {
  const originDemand = options.demand * streamingTraffic.metadata;
  const origin = evaluateServiceGraph(graph, {
    demand: originDemand,
    latencySlo: options.latencySlo,
    errorSlo: options.errorSlo,
    entryKinds: ["loadBalancer"],
    responseSinkKinds: ["postgres"],
    requiredResponseKinds: ["loadBalancer", "api", "postgres"],
    tierLatencyMs: {
      loadBalancer: 4,
      api: 16,
      postgres: 85,
    },
    cache: {
      kind: "redis",
      backingKind: "postgres",
      backingCapacityMultiplier: 3.125,
      latencyMs: 6,
      backingLatencyWhenCachedMs: 9,
    },
    background: {
      sourceKind: "api",
      queueKind: "queue",
      processorKind: "worker",
      sinkKinds: ["objectStorage"],
      trafficFraction: streamingTraffic.mediaJobs / streamingTraffic.metadata,
      synchronousLatencyMs: 72,
      asynchronousLatencyBenefitMs: 7,
    },
    loadPenaltyThreshold: 0.72,
    loadPenaltyMs: 64,
    replicaKind: "api",
    replicaLatencyBenefitMs: 1.5,
    maximumReplicaLatencyBenefitMs: 8,
  });

  const deliveryDemand = options.demand * streamingTraffic.playback;
  const delivery = evaluateServiceGraph(graph, {
    demand: deliveryDemand,
    latencySlo: options.latencySlo,
    errorSlo: options.errorSlo,
    entryKinds: ["cdn"],
    responseSinkKinds: ["objectStorage"],
    requiredResponseKinds: ["cdn", "objectStorage"],
    tierLatencyMs: {
      cdn: 11,
      objectStorage: 18,
    },
    loadPenaltyThreshold: 0.78,
    loadPenaltyMs: 42,
    replicaKind: "cdn",
    replicaLatencyBenefitMs: 2,
    maximumReplicaLatencyBenefitMs: 6,
  });

  const requestCapacity = origin.requestCapacity / streamingTraffic.metadata;
  const deliveryCapacity = delivery.requestCapacity / streamingTraffic.playback;
  const backgroundCapacity = origin.backgroundCapacity / streamingTraffic.metadata;
  const capacity = Math.min(requestCapacity, deliveryCapacity, backgroundCapacity);
  const hasResponsePath = origin.hasResponsePath && delivery.hasResponsePath;
  const errors = options.demand > 0
    ? Math.max(0, ((options.demand - capacity) / options.demand) * 100)
    : 0;
  const latency = hasResponsePath ? Math.max(origin.latency, delivery.latency) : 0;
  const limitingRoute = [
    { capacity: requestCapacity, kind: origin.bottleneckKind },
    { capacity: deliveryCapacity, kind: delivery.bottleneckKind },
    { capacity: backgroundCapacity, kind: origin.backgroundBottleneckKind },
  ].sort((left, right) => left.capacity - right.capacity)[0];
  const originDisconnected = new Set(origin.disconnectedNodeIds);
  const deliveryDisconnected = new Set(delivery.disconnectedNodeIds);
  const disconnectedNodeIds = graph.nodes
    .filter((node) => originDisconnected.has(node.id) && deliveryDisconnected.has(node.id))
    .map((node) => node.id);
  const missingKinds = [...new Set([
    ...origin.missingKinds,
    ...delivery.missingKinds,
    ...(origin.backgroundMode === "missing" ? ["queue", "worker"] : []),
  ])];
  const tierCapacities = [
    ...scaleTiers(origin.tierCapacities, streamingTraffic.metadata),
    ...scaleTiers(delivery.tierCapacities, streamingTraffic.playback),
  ];
  const backgroundArrivalRps = options.demand * streamingTraffic.mediaJobs;
  const rawBackgroundDrainRps = origin.backgroundCapacity * (streamingTraffic.mediaJobs / streamingTraffic.metadata);
  const backgroundBacklogRps = Math.max(0, backgroundArrivalRps - rawBackgroundDrainRps);
  const backgroundHealthy = origin.backgroundMode !== "missing" && backgroundCapacity >= options.demand;

  return {
    capacity,
    requestCapacity,
    latency,
    errors,
    hasResponsePath,
    meetsContract: hasResponsePath
      && capacity >= options.demand
      && latency <= options.latencySlo
      && errors < options.errorSlo
      && backgroundHealthy,
    bottleneckKind: limitingRoute.kind,
    missingKinds,
    responsePathNodeIds: [...new Set([...origin.responsePathNodeIds, ...delivery.responsePathNodeIds])],
    disconnectedNodeIds,
    tierCapacities,
    backgroundMode: origin.backgroundMode,
    backgroundCapacity,
    backgroundArrivalRps,
    backgroundBacklogRps,
    backgroundLagSeconds: origin.backgroundLagSeconds,
    backgroundHealthy,
    backgroundProcessorCount: origin.backgroundProcessorCount,
    backgroundBottleneckKind: origin.backgroundBottleneckKind,
    cacheOperational: origin.cacheOperational,
    routeCapacities: {
      request: requestCapacity,
      delivery: deliveryCapacity,
      background: backgroundCapacity,
    },
  };
}
