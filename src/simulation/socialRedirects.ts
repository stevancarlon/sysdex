import {
  evaluateServiceGraph,
  type ServiceContract,
  type ServiceEvaluation,
  type SimulationGraph,
} from "./graph.ts";

export const socialRedirectCapacity = {
  loadBalancer: 950,
  api: 300,
  redis: 1_750,
  postgres: 560,
  queue: 1_200,
  worker: 1_600,
} as const;

export type SocialRedirectOptions = {
  demand: number;
  latencySlo: number;
  errorSlo: number;
};

export function createSocialRedirectContract(options: SocialRedirectOptions): ServiceContract {
  return {
    ...options,
    entryKinds: ["loadBalancer"],
    responseSinkKinds: ["postgres"],
    requiredResponseKinds: ["loadBalancer", "api", "postgres"],
    tierLatencyMs: {
      loadBalancer: 5,
      api: 20,
      postgres: 120,
    },
    cache: {
      kind: "redis",
      backingKind: "postgres",
      backingCapacityMultiplier: 3.125,
      latencyMs: 8,
      backingLatencyWhenCachedMs: 39,
    },
    background: {
      sourceKind: "api",
      queueKind: "queue",
      processorKind: "worker",
      sinkKinds: ["postgres"],
      trafficFraction: 0.32,
      synchronousLatencyMs: 60,
      asynchronousLatencyBenefitMs: 12,
    },
    loadPenaltyThreshold: 0.72,
    loadPenaltyMs: 74,
    replicaLatencyBenefitMs: 3,
    maximumReplicaLatencyBenefitMs: 12,
  };
}

export function evaluateSocialRedirectGraph(
  graph: SimulationGraph,
  options: SocialRedirectOptions,
): ServiceEvaluation {
  return evaluateServiceGraph(graph, createSocialRedirectContract(options));
}
