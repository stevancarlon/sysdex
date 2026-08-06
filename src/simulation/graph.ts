export type SimulationNodeState = "healthy" | "degraded" | "failed";

export type SimulationEdgeMode =
  | "request"
  | "cache"
  | "enqueue"
  | "consume"
  | "commit"
  | "replicate";

export type SimulationNode = {
  id: string;
  kind: string;
  capacity: number;
  state?: SimulationNodeState;
  capacityMultiplier?: number;
};

export type SimulationEdge = {
  from: string;
  to: string;
  mode: SimulationEdgeMode;
};

export type SimulationGraph = {
  nodes: SimulationNode[];
  edges: SimulationEdge[];
};

export type CacheContract = {
  kind: string;
  backingKind: string;
  backingCapacityMultiplier: number;
  latencyMs: number;
  backingLatencyWhenCachedMs: number;
};

export type BackgroundContract = {
  sourceKind: string;
  queueKind: string;
  processorKind: string;
  sinkKinds: string[];
  trafficFraction: number;
  synchronousLatencyMs: number;
  asynchronousLatencyBenefitMs: number;
};

export type ServiceContract = {
  demand: number;
  latencySlo: number;
  errorSlo: number;
  entryKinds: string[];
  responseSinkKinds: string[];
  requiredResponseKinds: string[];
  tierLatencyMs: Record<string, number>;
  cache?: CacheContract;
  background?: BackgroundContract;
  loadPenaltyThreshold?: number;
  loadPenaltyMs?: number;
  replicaLatencyBenefitMs?: number;
  maximumReplicaLatencyBenefitMs?: number;
};

export type BackgroundMode = "none" | "missing" | "synchronous" | "asynchronous";

export type TierCapacity = {
  kind: string;
  capacity: number;
};

export type ServiceEvaluation = {
  capacity: number;
  requestCapacity: number;
  latency: number;
  errors: number;
  hasResponsePath: boolean;
  meetsContract: boolean;
  bottleneckKind: string | null;
  missingKinds: string[];
  responsePathNodeIds: string[];
  disconnectedNodeIds: string[];
  tierCapacities: TierCapacity[];
  backgroundMode: BackgroundMode;
  backgroundCapacity: number;
  backgroundArrivalRps: number;
  backgroundBacklogRps: number;
  backgroundLagSeconds: number;
  backgroundHealthy: boolean;
  backgroundProcessorCount: number;
  cacheOperational: boolean;
};

const responseEdgeModes = new Set<SimulationEdgeMode>(["request", "cache"]);

function stateMultiplier(state: SimulationNodeState | undefined) {
  if (state === "failed") return 0;
  if (state === "degraded") return 0.55;
  return 1;
}

function effectiveCapacity(node: SimulationNode) {
  return node.capacity * stateMultiplier(node.state) * (node.capacityMultiplier ?? 1);
}

function reachableFrom(starts: Iterable<string>, adjacency: Map<string, string[]>) {
  const visited = new Set<string>();
  const pending = [...starts];
  while (pending.length > 0) {
    const id = pending.pop();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    for (const next of adjacency.get(id) ?? []) {
      if (!visited.has(next)) pending.push(next);
    }
  }
  return visited;
}

function sumCapacity(nodes: SimulationNode[]) {
  return nodes.reduce((total, node) => total + effectiveCapacity(node), 0);
}

function unique<T>(items: T[]) {
  return [...new Set(items)];
}

/**
 * Evaluates observable service behavior from a directed topology. A machine only
 * contributes when it is healthy enough and lies on a complete path; merely
 * placing an unconnected replica never increases capacity.
 */
