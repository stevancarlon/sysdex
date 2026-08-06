# Sysdex: Emergent Systems Sandbox

## North star

Sysdex is not a quiz where the designer hides a correct topology and the player reconstructs it.

It is a systems sandbox. The game provides a small set of understandable infrastructure primitives, a workload, and an operating contract. Players decide how components are connected and configured. A deterministic simulation applies the same rules to every design, including designs the scenario author never anticipated.

The desired freedom is combinatorial rather than content-scripted: a finite set of parts should create a very large solution space through topology, configuration, workload, and failure interactions.

## The core learning loop

1. **Observe** an inherited system, workload trace, or empty environment.
2. **Form a hypothesis** from latency, queue depth, errors, cost, logs, and request traces.
3. **Change the system** by adding, removing, connecting, or configuring primitives.
4. **Stress it** with normal traffic, bursts, skewed keys, dependency failures, and regional events.
5. **Inspect the causal result**, including one request's path and the reason an SLO passed or failed.
6. **Iterate or ship**. Certification checks the contract, never a component recipe.

## What must change from the current prototype

| Current prototype | Sandbox foundation |
| --- | --- |
| Connections are generated automatically from component types | Players create and remove directed connections between compatible ports |
| Metrics are mostly derived from machine counts | Requests move through the graph and consume finite service, queue, network, and storage resources |
| Incidents prescribe another copy of the affected machine | Failures alter graph behavior; players may reroute, shed, retry, replicate, degrade, or add capacity |
| A phase implicitly expects specific components | A scenario declares traffic and guarantees such as latency, durability, correctness, and cost |
| Configuration is a global percentage bonus | Policies live on nodes or edges and change concrete behavior |
| Success is a single green/red capacity check | Designs sit on a tradeoff frontier across reliability, correctness, latency, cost, and complexity |

## Simulation primitives

Every placeable item exposes ports, resources, state, and configurable behavior. A component name must describe what it does, not what puzzle it solves.

### Nodes

- **Compute**: concurrency, service-time distribution, memory, crash behavior, stateless/stateful mode.
- **Load balancer**: routing algorithm, health checks, connection limits, regional affinity.
- **Cache**: capacity, eviction policy, TTL, cache-aside/write-through behavior, hot-key handling.
- **Relational database**: leader/follower roles, read/write capacity, indexes, replication lag, durability.
- **Key-value or document store**: partition key, consistency mode, item size, hot-partition behavior.
- **Queue or event log**: partitions, retention, acknowledgement, ordering, delivery semantics, backpressure.
- **Worker**: concurrency, batching, idempotency, retry and dead-letter behavior.
- **Object storage**: object size, throughput, durability, upload/download behavior.
- **CDN edge**: cache policy, origin shield, regional capacity, invalidation behavior.
- **Geo index**: cell size, rebalance policy, query radius, hot-cell behavior.

### Edges

Players connect compatible output and input ports. Each edge has semantics:

- synchronous request;
- asynchronous event;
- database read or write;
- replication stream;
- cache fill or invalidation;
- media transfer;
- health check.

Edges can be configured with timeout, retry count, backoff, circuit breaking, concurrency limit, batching, compression, and failure fallback. These settings create interactions such as retry storms, backpressure, stale reads, duplicate events, and head-of-line blocking.

### Workloads

A workload is not one RPS number. It contains:

- request classes and their percentages;
- read/write ratio;
- payload and media size distributions;
- key popularity and geographic distribution;
- steady traffic, bursts, and diurnal patterns;
- correctness requirements;
- background jobs and deadlines;
- user regions and network latency.

## How a request is simulated

1. A workload generator creates a request with a type, key, region, payload, and deadline.
2. The request enters a compatible graph port.
3. Each node consumes capacity and adds service time according to its current queue and configuration.
4. Synchronous edges keep the caller waiting. Asynchronous edges acknowledge according to queue policy and continue independently.
5. Reads and writes change state. Replicas converge over time rather than receiving an abstract capacity multiplier.
6. Failures, timeouts, retries, and fallbacks create new events using the same rules.
7. The evaluator records user-visible latency, errors, lost or duplicated work, stale data, cost, and recovery behavior.

The UI should be a view over this domain model. The simulation must not depend on Three.js or DOM state.

## Scenario contracts, not recipes

A scenario may define:

- p95 and p99 latency by request class;
- minimum successful throughput;
- maximum error rate;
- durability and event-capture percentage;
- maximum stale-read window;
- ordering or consistency requirements;
- recovery time and recovery point objectives;
- monthly cost or build budget;
- physical machine or region limits.

It must not define required component kinds unless the scenario is explicitly teaching a constrained legacy migration.

A design passes when it satisfies the observable contract throughout the test. Removing analytics may improve latency, for example, but fails if the contract requires 99.9% of click events to be recorded.

## Multiple solutions and meaningful tradeoffs

Passing designs should be compared rather than collapsed into one answer.

- **Performance**: latency, throughput, queue delay.
- **Reliability**: availability and recovery under multiple failure seeds.
- **Correctness**: lost, duplicated, reordered, or stale data.
- **Efficiency**: infrastructure and operational cost.
- **Simplicity**: nodes, edges, policies, and failure modes introduced.
- **Elasticity**: behavior under traffic shapes not shown during construction.

