import type { BackgroundMode, ServiceEvaluation } from "./graph.ts";

export type BackgroundCorrectnessContract = {
  maxLagSeconds: number;
  minimumDeliveryPercent: number;
};

export type BackgroundCorrectnessStatus = "not-required" | "missing" | "backlogged" | "stale" | "blocking" | "healthy";

export type BackgroundCorrectnessEvaluation = {
  required: boolean;
  mode: BackgroundMode;
  status: BackgroundCorrectnessStatus;
  deliveryPercent: number;
  lagSeconds: number;
  backlogRps: number;
  meetsContract: boolean;
  maxLagSeconds: number | null;
  minimumDeliveryPercent: number | null;
};

/**
 * Converts queue arrival, drain, and lag signals into an observable data
 * contract. It does not care which campaign is running or which topology was
 * expected; correctness follows only from the evaluated directed graph.
 */
export function evaluateBackgroundCorrectness(
  evaluation: ServiceEvaluation,
  contract?: BackgroundCorrectnessContract,
): BackgroundCorrectnessEvaluation {
  if (!contract) {
    return {
      required: false,
      mode: evaluation.backgroundMode,
      status: "not-required",
      deliveryPercent: 100,
      lagSeconds: 0,
      backlogRps: 0,
      meetsContract: true,
      maxLagSeconds: null,
      minimumDeliveryPercent: null,
    };
  }

  const arrival = Math.max(0, evaluation.backgroundArrivalRps);
  const backlog = Math.max(0, evaluation.backgroundBacklogRps);
  const delivered = Math.max(0, arrival - backlog);
  const deliveryPercent = arrival > 0 ? Math.min(100, (delivered / arrival) * 100) : 100;
  const lagSeconds = Number.isFinite(evaluation.backgroundLagSeconds)
    ? Math.max(0, evaluation.backgroundLagSeconds)
    : Number.POSITIVE_INFINITY;
  const missing = evaluation.backgroundMode === "missing";
  const deliveryMet = deliveryPercent >= contract.minimumDeliveryPercent;
  const lagMet = lagSeconds <= contract.maxLagSeconds;
  const meetsContract = !missing && evaluation.backgroundHealthy && deliveryMet && lagMet;
  const status: BackgroundCorrectnessStatus = missing
    ? "missing"
    : !evaluation.backgroundHealthy || !deliveryMet
      ? "backlogged"
      : !lagMet
        ? "stale"
        : evaluation.backgroundMode === "synchronous"
          ? "blocking"
          : "healthy";

  return {
    required: true,
    mode: evaluation.backgroundMode,
    status,
    deliveryPercent,
    lagSeconds,
    backlogRps: backlog,
    meetsContract,
    maxLagSeconds: contract.maxLagSeconds,
    minimumDeliveryPercent: contract.minimumDeliveryPercent,
  };
}
