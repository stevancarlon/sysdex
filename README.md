# Sysdex

A browser-based systems engineering campaign and creative sandbox. Build production topologies in a cool-toned pixelated 2.5D lab, author directed data paths, configure resilience policies, prove service-level objectives, and operate the system through live failure drills.

The long-term mechanics direction is documented in [GAME_DESIGN.md](./GAME_DESIGN.md): a composable graph simulation where scenarios define contracts rather than hidden component recipes.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite.

## Campaign

Eight phases escalate from a first URL-shortener release to product-scale architecture exercises. Every phase changes the budget, component unlocks, traffic target, latency/error SLO, certification window, and production incident:

1. First Release — build and operate a URL shortener
2. Growth Loop — diagnose and redesign a blocking analytics dependency
3. On-call Rotation — keep a checkout API alive through a node crash
4. Regional Scale — protect a realtime workspace from database failure
5. Planetary Event — operate a global live platform through compound failure
6. Discovery Grid — design Tinder-like nearby matching with geographic partitions
7. Premiere Night — design Netflix-like video streaming with object storage, transcoding workers, and CDN edges
8. City Surge — design Uber-like ride dispatch under a geographic hotspot

Successful certification unlocks the next operation and persists the best score locally. Later phases unlock runbook configurations including tracing and SLO alerts, API autoscaling, circuit breakers, read replicas, WAL tuning, and Multi-AZ failover.

## Free Lab

Creative mode removes campaign progression and prescribed incidents. Choose any of five workload families, set 500–10,000 requests per second, and author the p95, error, delivery, and freshness contracts yourself. Every machine and runbook is unlocked, budget is unlimited, and traffic runs until you stop it.

Select any installed machine to take it offline or restore it while traffic is live. Broken and incomplete graphs remain runnable, so you can observe total outages, partial degradation, synchronous fallbacks, stale data, and successful failover. Custom contracts, manual cables, runbooks, and offline machines survive local saves and compact share links.

## Gameplay

- Drag nine machine types onto the grid: Load Balancer, API Server, Redis, PostgreSQL, Message Queue, Worker Pool, Geo Index, Object Storage, and CDN Edge.
- Use `1`–`9` to pick machines without leaving the laboratory view, then click a highlighted floor tile to install them.
- Rearrange placed machines by dragging them between tiles.
- Select a machine to learn how its physical metaphor maps to the software component.
- Press `W` after the tutorial to switch from automatic routing to compatible, directed player-authored cables.
- Press `R` to trace each blocking request, asynchronous event, and playback path through the graph.
- Start or abort a production drill with the control-desk button or `T`, then watch requests travel through automatically routed data cables.
- Tune throughput, p95 latency, and errors against each phase's service-level objectives.
- Respond to incidents by changing the live topology while traffic is running. Existing redundancy, rerouting, scaling, caching, or a relevant runbook can all be valid when they restore the declared contracts.
- Configure resilience policies before the drill to make matching incidents recover automatically; runbook choices are operational behavior, not buttons pressed after failure.
- Observe failed and recovering machines in the scene, labels, live capacity, latency, errors, and bottleneck diagnosis.
- Save reversible phase-local blueprints, compare consecutive drills, and copy validated share links for automatic or manual designs.
- Remove selected machines for a full refund using the component card or `Delete`.
- Rotate the isometric laboratory by left-dragging empty floor space. Right-drag, middle-drag, `Q` / `E`, and the on-screen controls remain available as alternatives.
- Watch each machine react to traffic: the Load Balancer scans, API beacons pulse, Redis memory lights sequence, PostgreSQL disks spin, Queue conveyors accelerate, Worker fans turn, Geo cells ripple, and CDN signals broadcast.
- Click the machine emblem beside the Sysdex wordmark to cycle through the workshop machines.

Append `?demo=1` to load a healthy system during its live traffic ramp. Use
`?demo=certified` or `?demo=failed` to render deterministic result states for
visual regression checks.
Use `?demo=packets` to populate the routes with deterministic data frames for
traffic-visualization checks.
Use `?demo=incident` to render an active cache-stampede response, or
`?demo=config&phase=3` to open the fully unlocked resilience runbook.
Use `?demo=analytics-inherited`, `?demo=analytics-failed`,
`?demo=analytics-queue`, or `?demo=analytics-scale` to compare the Phase 2
bottleneck, its diagnostic result, and two valid designs.
Add `&angle=1.8` to render a deterministic rotated camera angle.
Use `?lab=dispatch&rps=3000&demo=sandbox-certified` for a deterministic Free
Lab workload, or replace the demo with `sandbox-failure` to render a selected
offline machine. Shared sandbox URLs also carry `p95`, `err`, `delivery`, and
`lag` contract parameters.

## Design references

The product-scale exercises adapt common architecture patterns explained by ByteByteGo: asynchronous queues and workers, geographic partitioning for nearby search, separating media from metadata, and serving high-volume playback from CDN edges.

- [Scale from zero to millions of users](https://bytebytego.com/courses/system-design-interview/scale-from-zero-to-millions-of-users)
- [How Tinder recommends matches with geosharding](https://blog.bytebytego.com/p/how-tinder-recommends-to-75-million)
- [Netflix's overall architecture](https://bytebytego.com/guides/guides/netflixs-overall-architecture/)
- [Design YouTube](https://bytebytego.com/courses/system-design-interview/design-youtube)

## Commands

```bash
npm run typecheck
npm run build
npm run preview
```
