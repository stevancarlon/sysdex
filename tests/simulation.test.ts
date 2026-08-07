import assert from "node:assert/strict";
import test from "node:test";
import {
  socialRedirectCapacity,
  evaluateSocialRedirectGraph,
} from "../src/simulation/socialRedirects.ts";
import { evaluateCoreServiceGraph } from "../src/simulation/coreService.ts";
import {
  evaluateDispatchGraph,
  evaluateMatchingGraph,
  evaluateStreamingGraph,
  infrastructureComponentCapacity,
} from "../src/simulation/specializedWorkloads.ts";
import type {
  SimulationEdge,
  SimulationEdgeMode,
  SimulationGraph,
  SimulationNode,
} from "../src/simulation/graph.ts";
import {
  compareDrillRuns,
  validateDrillSnapshot,
  type DrillSnapshotV1,
} from "../src/simulation/runComparison.ts";
import { evaluateBackgroundCorrectness } from "../src/simulation/correctness.ts";
import {
  decodeSharedBlueprint,
  encodeSharedBlueprint,
  maximumSharedBlueprintLength,
  type SharedBlueprintV1,
} from "../src/simulation/blueprintCodec.ts";
import { workloadDemandAt } from "../src/simulation/workloadTrace.ts";

const options = { demand: 1_200, latencySlo: 115, errorSlo: 1.5 };

function node(id: string, kind: keyof typeof socialRedirectCapacity): SimulationNode {
  return { id, kind, capacity: socialRedirectCapacity[kind] };
}

function edge(from: string, to: string, mode: SimulationEdgeMode): SimulationEdge {
  return { from, to, mode };
}

function infrastructureNode(
  id: string,
  kind: keyof typeof infrastructureComponentCapacity,
): SimulationNode {
  return { id, kind, capacity: infrastructureComponentCapacity[kind] };
}

function replicas(kind: keyof typeof infrastructureComponentCapacity, count: number) {
  return Array.from({ length: count }, (_, index) => infrastructureNode(`${kind}-${index + 1}`, kind));
}

function connectEvery(
  fromNodes: SimulationNode[],
  toNodes: SimulationNode[],
  mode: SimulationEdgeMode,
) {
  const edgeCount = Math.max(fromNodes.length, toNodes.length);
  return Array.from({ length: edgeCount }, (_, index) => edge(
    fromNodes[index % fromNodes.length].id,
    toNodes[index % toNodes.length].id,
    mode,
  ));
}

function nearbyGraph(withBackground = false): SimulationGraph {
  const loadBalancers = replicas("loadBalancer", 9);
  const apis = replicas("api", 29);
  const caches = replicas("redis", 5);
  const geoIndexes = replicas("geoIndex", 3);
  const databases = replicas("postgres", 5);
  const queues = withBackground ? replicas("queue", 3) : [];
  const workers = withBackground ? replicas("worker", 3) : [];
  return {
    nodes: [...loadBalancers, ...apis, ...caches, ...geoIndexes, ...databases, ...queues, ...workers],
    edges: [
      ...connectEvery(loadBalancers, apis, "request"),
      ...connectEvery(apis, caches, "request"),
      ...connectEvery(caches, geoIndexes, "cache"),
      ...connectEvery(geoIndexes, databases, "request"),
      ...(withBackground ? [
        ...connectEvery(apis, queues, "enqueue"),
        ...connectEvery(queues, workers, "consume"),
        ...connectEvery(workers, databases, "commit"),
      ] : []),
    ],
  };
}

function inheritedGraph(): SimulationGraph {
  return {
    nodes: [
      node("lb-1", "loadBalancer"),
      node("lb-2", "loadBalancer"),
      node("api-1", "api"),
      node("api-2", "api"),
      node("api-3", "api"),
      node("api-4", "api"),
      node("cache", "redis"),
      node("analytics-1", "worker"),
      node("database", "postgres"),
    ],
    edges: [
      edge("lb-1", "api-1", "request"),
      edge("lb-1", "api-2", "request"),
      edge("lb-2", "api-3", "request"),
      edge("lb-2", "api-4", "request"),
      edge("api-1", "cache", "request"),
      edge("api-2", "cache", "request"),
      edge("api-3", "cache", "request"),
      edge("api-4", "cache", "request"),
      edge("cache", "database", "cache"),
      edge("api-1", "analytics-1", "request"),
      edge("analytics-1", "database", "commit"),
    ],
  };
}

