export type DrillBackgroundMode = "none" | "missing" | "synchronous" | "asynchronous";
export type DrillTopologyMode = "automatic" | "manual";
export type DrillTrend = "better" | "worse" | "same" | "neutral";

export type DrillSnapshotV1 = {
  version: 1;
  phaseIndex: number;
  completedAt: number;
  passed: boolean;
  capacity: number;
  latency: number;
  errors: number;
  spend: number;
  machineCount: number;
  connectedMachineCount: number;
  configCount: number;
  backgroundMode: DrillBackgroundMode;
  topologyMode: DrillTopologyMode;
};

export type DrillDelta = {
  value: number;
  trend: DrillTrend;
};

export type DrillComparison = {
  previous: DrillSnapshotV1;
  current: DrillSnapshotV1;
  outcomeChanged: boolean;
  backgroundModeChanged: boolean;
  topologyModeChanged: boolean;
  capacity: DrillDelta;
  latency: DrillDelta;
  errors: DrillDelta;
  spend: DrillDelta;
  machineCount: DrillDelta;
  connectedMachineCount: DrillDelta;
};

const backgroundModes = new Set<DrillBackgroundMode>(["none", "missing", "synchronous", "asynchronous"]);
const topologyModes = new Set<DrillTopologyMode>(["automatic", "manual"]);

function isFiniteNumber(value: unknown, minimum = 0) {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function measuredDelta(value: number, lowerIsBetter: boolean): DrillDelta {
  if (Math.abs(value) < 0.0001) return { value: 0, trend: "same" };
  const better = lowerIsBetter ? value < 0 : value > 0;
  return { value, trend: better ? "better" : "worse" };
}

export function validateDrillSnapshot(value: unknown, expectedPhaseIndex: number): DrillSnapshotV1 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DrillSnapshotV1>;
  if (candidate.version !== 1 || candidate.phaseIndex !== expectedPhaseIndex) return null;
  if (!Number.isInteger(candidate.phaseIndex) || !Number.isInteger(candidate.completedAt) || candidate.completedAt! < 0) return null;
  if (typeof candidate.passed !== "boolean") return null;
  if (!isFiniteNumber(candidate.capacity) || !isFiniteNumber(candidate.latency) || !isFiniteNumber(candidate.errors)) return null;
  if (!isFiniteNumber(candidate.spend) || !Number.isInteger(candidate.machineCount) || candidate.machineCount! < 0) return null;
  if (!Number.isInteger(candidate.connectedMachineCount) || candidate.connectedMachineCount! < 0 || candidate.connectedMachineCount! > candidate.machineCount!) return null;
  if (!Number.isInteger(candidate.configCount) || candidate.configCount! < 0) return null;
  if (!backgroundModes.has(candidate.backgroundMode as DrillBackgroundMode)) return null;
  if (!topologyModes.has(candidate.topologyMode as DrillTopologyMode)) return null;
  return candidate as DrillSnapshotV1;
}

export function compareDrillRuns(previous: DrillSnapshotV1, current: DrillSnapshotV1): DrillComparison | null {
  if (previous.phaseIndex !== current.phaseIndex) return null;
  return {
    previous,
    current,
    outcomeChanged: previous.passed !== current.passed,
    backgroundModeChanged: previous.backgroundMode !== current.backgroundMode,
    topologyModeChanged: previous.topologyMode !== current.topologyMode,
    capacity: measuredDelta(current.capacity - previous.capacity, false),
    latency: measuredDelta(current.latency - previous.latency, true),
    errors: measuredDelta(current.errors - previous.errors, true),
    spend: measuredDelta(current.spend - previous.spend, true),
    machineCount: {
      value: current.machineCount - previous.machineCount,
      trend: current.machineCount === previous.machineCount ? "same" : "neutral",
    },
    connectedMachineCount: measuredDelta(current.connectedMachineCount - previous.connectedMachineCount, false),
  };
}