export function evaluateServiceGraph(graph: SimulationGraph, contract: ServiceContract): ServiceEvaluation {
  const activeNodes = graph.nodes.filter((node) => effectiveCapacity(node) > 0);
  const nodeById = new Map(activeNodes.map((node) => [node.id, node]));
  const activeEdges = graph.edges.filter((edge) => nodeById.has(edge.from) && nodeById.has(edge.to));
  const forward = new Map<string, string[]>();
  const reverse = new Map<string, string[]>();

  for (const edge of activeEdges) {
    if (!responseEdgeModes.has(edge.mode)) continue;
    forward.set(edge.from, [...(forward.get(edge.from) ?? []), edge.to]);
    reverse.set(edge.to, [...(reverse.get(edge.to) ?? []), edge.from]);
  }

  const entryIds = activeNodes
    .filter((node) => contract.entryKinds.includes(node.kind))
    .map((node) => node.id);
  const sinkIds = activeNodes
    .filter((node) => contract.responseSinkKinds.includes(node.kind))
    .map((node) => node.id);
  const reachableFromEntry = reachableFrom(entryIds, forward);
  const canReachSink = reachableFrom(sinkIds, reverse);
  const responsePathIds = new Set(
    activeNodes
      .filter((node) => reachableFromEntry.has(node.id) && canReachSink.has(node.id))
      .map((node) => node.id),
  );
  const responseNodes = activeNodes.filter((node) => responsePathIds.has(node.id));
  const functionalNodeIds = new Set(responsePathIds);
  const presentResponseKinds = new Set(responseNodes.map((node) => node.kind));
  const missingKinds = contract.requiredResponseKinds.filter((kind) => !presentResponseKinds.has(kind));
  const hasResponsePath = entryIds.some((id) => canReachSink.has(id)) && missingKinds.length === 0;

  const cacheNodes = contract.cache
    ? responseNodes.filter((node) => node.kind === contract.cache!.kind)
    : [];
  const cacheOperational = cacheNodes.length > 0;
  const tierCapacities: TierCapacity[] = [];

  if (hasResponsePath) {
    for (const kind of contract.requiredResponseKinds) {
      let capacity = sumCapacity(responseNodes.filter((node) => node.kind === kind));
      if (cacheOperational && kind === contract.cache?.backingKind) {
        capacity *= contract.cache.backingCapacityMultiplier;
      }
      tierCapacities.push({ kind, capacity });
    }
    if (cacheOperational && contract.cache) {
      tierCapacities.push({ kind: contract.cache.kind, capacity: sumCapacity(cacheNodes) });
    }
  }

  let backgroundMode: BackgroundMode = contract.background ? "missing" : "none";
  let backgroundCapacity = contract.background ? 0 : Number.POSITIVE_INFINITY;
  let backgroundIngressCapacity = contract.background ? 0 : Number.POSITIVE_INFINITY;
  let backgroundProcessorCount = 0;

  if (hasResponsePath && contract.background) {
    const background = contract.background;
    const sourceIds = new Set(
      responseNodes.filter((node) => node.kind === background.sourceKind).map((node) => node.id),
    );
    const validSinkIds = new Set(
      activeNodes.filter((node) => background.sinkKinds.includes(node.kind)).map((node) => node.id),
    );
    const processorsWithCommit = new Set(
      activeEdges
        .filter((edge) => edge.mode === "commit" && validSinkIds.has(edge.to))
        .map((edge) => edge.from),
    );
    const synchronousProcessorIds = unique(
      activeEdges
        .filter((edge) => edge.mode === "request" && sourceIds.has(edge.from) && processorsWithCommit.has(edge.to))
        .map((edge) => edge.to),
    );

    const enqueuedQueueIds = new Set(
      activeEdges
        .filter((edge) => edge.mode === "enqueue" && sourceIds.has(edge.from))
        .map((edge) => edge.to)
        .filter((id) => nodeById.get(id)?.kind === background.queueKind),
    );
    const asynchronousProcessorIds = unique(
      activeEdges
        .filter((edge) => edge.mode === "consume" && enqueuedQueueIds.has(edge.from) && processorsWithCommit.has(edge.to))
        .map((edge) => edge.to)
        .filter((id) => nodeById.get(id)?.kind === background.processorKind),
    );

    const queueCapacity = sumCapacity([...enqueuedQueueIds].map((id) => nodeById.get(id)).filter((node): node is SimulationNode => Boolean(node)));
    if (enqueuedQueueIds.size > 0) {
      backgroundMode = "asynchronous";
      backgroundIngressCapacity = queueCapacity / background.trafficFraction;
      for (const id of enqueuedQueueIds) functionalNodeIds.add(id);
    }
    if (asynchronousProcessorIds.length > 0) {
      const processorCapacity = sumCapacity(asynchronousProcessorIds.map((id) => nodeById.get(id)).filter((node): node is SimulationNode => Boolean(node)));
      backgroundMode = "asynchronous";
      backgroundCapacity = Math.min(queueCapacity, processorCapacity) / background.trafficFraction;
      backgroundProcessorCount = asynchronousProcessorIds.reduce(
        (total, id) => total + stateMultiplier(nodeById.get(id)?.state),
        0,
      );
      for (const id of asynchronousProcessorIds) functionalNodeIds.add(id);
    }
    if (synchronousProcessorIds.length > 0) {
      backgroundMode = "synchronous";
      const synchronousCapacity = sumCapacity(synchronousProcessorIds.map((id) => nodeById.get(id)).filter((node): node is SimulationNode => Boolean(node))) / background.trafficFraction;
      backgroundCapacity = Math.max(backgroundCapacity, synchronousCapacity);
      backgroundProcessorCount = synchronousProcessorIds.reduce(
        (total, id) => total + stateMultiplier(nodeById.get(id)?.state),
        0,
      );
      for (const id of synchronousProcessorIds) functionalNodeIds.add(id);
    }
  }

  if (contract.background) tierCapacities.push({
    kind: backgroundMode === "asynchronous" ? contract.background.queueKind : contract.background.processorKind,
    capacity: backgroundCapacity,
  });

  const responseTierCapacities = tierCapacities
    .filter((tier) => !contract.background || (tier.kind !== contract.background.queueKind && tier.kind !== contract.background.processorKind))
    .map((tier) => tier.capacity)
    .filter(Number.isFinite);
  const requestCapacity = hasResponsePath && responseTierCapacities.length > 0 ? Math.min(...responseTierCapacities) : 0;
  const backgroundArrivalRps = contract.background ? contract.demand * contract.background.trafficFraction : 0;
  const backgroundDrainRps = contract.background ? backgroundCapacity * contract.background.trafficFraction : Number.POSITIVE_INFINITY;
  const backgroundBacklogRps = contract.background ? Math.max(0, backgroundArrivalRps - backgroundDrainRps) : 0;
  const backgroundHealthy = !contract.background || backgroundCapacity >= contract.demand;
  const backgroundLagSeconds = !contract.background
    ? 0
    : backgroundMode === "synchronous"
      ? 0
      : backgroundCapacity <= 0
        ? Number.POSITIVE_INFINITY
        : backgroundBacklogRps > 0
          ? Number.POSITIVE_INFINITY
          : 0.18 + (backgroundArrivalRps / Math.max(1, backgroundDrainRps)) * 0.82;
  const responseBottleneck = tierCapacities
    .filter((tier) => !contract.background || (tier.kind !== contract.background.queueKind && tier.kind !== contract.background.processorKind))
    .filter((tier) => Number.isFinite(tier.capacity))
    .sort((left, right) => left.capacity - right.capacity)[0];
  const backgroundBottleneck = contract.background && !backgroundHealthy
    ? tierCapacities.find((tier) => tier.kind === (backgroundMode === "asynchronous" ? contract.background!.queueKind : contract.background!.processorKind))
    : null;
  const bottleneckTier = requestCapacity < contract.demand ? responseBottleneck : backgroundBottleneck ?? responseBottleneck;
  const utilization = contract.demand / Math.max(1, requestCapacity);

  let latency = 0;
  if (hasResponsePath) {
    latency = contract.requiredResponseKinds.reduce(
      (total, kind) => total + (contract.tierLatencyMs[kind] ?? 0),
      0,
    );
    if (cacheOperational && contract.cache) {
      latency += contract.cache.latencyMs;
      latency -= contract.tierLatencyMs[contract.cache.backingKind] ?? 0;
      latency += contract.cache.backingLatencyWhenCachedMs;
    }
    if (contract.background) {
      if (backgroundMode === "synchronous") {
        latency += contract.background.synchronousLatencyMs / Math.max(1, backgroundProcessorCount);
      } else if (backgroundMode === "asynchronous" && backgroundIngressCapacity >= contract.demand) {
        latency -= contract.background.asynchronousLatencyBenefitMs;
      }
    }
    const apiKind = contract.background?.sourceKind;
    const replicaCount = apiKind
      ? responseNodes.filter((node) => node.kind === apiKind).reduce((total, node) => total + stateMultiplier(node.state), 0)
      : 1;
    latency -= Math.min(
      contract.maximumReplicaLatencyBenefitMs ?? 0,
      Math.max(0, replicaCount - 1) * (contract.replicaLatencyBenefitMs ?? 0),
    );
    latency += Math.max(0, utilization - (contract.loadPenaltyThreshold ?? 0.72)) * (contract.loadPenaltyMs ?? 74);
    latency = Math.round(Math.max(1, latency));
  }

  const errors = contract.demand > 0
    ? Math.max(0, ((contract.demand - requestCapacity) / contract.demand) * 100)
    : 0;
  const disconnectedNodeIds = activeNodes
    .filter((node) => !functionalNodeIds.has(node.id))
    .map((node) => node.id);
  const meetsContract = hasResponsePath
    && requestCapacity >= contract.demand
    && latency <= contract.latencySlo
    && errors < contract.errorSlo
    && backgroundHealthy;

  return {
    capacity: requestCapacity,
    requestCapacity,
    latency,
    errors,
    hasResponsePath,
    meetsContract,
    bottleneckKind: bottleneckTier?.kind ?? missingKinds[0] ?? null,
    missingKinds,
    responsePathNodeIds: [...responsePathIds],
    disconnectedNodeIds,
    tierCapacities,
    backgroundMode,
    backgroundCapacity,
    backgroundArrivalRps,
    backgroundBacklogRps,
    backgroundLagSeconds,
    backgroundHealthy,
    backgroundProcessorCount,
    cacheOperational,
  };
}