test("the inherited synchronous analytics path misses latency for a structural reason", () => {
  const result = evaluateSocialRedirectGraph(inheritedGraph(), options);

  assert.equal(result.hasResponsePath, true);
  assert.equal(result.backgroundMode, "synchronous");
  assert.equal(result.capacity, 1_200);
  assert.equal(result.latency, 144);
  assert.equal(result.meetsContract, false);
});

test("an asynchronous queue removes analytics from user latency", () => {
  const graph = inheritedGraph();
  graph.nodes.push(node("events", "queue"));
  graph.edges = graph.edges.filter((candidate) => candidate.to !== "analytics-1");
  graph.edges.push(
    edge("api-1", "events", "enqueue"),
    edge("events", "analytics-1", "consume"),
  );

  const result = evaluateSocialRedirectGraph(graph, options);

  assert.equal(result.backgroundMode, "asynchronous");
  assert.equal(result.backgroundCapacity, 3_750);
  assert.equal(result.latency, 72);
  assert.equal(result.meetsContract, true);
  assert.ok(!result.disconnectedNodeIds.includes("events"));
  assert.ok(!result.disconnectedNodeIds.includes("analytics-1"));
});

test("scaling a synchronous dependency is a valid but costlier alternative", () => {
  const graph = inheritedGraph();
  graph.nodes.push(node("analytics-2", "worker"));
  graph.edges.push(
    edge("api-2", "analytics-2", "request"),
    edge("analytics-2", "database", "commit"),
  );

  const result = evaluateSocialRedirectGraph(graph, options);

  assert.equal(result.backgroundMode, "synchronous");
  assert.equal(result.backgroundProcessorCount, 2);
  assert.equal(result.latency, 114);
  assert.equal(result.meetsContract, true);
});

test("an async side path cannot hide a synchronous dependency that still blocks", () => {
  const graph = inheritedGraph();
  graph.nodes.push(node("events", "queue"));
  graph.edges.push(
    edge("api-1", "events", "enqueue"),
    edge("events", "analytics-1", "consume"),
  );

  const result = evaluateSocialRedirectGraph(graph, options);

  assert.equal(result.backgroundMode, "synchronous");
  assert.equal(result.latency, 144);
  assert.equal(result.meetsContract, false);
});

test("a disconnected replica contributes no request capacity", () => {
  const graph = inheritedGraph();
  graph.nodes = graph.nodes.filter((candidate) => candidate.id !== "api-4");
  graph.edges = graph.edges.filter((candidate) => candidate.from !== "api-4" && candidate.to !== "api-4");
  graph.nodes.push(node("api-disconnected", "api"));

  const result = evaluateSocialRedirectGraph(graph, options);

  assert.equal(result.capacity, 900);
  assert.ok(result.disconnectedNodeIds.includes("api-disconnected"));
  assert.equal(result.meetsContract, false);
});

test("a queue without a reachable consumer preserves redirects but fails event delivery", () => {
  const graph = inheritedGraph();
  graph.nodes.push(node("events", "queue"));
  graph.edges = graph.edges.filter((candidate) => candidate.to !== "analytics-1");
  graph.edges.push(edge("api-1", "events", "enqueue"));

  const result = evaluateSocialRedirectGraph(graph, options);

  assert.equal(result.backgroundMode, "asynchronous");
  assert.equal(result.backgroundCapacity, 0);
  assert.equal(result.capacity, 1_200);
  assert.equal(result.errors, 0);
  assert.equal(result.backgroundBacklogRps, 384);
  assert.equal(result.backgroundLagSeconds, Number.POSITIVE_INFINITY);
  assert.equal(result.meetsContract, false);
});

test("failed and cyclic machines cannot create phantom paths", () => {
  const graph = inheritedGraph();
  graph.nodes.push(node("orphan-a", "api"), node("orphan-b", "redis"));
  graph.edges.push(
    edge("orphan-a", "orphan-b", "request"),
    edge("orphan-b", "orphan-a", "cache"),
  );
  const primaryCache = graph.nodes.find((candidate) => candidate.id === "cache");
  assert.ok(primaryCache);
  primaryCache.state = "failed";

  const result = evaluateSocialRedirectGraph(graph, options);

  assert.equal(result.hasResponsePath, false);
  assert.deepEqual(result.missingKinds, ["loadBalancer", "api", "postgres"]);
  assert.ok(result.disconnectedNodeIds.includes("orphan-a"));
});

