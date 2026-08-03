# Sysdex

A browser-based systems engineering campaign. Build production topologies in a tactile retro-isometric lab, configure resilience policies, prove service-level objectives, and operate the system through live failure drills.

## Run locally

```bash
npm install
npm run dev
```

Then open the local URL printed by Vite.

## Campaign

Eight phases escalate from a first URL-shortener release to product-scale architecture exercises. Every phase changes the budget, component unlocks, traffic target, latency/error SLO, certification window, and production incident:

1. First Release — build and operate a URL shortener
2. Growth Loop — isolate social-link analytics with a queue and worker
3. On-call Rotation — keep a checkout API alive through a node crash
4. Regional Scale — protect a realtime workspace from database failure
5. Planetary Event — operate a global live platform through compound failure
6. Discovery Grid — design Tinder-like nearby matching with geographic partitions
7. Premiere Night — design Netflix-like video streaming with object storage, transcoding workers, and CDN edges
8. City Surge — design Uber-like ride dispatch under a geographic hotspot

Successful certification unlocks the next operation and persists the best score locally. Later phases unlock runbook configurations including tracing and SLO alerts, API autoscaling, circuit breakers, read replicas, WAL tuning, and Multi-AZ failover.

## Gameplay

- Drag nine machine types onto the grid: Load Balancer, API Server, Redis, PostgreSQL, Message Queue, Worker Pool, Geo Index, Object Storage, and CDN Edge.
- Use `1`–`9` to pick machines without leaving the laboratory view, then click a highlighted floor tile to install them.
- Rearrange placed machines by dragging them between tiles.
- Select a machine to learn how its physical metaphor maps to the software component.
- Start or abort a production drill with the control-desk button or `T`, then watch requests travel through automatically routed data cables.
- Tune throughput, p95 latency, and errors against each phase's service-level objectives.
- Respond to incidents with the phase-specific manual mitigation or a faster automated response unlocked by the configured runbook.
- Observe failed and recovering machines in the scene, labels, live capacity, latency, errors, and bottleneck diagnosis.
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
Add `&angle=1.8` to render a deterministic rotated camera angle.

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
