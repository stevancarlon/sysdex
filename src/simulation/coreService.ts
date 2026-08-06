import {
  evaluateServiceGraph,
  type ServiceContract,
  type ServiceEvaluation,
  type SimulationGraph,
} from "./graph.ts";

export const coreComponentCapacity = {
  loadBalancer: 950,
  api: 300,
  redis: 1_750,
  postgres: 560,
  queue: 1_200,
  worker: 1_600,
} as const;

export type CoreServiceOptions = {
  demand: number;
  latencySlo: number;
  errorSlo: number;
};

export function createCoreServiceContract(options: CoreServiceOptions): ServiceContract {
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
    loadPenaltyThreshold: 0.72,
    loadPenaltyMs: 74,
    replicaKind: "api",
    replicaLatencyBenefitMs: 3,
    maximumReplicaLatencyBenefitMs: 12,
  };
}

export function evaluateCoreServiceGraph(
  graph: SimulationGraph,
  options: CoreServiceOptions,
): ServiceEvaluation {
  return evaluateServiceGraph(graph, createCoreServiceContract(options));
}