test("the first release scales only through connected API replicas", () => {
  const graph: SimulationGraph = {
    nodes: [
      node("lb", "loadBalancer"),
      node("api-1", "api"),
      node("api-2", "api"),
      node("database", "postgres"),
    ],
    edges: [
      edge("lb", "api-1", "request"),
      edge("api-1", "database", "request"),
    ],
  };
  const release = { demand: 500, latencySlo: 160, errorSlo: 2 };

  const disconnected = evaluateCoreServiceGraph(graph, release);
  assert.equal(disconnected.capacity, 300);
  assert.ok(disconnected.disconnectedNodeIds.includes("api-2"));

  graph.edges.push(
    edge("lb", "api-2", "request"),
    edge("api-2", "database", "request"),
  );
  const connected = evaluateCoreServiceGraph(graph, release);
  assert.equal(connected.capacity, 560);
  assert.equal(connected.latency, 155);
  assert.equal(connected.meetsContract, true);
});

test("a cache accelerates storage only when it lies on the response path", () => {
  const graph = inheritedGraph();
  graph.nodes = graph.nodes.filter((candidate) => candidate.kind !== "worker");
  graph.edges = graph.edges.filter((candidate) => candidate.from !== "analytics-1" && candidate.to !== "analytics-1");
  const coreOptions = { demand: 1_200, latencySlo: 115, errorSlo: 1.5 };

  const cached = evaluateCoreServiceGraph(graph, coreOptions);
  assert.equal(cached.cacheOperational, true);
  assert.equal(cached.capacity, 1_200);
  assert.equal(cached.latency, 84);

  graph.edges = graph.edges.filter((candidate) => candidate.from !== "cache" && candidate.to !== "cache");
  graph.edges.push(...["api-1", "api-2", "api-3", "api-4"].map((id) => edge(id, "database", "request")));
  const bypassed = evaluateCoreServiceGraph(graph, coreOptions);
  assert.equal(bypassed.cacheOperational, false);
  assert.equal(bypassed.capacity, 560);
  assert.ok(bypassed.disconnectedNodeIds.includes("cache"));
});

test("a replicated standby is functional without pretending to serve reads", () => {
  const graph: SimulationGraph = {
    nodes: [
      node("lb", "loadBalancer"),
      node("api", "api"),
      node("primary", "postgres"),
      node("standby", "postgres"),
    ],
    edges: [
      edge("lb", "api", "request"),
      edge("api", "primary", "request"),
      edge("primary", "standby", "replicate"),
    ],
  };

  const result = evaluateCoreServiceGraph(graph, { demand: 300, latencySlo: 220, errorSlo: 2 });

  assert.equal(result.capacity, 300);
  assert.ok(!result.disconnectedNodeIds.includes("standby"));
});

test("nearby matching credits only geoshards on a complete query path", () => {
  const graph = nearbyGraph();
  graph.edges = graph.edges.filter((candidate) => candidate.from !== "geoIndex-3" && candidate.to !== "geoIndex-3");
  const options = { demand: 6_200, latencySlo: 68, errorSlo: 0.18 };

  const disconnected = evaluateMatchingGraph(graph, options);
  assert.equal(disconnected.capacity, 6_400);
  assert.ok(disconnected.disconnectedNodeIds.includes("geoIndex-3"));
  assert.equal(disconnected.meetsContract, true);

  graph.edges.push(
    edge("redis-3", "geoIndex-3", "cache"),
    edge("geoIndex-3", "postgres-3", "request"),
  );
  const connected = evaluateMatchingGraph(graph, options);
  assert.equal(connected.capacity, 8_550);
  assert.ok(!connected.disconnectedNodeIds.includes("geoIndex-3"));
});

