import assert from "node:assert/strict";
import test from "node:test";
import {
  socialRedirectCapacity,
  evaluateSocialRedirectGraph,
} from "../src/simulation/socialRedirects.ts";
import type {
  SimulationEdge,
  SimulationEdgeMode,
  SimulationGraph,
  SimulationNode,
} from "../src/simulation/graph.ts";

const options = { demand: 1_200, latencySlo: 115, errorSlo: 1.5 };

function node(id: string, kind: keyof typeof socialRedirectCapacity): SimulationNode {
  return { id, kind, capacity: socialRedirectCapacity[kind] };
}

function edge(from: string, to: string, mode: SimulationEdgeMode): SimulationEdge {
  return { from, to, mode };
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
