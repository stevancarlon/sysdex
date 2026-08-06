import {
  evaluateServiceGraph,
  type ServiceContract,
  type ServiceEvaluation,
  type SimulationGraph,
} from "./graph.ts";
import {
  coreComponentCapacity,
  createCoreServiceContract,
  type CoreServiceOptions,
} from "./coreService.ts";

export const socialRedirectCapacity = coreComponentCapacity;

export type SocialRedirectOptions = CoreServiceOptions;

export function createSocialRedirectContract(options: SocialRedirectOptions): ServiceContract {
  return {
    ...createCoreServiceContract(options),
    background: {
      sourceKind: "api",
      queueKind: "queue",
      processorKind: "worker",
      sinkKinds: ["postgres"],
      trafficFraction: 0.32,
      synchronousLatencyMs: 60,
      asynchronousLatencyBenefitMs: 12,
    },
  };
}

export function evaluateSocialRedirectGraph(
  graph: SimulationGraph,
  options: SocialRedirectOptions,
): ServiceEvaluation {
  return evaluateServiceGraph(graph, createSocialRedirectContract(options));
}