test("dispatch can be valid synchronously, but async location updates protect p95", () => {
  const graph = nearbyGraph(true);
  const options = { demand: 8_500, latencySlo: 48, errorSlo: 0.1 };
  graph.edges = graph.edges.filter((candidate) => candidate.mode !== "enqueue" && candidate.mode !== "consume");
  graph.edges.push(...connectEvery(
    graph.nodes.filter((candidate) => candidate.kind === "api"),
    graph.nodes.filter((candidate) => candidate.kind === "worker"),
    "request",
  ));

  const synchronous = evaluateDispatchGraph(graph, options);
  assert.equal(synchronous.backgroundMode, "synchronous");
  assert.ok(synchronous.latency > options.latencySlo);
  assert.equal(synchronous.meetsContract, false);

  graph.edges = graph.edges.filter((candidate) => !(candidate.mode === "request" && candidate.to.startsWith("worker-")));
  graph.edges.push(
    ...connectEvery(
      graph.nodes.filter((candidate) => candidate.kind === "api"),
      graph.nodes.filter((candidate) => candidate.kind === "queue"),
      "enqueue",
    ),
    ...connectEvery(
      graph.nodes.filter((candidate) => candidate.kind === "queue"),
      graph.nodes.filter((candidate) => candidate.kind === "worker"),
      "consume",
    ),
  );
  const asynchronous = evaluateDispatchGraph(graph, options);
  assert.equal(asynchronous.backgroundMode, "asynchronous");
  assert.ok(asynchronous.latency <= options.latencySlo);
  assert.equal(asynchronous.meetsContract, true);
});

test("streaming certifies metadata, playback, and transcode routes independently", () => {
  const loadBalancers = replicas("loadBalancer", 2);
  const apis = replicas("api", 6);
  const caches = replicas("redis", 2);
  const databases = replicas("postgres", 2);
  const queues = replicas("queue", 2);
  const workers = replicas("worker", 1);
  const storage = replicas("objectStorage", 2);
  const edges = replicas("cdn", 2);
  const graph: SimulationGraph = {
    nodes: [...loadBalancers, ...apis, ...caches, ...databases, ...queues, ...workers, ...storage, ...edges],
    edges: [
      ...connectEvery(loadBalancers, apis, "request"),
      ...connectEvery(apis, caches, "request"),
      ...connectEvery(caches, databases, "cache"),
      ...connectEvery(apis, queues, "enqueue"),
      ...connectEvery(queues, workers, "consume"),
      ...connectEvery(workers, storage, "commit"),
      ...connectEvery(edges, storage, "cache"),
    ],
  };
  const options = { demand: 8_000, latencySlo: 58, errorSlo: 0.12 };

  const healthy = evaluateStreamingGraph(graph, options);
  assert.equal(Math.round(healthy.capacity), 8_182);
  assert.equal(healthy.backgroundMode, "asynchronous");
  assert.equal(healthy.meetsContract, true);

  graph.edges = graph.edges.filter((candidate) => candidate.from !== "cdn-2");
  const brokenDelivery = evaluateStreamingGraph(graph, options);
  assert.equal(brokenDelivery.hasResponsePath, true);
  assert.equal(Math.round(brokenDelivery.routeCapacities.request), 8_182);
  assert.equal(Math.round(brokenDelivery.capacity), 5_128);
  assert.equal(brokenDelivery.bottleneckKind, "cdn");
  assert.equal(brokenDelivery.meetsContract, false);
});

test("drill comparison treats faster capacity as improvement and higher spend as a tradeoff", () => {
  const previous: DrillSnapshotV1 = {
    version: 1,
    phaseIndex: 1,
    completedAt: 100,
    passed: false,
    capacity: 1120,
    latency: 152,
    errors: 0.8,
    spend: 1290,
    machineCount: 8,
    connectedMachineCount: 8,
    configCount: 0,
    backgroundMode: "synchronous",
    topologyMode: "automatic",
  };
  const current: DrillSnapshotV1 = {
    ...previous,
    completedAt: 200,
    passed: true,
    capacity: 1320,
    latency: 103,
    errors: 0.2,
    spend: 1420,
    machineCount: 9,
    connectedMachineCount: 9,
    backgroundMode: "asynchronous",
  };

  const comparison = compareDrillRuns(previous, current);
  assert.ok(comparison);
  assert.equal(comparison.outcomeChanged, true);
  assert.equal(comparison.backgroundModeChanged, true);
  assert.deepEqual(comparison.capacity, { value: 200, trend: "better" });
  assert.deepEqual(comparison.latency, { value: -49, trend: "better" });
  assert.deepEqual(comparison.spend, { value: 130, trend: "worse" });
  assert.deepEqual(comparison.machineCount, { value: 1, trend: "neutral" });
});