The game should identify Pareto-efficient designs. A cheap simple topology and an expensive resilient topology can both be excellent for different contracts.

## Phase 2 as the first vertical slice

The player inherits a redirect service whose API calls Analytics Service synchronously.

Contract:

- sustain 1,200 redirects per second;
- p95 redirect latency at or below 115 ms;
- record at least 99.9% of click events;
- stay inside budget;
- survive a cache stampede.

The game exposes the blocking call and its latency contribution. It does not require a Message Queue. Possible player inventions include:

- insert a queue and process events asynchronously;
- scale Analytics Service while keeping the synchronous contract;
- batch or sample events if the capture contract still passes;
- write an event to durable storage and process the log later;
- add timeouts and fallback storage;
- combine several approaches.

Each solution should behave differently under analytics failure, traffic bursts, event duplication, and cost scoring.

The current Phase 2 implementation is transitional: it demonstrates inherited topology, visible synchronous versus asynchronous routes, and two valid designs. The graph simulator will remove the remaining authored assumptions.

## Campaign reframing

Campaign operations become curated scenario families built on the same sandbox:

1. **URL Shortener**: greenfield onboarding to request flow, persistence, and horizontal compute.
2. **Social Redirects**: synchronous dependency, event capture, backpressure, and cache stampede.
3. **Checkout**: retries, idempotency, partial failure, and correctness under duplicate requests.
4. **Realtime Workspace**: replication, consistency, failover, and conflicting writes.
5. **Global Live Platform**: regional routing, traffic shedding, and compound failure.
6. **Nearby Matching**: geographic partitioning, hot cells, radius expansion, and stale location data.
7. **Video Streaming**: upload, transcoding, metadata, object storage, CDN fill, and origin protection.
8. **Ride Dispatch**: rapidly changing location state, fairness, geographic hotspots, and degraded operation.

Earlier operations reveal mechanics with causal guidance. Later operations reveal only the contract, workload documentation, and observable telemetry. All use the same components and rules.

## Learning without prescribing

- Allow inspection of a single request as a timeline across nodes and edges.
- Explain the largest latency contributors and the causal chain behind each error.
- Show before/after diffs when the graph changes.
- Provide an optional hint ladder: observation, concept, then concrete suggestion.
- End with an operational review: what passed, what failed, hidden risks, and alternative tradeoffs.
- Never label one certified topology as “the solution.”

## Emergent failure examples

The simulator should permit problems that were not manually attached to a phase:

- retry amplification overwhelms a recovering database;
- a cache TTL causes synchronized expiry and a thundering herd;
- a poor partition key creates a hot shard;
- queue consumers retry a poison event forever;
- at-least-once delivery duplicates a payment without idempotency;
- autoscaling adds instances faster than the database can accept connections;
- CDN invalidation floods the origin;
- replication lag returns stale profile or inventory data;
- a circuit breaker protects latency while silently violating event-capture requirements;
- overprovisioning passes every SLO but loses on cost and operational complexity.

These should emerge from shared rules, not bespoke incident scripts.

## Migration plan

Implementation checkpoint: Phase 1 and the core-service operations in Phases 2–5 now run through the UI-independent directed-graph evaluator in `src/simulation/`. Request capacity only credits machines on a complete response path; caches accelerate only paths that traverse them; replicated standbys remain operationally meaningful without pretending to serve reads; and synchronous calls, asynchronous queues, consumers, commits, failures, event backlog, and delivery lag come from edge semantics. Graph-driven post-tutorial phases offer optional manual wiring with directed compatible ports and recoverable auto-routing. The matching, streaming, and dispatch phases still use the transitional count model while the same engine is expanded.

### 1. Extract the domain model

Move components, graph state, workload, and metrics into a UI-independent `simulation/` module. Preserve the current renderer as a client of that state.

### 2. Give components explicit ports

Replace automatic topology generation with player-created directed edges. Keep an optional auto-wire action for onboarding, never as the only mode.

### 3. Introduce discrete request flow

Simulate request classes, node queues, service times, and synchronous/asynchronous completion. Derive telemetry from events rather than count formulas.

### 4. Add state and correctness

Model writes, replication, cache entries, queue acknowledgements, event capture, duplication, ordering, and staleness.

### 5. Convert phases into scenario data

Scenarios declare initial graphs, workloads, contracts, failure schedules, and allowed environment constraints. They do not contain solution checks.

### 6. Add sandbox and sharing

Allow unrestricted laboratories, saved blueprints, deterministic workload seeds, replayable tests, and community scenario contracts.

## Acceptance test for freedom

Sysdex has reached the intended design when all of the following are true:

- a player can draw a topology the developers did not encode;
- the simulation can run it without special-case logic;
- its success or failure follows documented component rules;
- telemetry explains the causal result;
- more than one materially different design can satisfy a scenario;
- a design can create a failure mode the scenario author did not script;
- the game can replay the same workload seed deterministically for comparison.
