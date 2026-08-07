export type WorkloadTrafficPattern = "steady" | "wave" | "burst";

function deterministicUnit(seed: number, index: number) {
  let value = (seed ^ Math.imul(index + 1, 0x45d9f3b)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) / 0xffffffff;
}

export function workloadDemandAt(
  pattern: WorkloadTrafficPattern,
  peakRps: number,
  seed: number,
  operatingSeconds: number,
) {
  const safePeak = Math.max(0, peakRps);
  const safeTime = Math.max(0, operatingSeconds);
  if (pattern === "steady") return Math.round(safePeak);
  if (pattern === "wave") {
    const phase = (seed % 360) * Math.PI / 180;
    const factor = 0.62 + (0.5 + 0.5 * Math.sin(safeTime * Math.PI / 6 + phase)) * 0.38;
    return Math.round(safePeak * factor);
  }
  const bucket = Math.floor(safeTime / 2);
  const peak = (bucket + seed) % 4 === 0;
  const factor = peak ? 1 : 0.46 + deterministicUnit(seed, bucket) * 0.26;
  return Math.round(safePeak * factor);
}