test("persisted drill snapshots are phase-local and reject malformed metrics", () => {
  const valid: DrillSnapshotV1 = {
    version: 1,
    phaseIndex: 6,
    completedAt: 100,
    passed: true,
    capacity: 8000,
    latency: 27,
    errors: 0,
    spend: 4240,
    machineCount: 17,
    connectedMachineCount: 17,
    configCount: 3,
    backgroundMode: "asynchronous",
    topologyMode: "manual",
  };

  assert.deepEqual(validateDrillSnapshot(valid, 6), valid);
  assert.equal(validateDrillSnapshot(valid, 7), null);
  assert.equal(validateDrillSnapshot({ ...valid, connectedMachineCount: 18 }, 6), null);
  assert.equal(validateDrillSnapshot({ ...valid, latency: Number.NaN }, 6), null);
  assert.equal(compareDrillRuns(valid, { ...valid, phaseIndex: 7 }), null);
});

test("background correctness follows delivery and lag rather than a prescribed topology", () => {
  const asynchronousGraph = inheritedGraph();
  asynchronousGraph.nodes.push(node("events", "queue"));
  asynchronousGraph.edges = asynchronousGraph.edges.filter((candidate) => candidate.to !== "analytics-1");
  asynchronousGraph.edges.push(
    edge("api-1", "events", "enqueue"),
    edge("events", "analytics-1", "consume"),
  );
  const synchronous = evaluateSocialRedirectGraph(inheritedGraph(), options);
  const asynchronous = evaluateSocialRedirectGraph(asynchronousGraph, options);
  const contract = { minimumDeliveryPercent: 99.5, maxLagSeconds: 1 };

  const blocking = evaluateBackgroundCorrectness(synchronous, contract);
  assert.equal(blocking.meetsContract, true);
  assert.equal(blocking.status, "blocking");
  assert.equal(blocking.deliveryPercent, 100);

  const isolated = evaluateBackgroundCorrectness(asynchronous, contract);
  assert.equal(isolated.meetsContract, true);
  assert.equal(isolated.status, "healthy");
  assert.ok(isolated.lagSeconds < 1);

  const underprovisionedGraph = inheritedGraph();
  underprovisionedGraph.nodes.push(node("events", "queue"));
  underprovisionedGraph.edges = underprovisionedGraph.edges.filter((candidate) => candidate.to !== "analytics-1");
  underprovisionedGraph.edges.push(edge("api-1", "events", "enqueue"));
  const underprovisioned = evaluateSocialRedirectGraph(underprovisionedGraph, options);
  const failing = evaluateBackgroundCorrectness(underprovisioned, contract);
  assert.equal(failing.meetsContract, false);
  assert.equal(failing.status, "backlogged");
  assert.ok(failing.deliveryPercent < 99.5);
});

test("shared blueprints round-trip compact manual graph tuples", () => {
  const payload: SharedBlueprintV1 = {
    v: 1,
    p: 1,
    m: 1,
    n: [[1, 0, 1, 3], [2, 1, 3, 3, 1], [3, 4, 5, 3]],
    e: [[1, 2, 0], [2, 3, 2, "ASYNC EVENT · NON-BLOCKING"]],
    c: [0],
  };
  const encoded = encodeSharedBlueprint(payload);

  assert.match(encoded, /^[A-Za-z0-9_-]+$/);
  assert.ok(encoded.length < JSON.stringify(payload).length * 1.5);
  assert.deepEqual(decodeSharedBlueprint(encoded), payload);
  assert.equal(decodeSharedBlueprint("not+url/safe"), null);
  assert.equal(decodeSharedBlueprint("a".repeat(maximumSharedBlueprintLength + 1)), null);
});

test("seeded workload traces replay the same demand timeline", () => {
  const timestamps = Array.from({ length: 10 }, (_, index) => index * 2);
  const firstRun = timestamps.map((seconds) => workloadDemandAt("burst", 1_000, 7, seconds));
  const replay = timestamps.map((seconds) => workloadDemandAt("burst", 1_000, 7, seconds));
  const differentSeed = timestamps.map((seconds) => workloadDemandAt("burst", 1_000, 8, seconds));

  assert.deepEqual(replay, firstRun);
  assert.notDeepEqual(differentSeed, firstRun);
  assert.equal(workloadDemandAt("burst", 1_000, 7, 2), 1_000);
  assert.equal(workloadDemandAt("steady", 1_000, 999, 200), 1_000);
  assert.ok(timestamps.every((seconds) => workloadDemandAt("wave", 1_000, 42, seconds) <= 1_000));
});
