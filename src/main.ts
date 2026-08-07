import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPixelatedPass } from "three/addons/postprocessing/RenderPixelatedPass.js";
import { ShaderPass } from "three/addons/postprocessing/ShaderPass.js";
import "./style.css";
import {
  campaignPhases,
  configDefinitions,
  type CampaignPhase,
  type ComponentKind,
  type ConfigId,
  type WorkloadKind,
} from "./campaign";
import { type SimulationEdgeMode, type SimulationGraph } from "./simulation/graph.ts";
import { coreComponentCapacity, evaluateCoreServiceGraph } from "./simulation/coreService.ts";
import { evaluateSocialRedirectGraph } from "./simulation/socialRedirects.ts";
import {
  evaluateDispatchGraph,
  evaluateMatchingGraph,
  evaluateStreamingGraph,
  infrastructureComponentCapacity,
  type SpecializedEvaluation,
} from "./simulation/specializedWorkloads.ts";
import {
  compareDrillRuns,
  validateDrillSnapshot,
  type DrillBackgroundMode,
  type DrillComparison,
  type DrillSnapshotV1,
  type DrillTrend,
} from "./simulation/runComparison.ts";
import { evaluateBackgroundCorrectness } from "./simulation/correctness.ts";
import {
  decodeSharedBlueprint,
  encodeSharedBlueprint,
  type SharedBlueprintV1,
} from "./simulation/blueprintCodec.ts";
import { workloadDemandAt, workloadSeedUnit, type WorkloadTrafficPattern } from "./simulation/workloadTrace.ts";

type ComponentDefinition = {
  label: string;
  shortLabel: string;
  role: string;
  cost: number;
  color: number;
  cssColor: string;
  description: string;
  capacityText: string;
  effectText: string;
};

type TestPhase = "idle" | "ramping" | "holding" | "passed" | "failed";

type GridPosition = {
  col: number;
  row: number;
};

type PlacedComponent = {
  id: number;
  kind: ComponentKind;
  group: THREE.Group;
  grid: GridPosition;
  label: HTMLDivElement;
  visual: HTMLImageElement;
  state: "healthy" | "degraded" | "failed";
};

type Connection = {
  specId: number | null;
  from: PlacedComponent;
  to: PlacedComponent;
  mode: SimulationEdgeMode;
  tube: THREE.Mesh;
  hitTube: THREE.Mesh;
  curve: THREE.CatmullRomCurve3;
  material: THREE.MeshStandardMaterial;
  annotation: HTMLDivElement | null;
  label: string | null;
  activity: number;
};

type AuthoredConnection = {
  id: number;
  fromId: number;
  toId: number;
  mode: SimulationEdgeMode;
  label: string | null;
};

type Packet = {
  mesh: THREE.Group;
  route: Connection[];
  segmentIndex: number;
  progress: number;
  speed: number;
  phase: number;
};

type InspectionRoute = {
  id: string;
  label: string;
  kind: "blocking" | "async" | "delivery";
  connections: Connection[];
};

type SavedBlueprintV1 = {
  version: 1;
  phaseIndex: number;
  savedAt: number;
  topologyMode: "automatic" | "manual";
  nodes: Array<{ id: number; kind: ComponentKind; grid: GridPosition; state?: "healthy" | "failed" }>;
  connections: Array<{ fromId: number; toId: number; mode: SimulationEdgeMode; label: string | null }>;
  configs: ConfigId[];
};

const componentDefinitions: Record<ComponentKind, ComponentDefinition> = {
  loadBalancer: {
    label: "Load Balancer",
    shortLabel: "LB",
    role: "Traffic dispatcher",
    cost: 120,
    color: 0x58c7d4,
    cssColor: "#58c7d4",
    description: "Distributes incoming requests across API servers so no single machine receives all the traffic.",
    capacityText: "950 req/s",
    effectText: "Unlocks horizontal scaling",
  },
  api: {
    label: "API Server",
    shortLabel: "API",
    role: "Request processor",
    cost: 180,
    color: 0xd5e0dd,
    cssColor: "#d5e0dd",
    description: "Runs the URL-shortening application: validates requests, creates short codes, and returns redirects.",
    capacityText: "300 req/s",
    effectText: "Add replicas for throughput",
  },
  redis: {
    label: "Redis",
    shortLabel: "R",
    role: "Fast memory cabinet",
    cost: 110,
    color: 0x789bd3,
    cssColor: "#789bd3",
    description: "Keeps frequently requested short links in fast key-value memory, reducing database work and latency.",
    capacityText: "1,750 reads/s",
    effectText: "Cuts redirect latency by 92 ms",
  },
  postgres: {
    label: "PostgreSQL",
    shortLabel: "PG",
    role: "Durable archive",
    cost: 220,
    color: 0x71b9a9,
    cssColor: "#71b9a9",
    description: "Durably stores the mapping between each short code and its original destination URL.",
    capacityText: "560 reads/s",
    effectText: "Required durable source of truth",
  },
  queue: {
    label: "Message Queue",
    shortLabel: "Q",
    role: "Work conveyor",
    cost: 130,
    color: 0xa29bc9,
    cssColor: "#a29bc9",
    description: "Buffers analytics and background jobs so API requests do not wait for slower work to finish.",
    capacityText: "1,200 jobs/s",
    effectText: "Buffers work for async processors",
  },
  worker: {
    label: "Worker Pool",
    shortLabel: "WK",
    role: "Async job processor",
    cost: 140,
    color: 0xe58b87,
    cssColor: "#e58b87",
    description: "Consumes queued analytics, media, and location jobs away from the synchronous API request path.",
    capacityText: "1,600 jobs/s",
    effectText: "Completes the Queue → Worker path",
  },
  geoIndex: {
    label: "Geo Index",
    shortLabel: "GEO",
    role: "Proximity search grid",
    cost: 260,
    color: 0x72c7b3,
    cssColor: "#72c7b3",
    description: "Partitions location data into nearby cells so matching and dispatch queries avoid global scans.",
    capacityText: "3,200 lookups/s",
    effectText: "Enables low-latency nearby search",
  },
  objectStorage: {
    label: "Object Storage",
    shortLabel: "OBJ",
    role: "Media bucket cluster",
    cost: 320,
    color: 0xb5acd6,
    cssColor: "#b5acd6",
    description: "Stores large immutable media objects separately from transactional metadata in PostgreSQL.",
    capacityText: "5,000 objects/s",
    effectText: "Removes media blobs from the database",
  },
  cdn: {
    label: "CDN Edge",
    shortLabel: "CDN",
    role: "Regional content edge",
    cost: 400,
    color: 0x69c9dd,
    cssColor: "#69c9dd",
    description: "Caches popular content near users and shields the origin from repeated global reads.",
    capacityText: "4,000 edge r/s",
    effectText: "Offloads 22% origin traffic per edge",
  },
};

const componentOrder: ComponentKind[] = [
  "loadBalancer",
  "api",
  "redis",
  "postgres",
  "queue",
  "worker",
  "geoIndex",
  "objectStorage",
  "cdn",
];
const componentPreviewSources: Record<ComponentKind, string> = {
  loadBalancer: "/assets/components-v2/load-balancer.png",
  api: "/assets/components-v2/api-gateway.png",
  redis: "/assets/components-v2/cache-node.png",
  postgres: "/assets/components-v2/database-proxy.png",
  queue: "/assets/components-v2/message-queue.png",
  worker: "/assets/components-v2/worker-node.png",
  geoIndex: "/assets/components-v2/geo-index.png",
  objectStorage: "/assets/components-v2/object-storage.png",
  cdn: "/assets/components-v2/cdn-edge.png",
};
const componentWorldSources: Record<ComponentKind, string> = {
  loadBalancer: "/assets/components-v1/load-balancer.png",
  api: "/assets/components-v1/api-gateway.png",
  redis: "/assets/components-v1/cache-node.png",
  postgres: "/assets/components-v1/database-proxy.png",
  queue: "/assets/components-v1/message-queue.png",
  worker: "/assets/components-v1/worker-node.png",
  geoIndex: "/assets/components-v1/geo-index.png",
  objectStorage: "/assets/components-v1/object-storage.png",
  cdn: "/assets/components-v1/cdn-edge.png",
};
const blueprintConnectionModes: SimulationEdgeMode[] = ["request", "cache", "enqueue", "consume", "commit", "replicate"];
const sandboxPresets: Record<WorkloadKind, {
  name: string;
  service: string;
  objective: string;
  description: string;
  lesson: string;
  latencySlo: number;
  errorSlo: number;
  backgroundSlo?: CampaignPhase["backgroundSlo"];
}> = {
  general: {
    name: "Core API",
    service: "API Platform",
    objective: "Author any durable request topology.",
    description: "Explore ingress, compute, cache, storage, replication, and cost without a scripted failure.",
    lesson: "Change one boundary at a time and compare measured behavior.",
    latencySlo: 95,
    errorSlo: 0.5,
  },
  analytics: {
    name: "Event Pipeline",
    service: "Event Platform",
    objective: "Design a request path and an event-delivery path.",
    description: "Explore synchronous calls, queues, consumers, backlog, and data freshness.",
    lesson: "User latency and event delivery are separate contracts.",
    latencySlo: 115,
    errorSlo: 1,
    backgroundSlo: { label: "Product events", maxLagSeconds: 1, minimumDeliveryPercent: 99.5 },
  },
  matching: {
    name: "Nearby Search",
    service: "Geo Search",
    objective: "Build any bounded geographic query topology.",
    description: "Explore geo partitions, cache placement, durable profiles, and hotspot headroom.",
    lesson: "Only geographic indexes on a complete query path contribute.",
    latencySlo: 70,
    errorSlo: 0.2,
  },
  streaming: {
    name: "Media Delivery",
    service: "Media Platform",
    objective: "Balance metadata, playback, and transcode contracts.",
    description: "Explore origin protection, object storage, edge delivery, and asynchronous media jobs.",
    lesson: "Healthy metadata cannot conceal a broken playback or transcode path.",
    latencySlo: 60,
    errorSlo: 0.15,
    backgroundSlo: { label: "Transcode jobs", maxLagSeconds: 1.2, minimumDeliveryPercent: 99.5 },
  },
  dispatch: {
    name: "Live Dispatch",
    service: "Dispatch Platform",
    objective: "Combine nearby queries with live location delivery.",
    description: "Explore geographic partitions, fast reads, queues, and location freshness under arbitrary load.",
    lesson: "A fast match based on stale locations is still wrong.",
    latencySlo: 50,
    errorSlo: 0.1,
    backgroundSlo: { label: "Driver locations", maxLagSeconds: 1, minimumDeliveryPercent: 99.8 },
  },
};

type SandboxContract = {
  latencySlo: number;
  errorSlo: number;
  minimumDeliveryPercent: number | null;
  maxLagSeconds: number | null;
};

type SandboxTrafficPattern = WorkloadTrafficPattern;

const sandboxTrafficPatterns: Record<SandboxTrafficPattern, { name: string; description: string }> = {
  steady: { name: "Steady", description: "Constant peak load" },
  wave: { name: "Wave", description: "Smooth demand cycle" },
  burst: { name: "Burst", description: "Seeded traffic spikes" },
};

function defaultSandboxContract(workload: WorkloadKind): SandboxContract {
  const preset = sandboxPresets[workload];
  return {
    latencySlo: preset.latencySlo,
    errorSlo: preset.errorSlo,
    minimumDeliveryPercent: preset.backgroundSlo?.minimumDeliveryPercent ?? null,
    maxLagSeconds: preset.backgroundSlo?.maxLagSeconds ?? null,
  };
}

function createSandboxPhase(workload: WorkloadKind, demand: number, contract: SandboxContract): CampaignPhase {
  const preset = sandboxPresets[workload];
  const backgroundSlo = preset.backgroundSlo
    && contract.minimumDeliveryPercent !== null
    && contract.maxLagSeconds !== null
    ? {
      label: preset.backgroundSlo.label,
      minimumDeliveryPercent: contract.minimumDeliveryPercent,
      maxLagSeconds: contract.maxLagSeconds,
    }
    : undefined;
  return {
    index: campaignPhases.length,
    name: `Free Lab · ${preset.name}`,
    service: preset.service,
    difficulty: "Sandbox",
    workload,
    objective: preset.objective,
    description: preset.description,
    lesson: preset.lesson,
    targetRps: demand,
    latencySlo: contract.latencySlo,
    errorSlo: contract.errorSlo,
    backgroundSlo,
    budget: 99_999,
    certificationSeconds: 5,
    testTimeLimit: Number.POSITIVE_INFINITY,
    unlocks: [...componentOrder],
    configUnlocks: configDefinitions.map((config) => config.id),
    incident: {
      code: "LAB-000",
      title: "No scripted incident",
      summary: "Free Lab runs only the workload and topology you choose.",
      operatorPrompt: "Keep experimenting.",
      manualAction: "Continue observation",
      affectedKind: null,
      triggerAt: Number.POSITIVE_INFINITY,
      loadMultiplier: 1,
      capacityMultiplier: 1,
      latencyPenalty: 0,
      errorPenalty: 0,
      recoverySeconds: 0,
    },
  };
}
const brandPreviewData = new Map<ComponentKind, string>();
let currentPhaseIndex = 0;
let currentPhase: CampaignPhase = campaignPhases[currentPhaseIndex];
let isSandboxMode = false;
let sandboxWorkload: WorkloadKind = "general";
let sandboxTargetRps = 3_000;
let sandboxContract = defaultSandboxContract(sandboxWorkload);
let sandboxTrafficPattern: SandboxTrafficPattern = "steady";
let sandboxTraceSeed = 42;
let totalBudget = currentPhase.budget;
let targetRps = currentPhase.targetRps;
let latencySlo = currentPhase.latencySlo;
let errorSlo = currentPhase.errorSlo;
const rampDuration = 5;
let certificationDuration = currentPhase.certificationSeconds;
let testTimeLimit = currentPhase.testTimeLimit;
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
let prefersReducedMotion = reducedMotionQuery.matches;

function contextualComponentLabel(kind: ComponentKind) {
  if (kind !== "worker") return componentDefinitions[kind].label;
  if (currentPhase.workload === "analytics") return "Analytics Service";
  if (currentPhase.workload === "streaming") return "Transcode Worker";
  if (currentPhase.workload === "dispatch") return "Location Worker";
  return componentDefinitions.worker.label;
}

function contextualComponentRole(kind: ComponentKind) {
  if (kind !== "worker") return componentDefinitions[kind].role;
  if (currentPhase.workload === "analytics") return "Click-event processor";
  if (currentPhase.workload === "streaming") return "Video job processor";
  if (currentPhase.workload === "dispatch") return "Location-event processor";
  return componentDefinitions.worker.role;
}

function errorContractDecimals(value: number) {
  return Math.round(value * 100) % 10 === 0 ? 1 : 2;
}

function formatErrorPercent(value: number, contract = value) {
  return value.toFixed(errorContractDecimals(contract));
}

document.querySelector<HTMLDivElement>("#app")!.innerHTML = `
  <main class="game-shell">
    <canvas id="game-canvas" aria-label="Isometric system design workspace"></canvas>
    <div class="workshop-art-layer workshop-back-wall" id="workshop-back-wall" aria-hidden="true">
      <img src="/assets/workshop-v2/back-wall.png" alt="" />
    </div>
    <div class="component-visual-layer" id="component-visual-layer" aria-hidden="true"></div>
    <div class="workshop-art-layer workshop-foreground-deck" id="workshop-foreground-deck" aria-hidden="true">
      <img src="/assets/workshop-v2/foreground-deck.png" alt="" />
    </div>

    <div class="start-overlay" id="start-overlay" data-visible="true" aria-hidden="false">
      <section class="start-card" role="dialog" aria-modal="true" aria-labelledby="start-title">
        <div class="start-hero">
          <p class="start-eyebrow">Sysdex operations simulator · Campaign</p>
          <h2 id="start-title">Build it. Break it. Keep it running.</h2>
          <p>Design production systems, configure resilience policies, respond to live incidents, and grow from a first release to planetary scale.</p>
          <div class="start-principles" aria-label="Campaign principles">
            <span><b>01</b> Design the path</span>
            <span><b>02</b> Prove the SLO</span>
            <span><b>03</b> Survive failure</span>
          </div>
        </div>
        <div class="campaign-select">
          <div class="campaign-select-heading">
            <div>
              <p class="panel-kicker">Career progression</p>
              <h3>Select an operation</h3>
            </div>
              <span id="campaign-progress">1 / 8 unlocked</span>
          </div>
          <button class="sandbox-launch-button" id="open-sandbox-button" type="button">
            <span><small>Creative mode</small><strong>Free Lab</strong></span><b>Choose workload + traffic →</b>
          </button>
          <div class="phase-list" id="phase-list"></div>
          <div class="phase-brief" id="phase-brief"></div>
          <button class="start-button" id="start-phase-button" type="button">
            <span>Enter operations lab</span><b>Start phase 01 →</b>
          </button>
        </div>
      </section>
    </div>

    <div class="sandbox-overlay" id="sandbox-overlay" data-visible="false" aria-hidden="true">
      <section class="sandbox-card" role="dialog" aria-modal="true" aria-labelledby="sandbox-title">
        <div class="sandbox-heading">
          <div><p class="panel-kicker">Creative mode</p><h2 id="sandbox-title">Open a Free Lab</h2><p>Choose the system contract. Every machine and runbook is available; no scripted incident or campaign solution exists.</p></div>
          <button id="close-sandbox-button" type="button" aria-label="Close Free Lab setup">×</button>
        </div>
        <div class="sandbox-workloads" id="sandbox-workloads" role="radiogroup" aria-label="Sandbox workload">
          <button type="button" role="radio" data-workload="general" aria-checked="true"><span>Core API</span><small>Request + storage</small></button>
          <button type="button" role="radio" data-workload="analytics" aria-checked="false"><span>Events</span><small>Request + delivery</small></button>
          <button type="button" role="radio" data-workload="matching" aria-checked="false"><span>Nearby</span><small>Geo queries</small></button>
          <button type="button" role="radio" data-workload="streaming" aria-checked="false"><span>Media</span><small>Metadata + playback</small></button>
          <button type="button" role="radio" data-workload="dispatch" aria-checked="false"><span>Dispatch</span><small>Geo + locations</small></button>
        </div>
        <div class="sandbox-demand">
          <div><span>Peak traffic contract</span><strong id="sandbox-demand-value">3,000 r/s</strong></div>
          <input id="sandbox-demand-input" type="range" min="500" max="10000" step="500" value="3000" aria-label="Sandbox traffic target" />
        </div>
        <div class="sandbox-trace-row">
          <div class="sandbox-patterns" id="sandbox-patterns" role="radiogroup" aria-label="Traffic trace shape">
            <button type="button" role="radio" data-pattern="steady" aria-checked="true"><span>Steady</span><small>Constant peak</small></button>
            <button type="button" role="radio" data-pattern="wave" aria-checked="false"><span>Wave</span><small>Smooth cycle</small></button>
            <button type="button" role="radio" data-pattern="burst" aria-checked="false"><span>Burst</span><small>Seeded spikes</small></button>
          </div>
          <label class="sandbox-seed"><small>Replay seed</small><input id="sandbox-seed-input" type="number" min="1" max="9999" step="1" value="42" aria-label="Deterministic workload replay seed" /></label>
        </div>
        <div class="sandbox-contract-heading">
          <span>Define the service contract</span>
          <button id="reset-sandbox-contract-button" type="button">Reset preset</button>
        </div>
        <div class="sandbox-contracts" aria-label="Editable sandbox contracts">
          <label><small>p95 latency</small><span><input id="sandbox-latency-contract" type="number" min="20" max="500" step="5" value="95" aria-label="Maximum p95 latency in milliseconds" /><b>ms</b></span></label>
          <label><small>Error ceiling</small><span><input id="sandbox-error-contract" type="number" min="0.05" max="10" step="0.05" value="0.5" aria-label="Maximum error percentage" /><b>%</b></span></label>
          <label id="sandbox-delivery-contract" hidden><small>Delivery floor</small><span><input id="sandbox-delivery-contract-value" type="number" min="80" max="100" step="0.1" value="99.5" aria-label="Minimum background delivery percentage" /><b>%</b></span></label>
          <label id="sandbox-lag-contract" hidden><small>Freshness lag</small><span><input id="sandbox-lag-contract-value" type="number" min="0.1" max="30" step="0.1" value="1" aria-label="Maximum background delivery lag in seconds" /><b>s</b></span></label>
        </div>
        <div class="sandbox-footer">
          <p><b>Unlimited lab budget.</b> Save variants, trace paths, inject machine failures, and share any valid graph.</p>
          <button id="enter-sandbox-button" type="button">Enter Free Lab →</button>
        </div>
      </section>
    </div>

    <div class="phase-briefing-overlay" id="phase-briefing-overlay" data-visible="false" aria-hidden="true">
      <section class="phase-briefing-card" role="dialog" aria-modal="true" aria-labelledby="phase-briefing-title">
        <div class="briefing-header briefing-enter-item">
          <div>
            <p class="briefing-eyebrow" id="phase-briefing-eyebrow">Phase 01 · Apprentice operation</p>
            <div class="briefing-title-line">
              <h2 id="phase-briefing-title">First Release</h2>
              <p id="phase-briefing-service">URL Shortener</p>
            </div>
          </div>
          <span class="briefing-index" id="phase-briefing-index">01 / 08</span>
        </div>

        <div class="briefing-flow">
          <section class="briefing-step briefing-assignment briefing-enter-item">
            <span class="briefing-step-number">1</span>
            <div class="briefing-step-content">
              <p class="briefing-step-label" id="briefing-assignment-label">Build this</p>
              <h3 id="phase-briefing-assignment"></h3>
              <p id="phase-briefing-lesson"></p>
              <div class="briefing-context" id="briefing-context" hidden>
                <div>
                  <small>Inherited request path</small>
                  <strong>API → Analytics Service → Response</strong>
                  <p>Every redirect waits for click tracking to finish.</p>
                </div>
                <div>
                  <small>Engineering question</small>
                  <strong>Must analytics finish first?</strong>
                  <p>Trace the blocking cable, then redesign the boundary.</p>
                </div>
              </div>
              <div class="briefing-toolbox">
                <div class="briefing-toolbox-heading">
                  <span id="briefing-toolbox-label">Available parts</span>
                  <strong><span id="briefing-budget-label">Budget</span> <b id="briefing-target-budget">$850</b></strong>
                </div>
                <div id="briefing-unlocks"></div>
                <small id="briefing-runbook"></small>
              </div>
            </div>
          </section>

          <section class="briefing-step briefing-success briefing-enter-item">
            <span class="briefing-step-number">2</span>
            <div class="briefing-step-content">
              <p class="briefing-step-label">Pass every service contract</p>
              <div class="briefing-targets" id="briefing-targets" aria-label="Phase success criteria">
                <div><small>Handle traffic</small><strong id="briefing-target-rps">500 r/s</strong></div>
                <div><small>Keep it fast</small><strong id="briefing-target-latency">p95 ≤ 160 ms</strong></div>
                <div><small>Avoid errors</small><strong id="briefing-target-errors">&lt; 2.0%</strong></div>
                <div id="briefing-background-target" hidden><small id="briefing-background-label">Deliver events</small><strong id="briefing-target-background">lag ≤ 1.0s</strong></div>
              </div>
            </div>
          </section>

          <section class="briefing-step briefing-incident briefing-enter-item">
            <span class="briefing-step-number">3</span>
            <div class="briefing-step-content">
              <div class="briefing-incident-heading">
                <p class="briefing-step-label">Then survive this incident</p>
                <span id="briefing-incident-code">TRAFFIC-210</span>
              </div>
              <h3 id="briefing-incident-title">Launch traffic spike</h3>
              <p id="briefing-incident-summary"></p>
            </div>
          </section>
        </div>

        <button class="briefing-button briefing-enter-item" id="dismiss-briefing-button" type="button">
          <span>This checklist stays pinned in the top-right</span><b>Start building <i>→</i></b>
        </button>
      </section>
    </div>

    <header class="topbar">
      <div class="brand">
        <button
          class="brand-mark"
          id="brand-mark"
          type="button"
          aria-label="Sysdex machine emblem. Click to reveal another machine."
          title="Click to cycle the workshop emblem"
        >
          <img class="brand-item-icon" id="brand-item-primary" data-active="false" alt="" />
          <img class="brand-item-icon" id="brand-item-secondary" data-active="false" alt="" />
          <span class="brand-item-loading" aria-hidden="true">···</span>
        </button>
        <div>
          <h1>Sysdex</h1>
          <p>Systems engineering laboratory</p>
        </div>
      </div>

      <section class="mission-card" id="mission-card" data-briefing="false" aria-labelledby="mission-title" tabindex="-1">
        <div class="mission-heading">
          <p class="mission-label" id="mission-label">Phase 01 · URL Shortener</p>
          <button class="mission-phase" id="mission-phase" type="button" aria-label="Open runbook configuration">Build mode</button>
        </div>
        <h2 id="mission-title">Build a URL Shortener</h2>
        <div class="mission-guide" id="mission-guide" data-state="build" aria-live="polite">
          <span id="mission-guide-stage">Step 1 of 3 · Build</span>
          <strong id="mission-guide-title">Place a Load Balancer</strong>
          <p id="mission-description">Select the highlighted part, then choose any free floor tile.</p>
        </div>
        <div class="mission-objectives" aria-label="Mission objectives">
          <div class="objective-row" id="objective-throughput" data-met="false">
            <span>Throughput</span><strong id="objective-throughput-value">0 / 800 r/s</strong>
          </div>
          <div class="objective-row" id="objective-latency" data-met="false">
            <span>p95 latency</span><strong id="objective-latency-value">— / 100 ms</strong>
          </div>
          <div class="objective-row" id="objective-errors" data-met="false">
            <span>Error rate</span><strong id="objective-errors-value">Run test</strong>
          </div>
          <div class="objective-row" id="objective-background" data-met="false" hidden>
            <span>Analytics path</span><strong id="objective-background-value">No delivery path</strong>
          </div>
        </div>
      </section>
    </header>

    <nav class="campaign-dock" aria-label="Campaign controls">
      <button id="missions-button" type="button"><span>Campaign</span><b id="dock-phase">01 · First Release</b></button>
      <div class="phase-pips" id="phase-pips" aria-label="Campaign progress"></div>
      <button id="configs-button" type="button"><span>Runbook</span><b id="config-count">0 configs</b></button>
    </nav>

    <aside class="selected-card" id="selected-card" data-visible="false" aria-live="polite">
      <strong id="selected-role">Component</strong>
      <h3 id="selected-name">Nothing selected</h3>
      <p id="selected-description"></p>
      <div class="selected-specs">
        <span><small>Rated capacity</small><b id="selected-capacity">—</b></span>
        <span><small>System effect</small><b id="selected-effect">—</b></span>
        <span><small>Runtime state</small><b id="selected-state">Healthy</b></span>
      </div>
      <div class="selected-actions">
        <button class="chaos-button" id="chaos-button" type="button" hidden aria-pressed="false">Take offline</button>
        <button class="scrap-button" id="scrap-button" type="button">Remove · full refund</button>
      </div>
    </aside>

    <section class="parts-panel" aria-labelledby="parts-title">
      <div class="panel-title">
        <div>
          <p class="panel-kicker">Parts inventory</p>
          <h2 id="parts-title">System machines</h2>
        </div>
        <span class="budget" id="budget">$1,200</span>
      </div>
      <div class="parts-list" id="parts-list"></div>
      <p class="parts-hint" id="parts-hint"><b>Click a part, then click a free floor tile.</b> Cables connect automatically. Drag machines to move them.</p>
      <div class="blueprint-actions" aria-label="Blueprint controls">
        <button id="save-blueprint-button" type="button">Save design</button>
        <button id="load-blueprint-button" type="button">Restore saved</button>
        <button id="share-blueprint-button" type="button">Share link</button>
      </div>
      <button class="inventory-footer-button" id="inventory-footer-button" type="button" aria-label="Return to campaign">⌄</button>
    </section>

    <section class="telemetry-panel" aria-labelledby="telemetry-title">
      <div class="status-row">
        <div>
          <p class="panel-kicker">Telemetry</p>
          <h2 id="telemetry-title">System telemetry</h2>
        </div>
        <span class="status-light" id="status-light" data-running="false">Standby</span>
      </div>
      <div class="telemetry-console">
        <div class="telemetry-readouts">
          <div class="metrics">
            <div class="metric"><span>Throughput</span><strong id="throughput">0 r/s</strong></div>
            <div class="metric"><span>p95 latency</span><strong id="latency">—</strong></div>
            <div class="metric"><span>Error rate</span><strong id="errors">0.0%</strong></div>
          </div>
          <div class="delivery-meter" id="delivery-meter" data-met="false" hidden>
            <div><span id="delivery-label">Event freshness</span><strong id="delivery-value">— / 1.0s</strong></div>
            <div class="delivery-track" aria-hidden="true"><i id="delivery-fill"></i></div>
            <p id="delivery-status">No delivery path</p>
          </div>
          <div class="signal-track" id="signal-track" data-running="false" aria-hidden="true">
            <div class="signal-line"></div>
          </div>
          <div class="test-sequence">
            <div class="test-sequence-row">
              <span id="test-phase">Awaiting topology</span>
              <strong id="test-time">READY</strong>
            </div>
            <div class="test-progress" aria-hidden="true"><span id="test-progress-fill"></span></div>
            <p class="bottleneck" id="bottleneck">Install the core request path.</p>
          </div>
        </div>
        <div class="telemetry-controls" aria-label="Telemetry controls">
          <button class="run-button" id="run-button" type="button" data-running="false"><i aria-hidden="true">▶</i><span>Start traffic test</span></button>
          <button class="trace-button" id="trace-button" type="button" aria-expanded="false"><i aria-hidden="true">◎</i><span>Trace a path</span><kbd>R</kbd></button>
          <button class="telemetry-export-button" id="telemetry-export-button" type="button"><i aria-hidden="true">⇱</i><span>Export design</span></button>
        </div>
      </div>
    </section>

    <section class="incident-panel" id="incident-panel" data-visible="false" data-status="active" aria-live="assertive">
      <div class="incident-heading">
        <span id="incident-code">SEV-2 · API-503</span>
        <b id="incident-status">Active incident</b>
      </div>
      <h2 id="incident-title">API node crash</h2>
      <p id="incident-summary"></p>
      <div class="incident-impact" id="incident-impact"></div>
      <p class="incident-prompt" id="incident-prompt"></p>
      <div class="incident-task" id="incident-task" data-complete="false" hidden>
        <div class="incident-task-heading">
          <span>Live topology change</span>
          <b id="incident-task-count">2 / 3 installed</b>
        </div>
        <strong id="incident-task-title">Add one API Server</strong>
        <p id="incident-task-description">Select API Server in the catalogue, then install it on a free floor tile.</p>
        <div class="incident-task-progress" aria-hidden="true"><span id="incident-task-progress"></span></div>
      </div>
    </section>

    <div class="view-controls" id="view-controls" data-wiring="false" aria-label="View controls">
      <button id="rotate-left-button" type="button" aria-label="Rotate view counter-clockwise">↶</button>
      <span><b>Drag to rotate</b><small>Empty floor · Q / E</small></span>
      <button id="rotate-right-button" type="button" aria-label="Rotate view clockwise">↷</button>
      <button class="wiring-button" id="wiring-button" type="button" data-mode="automatic" data-editing="false" aria-pressed="false" disabled hidden>
        <b id="wiring-button-label">Auto cables</b><small>Unlocks phase 02</small>
      </button>
    </div>

    <div class="wiring-guide" id="wiring-guide" data-visible="false" aria-hidden="true" aria-live="polite">
      <span id="wiring-guide-step">Select a source machine</span>
      <strong id="wiring-guide-detail">Then select its destination · click a cable to remove</strong>
      <button id="restore-auto-button" type="button">Restore auto-route</button>
    </div>

    <section class="trace-readout" id="trace-readout" data-visible="false" aria-hidden="true" aria-labelledby="trace-title">
      <div class="trace-heading">
        <div><span>Live graph inspector</span><strong id="trace-title">Request path</strong></div>
        <button id="trace-close-button" type="button" aria-label="Close path inspector">×</button>
      </div>
      <div class="trace-tabs" id="trace-tabs" role="tablist" aria-label="Available topology paths"></div>
      <div class="trace-route" id="trace-route" aria-live="polite"></div>
      <p id="trace-explanation"></p>
    </section>

    <div class="toast" id="toast" data-visible="false" role="status"></div>

    <div class="config-overlay" id="config-overlay" data-visible="false" aria-hidden="true">
      <section class="config-card" role="dialog" aria-modal="true" aria-labelledby="config-title">
        <div class="config-heading">
          <div>
            <p class="panel-kicker">Production runbook</p>
            <h2 id="config-title">Resilience configuration</h2>
            <p>Configuration consumes phase budget, but changes how the system behaves when load and dependencies fail.</p>
          </div>
          <button id="close-config-button" type="button" aria-label="Close configuration">×</button>
        </div>
        <div class="config-list" id="config-list"></div>
        <div class="config-footer">
          <span>Available budget <b id="config-budget">$0</b></span>
          <button id="apply-config-button" type="button">Apply runbook</button>
        </div>
      </section>
    </div>

    <div class="result-overlay" id="result-overlay" data-visible="false" aria-hidden="true">
      <section class="result-card" id="result-card" data-outcome="passed" role="dialog" aria-modal="true" aria-labelledby="result-title">
        <div class="result-scroll">
          <div class="result-signal" aria-hidden="true"><span></span></div>
          <p class="panel-kicker" id="result-kicker">Traffic certification</p>
          <h2 id="result-title">Service certified</h2>
          <p class="result-summary" id="result-summary"></p>
          <div class="result-stats">
            <span><small id="result-score-label">Score</small><strong id="result-score">0</strong></span>
            <span><small id="result-budget-label">Budget left</small><strong id="result-budget">$0</strong></span>
            <span><small id="result-stability-label">Stable for</small><strong id="result-stability">0.0s</strong></span>
          </div>
          <p class="result-diagnosis" id="result-diagnosis"></p>
          <section class="result-review" id="result-review" aria-label="Operational review">
            <div class="result-review-heading"><span>Operational review</span><b id="result-review-profile">Observed graph</b></div>
            <div class="result-review-grid">
              <article data-kind="proof"><small>Proven</small><strong id="result-proof-title"></strong><p id="result-proof-copy"></p></article>
              <article data-kind="risk"><small>Watch</small><strong id="result-risk-title"></strong><p id="result-risk-copy"></p></article>
              <article data-kind="experiment"><small>Try next</small><strong id="result-experiment-title"></strong><p id="result-experiment-copy"></p></article>
            </div>
          </section>
          <section class="result-comparison" id="result-comparison" data-state="baseline" aria-label="Previous drill comparison">
            <div class="result-comparison-heading"><span id="result-comparison-label">Experiment baseline</span><b id="result-comparison-outcome">Recorded</b></div>
            <p id="result-comparison-summary">This run becomes the baseline for the next topology experiment.</p>
            <div class="result-comparison-grid" id="result-comparison-grid" hidden>
              <span><small>p95 latency</small><strong id="result-delta-latency">No change</strong></span>
              <span><small>Capacity</small><strong id="result-delta-capacity">No change</strong></span>
              <span><small>Spend</small><strong id="result-delta-spend">No change</strong></span>
              <span><small>Machines</small><strong id="result-delta-machines">No change</strong></span>
            </div>
          </section>
          <section class="result-analysis" id="result-analysis" hidden aria-label="Slow request trace">
            <div class="result-analysis-heading">
              <span>Slow request trace</span>
              <strong id="result-latency-gap">29 ms over target</strong>
            </div>
            <div class="result-latency-track" aria-hidden="true">
              <span></span>
              <i id="result-latency-slo-marker"></i>
            </div>
            <div class="result-trace" aria-label="API Server waits for Analytics Service before responding">
              <span>API Server</span>
              <i data-state="blocking"><b>waits</b></i>
              <span data-state="blocking">Analytics Service</span>
              <i><b>then</b></i>
              <span>Response</span>
            </div>
          </section>
          <section class="result-hint" id="result-hint" hidden data-level="0">
            <div class="result-hint-heading">
              <span>Design hint</span>
              <button id="result-hint-button" type="button" aria-expanded="false">Reveal a hint</button>
            </div>
            <p id="result-hint-copy" aria-live="polite" hidden></p>
            <div class="result-hint-progress" aria-hidden="true"><i></i><i></i></div>
          </section>
        </div>
        <div class="result-actions">
          <button class="result-button result-button-primary" id="retry-button" type="button">Run again</button>
          <button class="result-button" id="dismiss-result-button" type="button">Keep building</button>
        </div>
      </section>
    </div>
  </main>
`;

const canvas = document.querySelector<HTMLCanvasElement>("#game-canvas")!;
const componentVisualLayer = document.querySelector<HTMLDivElement>("#component-visual-layer")!;
const workshopBackWallLayer = document.querySelector<HTMLDivElement>("#workshop-back-wall")!;
const workshopForegroundLayer = document.querySelector<HTMLDivElement>("#workshop-foreground-deck")!;
canvas.dataset.reducedMotion = String(prefersReducedMotion);
reducedMotionQuery.addEventListener("change", (event) => {
  prefersReducedMotion = event.matches;
  canvas.dataset.reducedMotion = String(prefersReducedMotion);
});
const partsList = document.querySelector<HTMLDivElement>("#parts-list")!;
const partsHint = document.querySelector<HTMLElement>("#parts-hint")!;
const saveBlueprintButton = document.querySelector<HTMLButtonElement>("#save-blueprint-button")!;
const loadBlueprintButton = document.querySelector<HTMLButtonElement>("#load-blueprint-button")!;
const shareBlueprintButton = document.querySelector<HTMLButtonElement>("#share-blueprint-button")!;
const inventoryFooterButton = document.querySelector<HTMLButtonElement>("#inventory-footer-button")!;
const budgetElement = document.querySelector<HTMLSpanElement>("#budget")!;
const runButton = document.querySelector<HTMLButtonElement>("#run-button")!;
const telemetryExportButton = document.querySelector<HTMLButtonElement>("#telemetry-export-button")!;
const statusLight = document.querySelector<HTMLSpanElement>("#status-light")!;
const signalTrack = document.querySelector<HTMLDivElement>("#signal-track")!;
const throughputElement = document.querySelector<HTMLElement>("#throughput")!;
const latencyElement = document.querySelector<HTMLElement>("#latency")!;
const errorsElement = document.querySelector<HTMLElement>("#errors")!;
const deliveryMeter = document.querySelector<HTMLElement>("#delivery-meter")!;
const deliveryLabel = document.querySelector<HTMLElement>("#delivery-label")!;
const deliveryValue = document.querySelector<HTMLElement>("#delivery-value")!;
const deliveryFill = document.querySelector<HTMLElement>("#delivery-fill")!;
const deliveryStatus = document.querySelector<HTMLElement>("#delivery-status")!;
const toastElement = document.querySelector<HTMLDivElement>("#toast")!;
const selectedCard = document.querySelector<HTMLDivElement>("#selected-card")!;
const selectedName = document.querySelector<HTMLElement>("#selected-name")!;
const selectedRole = document.querySelector<HTMLElement>("#selected-role")!;
const selectedDescription = document.querySelector<HTMLElement>("#selected-description")!;
const selectedCapacity = document.querySelector<HTMLElement>("#selected-capacity")!;
const selectedEffect = document.querySelector<HTMLElement>("#selected-effect")!;
const selectedState = document.querySelector<HTMLElement>("#selected-state")!;
const chaosButton = document.querySelector<HTMLButtonElement>("#chaos-button")!;
const scrapButton = document.querySelector<HTMLButtonElement>("#scrap-button")!;
const missionLabelElement = document.querySelector<HTMLElement>("#mission-label")!;
const missionTitleElement = document.querySelector<HTMLElement>("#mission-title")!;
const missionDescriptionElement = document.querySelector<HTMLElement>("#mission-description")!;
const missionPhaseElement = document.querySelector<HTMLButtonElement>("#mission-phase")!;
const missionGuide = document.querySelector<HTMLElement>("#mission-guide")!;
const missionGuideStage = document.querySelector<HTMLElement>("#mission-guide-stage")!;
const missionGuideTitle = document.querySelector<HTMLElement>("#mission-guide-title")!;
const objectiveThroughput = document.querySelector<HTMLElement>("#objective-throughput")!;
const objectiveLatency = document.querySelector<HTMLElement>("#objective-latency")!;
const objectiveErrors = document.querySelector<HTMLElement>("#objective-errors")!;
const objectiveBackground = document.querySelector<HTMLElement>("#objective-background")!;
const objectiveThroughputValue = document.querySelector<HTMLElement>("#objective-throughput-value")!;
const objectiveLatencyValue = document.querySelector<HTMLElement>("#objective-latency-value")!;
const objectiveErrorsValue = document.querySelector<HTMLElement>("#objective-errors-value")!;
const objectiveBackgroundValue = document.querySelector<HTMLElement>("#objective-background-value")!;
const testPhaseElement = document.querySelector<HTMLElement>("#test-phase")!;
const testTimeElement = document.querySelector<HTMLElement>("#test-time")!;
const testProgressFill = document.querySelector<HTMLElement>("#test-progress-fill")!;
const bottleneckElement = document.querySelector<HTMLElement>("#bottleneck")!;
const traceButton = document.querySelector<HTMLButtonElement>("#trace-button")!;
const traceReadout = document.querySelector<HTMLElement>("#trace-readout")!;
const traceTitle = document.querySelector<HTMLElement>("#trace-title")!;
const traceTabs = document.querySelector<HTMLElement>("#trace-tabs")!;
const traceRouteElement = document.querySelector<HTMLElement>("#trace-route")!;
const traceExplanation = document.querySelector<HTMLElement>("#trace-explanation")!;
const traceCloseButton = document.querySelector<HTMLButtonElement>("#trace-close-button")!;

function setRunButtonLabel(label: string) {
  runButton.innerHTML = `<i aria-hidden="true">${isRunning ? "■" : "▶"}</i><span>${label}</span>`;
}

function setTraceButtonLabel(label: string) {
  traceButton.innerHTML = `<i aria-hidden="true">◎</i><span>${label}</span><kbd>R</kbd>`;
}
const resultOverlay = document.querySelector<HTMLElement>("#result-overlay")!;
const resultCard = document.querySelector<HTMLElement>("#result-card")!;
const resultKicker = document.querySelector<HTMLElement>("#result-kicker")!;
const resultTitle = document.querySelector<HTMLElement>("#result-title")!;
const resultSummary = document.querySelector<HTMLElement>("#result-summary")!;
const resultScoreLabel = document.querySelector<HTMLElement>("#result-score-label")!;
const resultScore = document.querySelector<HTMLElement>("#result-score")!;
const resultBudgetLabel = document.querySelector<HTMLElement>("#result-budget-label")!;
const resultBudget = document.querySelector<HTMLElement>("#result-budget")!;
const resultStabilityLabel = document.querySelector<HTMLElement>("#result-stability-label")!;
const resultStability = document.querySelector<HTMLElement>("#result-stability")!;
const resultDiagnosis = document.querySelector<HTMLElement>("#result-diagnosis")!;
const resultReview = document.querySelector<HTMLElement>("#result-review")!;
const resultReviewProfile = document.querySelector<HTMLElement>("#result-review-profile")!;
const resultProofTitle = document.querySelector<HTMLElement>("#result-proof-title")!;
const resultProofCopy = document.querySelector<HTMLElement>("#result-proof-copy")!;
const resultRiskTitle = document.querySelector<HTMLElement>("#result-risk-title")!;
const resultRiskCopy = document.querySelector<HTMLElement>("#result-risk-copy")!;
const resultExperimentTitle = document.querySelector<HTMLElement>("#result-experiment-title")!;
const resultExperimentCopy = document.querySelector<HTMLElement>("#result-experiment-copy")!;
const resultComparison = document.querySelector<HTMLElement>("#result-comparison")!;
const resultComparisonLabel = document.querySelector<HTMLElement>("#result-comparison-label")!;
const resultComparisonOutcome = document.querySelector<HTMLElement>("#result-comparison-outcome")!;
const resultComparisonSummary = document.querySelector<HTMLElement>("#result-comparison-summary")!;
const resultComparisonGrid = document.querySelector<HTMLElement>("#result-comparison-grid")!;
const resultDeltaLatency = document.querySelector<HTMLElement>("#result-delta-latency")!;
const resultDeltaCapacity = document.querySelector<HTMLElement>("#result-delta-capacity")!;
const resultDeltaSpend = document.querySelector<HTMLElement>("#result-delta-spend")!;
const resultDeltaMachines = document.querySelector<HTMLElement>("#result-delta-machines")!;
const resultAnalysis = document.querySelector<HTMLElement>("#result-analysis")!;
const resultLatencyGap = document.querySelector<HTMLElement>("#result-latency-gap")!;
const resultLatencySloMarker = document.querySelector<HTMLElement>("#result-latency-slo-marker")!;
const resultHint = document.querySelector<HTMLElement>("#result-hint")!;
const resultHintButton = document.querySelector<HTMLButtonElement>("#result-hint-button")!;
const resultHintCopy = document.querySelector<HTMLElement>("#result-hint-copy")!;
const retryButton = document.querySelector<HTMLButtonElement>("#retry-button")!;
const dismissResultButton = document.querySelector<HTMLButtonElement>("#dismiss-result-button")!;
const rotateLeftButton = document.querySelector<HTMLButtonElement>("#rotate-left-button")!;
const rotateRightButton = document.querySelector<HTMLButtonElement>("#rotate-right-button")!;
const viewControls = document.querySelector<HTMLElement>("#view-controls")!;
const wiringButton = document.querySelector<HTMLButtonElement>("#wiring-button")!;
const wiringButtonLabel = document.querySelector<HTMLElement>("#wiring-button-label")!;
const wiringGuide = document.querySelector<HTMLElement>("#wiring-guide")!;
const wiringGuideStep = document.querySelector<HTMLElement>("#wiring-guide-step")!;
const wiringGuideDetail = document.querySelector<HTMLElement>("#wiring-guide-detail")!;
const restoreAutoButton = document.querySelector<HTMLButtonElement>("#restore-auto-button")!;
const brandMark = document.querySelector<HTMLButtonElement>("#brand-mark")!;
const brandItemPrimary = document.querySelector<HTMLImageElement>("#brand-item-primary")!;
const brandItemSecondary = document.querySelector<HTMLImageElement>("#brand-item-secondary")!;
const startOverlay = document.querySelector<HTMLElement>("#start-overlay")!;
const openSandboxButton = document.querySelector<HTMLButtonElement>("#open-sandbox-button")!;
const sandboxOverlay = document.querySelector<HTMLElement>("#sandbox-overlay")!;
const closeSandboxButton = document.querySelector<HTMLButtonElement>("#close-sandbox-button")!;
const sandboxWorkloads = document.querySelector<HTMLElement>("#sandbox-workloads")!;
const sandboxDemandInput = document.querySelector<HTMLInputElement>("#sandbox-demand-input")!;
const sandboxDemandValue = document.querySelector<HTMLElement>("#sandbox-demand-value")!;
const sandboxPatterns = document.querySelector<HTMLElement>("#sandbox-patterns")!;
const sandboxSeedInput = document.querySelector<HTMLInputElement>("#sandbox-seed-input")!;
const sandboxLatencyContract = document.querySelector<HTMLInputElement>("#sandbox-latency-contract")!;
const sandboxErrorContract = document.querySelector<HTMLInputElement>("#sandbox-error-contract")!;
const sandboxDeliveryContract = document.querySelector<HTMLElement>("#sandbox-delivery-contract")!;
const sandboxDeliveryContractValue = document.querySelector<HTMLInputElement>("#sandbox-delivery-contract-value")!;
const sandboxLagContract = document.querySelector<HTMLElement>("#sandbox-lag-contract")!;
const sandboxLagContractValue = document.querySelector<HTMLInputElement>("#sandbox-lag-contract-value")!;
const resetSandboxContractButton = document.querySelector<HTMLButtonElement>("#reset-sandbox-contract-button")!;
const enterSandboxButton = document.querySelector<HTMLButtonElement>("#enter-sandbox-button")!;
const phaseBriefingOverlay = document.querySelector<HTMLElement>("#phase-briefing-overlay")!;
const phaseBriefingEyebrow = document.querySelector<HTMLElement>("#phase-briefing-eyebrow")!;
const phaseBriefingTitle = document.querySelector<HTMLElement>("#phase-briefing-title")!;
const phaseBriefingService = document.querySelector<HTMLElement>("#phase-briefing-service")!;
const phaseBriefingIndex = document.querySelector<HTMLElement>("#phase-briefing-index")!;
const phaseBriefingAssignment = document.querySelector<HTMLElement>("#phase-briefing-assignment")!;
const phaseBriefingLesson = document.querySelector<HTMLElement>("#phase-briefing-lesson")!;
const briefingAssignmentLabel = document.querySelector<HTMLElement>("#briefing-assignment-label")!;
const briefingContext = document.querySelector<HTMLElement>("#briefing-context")!;
const briefingToolboxLabel = document.querySelector<HTMLElement>("#briefing-toolbox-label")!;
const briefingTargetRps = document.querySelector<HTMLElement>("#briefing-target-rps")!;
const briefingTargetLatency = document.querySelector<HTMLElement>("#briefing-target-latency")!;
const briefingTargetErrors = document.querySelector<HTMLElement>("#briefing-target-errors")!;
const briefingTargets = document.querySelector<HTMLElement>("#briefing-targets")!;
const briefingBackgroundTarget = document.querySelector<HTMLElement>("#briefing-background-target")!;
const briefingBackgroundLabel = document.querySelector<HTMLElement>("#briefing-background-label")!;
const briefingTargetBackground = document.querySelector<HTMLElement>("#briefing-target-background")!;
const briefingTargetBudget = document.querySelector<HTMLElement>("#briefing-target-budget")!;
const briefingBudgetLabel = document.querySelector<HTMLElement>("#briefing-budget-label")!;
const briefingUnlocks = document.querySelector<HTMLElement>("#briefing-unlocks")!;
const briefingRunbook = document.querySelector<HTMLElement>("#briefing-runbook")!;
const briefingIncidentCode = document.querySelector<HTMLElement>("#briefing-incident-code")!;
const briefingIncidentTitle = document.querySelector<HTMLElement>("#briefing-incident-title")!;
const briefingIncidentSummary = document.querySelector<HTMLElement>("#briefing-incident-summary")!;
const dismissBriefingButton = document.querySelector<HTMLButtonElement>("#dismiss-briefing-button")!;
const missionCard = document.querySelector<HTMLElement>("#mission-card")!;
const phaseList = document.querySelector<HTMLElement>("#phase-list")!;
const phaseBrief = document.querySelector<HTMLElement>("#phase-brief")!;
const campaignProgress = document.querySelector<HTMLElement>("#campaign-progress")!;
const startPhaseButton = document.querySelector<HTMLButtonElement>("#start-phase-button")!;
const missionsButton = document.querySelector<HTMLButtonElement>("#missions-button")!;
const configsButton = document.querySelector<HTMLButtonElement>("#configs-button")!;
const dockPhase = document.querySelector<HTMLElement>("#dock-phase")!;
const phasePips = document.querySelector<HTMLElement>("#phase-pips")!;
const configCount = document.querySelector<HTMLElement>("#config-count")!;
const configOverlay = document.querySelector<HTMLElement>("#config-overlay")!;
const configList = document.querySelector<HTMLElement>("#config-list")!;
const configBudget = document.querySelector<HTMLElement>("#config-budget")!;
const closeConfigButton = document.querySelector<HTMLButtonElement>("#close-config-button")!;
const applyConfigButton = document.querySelector<HTMLButtonElement>("#apply-config-button")!;
const incidentPanel = document.querySelector<HTMLElement>("#incident-panel")!;
const incidentCode = document.querySelector<HTMLElement>("#incident-code")!;
const incidentStatus = document.querySelector<HTMLElement>("#incident-status")!;
const incidentTitle = document.querySelector<HTMLElement>("#incident-title")!;
const incidentSummary = document.querySelector<HTMLElement>("#incident-summary")!;
const incidentImpact = document.querySelector<HTMLElement>("#incident-impact")!;
const incidentPrompt = document.querySelector<HTMLElement>("#incident-prompt")!;
const incidentTask = document.querySelector<HTMLElement>("#incident-task")!;
const incidentTaskCount = document.querySelector<HTMLElement>("#incident-task-count")!;
const incidentTaskTitle = document.querySelector<HTMLElement>("#incident-task-title")!;
const incidentTaskDescription = document.querySelector<HTMLElement>("#incident-task-description")!;
const incidentTaskProgress = document.querySelector<HTMLElement>("#incident-task-progress")!;
let brandItemIndex = 0;
let brandActiveLayer: 0 | 1 = 0;

for (const kind of componentOrder) {
  const definition = componentDefinitions[kind];
  const button = document.createElement("button");
  button.className = "part-card";
  button.type = "button";
  button.draggable = true;
  button.dataset.kind = kind;
  button.setAttribute("aria-pressed", "false");
  button.style.setProperty("--part-color", definition.cssColor);
  button.innerHTML = `
    <span class="part-name">${contextualComponentLabel(kind)}</span>
    <span class="part-preview" aria-hidden="true">
      <img id="part-preview-${kind}" alt="" />
      <span class="part-code">${componentOrder.indexOf(kind) + 1} · ${definition.shortLabel}</span>
    </span>
    <span class="part-cost">$${definition.cost}</span>
  `;
  partsList.append(button);
}

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x0a1c2b, 22, 39);

const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.BasicShadowMap;
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 3.15;

const camera = new THREE.OrthographicCamera(-8, 8, 6, -6, 0.1, 100);
camera.position.set(-7.2, 21.5, 16.15);
const cameraTargetHeight = 0.45;
camera.lookAt(0, cameraTargetHeight, 0);
camera.zoom = 1.43;
camera.updateProjectionMatrix();
const composer = new EffectComposer(renderer);
composer.setPixelRatio(Math.min(window.devicePixelRatio, 1));
const pixelatedPass = new RenderPixelatedPass(2, scene, camera, {
  normalEdgeStrength: 0.16,
  depthEdgeStrength: 0.22,
});
composer.addPass(pixelatedPass);
const palettePass = new ShaderPass({
  name: "PixelPaletteShader",
  uniforms: {
    tDiffuse: { value: null },
    blockSize: { value: pixelatedPass.pixelSize },
    colorLevels: { value: 30 },
    ditherStrength: { value: 0.004 },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;

    void main() {
      vUv = uv;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float blockSize;
    uniform float colorLevels;
    uniform float ditherStrength;
    varying vec2 vUv;

    float orderedDither(vec2 block) {
      vec2 cell = mod(block, 2.0);
      float upper = mix(0.0, 2.0, cell.x);
      float lower = mix(3.0, 1.0, cell.x);
      return (mix(upper, lower, cell.y) + 0.5) / 4.0 - 0.5;
    }

    void main() {
      vec4 sampleColor = texture2D(tDiffuse, vUv);
      vec2 pixelBlock = floor(gl_FragCoord.xy / blockSize);
      float dither = orderedDither(pixelBlock) * ditherStrength / colorLevels;
      vec3 quantized = floor(clamp(sampleColor.rgb + dither, 0.0, 1.0) * colorLevels + 0.5) / colorLevels;
      gl_FragColor = vec4(quantized, sampleColor.a);
    }
  `,
});
composer.addPass(palettePass);
const cameraOrbitRadius = Math.hypot(camera.position.x, camera.position.z);
const cameraOrbitHeight = camera.position.y;
let cameraAzimuth = Math.atan2(camera.position.x, camera.position.z);
let targetCameraAzimuth = cameraAzimuth;
const referenceCameraAzimuth = cameraAzimuth;

const ambientLight = new THREE.HemisphereLight(0xdde8ef, 0x263c54, 5.55);
scene.add(ambientLight);

const keyLight = new THREE.DirectionalLight(0xe9eef2, 5.05);
keyLight.position.set(-9, 15, 11);
keyLight.castShadow = true;
keyLight.shadow.mapSize.set(2048, 2048);
keyLight.shadow.camera.left = -11;
keyLight.shadow.camera.right = 11;
keyLight.shadow.camera.top = 11;
keyLight.shadow.camera.bottom = -11;
keyLight.shadow.bias = -0.0005;
scene.add(keyLight);

const blueRimFill = new THREE.PointLight(0x638fbe, 6.8, 15, 2);
blueRimFill.position.set(-5, 5, -4);
scene.add(blueRimFill);

const coolFill = new THREE.PointLight(0x4aa5b7, 6.9, 15, 2);
coolFill.position.set(6, 4, 3);
scene.add(coolFill);

const frontFill = new THREE.DirectionalLight(0xb8cfe0, 2.05);
frontFill.position.set(1, 7, 12);
scene.add(frontFill);

const boardGroup = new THREE.Group();
const environmentGroup = new THREE.Group();
scene.add(environmentGroup, boardGroup);

const columns = 9;
const rows = 7;
const tileSize = 1.3;
const tileMeshes: THREE.Mesh[] = [];
const boardActivityMaterials: THREE.MeshStandardMaterial[] = [];
const workshopPulseMaterials: THREE.MeshStandardMaterial[] = [];
const workshopPulseLights: THREE.PointLight[] = [];
const workshopPortalGlows: THREE.MeshBasicMaterial[] = [];
const workshopAnimatedProps: THREE.Object3D[] = [];
const paintedFloorTexture = createPixelWorkshopTexture("floor");
const paintedWallTexture = createPixelWorkshopTexture("wall");
const paintedMachineDarkTexture = createPixelWorkshopTexture("machine-dark");
const paintedMachineNeutralTexture = createPixelWorkshopTexture("machine-light");
const paintedFasciaTexture = createPixelWorkshopTexture("fascia");
const paintedFasciaBumpTexture = createPixelWorkshopTexture("machine-dark");
paintedFloorTexture.wrapS = THREE.RepeatWrapping;
paintedFloorTexture.wrapT = THREE.RepeatWrapping;
paintedFloorTexture.repeat.set(1, 1);
for (const texture of [paintedMachineDarkTexture, paintedMachineNeutralTexture]) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // One generated plate field per face keeps the wear legible at gameplay
  // scale without turning the small machines into visual noise.
  texture.repeat.set(0.72, 0.72);
}
for (const texture of [paintedFasciaTexture, paintedFasciaBumpTexture]) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  // Long platform walls need several plates across their length; reusing the
  // small-machine UV scale would stretch one plate atlas across the room.
  texture.repeat.set(3.6, 0.86);
}

const floorTexture = createSurfaceTexture("#5f7a84", "#344f5d", "#8ba0a3");
floorTexture.repeat.set(3, 2);

const boardSurfaceMaterial = new THREE.MeshStandardMaterial({
  color: 0xffffff,
  map: floorTexture,
  roughness: 0.96,
  metalness: 0.02,
});
const boardFasciaMaterial = fasciaMaterial(0x879ba3, 0.86, 0.3, 0.018);
const boardBase = new THREE.Mesh(
  new THREE.BoxGeometry(columns * tileSize + 0.68, 0.68, rows * tileSize + 0.68),
  [
    boardFasciaMaterial,
    boardFasciaMaterial,
    boardSurfaceMaterial,
    boardFasciaMaterial,
    boardFasciaMaterial,
    boardFasciaMaterial,
  ],
);
boardBase.position.y = -0.31;
boardBase.receiveShadow = true;
boardGroup.add(boardBase);

const boardLip = new THREE.Mesh(
  new THREE.BoxGeometry(columns * tileSize + 0.98, 0.34, rows * tileSize + 0.98),
  fasciaMaterial(0x9aabb0, 0.8, 0.28, 0.014),
);
boardLip.position.y = -0.43;
boardLip.receiveShadow = true;
boardGroup.add(boardLip);

const paintedFloor = new THREE.Mesh(
  new THREE.PlaneGeometry(columns * tileSize - 0.1, rows * tileSize - 0.1),
  new THREE.MeshBasicMaterial({
    color: 0xffffff,
    map: paintedFloorTexture,
    side: THREE.DoubleSide,
  }),
);
paintedFloor.rotation.x = -Math.PI / 2;
paintedFloor.position.y = 0.01;
paintedFloor.receiveShadow = true;
boardGroup.add(paintedFloor);

for (let row = 0; row < rows; row += 1) {
  for (let col = 0; col < columns; col += 1) {
    const variation = pseudoRandom(row * columns + col);
    const tileTints = [0xd7ded9, 0xcbd5d0, 0xc4d0cd, 0xd0d8d3];
    const tileGeometry = new THREE.BoxGeometry(
      tileSize - 0.008,
      0.08 + variation * 0.025,
      tileSize - 0.018,
    );
    const tileUvs = tileGeometry.getAttribute("uv") as THREE.BufferAttribute;
    // BoxGeometry stores the upward-facing plane at UV vertices 8-11. Mapping
    // those vertices into the room-wide UV grid turns the generated artwork
    // into one continuous floor instead of stamping it onto every tile.
    for (let uvIndex = 8; uvIndex < 12; uvIndex += 1) {
      const localU = tileUvs.getX(uvIndex);
      const localV = tileUvs.getY(uvIndex);
      tileUvs.setXY(
        uvIndex,
        (col + localU) / columns,
        1 - (row + localV) / rows,
      );
    }
    tileUvs.needsUpdate = true;
    const tile = new THREE.Mesh(
      tileGeometry,
      new THREE.MeshStandardMaterial({
        color: tileTints[Math.floor(variation * tileTints.length)],
        map: paintedFloorTexture,
        roughness: 0.9,
        metalness: 0.06,
      }),
    );
    tile.position.copy(gridToWorld({ col, row }));
    tile.position.y = 0.075 + variation * 0.012;
    tile.receiveShadow = true;
    tile.userData.grid = { col, row } satisfies GridPosition;
    const tileOutline = new THREE.LineSegments(
      new THREE.EdgesGeometry(tile.geometry, 28),
      new THREE.LineBasicMaterial({
        color: 0x315b68,
        transparent: true,
        opacity: 0.16,
      }),
    );
    tileOutline.renderOrder = 1;
    tile.add(tileOutline);
    tileMeshes.push(tile);
    boardGroup.add(tile);
  }
}

addBoardDetails();
addEnvironment();
boardGroup.visible = true;
environmentGroup.visible = true;

const machinesGroup = new THREE.Group();
const connectionsGroup = new THREE.Group();
const packetsGroup = new THREE.Group();
scene.add(connectionsGroup, packetsGroup, machinesGroup);
machinesGroup.visible = true;

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const clock = new THREE.Clock();
const nodes: PlacedComponent[] = [];
const connections: Connection[] = [];
const authoredConnections: AuthoredConnection[] = [];
const packets: Packet[] = [];
let packetSequence = 0;
const trafficRoutes: Connection[][] = [];
let inspectionRoutes: InspectionRoute[] = [];
let activeInspectionRouteIndex = 0;
let activeInspectionConnections = new Set<Connection>();
let nextNodeId = 1;
let nextConnectionId = 1;
let topologyMode: "automatic" | "manual" = "automatic";
let wiringEditing = false;
let wiringSource: PlacedComponent | null = null;
let hoveredConnection: Connection | null = null;
let activeKind: ComponentKind | null = null;
let draggedPaletteKind: ComponentKind | null = null;
let draggedNode: PlacedComponent | null = null;
let pointerDownPosition = { x: 0, y: 0 };
let nodeHasMoved = false;
let ghost: THREE.Group | null = null;
let ghostVisual: HTMLImageElement | null = null;
let placementTile: THREE.Mesh | null = null;
let isRunning = false;
let testPhase: TestPhase = "idle";
let testElapsed = 0;
let stableElapsed = 0;
let currentDemand = 0;
let packetAccumulator = 0;
let nextTrafficRoute = 0;
let toastTimeout = 0;
let elapsed = 0;
let selectedNode: PlacedComponent | null = null;
let hoveredNode: PlacedComponent | null = null;
let isOrbiting = false;
let orbitPointerId = -1;
let orbitLastX = 0;
let selectedCampaignPhase = 0;
let unlockedPhaseIndex = Math.min(
  campaignPhases.length - 1,
  Math.max(0, Number.parseInt(window.localStorage.getItem("sysbench-unlocked-phase") ?? "0", 10) || 0),
);
const activeConfigs = new Set<ConfigId>();
let pendingConfigs = new Set<ConfigId>();
let incidentTriggered = false;
let incidentMode: "pending" | "active" | "recovering" | "resolved" = "pending";
let incidentRecoveryRemaining = 0;
let incidentTargetNodeId: number | null = null;
let incidentResolution = "";
let incidentResponseRequiredKind: ComponentKind | null = null;
let incidentResponseRequiredCount = 0;
let incidentBudgetCredit = 0;
let incidentTopologyFingerprintAtTrigger = "";
const incidentAffectedNodeIds = new Set<number>();

function configSpend(configs: Set<ConfigId> = activeConfigs) {
  return configDefinitions.reduce((sum, config) => sum + (configs.has(config.id) ? config.cost : 0), 0);
}

function installedMachineSpend() {
  return nodes.reduce((sum, node) => sum + componentDefinitions[node.kind].cost, 0);
}

function renderCampaignScreen() {
  campaignProgress.textContent = `${unlockedPhaseIndex + 1} / ${campaignPhases.length} unlocked`;
  phaseList.innerHTML = campaignPhases.map((phase) => {
    const locked = phase.index > unlockedPhaseIndex;
    const bestScore = window.localStorage.getItem(`sysbench-best-${phase.index}`);
    return `
      <button class="phase-option" type="button" data-phase="${phase.index}" data-selected="${phase.index === selectedCampaignPhase}" data-locked="${locked}" ${locked ? "disabled" : ""}>
        <span class="phase-number">${String(phase.index + 1).padStart(2, "0")}</span>
        <span><b>${phase.name}</b><small>${phase.service} · ${phase.difficulty}</small></span>
        <em>${locked ? "Locked" : bestScore ? `Best ${Number(bestScore).toLocaleString("en-US")}` : "Available"}</em>
      </button>
    `;
  }).join("");

  const phase = campaignPhases[selectedCampaignPhase];
  const nextConfig = phase.configUnlocks.length > 0
    ? phase.configUnlocks.map((id) => configDefinitions.find((config) => config.id === id)?.label).filter(Boolean).join(" · ")
    : "Core topology only";
  const backgroundTarget = phase.backgroundSlo
    ? ` · ${phase.backgroundSlo.label} lag ≤ ${phase.backgroundSlo.maxLagSeconds.toFixed(1)}s`
    : "";
  phaseBrief.innerHTML = `
    <div><span>Production target</span><b>${phase.targetRps.toLocaleString("en-US")} r/s</b></div>
    <div><span>Reliability SLO</span><b>p95 ≤ ${phase.latencySlo} ms · errors &lt; ${phase.errorSlo}%${backgroundTarget}</b></div>
    <div><span>Failure drill</span><b>${phase.incident.title}</b></div>
    <p>${phase.lesson}</p>
    <small>Runbook: ${nextConfig}</small>
  `;
  startPhaseButton.querySelector("b")!.textContent = `Start phase ${String(phase.index + 1).padStart(2, "0")} →`;
}

function renderPhaseProgress() {
  if (isSandboxMode) {
    dockPhase.textContent = `LAB · ${sandboxPresets[currentPhase.workload].name}`;
    phasePips.innerHTML = "<b>FREE LAB</b>";
    phasePips.dataset.sandbox = "true";
    configCount.textContent = `${activeConfigs.size} config${activeConfigs.size === 1 ? "" : "s"}`;
    return;
  }
  phasePips.dataset.sandbox = "false";
  dockPhase.textContent = `${String(currentPhase.index + 1).padStart(2, "0")} · ${currentPhase.name}`;
  phasePips.innerHTML = campaignPhases.map((phase) =>
    `<i data-current="${phase.index === currentPhaseIndex}" data-complete="${phase.index < currentPhaseIndex}" title="${phase.name}"></i>`,
  ).join("");
  configCount.textContent = `${activeConfigs.size} config${activeConfigs.size === 1 ? "" : "s"}`;
}

function updateMissionContent() {
  if (isSandboxMode) {
    missionLabelElement.textContent = `Free Lab · ${sandboxPresets[currentPhase.workload].name}`;
    missionTitleElement.textContent = `Sandbox: ${currentPhase.service}`;
    missionPhaseElement.textContent = isRunning ? "Live workload" : "Build mode";
    renderPhaseProgress();
    return;
  }
  missionLabelElement.textContent = `Phase ${String(currentPhase.index + 1).padStart(2, "0")} · ${currentPhase.service}`;
  missionTitleElement.textContent = `Build: ${currentPhase.service}`;
  renderPhaseProgress();
}

function renderPhaseBriefing() {
  const phaseNumber = String(currentPhase.index + 1).padStart(2, "0");
  phaseBriefingEyebrow.textContent = `Phase ${phaseNumber} · ${currentPhase.difficulty} operation`;
  phaseBriefingTitle.textContent = currentPhase.name;
  phaseBriefingService.textContent = currentPhase.service;
  phaseBriefingService.setAttribute("aria-label", `You are building ${currentPhase.service}`);
  phaseBriefingIndex.textContent = `${phaseNumber} / ${String(campaignPhases.length).padStart(2, "0")}`;
  briefingAssignmentLabel.textContent = currentPhaseIndex === 1 ? "Investigate this" : "Build this";
  phaseBriefingAssignment.textContent = currentPhase.objective;
  phaseBriefingLesson.textContent = currentPhaseIndex === 0
    ? `${currentPhase.description} Choose a part, then place it on any free floor tile—connections are automatic.`
    : currentPhaseIndex === 1
      ? `${currentPhase.description} Inspect the inherited path and its p95 latency. You may change the architecture or scale the dependency; any design that meets the SLO is valid.`
      : `${currentPhase.description} There is no prescribed topology: use the targets, component specs, and budget to design your solution.`;
  briefingContext.hidden = currentPhaseIndex !== 1;
  briefingToolboxLabel.textContent = currentPhaseIndex === 1 ? "Inherited + available parts" : "Available parts";
  briefingTargetRps.textContent = `${currentPhase.targetRps.toLocaleString("en-US")} r/s`;
  briefingTargetLatency.textContent = `p95 ≤ ${currentPhase.latencySlo} ms`;
  briefingTargetErrors.textContent = `< ${formatErrorPercent(currentPhase.errorSlo)}%`;
  briefingTargets.dataset.count = currentPhase.backgroundSlo ? "4" : "3";
  briefingBackgroundTarget.hidden = !currentPhase.backgroundSlo;
  if (currentPhase.backgroundSlo) {
    briefingBackgroundLabel.textContent = `Deliver ${currentPhase.backgroundSlo.label.toLocaleLowerCase("en-US")}`;
    briefingTargetBackground.textContent = `≥ ${currentPhase.backgroundSlo.minimumDeliveryPercent.toFixed(1)}% · lag ≤ ${currentPhase.backgroundSlo.maxLagSeconds.toFixed(1)}s`;
  }
  briefingBudgetLabel.textContent = currentPhaseIndex === 1 ? "Remaining" : "Budget";
  briefingTargetBudget.textContent = `$${(currentPhaseIndex === 1 ? 360 : currentPhase.budget).toLocaleString("en-US")}`;
  briefingUnlocks.innerHTML = currentPhase.unlocks.map((kind) => {
    const definition = componentDefinitions[kind];
    const preview = brandPreviewData.get(kind) ?? document.querySelector<HTMLImageElement>(`#part-preview-${kind}`)?.src ?? "";
    const inheritedState = currentPhaseIndex === 1 ? (kind === "queue" ? "Available" : "Installed") : "";
    return `<span style="--briefing-component:${definition.cssColor}" data-inherited="${inheritedState === "Installed"}"><img src="${preview}" alt="" /><em>${contextualComponentLabel(kind)}</em>${inheritedState ? `<i>${inheritedState}</i>` : ""}</span>`;
  }).join("");
  const runbookNames = currentPhase.configUnlocks
    .map((id) => configDefinitions.find((config) => config.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  briefingRunbook.textContent = runbookNames.length > 0
    ? `Runbook: ${runbookNames.join(" · ")}`
    : "";
  briefingRunbook.hidden = runbookNames.length === 0;
  briefingIncidentCode.textContent = currentPhase.incident.code;
  briefingIncidentTitle.textContent = currentPhase.incident.title;
  briefingIncidentSummary.textContent = currentPhase.incident.summary;
  dismissBriefingButton.querySelector("span")!.textContent = currentPhaseIndex === 0
    ? "Guided phase · next actions stay pinned top-right"
    : currentPhaseIndex === 1
      ? "Inherited system · diagnose cause before changing it"
      : "Independent phase · diagnose the system yourself";
  dismissBriefingButton.querySelector("b")!.textContent = currentPhaseIndex === 1 ? "Inspect inherited system →" : "Start building →";
}

function showPhaseBriefing() {
  renderPhaseBriefing();
  missionCard.dataset.briefing = "true";
  phaseBriefingOverlay.dataset.visible = "true";
  phaseBriefingOverlay.setAttribute("aria-hidden", "false");
  window.setTimeout(() => dismissBriefingButton.focus(), 320);
}

function dismissPhaseBriefing() {
  phaseBriefingOverlay.dataset.visible = "false";
  phaseBriefingOverlay.setAttribute("aria-hidden", "true");
  missionCard.dataset.briefing = "false";
  window.setTimeout(() => missionCard.focus({ preventScroll: true }), 320);
  showToast(currentPhaseIndex === 1
    ? "Inherited system loaded. Trace the blocking analytics call and compare valid fixes."
    : `Build mode ready. Design for ${targetRps.toLocaleString("en-US")} r/s, then start the production drill.`);
}

function applyPhaseParameters(phase: CampaignPhase, index: number) {
  currentPhaseIndex = index;
  currentPhase = phase;
  totalBudget = currentPhase.budget;
  targetRps = currentPhase.targetRps;
  latencySlo = currentPhase.latencySlo;
  errorSlo = currentPhase.errorSlo;
  certificationDuration = currentPhase.certificationSeconds;
  testTimeLimit = currentPhase.testTimeLimit;
  incidentBudgetCredit = 0;
  syncWiringUi();
}

function setPhaseParameters(index: number) {
  isSandboxMode = false;
  applyPhaseParameters(campaignPhases[index], index);
}

function normalizeSandboxContract(workload: WorkloadKind, contract: SandboxContract): SandboxContract {
  const preset = sandboxPresets[workload];
  const clamp = (value: number, minimum: number, maximum: number, fallback: number) =>
    Number.isFinite(value) ? THREE.MathUtils.clamp(value, minimum, maximum) : fallback;
  return {
    latencySlo: Math.round(clamp(contract.latencySlo, 20, 500, preset.latencySlo)),
    errorSlo: Math.round(clamp(contract.errorSlo, 0.05, 10, preset.errorSlo) * 100) / 100,
    minimumDeliveryPercent: preset.backgroundSlo
      ? Math.round(clamp(
        contract.minimumDeliveryPercent ?? preset.backgroundSlo.minimumDeliveryPercent,
        80,
        100,
        preset.backgroundSlo.minimumDeliveryPercent,
      ) * 10) / 10
      : null,
    maxLagSeconds: preset.backgroundSlo
      ? Math.round(clamp(
        contract.maxLagSeconds ?? preset.backgroundSlo.maxLagSeconds,
        0.1,
        30,
        preset.backgroundSlo.maxLagSeconds,
      ) * 10) / 10
      : null,
  };
}

function sandboxContractFromSearch(params: URLSearchParams, workload: WorkloadKind): SandboxContract | null {
  const preset = sandboxPresets[workload];
  const readNumber = (key: string, fallback: number, minimum: number, maximum: number) => {
    if (!params.has(key)) return fallback;
    const value = Number(params.get(key));
    return Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
  };
  const latency = readNumber("p95", preset.latencySlo, 20, 500);
  const errors = readNumber("err", preset.errorSlo, 0.05, 10);
  if (latency === null || errors === null) return null;
  if (!preset.backgroundSlo) {
    if (params.has("delivery") || params.has("lag")) return null;
    return normalizeSandboxContract(workload, {
      latencySlo: latency,
      errorSlo: errors,
      minimumDeliveryPercent: null,
      maxLagSeconds: null,
    });
  }
  const delivery = readNumber("delivery", preset.backgroundSlo.minimumDeliveryPercent, 80, 100);
  const lag = readNumber("lag", preset.backgroundSlo.maxLagSeconds, 0.1, 30);
  if (delivery === null || lag === null) return null;
  return normalizeSandboxContract(workload, {
    latencySlo: latency,
    errorSlo: errors,
    minimumDeliveryPercent: delivery,
    maxLagSeconds: lag,
  });
}

function normalizeSandboxTraceSeed(value: number) {
  return Math.round(THREE.MathUtils.clamp(Number.isFinite(value) ? value : 42, 1, 9_999));
}

function updateSandboxSetupUi() {
  const preset = sandboxPresets[sandboxWorkload];
  sandboxWorkloads.querySelectorAll<HTMLButtonElement>("button[data-workload]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.workload === sandboxWorkload));
  });
  sandboxDemandInput.value = String(sandboxTargetRps);
  sandboxDemandValue.textContent = `${sandboxTargetRps.toLocaleString("en-US")} r/s`;
  sandboxPatterns.querySelectorAll<HTMLButtonElement>("button[data-pattern]").forEach((button) => {
    button.setAttribute("aria-checked", String(button.dataset.pattern === sandboxTrafficPattern));
  });
  sandboxSeedInput.value = String(sandboxTraceSeed);
  sandboxLatencyContract.value = String(sandboxContract.latencySlo);
  sandboxErrorContract.value = String(sandboxContract.errorSlo);
  sandboxDeliveryContract.hidden = !preset.backgroundSlo;
  sandboxLagContract.hidden = !preset.backgroundSlo;
  if (preset.backgroundSlo) {
    sandboxDeliveryContractValue.value = String(sandboxContract.minimumDeliveryPercent ?? preset.backgroundSlo.minimumDeliveryPercent);
    sandboxLagContractValue.value = String(sandboxContract.maxLagSeconds ?? preset.backgroundSlo.maxLagSeconds);
  }
}

function commitSandboxContractInputs() {
  sandboxContract = normalizeSandboxContract(sandboxWorkload, {
    latencySlo: Number(sandboxLatencyContract.value),
    errorSlo: Number(sandboxErrorContract.value),
    minimumDeliveryPercent: Number(sandboxDeliveryContractValue.value),
    maxLagSeconds: Number(sandboxLagContractValue.value),
  });
  updateSandboxSetupUi();
}

function openSandboxSetup() {
  updateSandboxSetupUi();
  sandboxOverlay.dataset.visible = "true";
  sandboxOverlay.setAttribute("aria-hidden", "false");
  window.setTimeout(() => sandboxWorkloads.querySelector<HTMLButtonElement>(`button[data-workload="${sandboxWorkload}"]`)?.focus(), 220);
}

function closeSandboxSetup() {
  sandboxOverlay.dataset.visible = "false";
  sandboxOverlay.setAttribute("aria-hidden", "true");
}

function beginSandboxSession(
  workload: WorkloadKind,
  demand: number,
  contract = sandboxContract,
  trafficPattern = sandboxTrafficPattern,
  traceSeed = sandboxTraceSeed,
) {
  stopTest(true);
  hideResult();
  resetTopologyEditor();
  clearLaboratory();
  activeConfigs.clear();
  pendingConfigs.clear();
  sandboxWorkload = workload;
  sandboxTargetRps = Math.round(THREE.MathUtils.clamp(demand, 500, 10_000) / 500) * 500;
  sandboxContract = normalizeSandboxContract(sandboxWorkload, contract);
  sandboxTrafficPattern = trafficPattern;
  sandboxTraceSeed = normalizeSandboxTraceSeed(traceSeed);
  isSandboxMode = true;
  applyPhaseParameters(createSandboxPhase(sandboxWorkload, sandboxTargetRps, sandboxContract), campaignPhases.length);
  incidentTriggered = false;
  incidentMode = "pending";
  incidentTargetNodeId = null;
  incidentPanel.dataset.visible = "false";
  closeSandboxSetup();
  closeCampaignScreen();
  updateMissionContent();
  updateUi();
  updateTelemetry();
  showToast(`Free Lab ready: ${sandboxPresets[workload].name} · ${sandboxTrafficPatterns[sandboxTrafficPattern].name.toLowerCase()} trace · peak ${sandboxTargetRps.toLocaleString("en-US")} r/s · seed ${sandboxTraceSeed}.`);
}

function openCampaignScreen() {
  if (isRunning) stopTest();
  closeRequestTrace(true);
  phaseBriefingOverlay.dataset.visible = "false";
  phaseBriefingOverlay.setAttribute("aria-hidden", "true");
  missionCard.dataset.briefing = "false";
  selectedCampaignPhase = Math.min(unlockedPhaseIndex, currentPhaseIndex);
  renderCampaignScreen();
  startOverlay.dataset.visible = "true";
  startOverlay.setAttribute("aria-hidden", "false");
}

function closeCampaignScreen() {
  startOverlay.dataset.visible = "false";
  startOverlay.setAttribute("aria-hidden", "true");
}

function beginCampaignPhase(index: number) {
  if (index > unlockedPhaseIndex) return;
  stopTest(true);
  hideResult();
  resetTopologyEditor();
  clearLaboratory();
  activeConfigs.clear();
  pendingConfigs.clear();
  setPhaseParameters(index);
  loadInheritedScenario(index);
  incidentTriggered = false;
  incidentMode = "pending";
  incidentTargetNodeId = null;
  incidentPanel.dataset.visible = "false";
  closeCampaignScreen();
  updateMissionContent();
  updateUi();
  updateTelemetry();
  showPhaseBriefing();
}

function loadInheritedScenario(index: number) {
  if (index !== 1) return;
  const inherited: Array<[ComponentKind, GridPosition]> = [
    ["loadBalancer", { col: 1, row: 3 }],
    ["loadBalancer", { col: 1, row: 5 }],
    ["api", { col: 3, row: 2 }],
    ["api", { col: 3, row: 3 }],
    ["api", { col: 3, row: 4 }],
    ["api", { col: 3, row: 5 }],
    ["redis", { col: 5, row: 2 }],
    ["worker", { col: 5, row: 5 }],
    ["postgres", { col: 7, row: 3 }],
  ];
  for (const [kind, grid] of inherited) placeComponent(kind, grid, true);
  selectNode(null);
}

function renderConfigPanel() {
  const unlocked = new Set(currentPhase.configUnlocks);
  const plannedSpend = configSpend(pendingConfigs);
  const machineSpend = installedMachineSpend();
  configBudget.textContent = isSandboxMode ? "∞" : `$${Math.max(0, totalBudget - machineSpend - plannedSpend).toLocaleString("en-US")}`;
  configList.innerHTML = configDefinitions.map((config) => {
    const isUnlocked = unlocked.has(config.id);
    const selected = pendingConfigs.has(config.id);
    const cannotAfford = !isSandboxMode && !selected && machineSpend + plannedSpend + config.cost > totalBudget;
    return `
      <button class="config-option" type="button" data-config="${config.id}" data-selected="${selected}" data-locked="${!isUnlocked}" ${!isUnlocked || cannotAfford ? "disabled" : ""}>
        <span class="config-check" aria-hidden="true"><i>✓</i><b>+</b></span>
        <span class="config-copy"><small>${config.category}</small><strong>${config.label}</strong><p>${config.description}</p><em>${config.effect}</em></span>
        <span class="config-price">${isUnlocked ? `$${config.cost}` : `Phase ${Math.max(1, campaignPhases.findIndex((phase) => phase.configUnlocks.includes(config.id)) + 1)}`}</span>
      </button>
    `;
  }).join("");
  applyConfigButton.textContent = plannedSpend === configSpend(activeConfigs) ? "Close runbook" : "Apply configuration";
}

function openConfigScreen() {
  if (isRunning) {
    showToast("Configuration is frozen during a live traffic drill.");
    return;
  }
  closeRequestTrace(true);
  pendingConfigs = new Set(activeConfigs);
  renderConfigPanel();
  configOverlay.dataset.visible = "true";
  configOverlay.setAttribute("aria-hidden", "false");
}

function closeConfigScreen(apply = false) {
  if (apply) {
    activeConfigs.clear();
    for (const id of pendingConfigs) activeConfigs.add(id);
    updateUi();
    renderPhaseProgress();
  }
  configOverlay.dataset.visible = "false";
  configOverlay.setAttribute("aria-hidden", "true");
}

function gridToWorld(grid: GridPosition): THREE.Vector3 {
  return new THREE.Vector3(
    (grid.col - (columns - 1) / 2) * tileSize,
    0.13,
    (grid.row - (rows - 1) / 2) * tileSize,
  );
}

function pseudoRandom(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

type PixelWorkshopTextureKind = "floor" | "wall" | "machine-dark" | "machine-light" | "fascia";

function createPixelWorkshopTexture(kind: PixelWorkshopTextureKind) {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = kind === "floor" ? 256 : kind === "wall" ? 128 : 64;
  textureCanvas.height = kind === "floor" ? 256 : 64;
  const context = textureCanvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;

  const fill = (color: string, x: number, y: number, width: number, height: number) => {
    context.fillStyle = color;
    context.fillRect(x, y, width, height);
  };
  const dot = (color: string, x: number, y: number, size = 2) => fill(color, x, y, size, size);

  if (kind === "floor") {
    fill("#566f7e", 0, 0, 256, 256);
    for (let row = 0; row < 8; row += 1) {
      for (let col = 0; col < 8; col += 1) {
        const x = col * 32;
        const y = row * 32;
        fill("#213b4d", x, y, 32, 1);
        fill("#274050", x, y, 1, 32);
        fill("#758c96", x + 2, y + 2, 28, 1);
        fill((row + col) % 2 ? "#506b79" : "#5b7381", x + 3, y + 4, 27, 26);
        dot("#193448", x + 5, y + 7, 1);
        dot("#7e95a0", x + 25, y + 25, 1);
        if ((row * 8 + col) % 5 === 0) {
          fill("#365364", x + 8, y + 14, 11, 1);
          fill("#2c4658", x + 18, y + 15, 6, 1);
        }
      }
    }
    for (let index = 0; index < 180; index += 1) {
      const x = Math.floor(pseudoRandom(index * 3 + 91) * 252) + 2;
      const y = Math.floor(pseudoRandom(index * 3 + 92) * 252) + 2;
      const width = index % 7 === 0 ? 3 : index % 3 === 0 ? 2 : 1;
      fill(index % 11 === 0 ? "#765540" : index % 2 ? "#314d5e" : "#6a8290", x, y, width, 1);
    }
  } else if (kind === "wall") {
    fill("#2d465b", 0, 0, 128, 64);
    for (let col = 0; col < 4; col += 1) {
      const x = col * 32;
      fill("#152b3d", x, 0, 3, 64);
      fill("#627b8d", x + 3, 2, 27, 3);
      fill(col % 2 ? "#344e62" : "#38566a", x + 5, 8, 23, 48);
      fill("#213c50", x + 8, 13, 17, 3);
      fill("#28465a", x + 8, 20, 17, 24);
      fill("#5c7587", x + 10, 22, 13, 3);
      fill("#123248", x + 10, 29, 13, 11);
      if (col % 2 === 0) fill("#55d7dc", x + 12, 32, 9, 3);
      dot("#a1b1b5", x + 7, 52);
      dot("#183449", x + 25, 52);
    }
    fill("#10283b", 0, 59, 128, 5);
  } else {
    const isDark = kind === "machine-dark";
    const isFascia = kind === "fascia";
    const base = isDark ? "#34495c" : isFascia ? "#40586a" : "#768c98";
    const shade = isDark ? "#1b3145" : isFascia ? "#263f54" : "#465e70";
    const light = isDark ? "#607789" : isFascia ? "#708594" : "#a0b0b2";
    fill(base, 0, 0, 64, 64);
    for (let y = 0; y < 64; y += 16) {
      fill(shade, 0, y, 64, 3);
      fill(light, 0, y + 3, 64, 2);
      for (let x = 7; x < 64; x += 16) {
        dot(shade, x, y + 8);
        dot(light, x + 2, y + 8);
      }
    }
    fill(shade, 4, 53, 22, 3);
    fill(light, 36, 22, 16, 3);
    if (isFascia) {
      fill("#183547", 8, 7, 20, 6);
      fill("#59d1d8", 11, 9, 14, 2);
      fill("#264657", 39, 39, 17, 8);
    }
  }

  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.name = `pixel-workshop-${kind}`;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 1;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  texture.magFilter = THREE.NearestFilter;
  canvas.dataset[`${kind.replace("-", "")}Texture`] = `procedural:${textureCanvas.width}x${textureCanvas.height}`;
  return texture;
}

function createSurfaceTexture(base: string, dark: string, light: string) {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 256;
  textureCanvas.height = 256;
  const context = textureCanvas.getContext("2d")!;
  context.fillStyle = base;
  context.fillRect(0, 0, 256, 256);

  for (let index = 0; index < 850; index += 1) {
    const x = pseudoRandom(index * 3 + 1) * 256;
    const y = pseudoRandom(index * 3 + 2) * 256;
    const size = 0.5 + pseudoRandom(index * 3 + 3) * 3.4;
    context.globalAlpha = 0.05 + pseudoRandom(index + 900) * 0.18;
    context.fillStyle = index % 3 === 0 ? light : dark;
    context.fillRect(x, y, size, size * 0.55);
  }

  context.lineCap = "round";
  for (let index = 0; index < 18; index += 1) {
    const startX = pseudoRandom(index + 1900) * 256;
    const startY = pseudoRandom(index + 2100) * 256;
    context.globalAlpha = 0.08 + pseudoRandom(index + 2300) * 0.12;
    context.strokeStyle = index % 2 === 0 ? dark : light;
    context.lineWidth = 0.5 + pseudoRandom(index + 2500) * 1.2;
    context.beginPath();
    context.moveTo(startX, startY);
    context.lineTo(startX + 10 + pseudoRandom(index + 2700) * 35, startY - 6 + pseudoRandom(index + 2900) * 12);
    context.stroke();
  }
  context.globalAlpha = 1;

  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.anisotropy = 1;
  texture.minFilter = THREE.NearestMipmapNearestFilter;
  texture.magFilter = THREE.NearestFilter;
  return texture;
}

function createWorkshopLabelTexture(lines: string[]) {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 128;
  textureCanvas.height = 56;
  const context = textureCanvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  context.fillStyle = "#092735";
  context.fillRect(0, 0, 128, 56);
  context.fillStyle = "#315869";
  context.fillRect(3, 3, 122, 50);
  context.fillStyle = "#123b49";
  context.fillRect(6, 6, 116, 44);
  context.strokeStyle = "#82eee4";
  context.lineWidth = 2;
  context.strokeRect(7, 7, 114, 42);
  context.fillStyle = "#b7fff0";
  context.font = "bold 19px Pixelify Sans, monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  lines.forEach((line, index) => context.fillText(line, 64, 20 + index * 18));
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

function createWorkshopStencilTexture(text: string) {
  const textureCanvas = document.createElement("canvas");
  textureCanvas.width = 192;
  textureCanvas.height = 64;
  const context = textureCanvas.getContext("2d")!;
  context.imageSmoothingEnabled = false;
  context.clearRect(0, 0, textureCanvas.width, textureCanvas.height);
  context.fillStyle = "rgba(147, 169, 174, 0.52)";
  context.font = "900 43px monospace";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(text, 96, 34);
  for (let index = 0; index < 18; index += 1) {
    const x = 20 + Math.floor(pseudoRandom(index + 6200) * 152);
    const y = 16 + Math.floor(pseudoRandom(index + 6300) * 34);
    context.clearRect(x, y, 2 + index % 4, 1 + index % 2);
  }
  const texture = new THREE.CanvasTexture(textureCanvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  return texture;
}

function material(color: number, options: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.65,
    metalness: 0.14,
    flatShading: true,
    ...options,
  });
}

function casingMaterial(color: number, roughness = 0.76, metalness = 0.2, bumpScale = 0.014) {
  return material(color, {
    map: paintedMachineNeutralTexture,
    bumpMap: paintedMachineDarkTexture,
    bumpScale,
    roughness,
    metalness,
  });
}

function fasciaMaterial(color: number, roughness = 0.8, metalness = 0.3, bumpScale = 0.018) {
  return material(color, {
    map: paintedFasciaTexture,
    bumpMap: paintedFasciaBumpTexture,
    bumpScale,
    emissive: 0x132b38,
    emissiveMap: paintedFasciaTexture,
    emissiveIntensity: 0.2,
    roughness,
    metalness,
  });
}

function addMesh(
  parent: THREE.Object3D,
  geometry: THREE.BufferGeometry,
  meshMaterial: THREE.Material,
  position: [number, number, number],
  rotation?: [number, number, number],
) {
  const mesh = new THREE.Mesh(geometry, meshMaterial);
  mesh.position.set(...position);
  if (rotation) mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);

  if (geometry instanceof THREE.BoxGeometry || geometry instanceof THREE.CylinderGeometry) {
    const outline = new THREE.LineSegments(
      new THREE.EdgesGeometry(geometry, 28),
      new THREE.LineBasicMaterial({
        color: 0x203747,
        transparent: true,
        opacity: 0.34,
      }),
    );
    outline.renderOrder = 2;
    mesh.add(outline);
  }
  return mesh;
}

function createProceduralMachine(kind: ComponentKind, translucent = false): THREE.Group {
  const group = new THREE.Group();
  group.userData.kind = kind;
  const dark = material(0x9aadb2, {
    map: paintedMachineDarkTexture,
    bumpMap: paintedMachineDarkTexture,
    bumpScale: 0.018,
    roughness: 0.78,
    metalness: 0.24,
  });
  const ink = material(0x193747, { roughness: 0.72, metalness: 0.25 });
  const cream = material(0xc1cbc7, {
    map: paintedMachineNeutralTexture,
    bumpMap: paintedMachineDarkTexture,
    bumpScale: 0.012,
    roughness: 0.8,
    metalness: 0.1,
  });
  const accent = material(componentDefinitions[kind].color, {
    map: paintedMachineNeutralTexture,
    bumpMap: paintedMachineDarkTexture,
    bumpScale: 0.016,
    roughness: 0.68,
    metalness: 0.18,
  });
  const glass = material(0x76e6dc, {
    emissive: 0x207f85,
    emissiveIntensity: 1.55,
    roughness: 0.25,
  });

  const contactShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.7, 8),
    new THREE.MeshBasicMaterial({
      color: 0x153342,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    }),
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.set(0.08, 0.025, 0.08);
  contactShadow.scale.set(1, 0.72, 1);
  group.add(contactShadow);

  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(0.59, 0.68, 8),
    new THREE.MeshBasicMaterial({
      color: componentDefinitions[kind].color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.position.y = 0.032;
  selectionRing.userData.motion = "selectionRing";
  group.add(selectionRing);

  // Every service is assembled on the same octagonal hot-swap dock. The shared
  // port language makes machines read as parts of one system, while the upper
  // silhouettes stay distinct enough to identify without their labels.
  addMesh(group, new THREE.CylinderGeometry(0.62, 0.7, 0.13, 8), dark, [0, 0.08, 0]);
  addMesh(group, new THREE.CylinderGeometry(0.54, 0.61, 0.1, 8), cream, [0, 0.19, 0]);
  for (const [x, z, rotation] of [
    [0, 0.58, 0], [0.58, 0, Math.PI / 2], [0, -0.58, 0], [-0.58, 0, Math.PI / 2],
  ] as const) {
    addMesh(group, new THREE.BoxGeometry(0.19, 0.13, 0.08), ink, [x, 0.24, z], [0, rotation, 0]);
    addMesh(group, new THREE.BoxGeometry(0.09, 0.035, 0.014), glass, [x, 0.25, z + (z >= 0 ? 0.048 : -0.048)], [0, rotation, 0]);
  }

  if (kind === "api") {
    addMesh(group, new THREE.BoxGeometry(0.86, 0.7, 0.72), cream, [0, 0.55, 0]);
    addMesh(group, new THREE.BoxGeometry(0.7, 0.22, 0.055), ink, [0, 0.62, 0.388]);
    for (let index = 0; index < 4; index += 1) {
      addMesh(group, new THREE.BoxGeometry(0.56, 0.035, 0.022), dark, [0, 0.39 + index * 0.075, 0.418]);
    }
    addMesh(group, new THREE.SphereGeometry(0.045, 10, 8), glass, [-0.25, 0.75, 0.432]);
    addMesh(group, new THREE.SphereGeometry(0.045, 10, 8), material(0xa5ddff, { emissive: 0x245d9a, emissiveIntensity: 1 }), [-0.1, 0.75, 0.432]);
    addMesh(group, new THREE.BoxGeometry(0.66, 0.1, 0.58), accent, [0, 0.96, -0.01]);
    addMesh(group, new THREE.CylinderGeometry(0.055, 0.055, 0.22, 10), dark, [0.26, 1.11, 0], [0, 0, -0.1]);
    const apiBeacon = addMesh(group, new THREE.SphereGeometry(0.075, 12, 10), glass, [0.275, 1.23, 0]);
    apiBeacon.userData.motion = "beacon";
    apiBeacon.userData.phase = 0.2;
  }

  if (kind === "redis") {
    addMesh(group, new THREE.BoxGeometry(0.9, 0.68, 0.74), accent, [0, 0.55, 0]);
    addMesh(group, new THREE.BoxGeometry(0.74, 0.11, 0.055), dark, [0, 0.37, 0.395]);
    addMesh(group, new THREE.BoxGeometry(0.74, 0.11, 0.055), dark, [0, 0.53, 0.395]);
    addMesh(group, new THREE.BoxGeometry(0.74, 0.11, 0.055), dark, [0, 0.69, 0.395]);
    for (const [index, y] of [0.37, 0.53, 0.69].entries()) {
      const memoryLight = addMesh(group, new THREE.BoxGeometry(0.16, 0.035, 0.022), glass, [0.12, y, 0.389]);
      memoryLight.material = glass.clone();
      memoryLight.userData.motion = "memoryLight";
      memoryLight.userData.phase = index / 3;
    }
    addMesh(group, new THREE.BoxGeometry(0.94, 0.11, 0.78), dark, [0, 0.92, 0]);
    addMesh(group, new THREE.CylinderGeometry(0.045, 0.045, 0.22, 10), dark, [-0.28, 1.08, 0]);
    addMesh(group, new THREE.SphereGeometry(0.07, 12, 10), glass, [-0.28, 1.2, 0]);
  }

  if (kind === "postgres") {
    addMesh(group, new THREE.BoxGeometry(0.84, 0.95, 0.66), accent, [0, 0.7, 0]);
    addMesh(group, new THREE.BoxGeometry(0.7, 0.7, 0.045), ink, [0, 0.72, 0.355]);
    for (const x of [-0.2, 0.2]) {
      const archiveDisk = addMesh(group, new THREE.CylinderGeometry(0.2, 0.2, 0.055, 24), cream, [x, 0.82, 0.39], [Math.PI / 2, 0, 0]);
      archiveDisk.userData.motion = "archiveDisk";
      archiveDisk.userData.direction = x < 0 ? -1 : 1;
      addMesh(group, new THREE.CylinderGeometry(0.055, 0.055, 0.065, 16), dark, [x, 0.82, 0.427], [Math.PI / 2, 0, 0]);
    }
    addMesh(group, new THREE.BoxGeometry(0.36, 0.07, 0.035), glass, [0, 0.42, 0.39]);
    addMesh(group, new THREE.BoxGeometry(0.72, 0.12, 0.55), dark, [0, 1.24, -0.01]);
  }

  if (kind === "loadBalancer") {
    addMesh(group, new THREE.BoxGeometry(0.88, 0.58, 0.78), accent, [0, 0.51, 0]);
    addMesh(group, new THREE.BoxGeometry(0.72, 0.36, 0.055), cream, [0, 0.54, 0.425]);
    addMesh(group, new THREE.CylinderGeometry(0.18, 0.18, 0.07, 16), ink, [0, 0.56, 0.47], [Math.PI / 2, 0, 0]);
    addMesh(group, new THREE.BoxGeometry(0.035, 0.17, 0.035), cream, [0.02, 0.63, 0.51], [0, 0, -0.55]);
    for (const x of [-0.23, 0.23]) {
      addMesh(group, new THREE.SphereGeometry(0.04, 10, 8), glass, [x, 0.34, 0.47]);
    }
    addMesh(group, new THREE.CylinderGeometry(0.25, 0.32, 0.14, 12), dark, [0, 0.87, 0]);
    addMesh(group, new THREE.CylinderGeometry(0.07, 0.07, 0.18, 10), dark, [0, 1.02, 0]);
    addMesh(group, new THREE.SphereGeometry(0.085, 12, 8), glass, [0, 1.14, 0]);
    const radarSweep = addMesh(group, new THREE.BoxGeometry(0.42, 0.035, 0.055), accent, [0.11, 0.96, 0]);
    radarSweep.userData.motion = "radarSweep";
  }

  if (kind === "queue") {
    addMesh(group, new THREE.BoxGeometry(1, 0.34, 0.62), dark, [0, 0.38, 0]);
    addMesh(group, new THREE.BoxGeometry(0.92, 0.07, 0.5), accent, [0, 0.59, 0]);
    for (const x of [-0.36, -0.12, 0.12, 0.36]) {
      const roller = addMesh(group, new THREE.CylinderGeometry(0.055, 0.055, 0.52, 12), cream, [x, 0.64, 0], [Math.PI / 2, 0, 0]);
      roller.userData.motion = "queueRoller";
    }
    const queueBoxA = addMesh(group, new THREE.BoxGeometry(0.2, 0.17, 0.2), material(0xa7d6ee, {
      map: paintedMachineNeutralTexture,
      bumpMap: paintedMachineDarkTexture,
      bumpScale: 0.012,
      roughness: 0.7,
    }), [-0.24, 0.77, 0]);
    const queueBoxB = addMesh(group, new THREE.BoxGeometry(0.2, 0.17, 0.2), material(0xa8cbbf, {
      map: paintedMachineNeutralTexture,
      bumpMap: paintedMachineDarkTexture,
      bumpScale: 0.012,
      roughness: 0.72,
    }), [0.29, 0.77, 0]);
    queueBoxA.userData.motion = "queueBox";
    queueBoxA.userData.phase = 0;
    queueBoxB.userData.motion = "queueBox";
    queueBoxB.userData.phase = 0.5;
    addMesh(group, new THREE.BoxGeometry(0.12, 0.46, 0.12), cream, [-0.45, 0.91, -0.19]);
    addMesh(group, new THREE.SphereGeometry(0.07, 12, 10), glass, [-0.45, 1.18, -0.19]);
  }

  if (kind === "worker") {
    if (currentPhase.workload === "analytics") {
      addMesh(group, new THREE.BoxGeometry(0.9, 0.3, 0.72), accent, [0, 0.37, 0]);
      addMesh(group, new THREE.BoxGeometry(0.72, 0.13, 0.56), dark, [0, 0.59, -0.02]);
      addMesh(group, new THREE.BoxGeometry(0.64, 0.46, 0.12), cream, [0, 0.82, -0.08], [-0.3, 0, 0]);
      const analyticsScreen = addMesh(group, new THREE.BoxGeometry(0.5, 0.31, 0.035), glass, [0, 0.84, 0.01], [-0.3, 0, 0]);
      analyticsScreen.material = glass.clone();
      analyticsScreen.userData.motion = "memoryLight";
      analyticsScreen.userData.phase = 0.25;
      addMesh(group, new THREE.BoxGeometry(0.58, 0.08, 0.32), ink, [0, 0.55, 0.31], [-0.08, 0, 0]);
      for (const x of [-0.18, -0.06, 0.06, 0.18]) {
        addMesh(group, new THREE.BoxGeometry(0.055, 0.025, 0.025), x > 0.1 ? glass : cream, [x, 0.58, 0.46]);
      }
    } else {
      addMesh(group, new THREE.CylinderGeometry(0.46, 0.52, 0.62, 8), accent, [0, 0.52, 0]);
      addMesh(group, new THREE.BoxGeometry(0.74, 0.42, 0.055), ink, [0, 0.58, 0.43]);
      for (const x of [-0.2, 0.2]) {
        const fan = addMesh(group, new THREE.CylinderGeometry(0.145, 0.145, 0.055, 18), cream, [x, 0.63, 0.47], [Math.PI / 2, 0, 0]);
        fan.userData.motion = "workerFan";
        fan.userData.direction = x < 0 ? -1 : 1;
        addMesh(group, new THREE.CylinderGeometry(0.045, 0.045, 0.065, 12), dark, [x, 0.63, 0.506], [Math.PI / 2, 0, 0]);
      }
      addMesh(group, new THREE.BoxGeometry(0.72, 0.12, 0.62), dark, [0, 0.9, 0]);
      for (const x of [-0.24, -0.08, 0.08, 0.24]) {
        const jobLight = addMesh(group, new THREE.BoxGeometry(0.08, 0.035, 0.035), glass, [x, 0.98, 0.18]);
        jobLight.material = glass.clone();
        jobLight.userData.motion = "memoryLight";
        jobLight.userData.phase = x + 0.5;
      }
      addMesh(group, new THREE.BoxGeometry(0.18, 0.33, 0.18), cream, [0.31, 1.12, -0.15]);
      const workerBeacon = addMesh(group, new THREE.SphereGeometry(0.065, 12, 10), glass, [0.31, 1.33, -0.15]);
      workerBeacon.userData.motion = "beacon";
    }
  }

  if (kind === "geoIndex") {
    addMesh(group, new THREE.CylinderGeometry(0.47, 0.53, 0.3, 6), accent, [0, 0.35, 0]);
    addMesh(group, new THREE.CylinderGeometry(0.35, 0.4, 0.12, 6), cream, [0, 0.58, 0]);
    for (const [index, position] of [
      [-0.24, 0.74, -0.1],
      [0, 0.74, 0.18],
      [0.24, 0.74, -0.1],
    ].entries()) {
      const cell = addMesh(group, new THREE.CylinderGeometry(0.17, 0.17, 0.09, 6), index === 1 ? glass : accent, position as [number, number, number]);
      cell.userData.motion = "geoCell";
      cell.userData.phase = index / 3;
    }
    addMesh(group, new THREE.CylinderGeometry(0.045, 0.055, 0.68, 10), dark, [0, 1.05, 0]);
    for (const radius of [0.16, 0.28, 0.4]) {
      const ring = addMesh(group, new THREE.TorusGeometry(radius, 0.018, 8, 24), radius === 0.4 ? accent : glass, [0, 1.38, 0], [Math.PI / 2, 0, 0]);
      ring.userData.motion = "geoRing";
      ring.userData.phase = radius;
    }
    const locator = addMesh(group, new THREE.SphereGeometry(0.075, 12, 10), glass, [0, 1.39, 0]);
    locator.userData.motion = "beacon";
  }

  if (kind === "objectStorage") {
    addMesh(group, new THREE.BoxGeometry(0.92, 0.18, 0.74), dark, [0, 0.34, 0]);
    for (const [index, x] of [-0.28, 0, 0.28].entries()) {
      addMesh(group, new THREE.CylinderGeometry(0.16, 0.18, 0.64, 16), accent, [x, 0.72, 0]);
      addMesh(group, new THREE.CylinderGeometry(0.17, 0.17, 0.075, 16), cream, [x, 1.07, 0]);
      addMesh(group, new THREE.BoxGeometry(0.2, 0.12, 0.04), ink, [x, 0.72, 0.18]);
      const storageLight = addMesh(group, new THREE.BoxGeometry(0.08, 0.025, 0.025), glass, [x, 0.72, 0.205]);
      storageLight.material = glass.clone();
      storageLight.userData.motion = "memoryLight";
      storageLight.userData.phase = index / 3;
    }
    addMesh(group, new THREE.BoxGeometry(0.96, 0.1, 0.78), cream, [0, 1.18, 0]);
  }

  if (kind === "cdn") {
    addMesh(group, new THREE.BoxGeometry(0.72, 0.66, 0.66), accent, [0, 0.55, 0]);
    addMesh(group, new THREE.BoxGeometry(0.58, 0.34, 0.055), ink, [0, 0.58, 0.36]);
    for (const x of [-0.2, 0, 0.2]) {
      addMesh(group, new THREE.BoxGeometry(0.11, 0.045, 0.03), glass, [x, 0.61, 0.4]);
    }
    addMesh(group, new THREE.CylinderGeometry(0.07, 0.09, 0.52, 12), dark, [0, 1.08, 0]);
    const dish = new THREE.Group();
    dish.position.set(0, 1.37, 0);
    dish.userData.motion = "cdnDish";
    addMesh(dish, new THREE.CylinderGeometry(0.31, 0.1, 0.12, 24), cream, [0, 0, 0], [Math.PI / 2, 0, 0]);
    addMesh(dish, new THREE.CylinderGeometry(0.035, 0.035, 0.24, 10), dark, [0, 0, 0.19], [Math.PI / 2, 0, 0]);
    addMesh(dish, new THREE.SphereGeometry(0.06, 12, 10), glass, [0, 0, 0.33]);
    group.add(dish);
    for (const radius of [0.38, 0.5]) {
      const signalRing = addMesh(group, new THREE.TorusGeometry(radius, 0.014, 7, 24, Math.PI), glass, [0, 1.45, 0.22], [0, 0, Math.PI / 2]);
      signalRing.userData.motion = "edgeSignal";
      signalRing.userData.phase = radius;
    }
  }

  if (!["queue", "worker", "objectStorage"].includes(kind)) {
    addMesh(group, new THREE.CylinderGeometry(0.055, 0.055, 0.42, 10), dark, [-0.49, 0.48, -0.2]);
    addMesh(group, new THREE.TorusGeometry(0.1, 0.035, 7, 12, Math.PI), accent, [-0.49, 0.7, -0.1], [0, Math.PI / 2, 0]);
  }

  if (translucent) {
    group.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      const source = object.material as THREE.MeshStandardMaterial;
      object.material = source.clone();
      const clone = object.material as THREE.MeshStandardMaterial;
      clone.transparent = true;
      clone.opacity = 0.48;
      clone.depthWrite = false;
      object.userData.ghostBaseColor = clone.color.getHex();
    });
  }

  return group;
}

function createMachine(kind: ComponentKind, translucent = false): THREE.Group {
  if (new URLSearchParams(window.location.search).get("machine-renderer") === "procedural") {
    return createProceduralMachine(kind, translucent);
  }
  const group = new THREE.Group();
  group.userData.kind = kind;

  const contactShadow = new THREE.Mesh(
    new THREE.CircleGeometry(0.65, 12),
    new THREE.MeshBasicMaterial({
      color: 0x03121d,
      transparent: true,
      opacity: translucent ? 0.08 : 0.18,
      depthWrite: false,
    }),
  );
  contactShadow.rotation.x = -Math.PI / 2;
  contactShadow.position.set(0.08, 0.032, 0.1);
  contactShadow.scale.set(1, 0.64, 1);
  contactShadow.userData.motion = "contactShadow";
  group.add(contactShadow);

  const dockMaterial = material(0x29475b, {
    emissive: 0x102d3e,
    emissiveIntensity: translucent ? 0.2 : 0.48,
    roughness: 0.6,
    metalness: 0.34,
    transparent: translucent,
    opacity: translucent ? 0.42 : 1,
  });
  const dock = addMesh(
    group,
    new THREE.CylinderGeometry(0.56, 0.64, 0.08, 8),
    dockMaterial,
    [0, 0.09, 0],
  );
  dock.userData.motion = "machineDock";

  const hitVolume = new THREE.Mesh(
    new THREE.BoxGeometry(1.45, 1.6, 0.72),
    new THREE.MeshBasicMaterial({
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    }),
  );
  hitVolume.position.y = 0.76;
  group.add(hitVolume);

  const selectionRing = new THREE.Mesh(
    new THREE.RingGeometry(0.58, 0.69, 12),
    new THREE.MeshBasicMaterial({
      color: componentDefinitions[kind].color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  selectionRing.rotation.x = -Math.PI / 2;
  selectionRing.position.y = 0.035;
  selectionRing.userData.motion = "selectionRing";
  group.add(selectionRing);

  return group;
}

function renderPartPreviews() {
  for (const kind of componentOrder) {
    const previewData = componentPreviewSources[kind];
    const image = document.querySelector<HTMLImageElement>(`#part-preview-${kind}`);
    brandPreviewData.set(kind, previewData);
    if (image) image.src = previewData;
  }
  setBrandItem(componentOrder[brandItemIndex], false);
  if (phaseBriefingOverlay.dataset.visible === "true") renderPhaseBriefing();
}

function setBrandItem(kind: ComponentKind, animate = true) {
  const previewData = brandPreviewData.get(kind);
  if (!previewData) return;
  const definition = componentDefinitions[kind];
  brandMark.dataset.ready = "true";
  brandMark.setAttribute("aria-label", `${definition.label} workshop emblem. Click to reveal another machine.`);
  brandMark.title = `${definition.label} · click for another machine`;

  if (!animate) {
    brandItemPrimary.src = previewData;
    brandItemPrimary.dataset.active = "true";
    brandItemSecondary.dataset.active = "false";
    brandActiveLayer = 0;
    return;
  }

  const nextLayer = brandActiveLayer === 0 ? brandItemSecondary : brandItemPrimary;
  const previousLayer = brandActiveLayer === 0 ? brandItemPrimary : brandItemSecondary;
  nextLayer.src = previewData;
  requestAnimationFrame(() => {
    previousLayer.dataset.active = "false";
    nextLayer.dataset.active = "true";
    brandActiveLayer = brandActiveLayer === 0 ? 1 : 0;
  });
}

function addBoardDetails() {
  const dark = material(0x284858, { roughness: 0.68, metalness: 0.4 });
  const blue = material(0x63858f, { roughness: 0.61, metalness: 0.2 });
  const grate = material(0x1e3b4b, { roughness: 0.74, metalness: 0.52 });
  const seam = material(0x2f5661, {
    roughness: 0.82,
    metalness: 0.28,
    transparent: true,
    opacity: 0.2,
  });
  const patch = casingMaterial(0x68878b, 0.92, 0.1, 0.008);

  for (let col = 1; col < columns; col += 1) {
    addMesh(
      boardGroup,
      new THREE.BoxGeometry(0.01, 0.008, rows * tileSize - 0.08),
      seam,
      [(col - columns / 2) * tileSize, 0.135, 0],
    );
  }
  for (let row = 1; row < rows; row += 1) {
    addMesh(
      boardGroup,
      new THREE.BoxGeometry(columns * tileSize - 0.08, 0.008, 0.01),
      seam,
      [0, 0.135, (row - rows / 2) * tileSize],
    );
  }

  for (const [x, z, rotation, width, depth] of [
    [-2.25, -2.65, 0.04, 0.9, 0.52], [3.25, -2.15, -0.08, 0.62, 0.78],
    [-3.75, 1.75, 0.12, 0.72, 0.48], [1.7, 2.9, -0.06, 1.05, 0.44],
  ] as const) {
    addMesh(boardGroup, new THREE.BoxGeometry(width, 0.025, depth), patch, [x, 0.15, z], [0, rotation, 0]);
  }

  // Textured rotary patch table: a warm, painted network exchange with a
  // segmented service ring and a recessed radial cable grate.
  const exchange = new THREE.Group();
  exchange.position.set(0, 0.155, 0);
  exchange.rotation.y = -0.055;
  exchange.visible = false;
  boardGroup.add(exchange);

  const warmMetal = casingMaterial(0x84999b, 0.88, 0.1, 0.012);
  const sageMetal = casingMaterial(0x61928f, 0.82, 0.15, 0.014);
  const paleMetal = casingMaterial(0xa5b3b0, 0.9, 0.06, 0.01);
  const signalBlue = casingMaterial(0x42899e, 0.8, 0.15, 0.012);
  const signalViolet = casingMaterial(0x687cad, 0.8, 0.13, 0.012);
  const neutralGrate = material(0x243f4e, { roughness: 0.82, metalness: 0.34 });

  addMesh(exchange, new THREE.CylinderGeometry(1.08, 1.08, 0.07, 48), warmMetal, [0, 0.035, 0]);
  addMesh(exchange, new THREE.TorusGeometry(0.93, 0.09, 8, 48), signalBlue, [0, 0.105, 0], [Math.PI / 2, 0, 0]);
  addMesh(exchange, new THREE.CylinderGeometry(0.64, 0.64, 0.075, 40), sageMetal, [0, 0.105, 0]);

  // Separate ring plates make it look serviceable instead of like one smooth disc.
  for (let segment = 0; segment < 6; segment += 1) {
    const start = segment * (Math.PI * 2 / 6) + 0.045;
    const segmentMaterial = segment % 2 === 0 ? signalBlue : signalViolet;
    addMesh(
      exchange,
      new THREE.RingGeometry(0.68, 0.86, 24, 1, start, Math.PI * 2 / 6 - 0.09),
      segmentMaterial,
      [0, 0.16, 0],
      [-Math.PI / 2, 0, 0],
    );
  }

  // Radial cable channels and a small central bearing break up the inner field.
  for (let channel = 0; channel < 6; channel += 1) {
    const angle = channel * Math.PI / 3;
    const rail = addMesh(
      exchange,
      new THREE.BoxGeometry(0.09, 0.028, 0.45),
      neutralGrate,
      [Math.sin(angle) * 0.32, 0.165, Math.cos(angle) * 0.32],
      [0, angle, 0],
    );
    rail.receiveShadow = true;
  }
  addMesh(exchange, new THREE.CylinderGeometry(0.22, 0.22, 0.075, 24), paleMetal, [0, 0.19, 0]);
  addMesh(exchange, new THREE.CylinderGeometry(0.09, 0.09, 0.085, 18), neutralGrate, [0, 0.235, 0]);

  const portMaterial = material(0x61c8cf, {
    emissive: 0x164f5b,
    emissiveIntensity: 0.14,
    roughness: 0.38,
    metalness: 0.18,
  });
  for (let index = 0; index < 6; index += 1) {
    const angle = index * Math.PI / 3;
    const signalMaterial = portMaterial.clone();
    signalMaterial.emissiveIntensity = 0.14;
    boardActivityMaterials.push(signalMaterial);
    addMesh(
      exchange,
      new THREE.BoxGeometry(0.085, 0.026, 0.055),
      signalMaterial,
      [Math.sin(angle) * 0.78, 0.195, Math.cos(angle) * 0.78],
      [0, angle, 0],
    );
  }
  for (let bolt = 0; bolt < 8; bolt += 1) {
    const angle = bolt * Math.PI / 4;
    addMesh(
      exchange,
      new THREE.CylinderGeometry(0.025, 0.025, 0.03, 8),
      paleMetal,
      [Math.sin(angle) * 1.0, 0.145, Math.cos(angle) * 1.0],
    );
  }

  for (const [x, z, rotation] of [
    [-3.4, -2.1, 0.08], [3.65, 1.9, -0.12], [-2.65, 2.65, 0.2], [2.85, -2.65, -0.15],
  ] as const) {
    const vent = new THREE.Group();
    vent.position.set(x, 0.145, z);
    vent.rotation.y = rotation;
    boardGroup.add(vent);
    addMesh(vent, new THREE.BoxGeometry(0.86, 0.045, 0.52), dark, [0, 0, 0]);
    for (let index = 0; index < 6; index += 1) {
      addMesh(vent, new THREE.BoxGeometry(0.055, 0.025, 0.46), grate, [-0.34 + index * 0.135, 0.035, 0]);
    }
  }

  // Rivets at the major plate intersections give the grid an industrial scale.
  for (let row = 0; row <= rows; row += 2) {
    for (let col = 0; col <= columns; col += 2) {
      addMesh(
        boardGroup,
        new THREE.CylinderGeometry(0.027, 0.027, 0.026, 8),
        blue,
        [(col - columns / 2) * tileSize, 0.145, (row - rows / 2) * tileSize],
      );
    }
  }

}

function addEnvironment() {
  const dark = material(0x263f50, { roughness: 0.7, metalness: 0.42 });
  const screen = material(0x64d9d8, { emissive: 0x176d78, emissiveIntensity: 1.2, roughness: 0.25 });
  screen.userData.baseEmissiveIntensity = screen.emissiveIntensity;
  workshopPulseMaterials.push(screen);
  const propDark = casingMaterial(0x82969f, 0.82, 0.24, 0.014);
  const propBlue = casingMaterial(0x9aadb3, 0.74, 0.18, 0.014);
  const propSage = casingMaterial(0x91aaa5, 0.8, 0.12, 0.012);
  const propCream = casingMaterial(0xbfc9c5, 0.84, 0.08, 0.01);
  const propAccent = casingMaterial(0x75bcb5, 0.7, 0.18, 0.012);
  const fasciaDark = fasciaMaterial(0x8195a0, 0.86, 0.24, 0.016);
  const fasciaBlue = fasciaMaterial(0x94a7ac, 0.82, 0.18, 0.014);
  const paintedBulkhead = new THREE.MeshBasicMaterial({
    color: 0xb8c5c3,
    map: paintedWallTexture,
    side: THREE.DoubleSide,
  });

  addMesh(environmentGroup, new THREE.BoxGeometry(16.2, 0.42, 12.7), fasciaDark, [0, -0.57, 0]);
  addMesh(environmentGroup, new THREE.BoxGeometry(15.7, 0.14, 12.2), fasciaBlue, [0, -0.34, 0]);
  addPlatformUndercarriage(fasciaDark, fasciaBlue, screen, propDark, propBlue);

  // Dense back and side bulkheads make the room feel enclosed, not like a floating arena.
  addMesh(environmentGroup, new THREE.BoxGeometry(14.6, 2.25, 0.62), fasciaBlue, [0, 0.55, -5.35]);
  addMesh(environmentGroup, new THREE.BoxGeometry(0.62, 2.05, 10.4), fasciaDark, [-6.65, 0.45, 0]);
  addMesh(environmentGroup, new THREE.BoxGeometry(0.62, 2.05, 10.4), fasciaDark, [6.65, 0.45, 0]);
  addMesh(environmentGroup, new THREE.BoxGeometry(13.7, 1.15, 0.55), fasciaDark, [0, 0.05, 5.2]);

  addMesh(environmentGroup, new THREE.PlaneGeometry(13.95, 2.02), paintedBulkhead, [0, 0.58, -5.025]);
  addMesh(environmentGroup, new THREE.PlaneGeometry(9.7, 1.95), paintedBulkhead, [-6.325, 0.48, 0], [0, Math.PI / 2, 0]);
  addMesh(environmentGroup, new THREE.PlaneGeometry(9.7, 1.95), paintedBulkhead, [6.325, 0.48, 0], [0, -Math.PI / 2, 0]);
  addMesh(environmentGroup, new THREE.PlaneGeometry(12.8, 1.0), paintedBulkhead, [0, 0.1, 4.915], [0, Math.PI, 0]);

  const bayStencil = new THREE.Mesh(
    new THREE.PlaneGeometry(1.9, 0.58),
    new THREE.MeshBasicMaterial({
      map: createWorkshopStencilTexture("SB-17"),
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    }),
  );
  bayStencil.position.set(-3.6, 0.68, 5.52);
  bayStencil.renderOrder = 5;
  environmentGroup.add(bayStencil);

  for (let index = 0; index < 7; index += 1) {
    addEquipmentModule(-4.9 + index * 1.62, -4.88, 0, index, propSage, propCream, propDark, screen, propAccent);
  }
  for (let index = 0; index < 5; index += 1) {
    addEquipmentModule(-6.28, -3.25 + index * 1.62, Math.PI / 2, index + 7, propBlue, propSage, propDark, screen, propAccent);
    addEquipmentModule(6.28, -3.25 + index * 1.62, Math.PI / 2, index + 12, index % 2 ? propSage : propCream, propBlue, propDark, screen, propAccent);
  }
  for (let index = 0; index < 5; index += 1) {
    addEquipmentModule(-3.3 + index * 1.62, 4.85, 0, index + 17, index % 2 ? propSage : propCream, propBlue, propDark, screen, propAccent);
  }
  addMaintenanceGantry(propDark, propSage, propCream, screen, propAccent);

  const coolLamp = material(0xb6f3ec, {
    emissive: 0x368a94,
    emissiveIntensity: 1.5,
    roughness: 0.22,
  });
  coolLamp.userData.baseEmissiveIntensity = coolLamp.emissiveIntensity;
  workshopPulseMaterials.push(coolLamp);
  for (const [x, z, rotation] of [
    [-3.7, -4.54, 0], [0, -4.54, 0], [3.7, -4.54, 0],
    [-6.0, 2.25, Math.PI / 2], [6.0, -2.1, -Math.PI / 2],
  ] as const) {
    addMesh(environmentGroup, new THREE.BoxGeometry(0.78, 0.16, 0.09), coolLamp, [x, 1.55, z], [0, rotation, 0]);
  }
  for (const [x, z] of [[-3.7, -4.1], [0, -4.1], [3.7, -4.1]] as const) {
    const lampLight = new THREE.PointLight(0x72d8d6, 4.2, 5.2, 2);
    lampLight.position.set(x, 1.5, z);
    lampLight.userData.baseIntensity = lampLight.intensity;
    lampLight.userData.phase = workshopPulseLights.length * 1.7;
    workshopPulseLights.push(lampLight);
    environmentGroup.add(lampLight);
  }

  // Overhead utility spine and smaller cable runs.
  addMesh(environmentGroup, new THREE.CylinderGeometry(0.14, 0.14, 11.6, 12), propCream, [0.2, 2.02, -5.02], [0, 0, Math.PI / 2]);
  addMesh(environmentGroup, new THREE.CylinderGeometry(0.075, 0.075, 9.8, 10), propAccent, [0.6, 1.72, -4.68], [0, 0, Math.PI / 2]);
  for (const x of [-4.4, -1.5, 1.4, 4.3]) {
    addMesh(environmentGroup, new THREE.TorusGeometry(0.2, 0.055, 8, 18), dark, [x, 2.02, -5.02], [Math.PI / 2, 0, 0]);
  }

  addCable([
    new THREE.Vector3(-5.9, 0.3, -2.9), new THREE.Vector3(-5.5, 0.24, -1.6),
    new THREE.Vector3(-5.1, 0.2, -0.2), new THREE.Vector3(-4.6, 0.17, 0.7),
  ], 0x315f69, 0.035);
  addCable([
    new THREE.Vector3(5.95, 0.28, 2.9), new THREE.Vector3(5.2, 0.2, 2.35),
    new THREE.Vector3(4.3, 0.17, 2.25), new THREE.Vector3(3.7, 0.16, 2.6),
  ], 0x3c6d82, 0.035);

  // A legible fiber patch station replaces the old black service tunnel. It
  // explains the room as a network workshop and keeps this edge useful and bright.
  const uplink = new THREE.Group();
  uplink.position.set(-6.08, 0.86, -1.35);
  uplink.rotation.y = Math.PI / 2;
  environmentGroup.add(uplink);
  addMesh(uplink, new THREE.BoxGeometry(2.7, 1.9, 0.52), propDark, [0, 0, 0]);
  addMesh(uplink, new THREE.BoxGeometry(2.36, 1.55, 0.12), propCream, [0, 0, 0.32]);
  addMesh(uplink, new THREE.BoxGeometry(1.8, 0.42, 0.08), dark, [0, 0.42, 0.41]);
  addMesh(uplink, new THREE.BoxGeometry(1.5, 0.2, 0.035), screen, [0, 0.42, 0.47]);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col < 6; col += 1) {
      addMesh(
        uplink,
        new THREE.BoxGeometry(0.18, 0.12, 0.05),
        (row + col) % 3 === 0 ? screen : propBlue,
        [-0.65 + col * 0.26, 0.03 - row * 0.22, 0.43],
      );
    }
  }
  addMesh(uplink, new THREE.BoxGeometry(2.45, 0.12, 0.68), propAccent, [0, -0.86, 0.08]);

  addCrateStack(-5.7, 3.55, 0.1, 3, propCream, propAccent, propDark);
  addCrateStack(5.55, -3.35, -0.08, 3, propSage, propAccent, propDark);
  addCrateStack(-3.1, 5.05, 0.05, 3, propCream, propAccent, propDark, 0.92);
  addCrateStack(2.55, 5.0, -0.08, 4, propSage, propAccent, propDark, 0.92);
  addWorkshopOperator(1.8, 2.25, propDark, propBlue, screen, propAccent);
  addReferenceWorkshopProps(dark, propDark, propBlue, propCream, screen, propAccent);
}

function addWorkshopOperator(
  x: number,
  z: number,
  dark: THREE.Material,
  body: THREE.Material,
  screen: THREE.Material,
  accent: THREE.Material,
) {
  const operator = new THREE.Group();
  operator.position.set(x, 0.2, z);
  operator.rotation.y = -0.42;
  environmentGroup.add(operator);

  addMesh(operator, new THREE.BoxGeometry(0.34, 0.62, 0.28), body, [0, 0.5, 0]);
  addMesh(operator, new THREE.BoxGeometry(0.38, 0.15, 0.3), accent, [0, 0.66, 0]);
  addMesh(operator, new THREE.CylinderGeometry(0.18, 0.2, 0.24, 8), dark, [0, 0.96, 0]);
  addMesh(operator, new THREE.BoxGeometry(0.28, 0.08, 0.2), body, [0, 1.08, 0.02]);
  for (const side of [-1, 1]) {
    addMesh(operator, new THREE.BoxGeometry(0.12, 0.5, 0.12), dark, [side * 0.22, 0.47, 0], [0, 0, side * 0.16]);
    addMesh(operator, new THREE.BoxGeometry(0.13, 0.5, 0.14), dark, [side * 0.1, 0.02, 0]);
  }
  const tablet = addMesh(operator, new THREE.BoxGeometry(0.4, 0.28, 0.05), dark, [0.27, 0.57, 0.24], [-0.3, 0.1, -0.15]);
  addMesh(tablet, new THREE.BoxGeometry(0.3, 0.19, 0.02), screen, [0, 0, 0.04]);
  operator.userData.baseY = operator.position.y;
  operator.userData.motionPhase = 0.8;
  workshopAnimatedProps.push(operator);
}

function addReferenceWorkshopProps(
  dark: THREE.Material,
  body: THREE.Material,
  secondary: THREE.Material,
  cream: THREE.Material,
  screen: THREE.Material,
  accent: THREE.Material,
) {
  const addBench = (x: number, z: number, width: number, mirrored = false) => {
    const bench = new THREE.Group();
    bench.position.set(x, 0, z);
    environmentGroup.add(bench);
    addMesh(bench, new THREE.BoxGeometry(width, 0.15, 0.72), cream, [0, 0.72, 0]);
    addMesh(bench, new THREE.BoxGeometry(width + 0.1, 0.13, 0.82), dark, [0, 0.61, 0]);
    for (const legX of [-width * 0.38, width * 0.38]) {
      addMesh(bench, new THREE.BoxGeometry(0.16, 0.65, 0.16), body, [legX, 0.3, -0.16]);
    }
    const monitorX = mirrored ? 0.4 : -0.4;
    addMesh(bench, new THREE.BoxGeometry(0.86, 0.62, 0.12), dark, [monitorX, 1.12, -0.17]);
    const monitor = addMesh(bench, new THREE.BoxGeometry(0.7, 0.45, 0.035), screen, [monitorX, 1.12, -0.095]);
    monitor.userData.motion = "workshopScreen";
    addMesh(bench, new THREE.BoxGeometry(0.62, 0.055, 0.28), secondary, [-monitorX * 0.35, 0.83, 0.13], [-0.08, 0, 0]);
    for (let index = 0; index < 4; index += 1) {
      addMesh(bench, new THREE.BoxGeometry(0.075, 0.035, 0.04), index === 0 ? accent : dark, [0.25 + index * 0.11, 0.82, 0.27]);
    }
  };

  addBench(-4.25, -4.05, 2.35);
  addBench(4.55, -3.95, 1.85, true);

  for (const [rackX, phase] of [[0.65, 0], [1.7, 0.7]] as const) {
    const rack = new THREE.Group();
    rack.position.set(rackX, 0, -4.52);
    environmentGroup.add(rack);
    addMesh(rack, new THREE.BoxGeometry(0.82, 1.86, 0.62), dark, [0, 0.93, 0]);
    addMesh(rack, new THREE.BoxGeometry(0.68, 1.68, 0.1), body, [0, 0.93, 0.36]);
    for (let row = 0; row < 7; row += 1) {
      addMesh(rack, new THREE.BoxGeometry(0.56, 0.12, 0.055), row % 3 === 0 ? secondary : dark, [0, 0.32 + row * 0.2, 0.43]);
      const rackLight = addMesh(rack, new THREE.BoxGeometry(0.055, 0.035, 0.025), screen, [0.21, 0.32 + row * 0.2, 0.47]);
      rackLight.userData.motion = "workshopScreen";
      rackLight.userData.phase = phase + row * 0.23;
    }
  }

  const railDark = material(0x183445, { roughness: 0.62, metalness: 0.5 });
  const railAccent = material(0xd09a45, { emissive: 0x4f3211, emissiveIntensity: 0.36, roughness: 0.58, metalness: 0.3 });
  for (const x of [-5.6, -3.7, -1.8, 1.8, 3.7, 5.6]) {
    addMesh(environmentGroup, new THREE.CylinderGeometry(0.055, 0.065, 1.08, 8), railDark, [x, 0.72, 5.5]);
    addMesh(environmentGroup, new THREE.CylinderGeometry(0.08, 0.08, 0.08, 8), railAccent, [x, 1.28, 5.5]);
  }
  for (const [x, width] of [[-4.65, 1.82], [-2.75, 1.82], [2.75, 1.82], [4.65, 1.82]] as const) {
    addMesh(environmentGroup, new THREE.CylinderGeometry(0.055, 0.055, width, 8), railDark, [x, 1.24, 5.5], [0, 0, Math.PI / 2]);
    addMesh(environmentGroup, new THREE.CylinderGeometry(0.025, 0.025, width, 8), railAccent, [x, 1.1, 5.53], [0, 0, Math.PI / 2]);
  }

  addCable([
    new THREE.Vector3(-5.5, 0.2, -3.6),
    new THREE.Vector3(-3.9, 0.2, -2.6),
    new THREE.Vector3(-3.9, 0.2, 0.9),
    new THREE.Vector3(-2.6, 0.2, 1.9),
  ], 0x256f9a, 0.024);
  addCable([
    new THREE.Vector3(4.9, 0.19, -3.3),
    new THREE.Vector3(3.7, 0.19, -2.4),
    new THREE.Vector3(3.7, 0.19, 1.8),
  ], 0xb66c38, 0.022);
}

function addMaintenanceGantry(
  dark: THREE.Material,
  body: THREE.Material,
  cream: THREE.Material,
  screen: THREE.Material,
  accent: THREE.Material,
) {
  const gantry = new THREE.Group();
  gantry.position.set(-1.05, 0, -4.66);
  environmentGroup.add(gantry);

  // A deep central service bay gives the room a readable architectural focus.
  addMesh(gantry, new THREE.BoxGeometry(3.25, 2.75, 0.54), dark, [0, 1.18, 0]);
  addMesh(gantry, new THREE.BoxGeometry(2.75, 2.45, 0.58), body, [0, 1.16, 0.12]);
  addMesh(gantry, new THREE.BoxGeometry(1.52, 1.82, 0.68), dark, [0, 0.92, 0.25]);
  addMesh(gantry, new THREE.BoxGeometry(1.2, 1.52, 0.08), material(0x202431, {
    roughness: 0.86,
    metalness: 0.24,
  }), [0, 0.88, 0.64]);

  for (const x of [-1.25, 1.25]) {
    addMesh(gantry, new THREE.BoxGeometry(0.34, 2.42, 0.74), cream, [x, 1.15, 0.25]);
    addMesh(gantry, new THREE.CylinderGeometry(0.09, 0.09, 1.75, 10), accent, [x, 1.22, 0.68]);
    addMesh(gantry, new THREE.CylinderGeometry(0.14, 0.14, 0.18, 10), dark, [x, 0.42, 0.68]);
    addMesh(gantry, new THREE.CylinderGeometry(0.14, 0.14, 0.18, 10), dark, [x, 2.02, 0.68]);
  }

  addMesh(gantry, new THREE.TorusGeometry(0.76, 0.12, 8, 24, Math.PI), cream, [0, 1.54, 0.65]);
  addMesh(gantry, new THREE.BoxGeometry(1.0, 0.42, 0.12), dark, [0, 1.86, 0.69]);
  const standbySign = new THREE.Mesh(
    new THREE.PlaneGeometry(1.0, 0.41),
    new THREE.MeshBasicMaterial({ map: createWorkshopLabelTexture(["SYSTEM", "STANDBY"]) }),
  );
  standbySign.position.set(0, 1.88, 0.79);
  standbySign.renderOrder = 4;
  gantry.add(standbySign);
  addMesh(gantry, new THREE.BoxGeometry(0.38, 0.11, 0.05), screen, [0, 1.48, 0.72]);

  const portalGlowMaterial = new THREE.MeshBasicMaterial({
    color: 0x53dbd7,
    transparent: true,
    opacity: 0.34,
    depthWrite: false,
  });
  workshopPortalGlows.push(portalGlowMaterial);
  const portalGlow = new THREE.Mesh(new THREE.PlaneGeometry(1.04, 0.7), portalGlowMaterial);
  portalGlow.position.set(0, 0.88, 0.665);
  portalGlow.renderOrder = 3;
  portalGlow.userData.motion = "portalGlow";
  gantry.add(portalGlow);
  for (let line = 0; line < 5; line += 1) {
    addMesh(gantry, new THREE.BoxGeometry(0.94, 0.018, 0.018), screen, [0, 0.58 + line * 0.16, 0.69]);
  }
  for (const x of [-0.31, 0, 0.31]) {
    addMesh(gantry, new THREE.BoxGeometry(0.018, 0.68, 0.018), screen, [x, 0.9, 0.69]);
  }

  // Alternating safety plates echo the painted maintenance language in the references.
  for (let index = 0; index < 11; index += 1) {
    addMesh(
      gantry,
      new THREE.BoxGeometry(0.23, 0.1, 0.1),
      index % 2 === 0 ? accent : dark,
      [-1.15 + index * 0.23, 0.16, 0.68],
      [0, 0, index % 2 === 0 ? -0.3 : 0.3],
    );
  }

  // Uneven side consoles keep the bay from reading as a perfectly mirrored portal.
  addMesh(gantry, new THREE.BoxGeometry(0.72, 0.82, 0.62), dark, [-1.78, 0.58, 0.3], [0, -0.12, 0]);
  addMesh(gantry, new THREE.BoxGeometry(0.52, 0.18, 0.06), screen, [-1.78, 0.73, 0.64], [0, -0.12, 0]);
  addMesh(gantry, new THREE.BoxGeometry(0.58, 0.58, 0.56), body, [1.72, 0.48, 0.33], [0, 0.08, 0]);
  for (let index = 0; index < 3; index += 1) {
    addMesh(gantry, new THREE.BoxGeometry(0.3, 0.045, 0.035), index === 0 ? accent : dark, [1.72, 0.6 - index * 0.12, 0.63]);
  }
}

function addPlatformUndercarriage(
  dark: THREE.Material,
  wall: THREE.Material,
  screen: THREE.Material,
  casing: THREE.Material,
  casingCap: THREE.Material,
) {
  // A stepped, mechanically supported silhouette keeps the laboratory from
  // reading as one dark extruded box when viewed from an isometric angle.
  addMesh(environmentGroup, new THREE.BoxGeometry(15.35, 0.25, 11.8), wall, [0, -0.82, 0]);
  addMesh(environmentGroup, new THREE.BoxGeometry(14.4, 0.22, 10.9), dark, [0, -1.03, 0]);

  const ribMaterial = casing;
  const ribCapMaterial = casingCap;
  const recessMaterial = material(0x294657, { roughness: 0.86, metalness: 0.3 });
  for (let index = 0; index < 9; index += 1) {
    const x = -6.7 + index * 1.67;
    for (const z of [-6.24, 6.24]) {
      addMesh(environmentGroup, new THREE.BoxGeometry(1.08, 0.58, 0.24), ribMaterial, [x, -0.58, z]);
      addMesh(environmentGroup, new THREE.BoxGeometry(1.14, 0.08, 0.29), ribCapMaterial, [x, -0.285, z]);
      addMesh(environmentGroup, new THREE.BoxGeometry(0.62, 0.2, 0.035), recessMaterial, [x, -0.57, z + Math.sign(z) * 0.125]);
      if (index % 3 === 1) {
        addMesh(environmentGroup, new THREE.BoxGeometry(0.36, 0.085, 0.025), screen, [x, -0.57, z + Math.sign(z) * 0.148]);
      }
    }
  }
  for (let index = 0; index < 7; index += 1) {
    const z = -4.75 + index * 1.58;
    for (const x of [-8.02, 8.02]) {
      addMesh(environmentGroup, new THREE.BoxGeometry(0.24, 0.58, 1.0), ribMaterial, [x, -0.58, z]);
      addMesh(environmentGroup, new THREE.BoxGeometry(0.29, 0.08, 1.06), ribCapMaterial, [x, -0.285, z]);
      addMesh(environmentGroup, new THREE.BoxGeometry(0.035, 0.2, 0.55), recessMaterial, [x + Math.sign(x) * 0.125, -0.57, z]);
      if (index % 3 === 0) {
        addMesh(environmentGroup, new THREE.BoxGeometry(0.025, 0.085, 0.3), screen, [x + Math.sign(x) * 0.148, -0.57, z]);
      }
    }
  }

  for (const [x, z] of [[-6.9, -5.1], [6.9, -5.1], [-6.9, 5.1], [6.9, 5.1]] as const) {
    addMesh(environmentGroup, new THREE.CylinderGeometry(0.34, 0.45, 0.55, 10), casing, [x, -1.2, z]);
    addMesh(environmentGroup, new THREE.CylinderGeometry(0.26, 0.31, 0.12, 10), casingCap, [x, -1.49, z]);
  }

  const underglow = material(0x72dfd8, {
    emissive: 0x257c8d,
    emissiveIntensity: 1.8,
    roughness: 0.2,
  });
  underglow.userData.baseEmissiveIntensity = underglow.emissiveIntensity;
  workshopPulseMaterials.push(underglow);
  addMesh(environmentGroup, new THREE.BoxGeometry(8.2, 0.045, 0.06), underglow, [1.7, -1.13, 5.48]);
  addMesh(environmentGroup, new THREE.BoxGeometry(0.06, 0.045, 5.5), underglow, [7.25, -1.13, 0.8]);

  // Low grazing lights reveal the fascia geometry that overhead lighting misses.
  for (const [x, z] of [[0, 5.85], [6.9, 0], [0, -5.85], [-6.9, 0]] as const) {
    const serviceGlow = new THREE.PointLight(0x4dc9ee, 1.45, 3.2, 2);
    serviceGlow.position.set(x, -0.18, z);
    serviceGlow.userData.baseIntensity = serviceGlow.intensity;
    serviceGlow.userData.phase = workshopPulseLights.length * 1.7;
    workshopPulseLights.push(serviceGlow);
    environmentGroup.add(serviceGlow);
  }
}

function addCrateStack(
  x: number,
  z: number,
  rotation: number,
  count: number,
  cream: THREE.Material,
  rust: THREE.Material,
  dark: THREE.Material,
  baseY = 0.38,
) {
  for (let index = 0; index < count; index += 1) {
    const crate = new THREE.Group();
    crate.position.set(x + (index % 2) * 0.44, baseY + Math.floor(index / 2) * 0.58, z);
    crate.rotation.y = rotation + (index % 2) * 0.08;
    environmentGroup.add(crate);
    addMesh(crate, new THREE.BoxGeometry(0.74, 0.52, 0.65), index % 2 ? rust : cream, [0, 0, 0]);
    addMesh(crate, new THREE.BoxGeometry(0.8, 0.06, 0.71), dark, [0, 0.23, 0]);
    addMesh(crate, new THREE.BoxGeometry(0.8, 0.06, 0.71), dark, [0, -0.23, 0]);
    addMesh(crate, new THREE.BoxGeometry(0.06, 0.48, 0.71), dark, [-0.34, 0, 0]);
  }
}

function addEquipmentModule(
  x: number,
  z: number,
  rotation: number,
  index: number,
  body: THREE.Material,
  secondary: THREE.Material,
  dark: THREE.Material,
  screen: THREE.Material,
  accent: THREE.Material,
) {
  const module = new THREE.Group();
  module.position.set(x, 0.73, z);
  module.rotation.y = rotation;
  environmentGroup.add(module);
  addMesh(module, new THREE.BoxGeometry(1.5, 1.38, 0.22), dark, [0, 0, -0.12]);
  addMesh(module, new THREE.BoxGeometry(1.34, 1.2, 0.5), body, [0, 0, 0.08]);
  addMesh(module, new THREE.BoxGeometry(1.42, 0.12, 0.62), secondary, [0, 0.63, 0.1]);
  addMesh(module, new THREE.BoxGeometry(0.1, 1.15, 0.08), dark, [-0.61, 0, 0.37]);
  addMesh(module, new THREE.BoxGeometry(0.1, 1.15, 0.08), dark, [0.61, 0, 0.37]);

  // Recessed display, bezel and control cabinet add visible face depth.
  addMesh(module, new THREE.BoxGeometry(0.67, 0.55, 0.1), dark, [-0.22, 0.2, 0.37]);
  addMesh(module, new THREE.BoxGeometry(0.53, 0.4, 0.075), index % 3 === 0 ? screen : secondary, [-0.22, 0.2, 0.43]);
  addMesh(module, new THREE.BoxGeometry(0.4, 0.75, 0.13), dark, [0.38, -0.05, 0.39]);
  addMesh(module, new THREE.BoxGeometry(0.3, 0.61, 0.04), body, [0.38, -0.05, 0.47]);
  for (let line = 0; line < 4; line += 1) {
    addMesh(module, new THREE.BoxGeometry(0.22, 0.035, 0.022), line === 0 ? accent : dark, [0.38, 0.16 - line * 0.115, 0.5]);
  }

  // Lower vents, fasteners and a protruding service dial break up flat boxes.
  for (let vent = 0; vent < 4; vent += 1) {
    addMesh(module, new THREE.BoxGeometry(0.38, 0.035, 0.025), dark, [-0.22, -0.29 - vent * 0.075, 0.49]);
  }
  for (const xBolt of [-0.53, 0.53]) {
    for (const yBolt of [-0.5, 0.5]) {
      addMesh(module, new THREE.CylinderGeometry(0.026, 0.026, 0.025, 8), secondary, [xBolt, yBolt, 0.47], [Math.PI / 2, 0, 0]);
    }
  }
  addMesh(module, new THREE.CylinderGeometry(0.09, 0.09, 0.07, 14), secondary, [0.38, -0.39, 0.51], [Math.PI / 2, 0, 0]);
  addMesh(module, new THREE.CylinderGeometry(0.032, 0.032, 0.085, 10), accent, [0.38, -0.39, 0.56], [Math.PI / 2, 0, 0]);
  addMesh(module, new THREE.SphereGeometry(0.035, 8, 6), index % 2 ? accent : screen, [-0.51, -0.48, 0.49]);

  if (index % 2 === 0) {
    addMesh(module, new THREE.CylinderGeometry(0.045, 0.045, 0.72, 10), accent, [-0.5, 0.82, 0.06], [0, 0, Math.PI / 2]);
    addMesh(module, new THREE.TorusGeometry(0.1, 0.025, 7, 12), dark, [-0.17, 0.82, 0.06], [0, Math.PI / 2, 0]);
  }
  if (index % 3 === 0) {
    const colors = [0x69e1e8, 0x438dc4, 0x9ed8ef, 0x6582bd];
    for (let light = 0; light < colors.length; light += 1) {
      addMesh(
        module,
        new THREE.BoxGeometry(0.055, 0.16 + light * 0.025, 0.025),
        material(colors[light], { emissive: colors[light], emissiveIntensity: 1.5, roughness: 0.28 }),
        [-0.5 + light * 0.12, 0.18, 0.372],
      );
    }
  }
}

function addCable(points: THREE.Vector3[], color: number, radius: number) {
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.2);
  const cable = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 36, radius, 8, false),
    material(color, { roughness: 0.52, metalness: 0.18 }),
  );
  cable.castShadow = true;
  environmentGroup.add(cable);
}

function shortestAngleDifference(from: number, to: number) {
  return Math.atan2(Math.sin(to - from), Math.cos(to - from));
}

function updateCameraOrbit(delta: number) {
  const difference = shortestAngleDifference(cameraAzimuth, targetCameraAzimuth);
  cameraAzimuth += difference * (prefersReducedMotion ? 1 : Math.min(1, delta * 9));
  camera.position.set(
    Math.sin(cameraAzimuth) * cameraOrbitRadius,
    cameraOrbitHeight,
    Math.cos(cameraAzimuth) * cameraOrbitRadius,
  );
  camera.lookAt(0, cameraTargetHeight, 0);
  canvas.dataset.cameraAzimuth = cameraAzimuth.toFixed(3);
  const referenceDelta = shortestAngleDifference(referenceCameraAzimuth, cameraAzimuth);
  const referenceFade = THREE.MathUtils.clamp(1 - Math.abs(referenceDelta) * 3.2, 0, 1);
  workshopBackWallLayer.style.setProperty("--workshop-shift-x", `${(-referenceDelta * 105).toFixed(1)}px`);
  workshopBackWallLayer.style.setProperty("--workshop-shift-y", `${(Math.abs(referenceDelta) * 12).toFixed(1)}px`);
  workshopBackWallLayer.style.setProperty("--workshop-skew", `${(referenceDelta * -4.5).toFixed(2)}deg`);
  workshopBackWallLayer.style.opacity = referenceFade.toFixed(3);
  workshopForegroundLayer.style.setProperty("--workshop-shift-x", `${(referenceDelta * 145).toFixed(1)}px`);
  workshopForegroundLayer.style.setProperty("--workshop-shift-y", `${(-Math.abs(referenceDelta) * 8).toFixed(1)}px`);
  workshopForegroundLayer.style.setProperty("--workshop-skew", `${(referenceDelta * 3.2).toFixed(2)}deg`);
  workshopForegroundLayer.style.opacity = referenceFade.toFixed(3);
}

function rotateView(direction: -1 | 1) {
  targetCameraAzimuth += direction * (Math.PI / 4);
  showToast(direction < 0 ? "View rotated counter-clockwise." : "View rotated clockwise.");
}

function updatePointer(event: PointerEvent | DragEvent) {
  const rect = canvas.getBoundingClientRect();
  pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
  pointer.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
}

function getGridAtPointer(event: PointerEvent | DragEvent): GridPosition | null {
  updatePointer(event);
  const hit = raycaster.intersectObjects(tileMeshes, false)[0];
  return hit ? (hit.object.userData.grid as GridPosition) : null;
}

function getNodeAtPointer(event: PointerEvent): PlacedComponent | null {
  updatePointer(event);
  const hit = raycaster.intersectObjects(nodes.map((node) => node.group), true)[0];
  if (!hit) return null;
  let object: THREE.Object3D | null = hit.object;
  while (object && object.userData.nodeId === undefined) object = object.parent;
  return nodes.find((node) => node.id === object?.userData.nodeId) ?? null;
}

function getConnectionAtPointer(event: PointerEvent): Connection | null {
  if (connections.length === 0) return null;
  updatePointer(event);
  const hits = raycaster.intersectObjects(connections.map((connection) => connection.hitTube), false);
  for (const hit of hits) {
    const connection = connections.find((candidate) => candidate.hitTube === hit.object);
    if (!connection) continue;
    const start = connection.from.group.position.clone().setY(0.49);
    const end = connection.to.group.position.clone().setY(0.49);
    if (hit.point.distanceTo(start) < 0.42 || hit.point.distanceTo(end) < 0.42) continue;
    return connection;
  }
  return null;
}

function isOccupied(grid: GridPosition, exceptNode?: PlacedComponent) {
  return nodes.some(
    (node) => node !== exceptNode && node.grid.col === grid.col && node.grid.row === grid.row,
  );
}

function remainingBudget() {
  return totalBudget + incidentBudgetCredit - installedMachineSpend() - configSpend();
}

function placeComponent(kind: ComponentKind, grid: GridPosition, silent = false) {
  const definition = componentDefinitions[kind];
  if (isOccupied(grid)) {
    showToast("That floor tile is already occupied.");
    return false;
  }
  if (definition.cost > remainingBudget()) {
    showToast(`The laboratory needs another $${definition.cost - remainingBudget()} for ${definition.label}.`);
    return false;
  }

  const group = createMachine(kind);
  const id = nextNodeId++;
  group.userData.nodeId = id;
  group.traverse((object) => {
    object.userData.nodeId = id;
  });
  group.position.copy(gridToWorld(grid));
  group.scale.setScalar(0.08);
  group.rotation.y = -0.08;
  group.userData.spawnProgress = prefersReducedMotion ? 1 : 0;
  group.userData.dragLift = 0;
  machinesGroup.add(group);

  const visual = document.createElement("img");
  visual.className = "component-visual";
  visual.src = componentWorldSources[kind];
  visual.alt = "";
  visual.draggable = false;
  visual.dataset.kind = kind;
  visual.dataset.state = "healthy";
  componentVisualLayer.append(visual);

  const label = document.createElement("div");
  label.className = "component-label";
  label.innerHTML = `${contextualComponentLabel(kind)}<small>${contextualComponentRole(kind)}</small>`;
  document.querySelector(".game-shell")!.append(label);

  const node: PlacedComponent = { id, kind, group, grid: { ...grid }, label, visual, state: "healthy" };
  nodes.push(node);
  rebuildConnections();
  checkTopologyIncidentResponse();
  updateUi();
  updateTelemetry();
  if (!silent) {
    selectNode(node);
    showToast(topologyMode === "manual"
      ? `${contextualComponentLabel(kind)} installed but disconnected. Press W to cable its ports.`
      : `${contextualComponentLabel(kind)} installed — ${contextualComponentRole(kind).toLowerCase()}.`);
  }
  return true;
}

function moveNode(node: PlacedComponent, grid: GridPosition) {
  if (isOccupied(grid, node)) return;
  node.grid = { ...grid };
  node.group.position.copy(gridToWorld(grid));
  rebuildConnections();
}

function selectNode(node: PlacedComponent | null) {
  selectedNode = node;
  for (const candidate of nodes) candidate.visual.dataset.selected = String(candidate === node);
  if (!node) {
    selectedCard.dataset.visible = "false";
    chaosButton.hidden = true;
    return;
  }
  const definition = componentDefinitions[node.kind];
  selectedName.textContent = contextualComponentLabel(node.kind);
  selectedRole.textContent = contextualComponentRole(node.kind);
  selectedDescription.textContent = node.kind === "worker" && currentPhase.workload === "analytics"
    ? "Records click events for product analytics. Without a Message Queue, each API request waits for this service before it can respond."
    : definition.description;
  selectedCapacity.textContent = definition.capacityText;
  selectedEffect.textContent = node.kind === "worker" && currentPhase.workload === "analytics"
    ? nodes.some((candidate) => candidate.kind === "queue")
      ? "Consumes analytics outside the request path"
      : "Blocks API responses until click tracking finishes"
    : definition.effectText;
  selectedState.textContent = node.state === "healthy" ? "Healthy" : node.state === "degraded" ? "Recovering" : "Failed";
  selectedState.dataset.state = node.state;
  chaosButton.hidden = !isSandboxMode;
  chaosButton.dataset.offline = String(node.state === "failed");
  chaosButton.setAttribute("aria-pressed", String(node.state === "failed"));
  chaosButton.textContent = node.state === "failed" ? "Restore machine" : "Take offline";
  selectedCard.dataset.visible = "true";
}

function toggleSandboxNodeFailure() {
  if (!isSandboxMode || !selectedNode) return;
  const node = selectedNode;
  const takingOffline = node.state !== "failed";
  node.state = takingOffline ? "failed" : "healthy";
  rebuildConnections();
  selectNode(node);
  updateUi();
  updateTelemetry();
  showToast(takingOffline
    ? `${contextualComponentLabel(node.kind)} taken offline. The live graph will reroute wherever redundancy allows.`
    : `${contextualComponentLabel(node.kind)} restored. Capacity and routes are available again.`);
}

function updateMachineAnimations(delta: number) {
  const demand = isRunning ? Math.max(1, currentDemand) : targetRps;
  const metrics = calculateMetrics(demand);
  const disconnectedNodeIds = "topology" in metrics ? new Set(metrics.topology.disconnectedNodeIds) : null;
  const activity = isRunning ? THREE.MathUtils.clamp(currentDemand / targetRps, 0.2, 1) : 0.08;
  const motionDelta = prefersReducedMotion ? 0 : delta;
  const motionElapsed = prefersReducedMotion ? 0 : elapsed;

  for (const node of nodes) {
    const group = node.group;
    const spawnProgress = prefersReducedMotion
      ? 1
      : Math.min(1, (group.userData.spawnProgress as number ?? 1) + delta * 3.6);
    group.userData.spawnProgress = spawnProgress;
    const back = 1.35;
    const shifted = spawnProgress - 1;
    const spawnEase = 1 + (back + 1) * shifted ** 3 + back * shifted ** 2;
    const selected = node === selectedNode;
    const hovered = node === hoveredNode;
    const failed = node.state === "failed";
    const degraded = node.state === "degraded";
    const disconnected = disconnectedNodeIds?.has(String(node.id)) ?? false;
    const overloaded = isRunning && metrics.bottleneckKind === node.kind && currentDemand > metrics.capacity;
    node.visual.dataset.hovered = String(hovered);
    node.visual.dataset.state = failed ? "failed" : degraded ? "degraded" : disconnected ? "disconnected" : overloaded ? "hot" : "healthy";
    node.visual.dataset.running = String(isRunning && !failed && !disconnected);
    node.label.dataset.visible = String(selected || hovered);
    const targetScale = (selected ? 1.025 : hovered ? 0.985 : 0.94) * (failed ? 0.9 : degraded ? 0.96 : 1);
    const desiredLift = node === draggedNode ? 0.2 : 0;
    group.userData.dragLift = THREE.MathUtils.lerp(group.userData.dragLift as number ?? 0, desiredLift, Math.min(1, delta * 15));
    const idleBob = prefersReducedMotion
      ? 0
      : Math.sin(motionElapsed * (1.35 + activity) + node.id * 1.7) * (0.004 + activity * 0.009) + (failed ? Math.sin(motionElapsed * 29) * 0.012 : 0);
    group.position.y = gridToWorld(node.grid).y + (group.userData.dragLift as number) + idleBob;
    const renderedScale = Math.max(0.01, targetScale * spawnEase);
    group.scale.set(renderedScale, renderedScale * 0.82, renderedScale);
    group.rotation.y = -0.08 + (!prefersReducedMotion && (overloaded || failed) ? Math.sin(motionElapsed * 34 + node.id) * (failed ? 0.03 : 0.018) : 0);
    group.rotation.z = prefersReducedMotion
      ? failed ? -0.035 : 0
      : THREE.MathUtils.lerp(group.rotation.z, failed ? -0.035 : 0, Math.min(1, delta * 8));

    if (selected) {
      selectedState.textContent = failed ? "Failed" : degraded ? "Recovering" : disconnected ? "Disconnected" : "Healthy";
      selectedState.dataset.state = failed ? "failed" : degraded ? "degraded" : disconnected ? "disconnected" : "healthy";
    }

    group.traverse((object) => {
      const motion = object.userData.motion as string | undefined;
      if (!motion) return;
      if (motion === "selectionRing" && object instanceof THREE.Mesh) {
        const ringMaterial = object.material as THREE.MeshBasicMaterial;
        const spawnFlash = Math.max(0, 1 - spawnProgress) * 0.9;
        const desiredOpacity = Math.max(spawnFlash, selected ? 0.76 : hovered ? 0.38 : overloaded ? 0.58 : 0);
        ringMaterial.opacity = prefersReducedMotion
          ? desiredOpacity
          : THREE.MathUtils.lerp(ringMaterial.opacity, desiredOpacity, Math.min(1, delta * 12));
        ringMaterial.color.setHex(failed ? 0xf05f70 : degraded ? 0xf0b85f : overloaded ? 0xe7687f : componentDefinitions[node.kind].color);
        object.rotation.z += motionDelta * (selected ? 1.25 : 0.45);
        const ringScale = 1 + spawnFlash * 0.45 + (prefersReducedMotion ? 0 : Math.sin(motionElapsed * 3 + node.id) * (selected ? 0.035 : 0.012));
        object.scale.setScalar(ringScale);
      }
      if (motion === "radarSweep") object.rotation.y += motionDelta * (0.45 + activity * 4.4);
      if (motion === "beacon") {
        const pulse = prefersReducedMotion
          ? 1
          : 1 + Math.sin(motionElapsed * (3.4 + activity * 4.8) + (object.userData.phase as number ?? 0)) * (0.025 + activity * 0.1);
        object.scale.setScalar(pulse);
      }
      if (motion === "memoryLight" && object instanceof THREE.Mesh) {
        const phase = object.userData.phase as number ?? 0;
        const signal = prefersReducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(motionElapsed * (4 + activity * 7) + phase * Math.PI * 2);
        (object.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.45 + activity * (0.8 + signal * 2.2);
      }
      if (motion === "archiveDisk") {
        object.rotateY(motionDelta * (object.userData.direction as number) * (0.25 + activity * 3.1));
      }
      if (motion === "queueRoller") object.rotateY(motionDelta * (0.35 + activity * 5.8));
      if (motion === "workerFan") object.rotateZ(motionDelta * (1.2 + activity * 9) * (object.userData.direction as number ?? 1));
      if (motion === "geoCell") {
        const phase = object.userData.phase as number ?? 0;
        object.scale.y = prefersReducedMotion ? 1 : 1 + Math.sin(motionElapsed * (2.2 + activity * 2.4) + phase * Math.PI * 2) * (0.04 + activity * 0.08);
      }
      if (motion === "geoRing") {
        const phase = object.userData.phase as number ?? 0;
        const pulse = prefersReducedMotion ? 1 : 1 + Math.sin(motionElapsed * 2.8 + phase * 8) * (0.018 + activity * 0.035);
        object.scale.setScalar(pulse);
      }
      if (motion === "cdnDish") object.rotation.y = prefersReducedMotion ? 0 : Math.sin(motionElapsed * (0.7 + activity * 1.4)) * 0.42;
      if (motion === "edgeSignal") {
        const phase = object.userData.phase as number ?? 0;
        const signalMaterial = (object as THREE.Mesh).material as THREE.MeshStandardMaterial;
        signalMaterial.opacity = prefersReducedMotion ? 0.62 : 0.42 + (0.5 + 0.5 * Math.sin(motionElapsed * 3.5 + phase * 9)) * 0.38;
        signalMaterial.transparent = true;
      }
      if (motion === "queueBox") {
        const phase = object.userData.phase as number ?? 0;
        const travel = motionElapsed * (0.18 + activity * 0.55) + phase * Math.PI * 2;
        object.position.x = Math.sin(travel) * 0.29;
        object.position.y = 0.77 + Math.sin(travel * 2) * 0.018;
      }
    });
  }
}

function removeNode(node: PlacedComponent) {
  const index = nodes.indexOf(node);
  if (index < 0) return;
  const definition = componentDefinitions[node.kind];
  nodes.splice(index, 1);
  for (let connectionIndex = authoredConnections.length - 1; connectionIndex >= 0; connectionIndex -= 1) {
    const authored = authoredConnections[connectionIndex];
    if (authored.fromId === node.id || authored.toId === node.id) authoredConnections.splice(connectionIndex, 1);
  }
  machinesGroup.remove(node.group);
  node.group.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
    object.geometry.dispose();
    const objectMaterial = object.material;
    if (Array.isArray(objectMaterial)) objectMaterial.forEach((item) => item.dispose());
    else objectMaterial.dispose();
  });
  node.label.remove();
  node.visual.remove();
  selectNode(null);
  rebuildConnections();
  checkTopologyIncidentResponse();
  updateUi();
  updateTelemetry();
  showToast(`${definition.label} removed. $${definition.cost} returned to the laboratory budget.`);
}

function clearLaboratory() {
  selectNode(null);
  removeGhost();
  for (const node of nodes) {
    machinesGroup.remove(node.group);
    node.label.remove();
    node.visual.remove();
    node.group.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
      object.geometry.dispose();
      const objectMaterial = object.material;
      if (Array.isArray(objectMaterial)) objectMaterial.forEach((item) => item.dispose());
      else objectMaterial.dispose();
    });
  }
  nodes.length = 0;
  authoredConnections.length = 0;
  nextNodeId = 1;
  rebuildConnections();
}

function sandboxBlueprintContractKey() {
  const dataContract = currentPhase.backgroundSlo
    ? `-${currentPhase.backgroundSlo.minimumDeliveryPercent}-${currentPhase.backgroundSlo.maxLagSeconds}`
    : "-none";
  return `sysdex-blueprint-v1-lab-${currentPhase.workload}-${targetRps}-${latencySlo}-${errorSlo}${dataContract}`;
}

function blueprintStorageKey(phaseIndex = currentPhaseIndex) {
  if (isSandboxMode && phaseIndex === campaignPhases.length) {
    return `${sandboxBlueprintContractKey()}-${sandboxTrafficPattern}-${sandboxTraceSeed}`;
  }
  return `sysdex-blueprint-v1-${phaseIndex}`;
}

function usesDefaultSandboxContract() {
  if (!isSandboxMode) return false;
  const preset = sandboxPresets[currentPhase.workload];
  return latencySlo === preset.latencySlo
    && errorSlo === preset.errorSlo
    && (currentPhase.backgroundSlo?.minimumDeliveryPercent ?? null) === (preset.backgroundSlo?.minimumDeliveryPercent ?? null)
    && (currentPhase.backgroundSlo?.maxLagSeconds ?? null) === (preset.backgroundSlo?.maxLagSeconds ?? null);
}

function validateBlueprintCandidate(value: unknown): SavedBlueprintV1 | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<SavedBlueprintV1>;
  if (candidate.version !== 1 || candidate.phaseIndex !== currentPhaseIndex) return null;
  if (!Number.isInteger(candidate.savedAt) || candidate.savedAt! < 0) return null;
  if (candidate.topologyMode !== "automatic" && candidate.topologyMode !== "manual") return null;
  if (!Array.isArray(candidate.nodes) || !Array.isArray(candidate.connections) || !Array.isArray(candidate.configs)) return null;
  const validNodes = candidate.nodes.length <= columns * rows && candidate.nodes.every((node) => node
    && Number.isInteger(node.id)
    && node.id > 0
    && componentOrder.includes(node.kind as ComponentKind)
    && currentPhase.unlocks.includes(node.kind as ComponentKind)
    && Number.isInteger(node.grid?.col)
    && Number.isInteger(node.grid?.row)
    && node.grid!.col >= 0
    && node.grid!.col < columns
    && node.grid!.row >= 0
    && node.grid!.row < rows
    && (node.state === undefined || node.state === "healthy" || node.state === "failed")
    && (isSandboxMode || node.state !== "failed"));
  if (!validNodes) return null;
  const occupiedTiles = new Set(candidate.nodes.map((node) => `${node.grid.col}:${node.grid.row}`));
  const savedNodeIds = new Set(candidate.nodes.map((node) => node.id));
  const savedNodeById = new Map(candidate.nodes.map((node) => [node.id, node]));
  const configIds = new Set(candidate.configs);
  const validConfigs = configIds.size === candidate.configs.length
    && candidate.configs.every((id) => currentPhase.configUnlocks.includes(id as ConfigId));
  const connectionKeys = new Set<string>();
  const validConnections = candidate.connections.length <= 160 && candidate.connections.every((connection) => {
    if (!connection || connection.fromId === connection.toId) return false;
    const from = savedNodeById.get(connection.fromId);
    const to = savedNodeById.get(connection.toId);
    if (!from || !to || !blueprintConnectionModes.includes(connection.mode)) return false;
    const rule = authoredConnectionRule(from.kind as ComponentKind, to.kind as ComponentKind);
    if (!rule || rule.mode !== connection.mode) return false;
    if (connection.label !== null
      && (typeof connection.label !== "string" || connection.label.length > 64 || /[<>]/.test(connection.label))) return false;
    const key = `${connection.fromId}:${connection.toId}:${connection.mode}`;
    if (connectionKeys.has(key)) return false;
    connectionKeys.add(key);
    return true;
  });
  const machineCost = candidate.nodes.reduce((total, node) => total + componentDefinitions[node.kind as ComponentKind].cost, 0);
  const configCost = configDefinitions.reduce(
    (total, config) => total + (candidate.configs!.includes(config.id) ? config.cost : 0),
    0,
  );
  if (occupiedTiles.size !== candidate.nodes.length
    || savedNodeIds.size !== candidate.nodes.length
    || !validConfigs
    || !validConnections
    || (candidate.topologyMode === "automatic" && candidate.connections.length > 0)
    || machineCost + configCost > currentPhase.budget) return null;
  return candidate as SavedBlueprintV1;
}

function readSavedBlueprint(): SavedBlueprintV1 | null {
  const keys = [blueprintStorageKey()];
  if (isSandboxMode && sandboxTrafficPattern === "steady" && sandboxTraceSeed === 42) {
    keys.push(sandboxBlueprintContractKey());
  }
  if (usesDefaultSandboxContract() && sandboxTrafficPattern === "steady" && sandboxTraceSeed === 42) {
    keys.push(`sysdex-blueprint-v1-lab-${currentPhase.workload}-${targetRps}`);
  }
  for (const key of keys) {
    try {
      const raw = window.localStorage.getItem(key);
      const validated = raw ? validateBlueprintCandidate(JSON.parse(raw)) : null;
      if (validated) return validated;
    } catch {
      // Ignore a damaged slot and keep checking compatible fallback keys.
    }
  }
  return null;
}

function createCurrentBlueprint(): SavedBlueprintV1 {
  return {
    version: 1,
    phaseIndex: currentPhaseIndex,
    savedAt: Date.now(),
    topologyMode,
    nodes: nodes.map((node) => ({
      id: node.id,
      kind: node.kind,
      grid: { ...node.grid },
      state: node.state === "failed" ? "failed" : undefined,
    })),
    connections: topologyMode === "manual"
      ? authoredConnections.map((connection) => ({
        fromId: connection.fromId,
        toId: connection.toId,
        mode: connection.mode,
        label: connection.label,
      }))
      : [],
    configs: [...activeConfigs],
  };
}

function syncBlueprintUi() {
  const hasSavedBlueprint = readSavedBlueprint() !== null;
  saveBlueprintButton.disabled = isRunning || nodes.length === 0;
  loadBlueprintButton.disabled = isRunning || !hasSavedBlueprint;
  shareBlueprintButton.disabled = isRunning || nodes.length === 0;
  loadBlueprintButton.dataset.available = String(hasSavedBlueprint);
  loadBlueprintButton.title = hasSavedBlueprint
    ? `Restore the saved ${currentPhase.service} design`
    : `No saved ${currentPhase.service} design`;
}

function saveBlueprint() {
  if (isRunning) {
    showToast("Blueprints are frozen during a live traffic drill.");
    return;
  }
  if (nodes.length === 0) {
    showToast("Place at least one machine before saving a blueprint.");
    return;
  }
  const blueprint = createCurrentBlueprint();
  try {
    window.localStorage.setItem(blueprintStorageKey(), JSON.stringify(blueprint));
  } catch {
    showToast("The browser could not store this blueprint.");
    return;
  }
  saveBlueprintButton.dataset.saved = "true";
  saveBlueprintButton.textContent = "Saved";
  window.setTimeout(() => {
    saveBlueprintButton.dataset.saved = "false";
    saveBlueprintButton.textContent = "Save design";
  }, 1100);
  syncBlueprintUi();
  const offlineCount = blueprint.nodes.filter((node) => node.state === "failed").length;
  showToast(`${currentPhase.service} blueprint saved locally${offlineCount > 0 ? ` with ${offlineCount} offline machine${offlineCount === 1 ? "" : "s"}` : ""}. Restore saved will bring this exact graph back.`);
}

function compactSharedBlueprint(blueprint: SavedBlueprintV1): SharedBlueprintV1 {
  return {
    v: 1,
    p: blueprint.phaseIndex,
    m: blueprint.topologyMode === "manual" ? 1 : 0,
    n: blueprint.nodes.map((node) => node.state === "failed"
      ? [node.id, componentOrder.indexOf(node.kind), node.grid.col, node.grid.row, 1]
      : [node.id, componentOrder.indexOf(node.kind), node.grid.col, node.grid.row]),
    e: blueprint.connections.map((connection) => {
      const tuple: [number, number, number, string?] = [
        connection.fromId,
        connection.toId,
        blueprintConnectionModes.indexOf(connection.mode),
      ];
      if (connection.label !== null) tuple.push(connection.label);
      return tuple;
    }),
    c: blueprint.configs.map((id) => configDefinitions.findIndex((config) => config.id === id)),
  };
}

function readSharedBlueprint(encoded: string): SavedBlueprintV1 | null {
  const decoded = decodeSharedBlueprint(encoded);
  if (!decoded || typeof decoded !== "object") return null;
  const candidate = decoded as Partial<SharedBlueprintV1>;
  if (candidate.v !== 1 || candidate.p !== currentPhaseIndex || (candidate.m !== 0 && candidate.m !== 1)) return null;
  if (!Array.isArray(candidate.n) || candidate.n.length > columns * rows
    || !Array.isArray(candidate.e) || candidate.e.length > 160
    || !Array.isArray(candidate.c) || candidate.c.length > configDefinitions.length) return null;
  const validNodeTuples = candidate.n.every((tuple) => Array.isArray(tuple)
    && (tuple.length === 4 || tuple.length === 5)
    && tuple.every(Number.isInteger)
    && (tuple.length === 4 || tuple[4] === 1)
    && componentOrder[tuple[1]] !== undefined);
  const validEdgeTuples = candidate.e.every((tuple) => Array.isArray(tuple)
    && (tuple.length === 3 || tuple.length === 4)
    && Number.isInteger(tuple[0])
    && Number.isInteger(tuple[1])
    && Number.isInteger(tuple[2])
    && blueprintConnectionModes[tuple[2]] !== undefined
    && (tuple.length === 3 || typeof tuple[3] === "string"));
  const validConfigTuples = candidate.c.every((index) => Number.isInteger(index) && configDefinitions[index] !== undefined);
  if (!validNodeTuples || !validEdgeTuples || !validConfigTuples) return null;

  const expanded: SavedBlueprintV1 = {
    version: 1,
    phaseIndex: candidate.p,
    savedAt: Date.now(),
    topologyMode: candidate.m === 1 ? "manual" : "automatic",
    nodes: candidate.n.map(([id, kindIndex, col, row, offline]) => ({
      id,
      kind: componentOrder[kindIndex],
      grid: { col, row },
      state: offline === 1 ? "failed" : undefined,
    })),
    connections: candidate.e.map(([fromId, toId, modeIndex, label]) => ({
      fromId,
      toId,
      mode: blueprintConnectionModes[modeIndex],
      label: label ?? null,
    })),
    configs: candidate.c.map((index) => configDefinitions[index].id),
  };
  return validateBlueprintCandidate(expanded);
}

function fallbackCopyText(value: string) {
  const input = document.createElement("textarea");
  input.value = value;
  input.readOnly = true;
  input.style.position = "fixed";
  input.style.opacity = "0";
  document.body.append(input);
  input.select();
  const copied = document.execCommand("copy");
  input.remove();
  return copied;
}

async function shareBlueprint() {
  if (isRunning) {
    showToast("Blueprint links are frozen during a live traffic drill.");
    return;
  }
  if (nodes.length === 0) {
    showToast("Place at least one machine before sharing a blueprint.");
    return;
  }
  const blueprint = createCurrentBlueprint();
  const encoded = encodeSharedBlueprint(compactSharedBlueprint(blueprint));
  const url = new URL(window.location.href);
  url.search = "";
  url.hash = "";
  if (isSandboxMode) {
    url.searchParams.set("lab", currentPhase.workload);
    url.searchParams.set("rps", String(targetRps));
    url.searchParams.set("p95", String(latencySlo));
    url.searchParams.set("err", String(errorSlo));
    url.searchParams.set("shape", sandboxTrafficPattern);
    url.searchParams.set("seed", String(sandboxTraceSeed));
    if (currentPhase.backgroundSlo) {
      url.searchParams.set("delivery", String(currentPhase.backgroundSlo.minimumDeliveryPercent));
      url.searchParams.set("lag", String(currentPhase.backgroundSlo.maxLagSeconds));
    }
  } else {
    url.searchParams.set("phase", String(currentPhaseIndex));
  }
  url.searchParams.set("design", encoded);
  let copied = false;
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(url.toString());
      copied = true;
    }
  } catch {
    copied = false;
  }
  if (!copied) copied = fallbackCopyText(url.toString());
  if (!copied) {
    window.history.replaceState(null, "", url);
    showToast("The share URL is ready in the address bar.");
    return;
  }
  shareBlueprintButton.dataset.saved = "true";
  shareBlueprintButton.textContent = "Link copied";
  window.setTimeout(() => {
    shareBlueprintButton.dataset.saved = "false";
    shareBlueprintButton.textContent = "Share link";
  }, 1200);
  const offlineCount = blueprint.nodes.filter((node) => node.state === "failed").length;
  showToast(`Share link copied: ${nodes.length} machines${topologyMode === "manual" ? ` and ${authoredConnections.length} authored cables` : " with automatic routing"}${offlineCount > 0 ? ` · ${offlineCount} offline` : ""}.`);
}

function restoreBlueprintData(blueprint: SavedBlueprintV1, source: "saved" | "shared") {
  stopTest(true);
  hideResult();
  resetTopologyEditor();
  clearLaboratory();
  activeConfigs.clear();
  for (const config of blueprint.configs) activeConfigs.add(config);
  pendingConfigs = new Set(activeConfigs);

  const restoredIds = new Map<number, number>();
  for (const savedNode of blueprint.nodes) {
    if (!placeComponent(savedNode.kind, savedNode.grid, true)) continue;
    const restoredNode = nodes.at(-1);
    if (restoredNode) {
      restoredNode.state = savedNode.state === "failed" ? "failed" : "healthy";
      restoredIds.set(savedNode.id, restoredNode.id);
    }
  }

  if (blueprint.topologyMode === "manual") {
    topologyMode = "manual";
    authoredConnections.length = 0;
    for (const savedConnection of blueprint.connections) {
      const fromId = restoredIds.get(savedConnection.fromId);
      const toId = restoredIds.get(savedConnection.toId);
      if (fromId === undefined || toId === undefined) continue;
      authoredConnections.push({
        id: nextConnectionId++,
        fromId,
        toId,
        mode: savedConnection.mode,
        label: savedConnection.label,
      });
    }
  }
  rebuildConnections();
  wiringEditing = false;
  wiringSource = null;
  canvas.dataset.mode = "idle";
  selectNode(null);
  syncWiringUi();
  updateUi();
  updateTelemetry();
  const offlineCount = nodes.filter((node) => node.state === "failed").length;
  showToast(`${source === "shared" ? "Shared" : currentPhase.service} blueprint restored: ${nodes.length} machines, ${activeConfigs.size} runbook policies, ${topologyMode === "manual" ? `${authoredConnections.length} authored cables` : "automatic routing"}${offlineCount > 0 ? `, ${offlineCount} offline` : ""}.`);
}

function restoreBlueprint() {
  const blueprint = readSavedBlueprint();
  if (!blueprint) {
    showToast(`No valid ${currentPhase.service} blueprint is saved in this browser.`);
    syncBlueprintUi();
    return;
  }
  restoreBlueprintData(blueprint, "saved");
}

function setActiveKind(kind: ComponentKind | null) {
  if (kind && wiringEditing) {
    wiringEditing = false;
    wiringSource = null;
    hoveredConnection = null;
    syncWiringUi();
  }
  activeKind = kind;
  canvas.dataset.mode = kind ? "placing" : "idle";
  document.querySelectorAll<HTMLButtonElement>(".part-card").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.kind === kind));
  });
  if (!kind) removeGhost();
}

function updateGhost(kind: ComponentKind, grid: GridPosition | null) {
  if (!grid) {
    removeGhost();
    return;
  }
  if (!ghost || ghost.userData.kind !== kind) {
    removeGhost();
    ghost = createMachine(kind, true);
    ghost.userData.kind = kind;
    ghost.scale.setScalar(0.94);
    scene.add(ghost);
    ghostVisual = document.createElement("img");
    ghostVisual.className = "component-visual component-visual-ghost";
    ghostVisual.src = componentWorldSources[kind];
    ghostVisual.alt = "";
    ghostVisual.draggable = false;
    componentVisualLayer.append(ghostVisual);
  }
  ghost.position.copy(gridToWorld(grid));
  const valid = !isOccupied(grid) && componentDefinitions[kind].cost <= remainingBudget();
  if (ghostVisual) ghostVisual.dataset.valid = String(valid);
  const nextTile = tileMeshes.find((tile) => {
    const tileGrid = tile.userData.grid as GridPosition;
    return tileGrid.col === grid.col && tileGrid.row === grid.row;
  }) ?? null;
  if (placementTile !== nextTile) clearPlacementTile();
  placementTile = nextTile;
  if (placementTile) {
    const tileMaterial = placementTile.material as THREE.MeshStandardMaterial;
    tileMaterial.emissive.setHex(valid ? 0x2fbed1 : 0xd44962);
    tileMaterial.emissiveIntensity = 0.52;
  }
  ghost.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const meshMaterial = object.material as THREE.MeshStandardMaterial;
    const baseColor = object.userData.ghostBaseColor as number | undefined;
    if (baseColor !== undefined) meshMaterial.color.setHex(baseColor);
    meshMaterial.color.offsetHSL(valid ? 0 : -0.03, valid ? 0 : 0.35, valid ? 0 : -0.16);
  });
}

function clearPlacementTile() {
  if (!placementTile) return;
  const tileMaterial = placementTile.material as THREE.MeshStandardMaterial;
  tileMaterial.emissive.setHex(0x000000);
  tileMaterial.emissiveIntensity = 0;
  placementTile = null;
}

function removeGhost() {
  clearPlacementTile();
  ghostVisual?.remove();
  ghostVisual = null;
  if (!ghost) return;
  scene.remove(ghost);
  ghost.traverse((object) => {
    if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
    object.geometry.dispose();
    const objectMaterial = object.material;
    if (Array.isArray(objectMaterial)) objectMaterial.forEach((item) => item.dispose());
    else objectMaterial.dispose();
  });
  ghost = null;
}

function clearGroup(group: THREE.Group) {
  for (const child of [...group.children]) {
    group.remove(child);
    child.traverse((object) => {
      if (!(object instanceof THREE.Mesh || object instanceof THREE.Line)) return;
      object.geometry.dispose();
      const objectMaterial = object.material;
      if (Array.isArray(objectMaterial)) objectMaterial.forEach((item) => item.dispose());
      else objectMaterial.dispose();
    });
  }
}

function connect(
  from: PlacedComponent | undefined,
  to: PlacedComponent | undefined,
  label: string | null = null,
  mode: SimulationEdgeMode = "request",
  specId: number | null = null,
) {
  if (!from || !to) return null;
  const start = from.group.position.clone().setY(0.49);
  const end = to.group.position.clone().setY(0.49);
  const middleA = new THREE.Vector3(end.x, 0.49, start.z);
  const middleB = new THREE.Vector3(end.x, 0.49, end.z);
  const points = start.distanceTo(middleA) < 0.1
    ? [start, end]
    : [start, middleA, middleB, end];
  const curve = new THREE.CatmullRomCurve3(points, false, "catmullrom", 0.03);
  const cableMaterial = material(0x347a99, {
    emissive: 0x123f58,
    emissiveIntensity: 0.24,
    roughness: 0.42,
    metalness: 0.38,
  });
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 30, 0.028, 6, false),
    cableMaterial,
  );
  tube.receiveShadow = true;
  connectionsGroup.add(tube);
  const hitTube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 22, 0.14, 5, false),
    new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      colorWrite: false,
    }),
  );
  connectionsGroup.add(hitTube);
  const arrowMaterial = material(0x83e7e3, {
    emissive: 0x247c85,
    emissiveIntensity: 0.9,
    roughness: 0.4,
    metalness: 0.32,
  });
  const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.055, 0.13, 4), arrowMaterial);
  const arrowPosition = curve.getPointAt(0.64);
  const arrowDirection = curve.getTangentAt(0.64).normalize();
  arrow.position.copy(arrowPosition);
  arrow.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), arrowDirection);
  connectionsGroup.add(arrow);
  let annotation: HTMLDivElement | null = null;
  if (label) {
    annotation = document.createElement("div");
    annotation.className = "traffic-annotation";
    annotation.innerHTML = `<i aria-hidden="true"></i><span>${label}</span>`;
    annotation.dataset.visible = "false";
    annotation.dataset.pulse = "false";
    document.querySelector(".game-shell")!.append(annotation);
  }
  const connection: Connection = {
    specId,
    from,
    to,
    mode,
    tube,
    hitTube,
    curve,
    material: cableMaterial,
    annotation,
    label,
    activity: 0,
  };
  connections.push(connection);

  const joints = points.slice(1, -1);
  for (const point of joints) {
    const joint = new THREE.Mesh(
      new THREE.CylinderGeometry(0.048, 0.048, 0.055, 8),
      material(0x356f9d, { metalness: 0.35 }),
    );
    joint.position.copy(point).setY(0.5);
    connectionsGroup.add(joint);
  }
  return connection;
}

function rebuildConnections() {
  closeRequestTrace(true);
  for (const connection of connections) connection.annotation?.remove();
  clearGroup(connectionsGroup);
  clearGroup(packetsGroup);
  connections.length = 0;
  packets.length = 0;
  trafficRoutes.length = 0;
  nextTrafficRoute = 0;

  if (topologyMode === "manual") {
    for (const authored of authoredConnections) {
      const from = nodes.find((node) => node.id === authored.fromId);
      const to = nodes.find((node) => node.id === authored.toId);
      const rendered = connect(from, to, authored.label, authored.mode, authored.id);
      if (rendered && from?.state !== "failed" && to?.state !== "failed") trafficRoutes.push([rendered]);
    }
    return;
  }

  const routableNodes = nodes
    .filter((node) => node.state !== "failed")
    .sort((left, right) => Number(incidentAffectedNodeIds.has(left.id)) - Number(incidentAffectedNodeIds.has(right.id)));
  const loadBalancers = routableNodes.filter((node) => node.kind === "loadBalancer");
  const apiNodes = routableNodes.filter((node) => node.kind === "api");
  const redisNodes = routableNodes.filter((node) => node.kind === "redis");
  const postgresNodes = routableNodes.filter((node) => node.kind === "postgres");
  const queueNodes = routableNodes.filter((node) => node.kind === "queue");
  const workers = routableNodes.filter((node) => node.kind === "worker");
  const geoNodes = routableNodes.filter((node) => node.kind === "geoIndex");
  const objectStorageNodes = routableNodes.filter((node) => node.kind === "objectStorage");
  const cdnNodes = routableNodes.filter((node) => node.kind === "cdn");

  const primaryPostgres = postgresNodes[0];
  const usesGeoPath = currentPhase.workload === "matching" || currentPhase.workload === "dispatch";
  const archiveReplicationRoutes = postgresNodes.slice(1).map((replica, index) => [
    connect(primaryPostgres, replica, index === 0 ? "REPLICA STREAM" : null, "replicate"),
  ].filter((connection): connection is Connection => connection !== null));
  const geoArchiveByNode = new Map<PlacedComponent, Connection | null>();
  const geoArchiveRoutes: Connection[][] = [];
  const geoArchiveEdgeCount = Math.max(geoNodes.length, postgresNodes.length);
  for (let index = 0; index < geoArchiveEdgeCount && geoNodes.length > 0 && postgresNodes.length > 0; index += 1) {
    const geoNode = geoNodes[index % geoNodes.length];
    const connection = connect(
      geoNode,
      postgresNodes[index % postgresNodes.length],
      index === 0 ? "PROFILE SHARD" : null,
      "request",
    );
    if (!geoArchiveByNode.has(geoNode)) geoArchiveByNode.set(geoNode, connection);
    if (connection) geoArchiveRoutes.push([connection]);
  }
  const cacheDownstreamByNode = new Map<PlacedComponent, Connection | null>();
  for (const [index, redisNode] of redisNodes.entries()) {
    const downstream = usesGeoPath
      ? geoNodes[index % Math.max(1, geoNodes.length)]
      : postgresNodes[index % Math.max(1, postgresNodes.length)];
    cacheDownstreamByNode.set(redisNode, connect(redisNode, downstream, index === 0 ? "CACHE FILL" : "CACHE SHARD", "cache"));
  }
  const edgeIngress = cdnNodes.map((cdn, index) => connect(cdn, loadBalancers[index % Math.max(1, loadBalancers.length)], index === 0 ? "EDGE REQUEST" : null));
  const edgeMediaRoutes: Connection[][] = [];
  const edgeMediaRouteCount = Math.max(cdnNodes.length, objectStorageNodes.length);
  for (let index = 0; index < edgeMediaRouteCount && cdnNodes.length > 0 && objectStorageNodes.length > 0; index += 1) {
    const connection = connect(
      cdnNodes[index % cdnNodes.length],
      objectStorageNodes[index % objectStorageNodes.length],
      index === 0 ? "EDGE MEDIA FILL" : null,
      "cache",
    );
    if (connection) edgeMediaRoutes.push([connection]);
  }
  const ingressByApi = new Map<PlacedComponent, Connection | null>();

  for (const [index, api] of apiNodes.entries()) {
    const ingress = connect(loadBalancers[index % Math.max(1, loadBalancers.length)], api, index === 0 ? "INGRESS REQUEST" : null);
    const redis = redisNodes[index % Math.max(1, redisNodes.length)];
    const geoIndex = geoNodes[index % Math.max(1, geoNodes.length)];
    const postgres = postgresNodes[index % Math.max(1, postgresNodes.length)];
    const storage = connect(
      api,
      redis ?? (usesGeoPath ? geoIndex : postgres),
      index === 0 ? (redis ? "CACHE LOOKUP" : usesGeoPath ? "NEARBY QUERY" : "DATABASE READ") : null,
    );
    ingressByApi.set(api, ingress);
    const cacheDownstream = redis ? cacheDownstreamByNode.get(redis) ?? null : null;
    const selectedGeo = redis && usesGeoPath
      ? geoNodes[index % Math.max(1, geoNodes.length)]
      : geoIndex;
    const geoToArchive = selectedGeo ? geoArchiveByNode.get(selectedGeo) ?? null : null;
    const requestRoute = [edgeIngress[index % Math.max(1, edgeIngress.length)] ?? null, ingress, storage, cacheDownstream, geoToArchive].filter(
      (connection): connection is Connection => connection !== null,
    );
    if (requestRoute.length > 0) trafficRoutes.push(requestRoute);
  }

  const asyncEventLabel = currentPhase.workload === "streaming"
    ? "MEDIA JOB"
    : currentPhase.workload === "dispatch"
      ? "LOCATION EVENT"
      : "ASYNC EVENT · NON-BLOCKING";
  const synchronousAnalytics = currentPhase.workload === "analytics" && queueNodes.length === 0;
  if (synchronousAnalytics) for (const [index, worker] of workers.entries()) {
    const apiToWorker = synchronousAnalytics
      ? connect(apiNodes[index % Math.max(1, apiNodes.length)], worker, index === 0 ? "SYNC CALL · BLOCKING" : null)
      : null;
    const workerCommit = connect(
      worker,
      postgresNodes[index % Math.max(1, postgresNodes.length)],
      index === 0 ? "ASYNC COMMIT" : null,
      "commit",
    );
    const sourceApi = apiNodes[index % Math.max(1, apiNodes.length)];
    const asyncRoute = [sourceApi ? ingressByApi.get(sourceApi) ?? null : null, apiToWorker, workerCommit].filter(
      (connection): connection is Connection => connection !== null,
    );
    if (asyncRoute.length > 1) trafficRoutes.push(asyncRoute);
  }
  if (!synchronousAnalytics) {
    const asyncRouteCount = Math.max(queueNodes.length, workers.length);
    const enqueueByQueue = new Map<PlacedComponent, Connection | null>();
    for (const [index, queueNode] of queueNodes.entries()) {
      enqueueByQueue.set(queueNode, connect(
        apiNodes[index % Math.max(1, apiNodes.length)],
        queueNode,
        index === 0 ? asyncEventLabel : null,
        "enqueue",
      ));
    }
    for (let index = 0; index < asyncRouteCount && queueNodes.length > 0 && workers.length > 0; index += 1) {
      const queueNode = queueNodes[index % queueNodes.length];
      const worker = workers[index % workers.length];
      const queueToWorker = connect(queueNode, worker, index === 0 ? "CONSUME JOB" : null, "consume");
      const workerCommit = connect(
        worker,
        currentPhase.workload === "streaming"
          ? objectStorageNodes[index % Math.max(1, objectStorageNodes.length)]
          : postgresNodes[index % Math.max(1, postgresNodes.length)],
        index === 0 ? (currentPhase.workload === "streaming" ? "WRITE MEDIA" : "ASYNC COMMIT") : null,
        "commit",
      );
      const sourceApi = apiNodes[index % Math.max(1, apiNodes.length)];
      const asyncRoute = [
        sourceApi ? ingressByApi.get(sourceApi) ?? null : null,
        enqueueByQueue.get(queueNode) ?? null,
        queueToWorker,
        workerCommit,
      ].filter((connection): connection is Connection => connection !== null);
      if (asyncRoute.length > 1) trafficRoutes.push(asyncRoute);
    }
  }
  for (const route of edgeMediaRoutes) if (route.length > 0) trafficRoutes.push(route);
  for (const route of archiveReplicationRoutes) if (route.length > 0) trafficRoutes.push(route);
  for (const route of geoArchiveRoutes) if (route.length > 0) trafficRoutes.push(route);
}

function findPathFromNode(
  from: PlacedComponent,
  sinkKinds: Set<ComponentKind>,
  allowedModes: Set<SimulationEdgeMode>,
  visitedNodeIds: Set<number>,
): Connection[] | null {
  if (sinkKinds.has(from.kind)) return [];
  for (const connection of connections) {
    if (connection.from !== from || !allowedModes.has(connection.mode) || connection.to.state === "failed") continue;
    if (visitedNodeIds.has(connection.to.id)) continue;
    const nextVisited = new Set(visitedNodeIds);
    nextVisited.add(connection.to.id);
    if (sinkKinds.has(connection.to.kind)) return [connection];
    const tail = findPathFromNode(connection.to, sinkKinds, allowedModes, nextVisited);
    if (tail) return [connection, ...tail];
  }
  return null;
}

function findDirectedInspectionPath(
  entryKinds: ComponentKind[],
  sinkKinds: ComponentKind[],
  allowedModes: SimulationEdgeMode[],
) {
  const sinks = new Set(sinkKinds);
  const modes = new Set(allowedModes);
  for (const entry of nodes.filter((node) => entryKinds.includes(node.kind) && node.state !== "failed")) {
    const route = findPathFromNode(entry, sinks, modes, new Set([entry.id]));
    if (route && route.length > 0) return route;
  }
  return null;
}

function findBackgroundInspectionPath() {
  const sinkKinds = new Set<ComponentKind>(currentPhase.workload === "streaming" ? ["objectStorage"] : ["postgres"]);
  const firstEdges = connections.filter((connection) => connection.from.kind === "api"
    && connection.from.state !== "failed"
    && (connection.mode === "enqueue" || (connection.mode === "request" && connection.to.kind === "worker")));
  for (const firstEdge of firstEdges) {
    const tailModes = firstEdge.mode === "enqueue"
      ? new Set<SimulationEdgeMode>(["consume", "commit"])
      : new Set<SimulationEdgeMode>(["commit"]);
    const tail = findPathFromNode(firstEdge.to, sinkKinds, tailModes, new Set([firstEdge.from.id, firstEdge.to.id]));
    if (tail) return [firstEdge, ...tail];
  }
  return null;
}

function buildInspectionRoutes() {
  const available: InspectionRoute[] = [];
  const requestPath = findDirectedInspectionPath(
    ["loadBalancer"],
    ["postgres"],
    ["request", "cache"],
  );
  if (requestPath) available.push({
    id: "request",
    label: currentPhase.workload === "streaming" ? "Metadata" : "User request",
    kind: "blocking",
    connections: requestPath,
  });

  if (currentPhase.workload === "streaming") {
    const deliveryPath = findDirectedInspectionPath(["cdn"], ["objectStorage"], ["request", "cache"]);
    if (deliveryPath) available.push({
      id: "delivery",
      label: "Playback",
      kind: "delivery",
      connections: deliveryPath,
    });
  }

  if (currentPhase.workload === "analytics" || currentPhase.workload === "streaming" || currentPhase.workload === "dispatch") {
    const backgroundPath = findBackgroundInspectionPath();
    if (backgroundPath) {
      const asynchronous = backgroundPath.some((connection) => connection.mode === "enqueue");
      available.push({
        id: "background",
        label: currentPhase.workload === "analytics"
          ? `Analytics${asynchronous ? "" : " · blocking"}`
          : currentPhase.workload === "streaming"
            ? "Transcode"
            : "Location event",
        kind: asynchronous ? "async" : "blocking",
        connections: backgroundPath,
      });
    }
  }
  return available;
}

function traceComponentPreview(kind: ComponentKind) {
  return brandPreviewData.get(kind)
    ?? document.querySelector<HTMLImageElement>(`#part-preview-${kind}`)?.src
    ?? "";
}

function traceModeLabel(mode: SimulationEdgeMode) {
  if (mode === "enqueue") return "enqueue";
  if (mode === "consume") return "consume";
  if (mode === "commit") return "commit";
  if (mode === "cache") return "lookup";
  if (mode === "replicate") return "replicate";
  return "call";
}

function renderInspectionRoute(index: number) {
  if (inspectionRoutes.length === 0) {
    activeInspectionConnections.clear();
    traceTitle.textContent = "No complete path";
    traceTabs.innerHTML = "";
    traceRouteElement.innerHTML = "<span class=\"trace-empty\">The graph has no end-to-end route to inspect.</span>";
    traceExplanation.textContent = "Connect an entry, processing tier, and required sink. The inspector follows the same directed edges used by the simulator.";
    return;
  }
  activeInspectionRouteIndex = ((index % inspectionRoutes.length) + inspectionRoutes.length) % inspectionRoutes.length;
  const route = inspectionRoutes[activeInspectionRouteIndex];
  activeInspectionConnections = new Set(route.connections);
  traceTitle.textContent = route.label;
  traceTabs.innerHTML = inspectionRoutes.map((candidate, routeIndex) => `
    <button type="button" role="tab" data-route-index="${routeIndex}" aria-selected="${routeIndex === activeInspectionRouteIndex}" tabindex="${routeIndex === activeInspectionRouteIndex ? 0 : -1}">${candidate.label}</button>
  `).join("");
  traceTabs.querySelectorAll<HTMLButtonElement>("button").forEach((button) => {
    button.addEventListener("click", () => renderInspectionRoute(Number(button.dataset.routeIndex)));
  });

  const routeNodes = [route.connections[0].from, ...route.connections.map((connection) => connection.to)];
  traceRouteElement.innerHTML = routeNodes.map((node, nodeIndex) => {
    const preview = traceComponentPreview(node.kind);
    const nodeMarkup = `<span class="trace-node"><img src="${preview}" alt="" /><b>${contextualComponentLabel(node.kind)}</b></span>`;
    if (nodeIndex >= route.connections.length) return nodeMarkup;
    const connection = route.connections[nodeIndex];
    return `${nodeMarkup}<i data-mode="${connection.mode}"><small>${traceModeLabel(connection.mode)}</small>→</i>`;
  }).join("");

  const hasQueueBoundary = route.connections.some((connection) => connection.mode === "enqueue");
  traceExplanation.textContent = route.kind === "delivery"
    ? "Playback follows this edge route without entering the metadata API path."
    : hasQueueBoundary
      ? "The API completes after enqueue; consume and commit continue without blocking the user response."
      : route.id === "background"
        ? "There is no queue boundary, so this dependency remains inside the user response deadline."
        : "Every step on this path must finish before the user receives a response.";
  for (const connection of route.connections) connection.activity = 1;
  spawnPacketOnRoute(route.connections);
}

function openOrCycleRequestTrace() {
  const alreadyVisible = traceReadout.dataset.visible === "true";
  inspectionRoutes = buildInspectionRoutes();
  traceReadout.dataset.visible = "true";
  traceReadout.setAttribute("aria-hidden", "false");
  traceButton.setAttribute("aria-expanded", "true");
  setTraceButtonLabel("Trace next path");
  renderInspectionRoute(alreadyVisible ? activeInspectionRouteIndex + 1 : 0);
}

function closeRequestTrace(silent = false) {
  const wasVisible = traceReadout.dataset.visible === "true";
  traceReadout.dataset.visible = "false";
  traceReadout.setAttribute("aria-hidden", "true");
  traceButton.setAttribute("aria-expanded", "false");
  setTraceButtonLabel("Trace a path");
  activeInspectionConnections.clear();
  inspectionRoutes = [];
  if (wasVisible && !silent) traceButton.focus({ preventScroll: true });
}

function captureAutomaticTopology() {
  authoredConnections.length = 0;
  for (const connection of connections) {
    authoredConnections.push({
      id: nextConnectionId++,
      fromId: connection.from.id,
      toId: connection.to.id,
      mode: connection.mode,
      label: connection.label,
    });
  }
}

function manualWiringAvailable() {
  return currentPhaseIndex > 0;
}

function syncWiringUi() {
  const available = manualWiringAvailable();
  viewControls.dataset.wiring = String(available);
  wiringButton.hidden = !available;
  wiringButton.disabled = !available;
  wiringButton.dataset.mode = topologyMode;
  wiringButton.dataset.editing = String(wiringEditing);
  wiringButton.setAttribute("aria-pressed", String(topologyMode === "manual" && wiringEditing));
  const guideVisible = available && topologyMode === "manual" && wiringEditing;
  wiringGuide.dataset.visible = String(guideVisible);
  wiringGuide.setAttribute("aria-hidden", String(!guideVisible));
  const shortcut = wiringButton.querySelector<HTMLElement>("small")!;
  if (!available) {
    wiringButtonLabel.textContent = "Auto cables";
    shortcut.textContent = "Auto-routed phase";
    partsHint.innerHTML = "<b>Click a part, then click a free floor tile.</b> Cables connect automatically. Drag machines to move them.";
  } else if (topologyMode === "automatic") {
    wiringButtonLabel.textContent = "Take cable control";
    shortcut.textContent = "W · Auto-routed";
    partsHint.innerHTML = isSandboxMode
      ? "<b>Craft freely while traffic runs.</b> Select an installed machine to take it offline, or press W to author cables."
      : "<b>Place machines anywhere on the floor.</b> Auto-route connects compatible tiers; press W to take cable control.";
  } else if (wiringEditing) {
    wiringButtonLabel.textContent = "Finish wiring";
    shortcut.textContent = "W · Editing live";
    partsHint.innerHTML = "<b>Select a source machine, then its destination.</b> Click a cable to remove it; incompatible ports are rejected.";
  } else {
    wiringButtonLabel.textContent = "Edit cables";
    shortcut.textContent = "W · Manual graph";
    partsHint.innerHTML = isSandboxMode
      ? "<b>Your manual topology is live.</b> Select a machine to inject a failure, press W to edit cables, or restore auto-routing."
      : "<b>Your manual topology is preserved.</b> Press W to edit cables, or restore automatic routing from the wiring guide.";
  }
  if (wiringSource) {
    wiringGuideStep.textContent = `Source · ${contextualComponentLabel(wiringSource.kind)}`;
    wiringGuideDetail.textContent = "Choose a compatible destination · select empty floor to cancel";
  } else {
    wiringGuideStep.textContent = "Select a source machine";
    wiringGuideDetail.textContent = "Then select its destination · click a cable to remove";
  }
}

function resetTopologyEditor() {
  topologyMode = "automatic";
  wiringEditing = false;
  wiringSource = null;
  hoveredConnection = null;
  authoredConnections.length = 0;
  nextConnectionId = 1;
  syncWiringUi();
}

function setWiringEditing(active: boolean) {
  if (!manualWiringAvailable()) {
    showToast("Manual cable routing appears in operations backed by the directed-graph simulator.");
    return;
  }
  if (active && topologyMode === "automatic") {
    if (authoredConnections.length === 0) captureAutomaticTopology();
    topologyMode = "manual";
    rebuildConnections();
    updateTelemetry();
    showToast("Manual topology active. Select a source machine, then its destination.");
  }
  wiringEditing = active;
  wiringSource = null;
  hoveredConnection = null;
  setActiveKind(null);
  selectNode(null);
  canvas.dataset.mode = active ? "wiring" : "idle";
  syncWiringUi();
}

function restoreAutomaticTopology() {
  if (topologyMode === "automatic") return;
  topologyMode = "automatic";
  wiringEditing = false;
  wiringSource = null;
  hoveredConnection = null;
  rebuildConnections();
  checkTopologyIncidentResponse();
  updateUi();
  updateTelemetry();
  canvas.dataset.mode = "idle";
  syncWiringUi();
  showToast("Automatic routing restored. Your manual graph is preserved until the phase resets.");
}

function authoredConnectionRule(fromKind: ComponentKind, toKind: ComponentKind): Pick<AuthoredConnection, "mode" | "label"> | null {
  const pair = `${fromKind}->${toKind}`;
  const asyncEventLabel = currentPhase.workload === "streaming"
    ? "MEDIA JOB"
    : currentPhase.workload === "dispatch"
      ? "LOCATION EVENT"
      : "ASYNC EVENT · NON-BLOCKING";
  const rules: Record<string, Pick<AuthoredConnection, "mode" | "label">> = {
    "loadBalancer->api": { mode: "request", label: "INGRESS REQUEST" },
    "api->redis": { mode: "request", label: "CACHE LOOKUP" },
    "api->postgres": { mode: "request", label: "DATABASE READ" },
    "redis->postgres": { mode: "cache", label: "CACHE FILL" },
    "api->geoIndex": { mode: "request", label: "NEARBY QUERY" },
    "redis->geoIndex": { mode: "cache", label: "CACHED NEARBY QUERY" },
    "api->queue": { mode: "enqueue", label: asyncEventLabel },
    "queue->worker": { mode: "consume", label: "CONSUME JOB" },
    "api->worker": { mode: "request", label: "SYNC CALL · BLOCKING" },
    "worker->postgres": { mode: "commit", label: "ASYNC COMMIT" },
    "worker->objectStorage": { mode: "commit", label: "WRITE MEDIA" },
    "geoIndex->postgres": { mode: "request", label: "PROFILE SHARD" },
    "cdn->loadBalancer": { mode: "request", label: "EDGE REQUEST" },
    "cdn->objectStorage": { mode: "cache", label: "EDGE MEDIA FILL" },
    "postgres->postgres": { mode: "replicate", label: "REPLICA STREAM" },
  };
  return rules[pair] ?? null;
}

function inferAuthoredConnection(from: PlacedComponent, to: PlacedComponent): Pick<AuthoredConnection, "mode" | "label"> | null {
  return authoredConnectionRule(from.kind, to.kind);
}

function addAuthoredConnection(from: PlacedComponent, to: PlacedComponent) {
  if (from === to) {
    showToast("A machine cannot cable back into the same port.");
    return false;
  }
  const inferred = inferAuthoredConnection(from, to);
  if (!inferred) {
    showToast(`${contextualComponentLabel(from.kind)} has no compatible output for ${contextualComponentLabel(to.kind)}.`);
    return false;
  }
  if (authoredConnections.some((connection) => connection.fromId === from.id && connection.toId === to.id && connection.mode === inferred.mode)) {
    showToast("That directed connection already exists.");
    return false;
  }
  authoredConnections.push({
    id: nextConnectionId++,
    fromId: from.id,
    toId: to.id,
    ...inferred,
  });
  rebuildConnections();
  checkTopologyIncidentResponse();
  updateTelemetry();
  showToast(`${inferred.label} · ${contextualComponentLabel(from.kind)} → ${contextualComponentLabel(to.kind)} connected.`);
  return true;
}

function removeAuthoredConnection(connection: Connection) {
  if (connection.specId === null) return;
  const index = authoredConnections.findIndex((authored) => authored.id === connection.specId);
  if (index < 0) return;
  const [removed] = authoredConnections.splice(index, 1);
  const from = nodes.find((node) => node.id === removed.fromId);
  const to = nodes.find((node) => node.id === removed.toId);
  rebuildConnections();
  checkTopologyIncidentResponse();
  updateTelemetry();
  showToast(`${from ? contextualComponentLabel(from.kind) : "Source"} → ${to ? contextualComponentLabel(to.kind) : "destination"} cable removed.`);
}

function buildLiveSimulationGraph(
  incidentOpen: boolean,
  incidentCapacityMultiplier: number,
): SimulationGraph {
  return {
    nodes: nodes.map((node) => {
      const baseCapacity = infrastructureComponentCapacity[node.kind];
      const configCapacityMultiplier = node.kind === "api" && activeConfigs.has("autoscaling")
        ? 1.35
        : node.kind === "postgres" && activeConfigs.has("walTuning")
          ? 1.25
          : 1;
      const affectedByIncident = incidentOpen && incidentAffectedNodeIds.has(node.id);
      return {
        id: String(node.id),
        kind: node.kind,
        capacity: baseCapacity * configCapacityMultiplier,
        state: node.state,
        capacityMultiplier: affectedByIncident ? incidentCapacityMultiplier : 1,
      };
    }),
    edges: connections.map((connection) => ({
      from: String(connection.from.id),
      to: String(connection.to.id),
      mode: connection.mode,
    })),
  };
}

function evaluateCoreMetrics(
  demand: number,
  counts: Record<ComponentKind, number>,
  effectiveCounts: Record<ComponentKind, number>,
  incidentOpen: boolean,
  recoveryProgress: number,
  incidentCapacityMultiplier: number,
) {
  const topology = evaluateCoreServiceGraph(buildLiveSimulationGraph(incidentOpen, incidentCapacityMultiplier), {
    demand,
    latencySlo,
    errorSlo,
  });
  const correctness = evaluateBackgroundCorrectness(topology, currentPhase.backgroundSlo);
  const incidentLatency = incidentOpen
    ? currentPhase.incident.latencyPenalty * recoveryProgress * (activeConfigs.has("circuitBreaker") ? 0.58 : 1)
    : 0;
  const incidentErrors = incidentOpen
    ? currentPhase.incident.errorPenalty * recoveryProgress * (activeConfigs.has("circuitBreaker") ? 0.32 : 1)
    : 0;
  const latency = topology.hasResponsePath
    ? Math.round(Math.max(30, topology.latency - (activeConfigs.has("walTuning") ? 8 : 0) + incidentLatency))
    : 0;
  const errors = topology.errors + incidentErrors;
  const contractSatisfied = topology.hasResponsePath
    && topology.capacity >= demand
    && latency <= latencySlo
    && errors < errorSlo;
  let bottleneckKind = topology.bottleneckKind as ComponentKind | null;
  let diagnosis = "Every connected request-path tier is inside its operating envelope.";

  if (!topology.hasResponsePath) {
    bottleneckKind = currentPhase.incident.affectedKind ?? topology.missingKinds[0] as ComponentKind | null;
    diagnosis = incidentOpen
      ? `${currentPhase.incident.title}: the failure cut the only healthy route from ingress to durable data.`
      : "No complete directed route connects Load Balancer, API Server, and PostgreSQL.";
  } else if (incidentOpen) {
    bottleneckKind = currentPhase.incident.affectedKind;
    diagnosis = `${currentPhase.incident.title} in progress — ${currentPhase.incident.operatorPrompt}`;
  } else if (topology.capacity < demand) {
    const connectedCapacity = Math.round(topology.capacity).toLocaleString("en-US");
    if (bottleneckKind === "loadBalancer") diagnosis = `Connected ingress capacity saturates at ${connectedCapacity} r/s.`;
    else if (bottleneckKind === "api") diagnosis = `Only connected API replicas contribute; the request tier saturates at ${connectedCapacity} r/s.`;
    else if (bottleneckKind === "redis") diagnosis = `The reachable cache tier saturates at ${connectedCapacity} reads/s.`;
    else diagnosis = `The connected durable data path saturates at ${connectedCapacity} reads/s.`;
  } else if (latency > latencySlo) {
    bottleneckKind = topology.cacheOperational ? bottleneckKind : "redis";
    diagnosis = topology.cacheOperational
      ? `Queueing on the connected path pushes p95 to ${latency} ms, above the ${latencySlo} ms SLO.`
      : `Every read reaches PostgreSQL on disk; the connected path reaches p95 ${latency} ms.`;
  } else {
    bottleneckKind = null;
  }

  return {
    capacity: topology.capacity,
    latency,
    errors,
    hasCore: topology.hasResponsePath,
    bottleneckKind,
    diagnosis,
    counts,
    effectiveCounts,
    topology,
    correctness,
    contractSatisfied,
  };
}

function evaluateAnalyticsMetrics(
  demand: number,
  counts: Record<ComponentKind, number>,
  effectiveCounts: Record<ComponentKind, number>,
  incidentOpen: boolean,
  recoveryProgress: number,
  incidentCapacityMultiplier: number,
) {
  const topology = evaluateSocialRedirectGraph(buildLiveSimulationGraph(incidentOpen, incidentCapacityMultiplier), {
    demand,
    latencySlo,
    errorSlo,
  });
  const correctness = evaluateBackgroundCorrectness(topology, currentPhase.backgroundSlo);
  const incidentLatency = incidentOpen
    ? currentPhase.incident.latencyPenalty * recoveryProgress * (activeConfigs.has("circuitBreaker") ? 0.58 : 1)
    : 0;
  const incidentErrors = incidentOpen
    ? currentPhase.incident.errorPenalty * recoveryProgress * (activeConfigs.has("circuitBreaker") ? 0.32 : 1)
    : 0;
  const latency = topology.hasResponsePath ? Math.round(topology.latency + incidentLatency) : 0;
  const errors = topology.errors + incidentErrors;
  const contractSatisfied = topology.hasResponsePath
    && topology.capacity >= demand
    && latency <= latencySlo
    && errors < errorSlo
    && topology.backgroundHealthy
    && correctness.meetsContract;
  let bottleneckKind = topology.bottleneckKind as ComponentKind | null;
  let diagnosis = "Every required request and event path is inside its operating envelope.";

  if (!topology.hasResponsePath) {
    bottleneckKind = currentPhase.incident.affectedKind ?? topology.missingKinds[0] as ComponentKind | null;
    diagnosis = incidentOpen
      ? `${currentPhase.incident.title}: the failure cut the only healthy route from ingress to durable data.`
      : "The topology has no complete healthy route from Load Balancer through API Server to PostgreSQL.";
  } else if (incidentOpen) {
    bottleneckKind = currentPhase.incident.affectedKind;
    diagnosis = `${currentPhase.incident.title} in progress — ${currentPhase.incident.operatorPrompt}`;
  } else if (!topology.backgroundHealthy) {
    bottleneckKind = "worker";
    diagnosis = topology.backgroundMode === "asynchronous"
      ? `Redirects respond, but Analytics Service cannot drain ${Math.round(topology.backgroundArrivalRps).toLocaleString("en-US")} click events/s. The queue backlog keeps growing.`
      : "Redirects respond, but click events have no complete path to Analytics Service and durable storage.";
  } else if (!correctness.meetsContract) {
    bottleneckKind = topology.backgroundBottleneckKind as ComponentKind | null ?? "queue";
    diagnosis = `Click events are delivered, but ${correctness.lagSeconds.toFixed(1)}s freshness misses the ${correctness.maxLagSeconds?.toFixed(1)}s data contract. Add drain headroom or shorten the event path.`;
  } else if (topology.capacity < demand) {
    if (topology.backgroundMode === "missing") {
      bottleneckKind = "worker";
      diagnosis = "Click events leave the API, but no complete path can deliver and commit them to analytics storage.";
    } else if (bottleneckKind === "loadBalancer") {
      diagnosis = `Only connected ingress machines contribute; the live route carries ${Math.round(topology.capacity).toLocaleString("en-US")} r/s.`;
    } else if (bottleneckKind === "api") {
      diagnosis = `Connected API replicas saturate at ${Math.round(topology.capacity).toLocaleString("en-US")} r/s.`;
    } else if (bottleneckKind === "redis" || bottleneckKind === "postgres") {
      diagnosis = `The reachable data path saturates at ${Math.round(topology.capacity).toLocaleString("en-US")} r/s.`;
    } else {
      diagnosis = `The connected ${bottleneckKind ? contextualComponentLabel(bottleneckKind) : "background"} path cannot drain the offered workload.`;
    }
  } else if (latency > latencySlo && topology.backgroundMode === "synchronous") {
    bottleneckKind = "queue";
    const synchronousPenalty = Math.round(60 / Math.max(1, topology.backgroundProcessorCount));
    diagnosis = `The API waits for Analytics Service before responding. The synchronous edge adds ${synchronousPenalty} ms at p95.`;
  } else if (latency > latencySlo) {
    diagnosis = `The connected request path reaches p95 ${latency} ms under load, above the ${latencySlo} ms SLO.`;
  } else if (topology.backgroundMode === "synchronous") {
    bottleneckKind = "queue";
    diagnosis = "The SLO passes through extra analytics capacity, but user responses still depend on that synchronous service.";
  } else {
    bottleneckKind = null;
  }

  return {
    capacity: topology.capacity,
    latency,
    errors,
    hasCore: topology.hasResponsePath,
    bottleneckKind,
    diagnosis,
    counts,
    effectiveCounts,
    topology,
    correctness,
    contractSatisfied,
  };
}

function evaluateSpecializedMetrics(
  demand: number,
  counts: Record<ComponentKind, number>,
  effectiveCounts: Record<ComponentKind, number>,
  incidentOpen: boolean,
  recoveryProgress: number,
  incidentCapacityMultiplier: number,
) {
  const graph = buildLiveSimulationGraph(incidentOpen, incidentCapacityMultiplier);
  const options = { demand, latencySlo, errorSlo };
  let topology: SpecializedEvaluation;
  if (currentPhase.workload === "matching") topology = evaluateMatchingGraph(graph, options);
  else if (currentPhase.workload === "streaming") topology = evaluateStreamingGraph(graph, options);
  else topology = evaluateDispatchGraph(graph, options);
  const correctness = evaluateBackgroundCorrectness(topology, currentPhase.backgroundSlo);

  const incidentLatency = incidentOpen
    ? currentPhase.incident.latencyPenalty * recoveryProgress * (activeConfigs.has("circuitBreaker") ? 0.58 : 1)
    : 0;
  const incidentErrors = incidentOpen
    ? currentPhase.incident.errorPenalty * recoveryProgress * (activeConfigs.has("circuitBreaker") ? 0.32 : 1)
    : 0;
  const latency = topology.hasResponsePath
    ? Math.round(Math.max(24, topology.latency - (activeConfigs.has("walTuning") ? 8 : 0) + incidentLatency))
    : 0;
  const errors = topology.errors + incidentErrors;
  const contractSatisfied = topology.hasResponsePath
    && topology.capacity >= demand
    && latency <= latencySlo
    && errors < errorSlo
    && topology.backgroundHealthy
    && correctness.meetsContract;
  let bottleneckKind = topology.bottleneckKind as ComponentKind | null;
  let diagnosis = "Every connected route is inside its operating envelope.";

  if (!topology.hasResponsePath) {
    bottleneckKind = topology.missingKinds[0] as ComponentKind | null;
    if (currentPhase.workload === "streaming") {
      diagnosis = topology.missingKinds.includes("cdn") || topology.missingKinds.includes("objectStorage")
        ? "Playback has no complete CDN Edge → Object Storage delivery route. Metadata health cannot hide a broken media path."
        : "Metadata has no complete Load Balancer → API Server → PostgreSQL route.";
    } else {
      diagnosis = "Nearby requests need one complete directed route through Load Balancer, API Server, Geo Index, and PostgreSQL.";
    }
  } else if (incidentOpen) {
    bottleneckKind = currentPhase.incident.affectedKind;
    diagnosis = `${currentPhase.incident.title} in progress — ${currentPhase.incident.operatorPrompt}`;
  } else if (!topology.backgroundHealthy) {
    bottleneckKind = (topology.backgroundBottleneckKind as ComponentKind | null) ?? "worker";
    if (currentPhase.workload === "streaming") {
      diagnosis = topology.backgroundMode === "missing"
        ? "Playback and metadata respond, but uploads have no complete API → Queue → Transcode Worker → Object Storage path."
        : `Transcode jobs arrive at ${Math.round(topology.backgroundArrivalRps).toLocaleString("en-US")}/s faster than the connected media pipeline can drain them.`;
    } else {
      diagnosis = topology.backgroundMode === "missing"
        ? "Ride requests respond, but driver locations have no complete API → Queue → Location Worker → PostgreSQL path."
        : `Location updates are building a ${Math.round(topology.backgroundBacklogRps).toLocaleString("en-US")}/s backlog behind the request path.`;
    }
  } else if (!correctness.meetsContract) {
    bottleneckKind = topology.backgroundBottleneckKind as ComponentKind | null ?? "queue";
    const subject = currentPhase.backgroundSlo?.label ?? "Background data";
    diagnosis = `${subject} arrive ${correctness.lagSeconds.toFixed(1)}s late, outside the ${correctness.maxLagSeconds?.toFixed(1)}s freshness contract. Increase queue drain headroom or shorten the commit path.`;
  } else if (topology.capacity < demand) {
    const capacity = Math.round(topology.capacity).toLocaleString("en-US");
    if (bottleneckKind === "loadBalancer") diagnosis = `Only connected ingress machines contribute; this route carries ${capacity} r/s.`;
    else if (bottleneckKind === "api") diagnosis = `The connected API pool saturates at ${capacity} r/s equivalent capacity.`;
    else if (bottleneckKind === "geoIndex") diagnosis = `The connected geographic partitions saturate at ${capacity} nearby queries/s.`;
    else if (bottleneckKind === "cdn") diagnosis = `The connected edge regions can deliver ${capacity} playback requests/s before origin protection fails.`;
    else if (bottleneckKind === "objectStorage") diagnosis = `The reachable media store supports ${capacity} playback and upload requests/s.`;
    else if (bottleneckKind === "queue" || bottleneckKind === "worker") diagnosis = `The connected asynchronous pipeline drains only ${capacity} r/s equivalent work.`;
    else diagnosis = `The connected durable-data route saturates at ${capacity} r/s.`;
  } else if (latency > latencySlo) {
    bottleneckKind = topology.cacheOperational ? bottleneckKind : "redis";
    if (!topology.cacheOperational) {
      diagnosis = currentPhase.workload === "streaming"
        ? `Metadata reads still reach PostgreSQL on disk, pushing p95 to ${latency} ms.`
        : `Nearby profile reads bypass fast memory and push p95 to ${latency} ms.`;
    } else {
      diagnosis = `Queueing on the hottest connected route pushes p95 to ${latency} ms, above the ${latencySlo} ms SLO.`;
    }
  } else if (topology.backgroundMode === "synchronous") {
    bottleneckKind = "queue";
    diagnosis = "Capacity passes, but a user response still waits for background work. Decoupling that edge would isolate latency and failure.";
  } else {
    bottleneckKind = null;
  }

  return {
    capacity: topology.capacity,
    latency,
    errors,
    hasCore: topology.hasResponsePath,
    bottleneckKind,
    diagnosis,
    counts,
    effectiveCounts,
    topology,
    correctness,
    contractSatisfied,
  };
}

function calculateMetrics(demand = targetRps) {
  const counts = Object.fromEntries(componentOrder.map((kind) => [kind, nodes.filter((node) => node.kind === kind).length])) as Record<ComponentKind, number>;
  const effectiveCounts = Object.fromEntries(componentOrder.map((kind) => [
    kind,
    nodes
      .filter((node) => node.kind === kind)
      .reduce((sum, node) => sum + (node.state === "failed" ? 0 : node.state === "degraded" ? 0.55 : 1), 0),
  ])) as Record<ComponentKind, number>;
  const incidentOpen = incidentTriggered && incidentMode !== "resolved";
  const recoveryProgress = incidentMode === "recovering"
    ? THREE.MathUtils.clamp(incidentRecoveryRemaining / Math.max(0.1, currentPhase.incident.recoverySeconds), 0.12, 1)
    : incidentMode === "active" ? 1 : 0;
  const incident = currentPhase.incident;
  let incidentCapacityMultiplier = incidentOpen
    ? THREE.MathUtils.lerp(1, incident.capacityMultiplier, recoveryProgress)
    : 1;
  if (incident.affectedKind === "api" && activeConfigs.has("autoscaling")) {
    incidentCapacityMultiplier = Math.max(0.82, incidentCapacityMultiplier);
  }
  if (incident.affectedKind === "postgres" && activeConfigs.has("multiAz")) {
    incidentCapacityMultiplier = Math.max(0.8, incidentCapacityMultiplier);
  }
  if (currentPhase.workload === "analytics") {
    return evaluateAnalyticsMetrics(
      demand,
      counts,
      effectiveCounts,
      incidentOpen,
      recoveryProgress,
      incidentCapacityMultiplier,
    );
  }
  if (currentPhase.workload === "general") {
    return evaluateCoreMetrics(
      demand,
      counts,
      effectiveCounts,
      incidentOpen,
      recoveryProgress,
      incidentCapacityMultiplier,
    );
  }

  return evaluateSpecializedMetrics(
    demand,
    counts,
    effectiveCounts,
    incidentOpen,
    recoveryProgress,
    incidentCapacityMultiplier,
  );
}

function updateMissionGuide(metrics: ReturnType<typeof calculateMetrics>) {
  let stage = "Step 1 of 3 · Build the path";
  let title = "Place a Load Balancer";
  let description = "Select the highlighted part, then click any free floor tile.";
  let state = "build";

  if (isSandboxMode) {
    const contractReady = !("contractSatisfied" in metrics) || metrics.contractSatisfied;
    if (isRunning) {
      const healthy = metrics.hasCore
        && metrics.capacity >= targetRps
        && metrics.latency <= latencySlo
        && metrics.errors < errorSlo
        && contractReady;
      stage = `Free Lab · ${sandboxTrafficPatterns[sandboxTrafficPattern].name} trace · seed ${sandboxTraceSeed}`;
      title = healthy ? "Every selected contract is green" : "Observe the limiting contract";
      description = healthy
        ? "Keep it running, trace paths, or select any machine and take it offline. Nothing is locked into a canonical solution."
        : metrics.diagnosis;
      state = healthy ? "ready" : "live";
    } else if (!metrics.hasCore) {
      stage = "Free Lab · Build anything";
      title = "Author a complete request path";
      description = `${metrics.diagnosis} Every compatible component and manual cable is available.`;
    } else if (metrics.capacity < targetRps) {
      stage = "Free Lab · Preflight";
      title = `${metrics.bottleneckKind ? contextualComponentLabel(metrics.bottleneckKind) : "The graph"} limits throughput`;
      description = `${Math.round(metrics.capacity).toLocaleString("en-US")} / ${targetRps.toLocaleString("en-US")} r/s. Scale, cache, or reroute the graph however you choose.`;
    } else if (metrics.latency > latencySlo || !contractReady) {
      stage = "Free Lab · Preflight";
      title = "One selected contract is still outside its envelope";
      description = metrics.diagnosis;
    } else {
      stage = "Free Lab · Ready";
      title = "Start the workload or keep crafting";
      description = "Run continuously, inspect paths, inject failures, save variants, and share any topology you invent.";
      state = "ready";
    }
  } else if (currentPhaseIndex > 0) {
    stage = "Independent operation · Diagnose the system";
    title = "Read the topology signals";
    description = "Use the SLO preview, hot-tier labels, component specs, and budget to choose your own design.";

    if (isRunning) {
      if (incidentMode === "active") {
        stage = "Live incident · Change the topology";
        title = incidentTaskTitle.textContent ?? currentPhase.incident.title;
        description = incidentTaskDescription.textContent ?? currentPhase.incident.operatorPrompt;
        state = "incident";
      } else if (incidentMode === "recovering") {
        stage = "Live incident · Mitigation running";
        title = "Watch the recovery signals";
        description = "Track throughput, latency, and errors while the affected tier recovers.";
        state = "recovering";
      } else if (incidentMode === "resolved") {
        stage = "Certification · Prove recovery";
        title = "Hold every target green";
        description = `Remain inside the SLO for ${certificationDuration} seconds to certify the phase.`;
        state = "ready";
      } else {
        stage = "Production test · Live";
        title = testPhase === "ramping" ? "Traffic is ramping up" : "Observe the system under load";
        description = "Watch the telemetry and topology. The failure drill will begin automatically.";
        state = "live";
      }
    } else if (currentPhaseIndex === 1 && metrics.hasCore) {
      const analyticsWorkers = metrics.counts.worker;
      const hasAsyncQueue = metrics.counts.queue > 0;
      const topology = "topology" in metrics ? metrics.topology : null;
      if (topology && !topology.backgroundHealthy) {
        stage = "Guided diagnosis · Follow the event path";
        title = topology.backgroundMode === "asynchronous" ? "The queue is filling faster than it drains" : "Click events have nowhere to go";
        description = topology.backgroundMode === "asynchronous"
          ? "Redirects are fast, but queued events never reach a healthy consumer and durable commit. Trace the cable after the asynchronous boundary."
          : "The user request path works, but the analytics contract is incomplete. Trace where a click event should be processed and stored.";
      } else if (hasAsyncQueue && metrics.latency <= latencySlo) {
        stage = "Guided diagnosis · Compare the new path";
        title = "Analytics no longer blocks redirects";
        description = "The API publishes an event and responds immediately; Analytics Service consumes it later. Notice the NON-BLOCKING route and lower p95.";
        state = "ready";
      } else if (!hasAsyncQueue && analyticsWorkers >= 2 && metrics.latency <= latencySlo) {
        stage = "Guided diagnosis · Valid alternative";
        title = "More analytics capacity meets the SLO";
        description = "A second Analytics Service reduced queueing delay. This passes, but redirects still depend on analytics availability and use more compute than decoupling.";
        state = "ready";
      } else {
        stage = "Guided diagnosis · Inspect the inherited path";
        title = `Why is p95 ${metrics.latency} ms?`;
        description = "Follow SYNC CALL · BLOCKING: every API response waits for Analytics Service. You can change that boundary or provision the dependency differently.";
      }
    } else if (!metrics.hasCore) {
      const missing = (["loadBalancer", "api", "postgres"] as ComponentKind[])
        .filter((kind) => metrics.counts[kind] === 0)
        .map((kind) => componentDefinitions[kind].label);
      title = missing.length > 0 ? "The request path is incomplete" : "The installed tiers are disconnected";
      description = missing.length > 0
        ? `Missing required tier${missing.length === 1 ? "" : "s"}: ${missing.join(", ")}.`
        : `${metrics.diagnosis} Press W to inspect or repair the directed cables.`;
    } else if (metrics.capacity < targetRps) {
      const tierName = metrics.bottleneckKind === "loadBalancer"
        ? "Ingress"
        : metrics.bottleneckKind === "api"
          ? "API processing"
          : metrics.bottleneckKind === "postgres"
            ? "Storage"
            : metrics.bottleneckKind
              ? contextualComponentLabel(metrics.bottleneckKind)
              : "System";
      title = `${tierName} is the bottleneck`;
      description = `${metrics.capacity.toLocaleString("en-US")} / ${targetRps.toLocaleString("en-US")} r/s · p95 ${metrics.latency} / ${latencySlo} ms. Inspect the hot path and component effects.`;
    } else if (metrics.latency > latencySlo) {
      title = "The latency SLO is being missed";
      description = `The preview is p95 ${metrics.latency} ms; the target is ${latencySlo} ms. Inspect the request path for slow work.`;
    } else {
      stage = "Topology preview · Ready to test";
      title = "The design meets its preflight SLOs";
      description = "Run the production test when you are confident in its failure behavior.";
      state = "ready";
    }
  } else if (isRunning) {
    if (incidentMode === "active") {
      stage = "Step 3 of 3 · Respond to failure";
      title = "Add one API Server";
      description = "Scale the live API tier on the floor. The Load Balancer will attach the new replica automatically.";
      state = "incident";
    } else if (incidentMode === "recovering") {
      stage = "Step 3 of 3 · Recovery in progress";
      title = "Watch the service recover";
      description = "The failed machine is restarting. Keep watching latency and errors.";
      state = "recovering";
    } else if (incidentMode === "resolved") {
      stage = "Step 3 of 3 · Prove recovery";
      title = "Hold every target green";
      description = `Stay inside the SLO for ${certificationDuration} seconds to certify the phase.`;
      state = "ready";
    } else {
      stage = "Step 2 of 3 · Run the test";
      title = testPhase === "ramping" ? "Traffic is ramping up" : "Keep the service healthy";
      description = "Watch throughput, latency, and errors. The failure drill will start automatically.";
      state = "live";
    }
  } else if (!metrics.hasCore) {
    const missingKind = (["loadBalancer", "api", "postgres"] as ComponentKind[])
      .find((kind) => metrics.counts[kind] === 0) ?? "loadBalancer";
    const definition = componentDefinitions[missingKind];
    title = `Place ${definition.label === "PostgreSQL" ? "PostgreSQL" : `a ${definition.label}`}`;
    if (missingKind === "loadBalancer") {
      description = "Select the highlighted part, then click any free floor tile. It routes incoming requests.";
    } else if (missingKind === "api") {
      description = "The API processes requests. A cable from the Load Balancer appears automatically.";
    } else {
      description = "PostgreSQL stores the URLs. Placing it completes the basic request path automatically.";
    }
  } else if (metrics.capacity < targetRps) {
    const bottleneckKind = metrics.bottleneckKind ?? "api";
    const definition = componentDefinitions[bottleneckKind];
    title = `Add another ${definition.label}`;
    description = bottleneckKind === "api"
      ? `One API handles ${definition.capacityText}. The Load Balancer distributes traffic across every API replica automatically.`
      : `The current ${definition.label} tier cannot handle ${targetRps.toLocaleString("en-US")} r/s. Add the highlighted part.`;
  } else if (metrics.latency > latencySlo) {
    const canAddRedis = currentPhase.unlocks.includes("redis") && metrics.counts.redis === 0;
    title = canAddRedis ? "Add Redis to reduce latency" : "Reduce the highlighted bottleneck";
    description = canAddRedis
      ? "Redis automatically sits between the API and PostgreSQL to serve hot redirects faster."
      : metrics.diagnosis;
  } else {
    stage = "Step 2 of 3 · Run the test";
    title = "Your design preview meets the targets";
    description = "Start the production test. Traffic and the failure drill run automatically.";
    state = "ready";
  }

  missionGuide.dataset.state = state;
  missionGuide.dataset.copy = description.length > 100 ? "long" : "normal";
  missionGuideStage.textContent = stage;
  missionGuideTitle.textContent = title;
  missionDescriptionElement.textContent = description;

  if (isSandboxMode) {
    const contractReady = !("contractSatisfied" in metrics) || metrics.contractSatisfied;
    const previewReady = metrics.hasCore && metrics.capacity >= targetRps && metrics.latency <= latencySlo && contractReady;
    runButton.disabled = nodes.length === 0;
    runButton.dataset.ready = String(!isRunning && previewReady);
    setRunButtonLabel(isRunning
      ? "Stop lab workload · T"
      : nodes.length === 0
        ? "Place any machine first"
        : !metrics.hasCore
          ? "Run broken graph · T"
        : previewReady
          ? "Start lab workload · T"
          : "Run current experiment · T");
  } else if (isRunning && incidentMode === "active") {
    runButton.disabled = true;
    runButton.dataset.ready = "false";
    setRunButtonLabel(incidentResponseRequiredKind
      ? `Install 1 more ${componentDefinitions[incidentResponseRequiredKind].label}`
      : "Restore incident envelope");
  } else if (isRunning && incidentMode === "recovering") {
    runButton.disabled = true;
    runButton.dataset.ready = "false";
    setRunButtonLabel("Recovery in progress");
  } else if (isRunning) {
    runButton.disabled = false;
    runButton.dataset.ready = "false";
    setRunButtonLabel("Abort traffic test · T");
  } else {
    const contractReady = !("contractSatisfied" in metrics) || metrics.contractSatisfied;
    const previewReady = metrics.hasCore && metrics.capacity >= targetRps && metrics.latency <= latencySlo && contractReady;
    runButton.disabled = !metrics.hasCore;
    runButton.dataset.ready = String(previewReady);
    setRunButtonLabel(!metrics.hasCore
      ? "Complete request path first"
      : previewReady
        ? "Start production test · T"
        : "Test current design · T");
  }
}

function updateUi() {
  const remaining = remainingBudget();
  budgetElement.textContent = isSandboxMode ? "BUDGET ∞" : `$${remaining.toLocaleString("en-US")}`;
  budgetElement.style.color = !isSandboxMode && remaining < 180 ? "#d66a78" : "#72d9ef";
  document.querySelectorAll<HTMLButtonElement>(".part-card").forEach((button) => {
    const kind = button.dataset.kind as ComponentKind;
    const locked = !currentPhase.unlocks.includes(kind);
    button.dataset.locked = String(locked);
    button.disabled = locked || componentDefinitions[kind].cost > remaining;
    const name = button.querySelector<HTMLElement>(".part-name");
    if (name) name.textContent = contextualComponentLabel(kind);
    const cost = button.querySelector<HTMLElement>(".part-cost");
    if (cost) cost.textContent = locked
      ? `Phase ${String(campaignPhases.findIndex((phase) => phase.unlocks.includes(kind)) + 1).padStart(2, "0")}`
      : `$${componentDefinitions[kind].cost}`;
  });
  configCount.textContent = `${activeConfigs.size} config${activeConfigs.size === 1 ? "" : "s"}`;
  syncBlueprintUi();
}

function updateTelemetry() {
  const measuredDemand = isRunning ? Math.max(1, currentDemand) : targetRps;
  const metrics = calculateMetrics(measuredDemand);
  const pulse = 0.96 + Math.sin(elapsed * 2.7) * 0.025 + Math.sin(elapsed * 6.2) * 0.012;
  const throughput = isRunning ? Math.round(Math.min(currentDemand, metrics.capacity) * pulse) : 0;
  const jitteredLatency = metrics.hasCore && isRunning ? Math.max(1, Math.round(metrics.latency + Math.sin(elapsed * 2.1) * 4)) : 0;
  throughputElement.textContent = `${throughput.toLocaleString("en-US")} r/s`;
  latencyElement.textContent = jitteredLatency > 0 ? `${jitteredLatency} ms` : "—";
  errorsElement.textContent = `${formatErrorPercent(isRunning ? metrics.errors : 0, errorSlo)}%`;
  errorsElement.style.color = metrics.errors > 1 && isRunning ? "#d66a78" : "#b8e8f4";

  const capacityMet = metrics.hasCore && metrics.capacity >= targetRps;
  const latencyMet = metrics.hasCore && metrics.latency <= latencySlo;
  const errorsMet = isRunning && currentDemand >= targetRps && metrics.errors < errorSlo;
  const backgroundTopology = (currentPhase.workload === "analytics"
    || currentPhase.workload === "streaming"
    || currentPhase.workload === "dispatch") && "topology" in metrics
    ? metrics.topology
    : null;
  const backgroundCorrectness = metrics.correctness;
  const backgroundLabel = objectiveBackground.querySelector<HTMLElement>("span")!;
  updateMissionGuide(metrics);
  objectiveThroughput.dataset.met = String(capacityMet);
  objectiveLatency.dataset.met = String(latencyMet);
  objectiveErrors.dataset.met = String(errorsMet || testPhase === "passed");
  objectiveBackground.hidden = !backgroundCorrectness.required;
  objectiveBackground.dataset.met = String(backgroundCorrectness.meetsContract);
  objectiveBackground.dataset.risk = String(backgroundCorrectness.required && !backgroundCorrectness.meetsContract);
  objectiveThroughputValue.textContent = `${Math.min(metrics.capacity, targetRps).toLocaleString("en-US")} / ${targetRps} r/s`;
  objectiveLatencyValue.textContent = `${metrics.hasCore ? metrics.latency : "—"} / ${latencySlo} ms`;
  objectiveErrorsValue.textContent = isRunning || testPhase === "passed" || testPhase === "failed"
    ? `${formatErrorPercent(metrics.errors, errorSlo)} / ${formatErrorPercent(errorSlo)}%`
    : "Run test";
  if (backgroundTopology && backgroundCorrectness.required) {
    backgroundLabel.textContent = currentPhase.backgroundSlo?.label ?? "Background delivery";
    objectiveBackground.dataset.mode = backgroundTopology.backgroundMode;
    objectiveBackgroundValue.textContent = backgroundCorrectness.status === "missing"
      ? "No delivery path"
      : backgroundCorrectness.status === "backlogged"
        ? `${backgroundCorrectness.deliveryPercent.toFixed(1)}% · +${Math.round(backgroundCorrectness.backlogRps)}/s backlog`
        : `${backgroundCorrectness.lagSeconds.toFixed(1)} / ${backgroundCorrectness.maxLagSeconds?.toFixed(1)}s${backgroundCorrectness.mode === "synchronous" ? " · blocking" : ""}`;
  }

  deliveryMeter.hidden = !backgroundCorrectness.required;
  if (backgroundCorrectness.required) {
    const lagRatio = Number.isFinite(backgroundCorrectness.lagSeconds)
      ? THREE.MathUtils.clamp(backgroundCorrectness.lagSeconds / Math.max(0.01, backgroundCorrectness.maxLagSeconds ?? 1), 0, 1)
      : 1;
    deliveryMeter.dataset.met = String(backgroundCorrectness.meetsContract);
    deliveryLabel.textContent = `${currentPhase.backgroundSlo?.label ?? "Background data"} freshness`;
    deliveryValue.textContent = Number.isFinite(backgroundCorrectness.lagSeconds)
      ? `${backgroundCorrectness.lagSeconds.toFixed(1)} / ${backgroundCorrectness.maxLagSeconds?.toFixed(1)}s`
      : `∞ / ${backgroundCorrectness.maxLagSeconds?.toFixed(1)}s`;
    deliveryFill.style.scale = `${lagRatio} 1`;
    deliveryStatus.textContent = backgroundCorrectness.status === "missing"
      ? "0% delivered · no complete path"
      : backgroundCorrectness.status === "backlogged"
        ? `${backgroundCorrectness.deliveryPercent.toFixed(1)}% delivered · backlog +${Math.round(backgroundCorrectness.backlogRps)}/s`
        : backgroundCorrectness.status === "stale"
          ? `${backgroundCorrectness.deliveryPercent.toFixed(1)}% delivered · data is stale`
          : backgroundCorrectness.status === "blocking"
            ? "100% delivered · blocks the user response"
            : `${backgroundCorrectness.deliveryPercent.toFixed(1)}% delivered · asynchronous`;
  }

  bottleneckElement.textContent = metrics.diagnosis;
  bottleneckElement.dataset.state = metrics.bottleneckKind === null ? "healthy" : "warning";
  const disconnectedNodeIds = "topology" in metrics ? new Set(metrics.topology.disconnectedNodeIds) : null;
  for (const node of nodes) {
    const disconnected = disconnectedNodeIds?.has(String(node.id)) ?? false;
    node.label.dataset.status = node.state === "failed"
      ? "failed"
      : node.state === "degraded"
        ? "degraded"
        : disconnected
          ? "disconnected"
          : node.kind === metrics.bottleneckKind ? "hot" : "normal";
    const stateLabel = node.state === "failed"
      ? "OFFLINE"
      : node.state === "degraded"
        ? "RECOVERING"
        : disconnected ? "DISCONNECTED" : contextualComponentRole(node.kind);
    node.label.querySelector("small")!.textContent = stateLabel;
  }
  document.querySelectorAll<HTMLButtonElement>(".part-card").forEach((button) => {
    const recommendedKind = incidentMode === "active" && incidentResponseRequiredKind
      ? incidentResponseRequiredKind
      : currentPhaseIndex === 0
        ? metrics.bottleneckKind
        : null;
    const learningAlternative = currentPhaseIndex === 1
      && !isRunning
      && metrics.counts.queue === 0
      && metrics.counts.worker < 2
      && (button.dataset.kind === "queue" || button.dataset.kind === "worker");
    button.dataset.recommended = String((button.dataset.kind === recommendedKind || learningAlternative) && !button.disabled);
  });

  if (testPhase === "idle") {
    const backgroundMet = backgroundTopology?.backgroundHealthy ?? true;
    const previewMeetsContract = capacityMet && latencyMet && backgroundMet;
    missionPhaseElement.textContent = previewMeetsContract
      ? "Ready to test"
      : currentPhaseIndex <= 1
        ? "Guided build"
        : "Independent build";
    testPhaseElement.textContent = metrics.hasCore ? "Topology preview" : "Awaiting topology";
    testTimeElement.textContent = previewMeetsContract ? "READY" : "CHECK";
    testTimeElement.dataset.state = previewMeetsContract ? "ready" : "warning";
    testProgressFill.style.scale = "0 1";
  }
}

function resetIncident() {
  incidentTriggered = false;
  incidentMode = "pending";
  incidentRecoveryRemaining = 0;
  incidentTargetNodeId = null;
  incidentResolution = "";
  incidentResponseRequiredKind = null;
  incidentResponseRequiredCount = 0;
  incidentTopologyFingerprintAtTrigger = "";
  incidentAffectedNodeIds.clear();
  incidentPanel.dataset.visible = "false";
  incidentPanel.dataset.status = "active";
  incidentPanel.dataset.tutorial = "false";
  incidentTask.hidden = true;
  incidentTask.dataset.complete = "false";
  missionCard.dataset.incident = "false";
  if (!isSandboxMode) {
    for (const node of nodes) node.state = "healthy";
  }
}

function topologyFingerprint() {
  const nodeSignature = nodes
    .map((node) => `${node.id}:${node.kind}`)
    .sort()
    .join("|");
  const edgeSignature = connections
    .map((connection) => `${connection.from.id}>${connection.to.id}:${connection.mode}`)
    .sort()
    .join("|");
  return `${nodeSignature}::${edgeSignature}`;
}

function checkTutorialIncidentResponse() {
  if (!incidentResponseRequiredKind) return;
  const installedCount = nodes.filter((node) => node.kind === incidentResponseRequiredKind).length;
  const requiredCount = incidentResponseRequiredCount;
  const definition = componentDefinitions[incidentResponseRequiredKind];
  incidentTaskCount.textContent = `${installedCount} / ${requiredCount} installed`;
  incidentTaskProgress.style.scale = `${Math.min(1, installedCount / Math.max(1, requiredCount))} 1`;
  if (installedCount < requiredCount) return;
  const responseMetrics = calculateMetrics(Math.max(1, currentDemand));
  const newestResponseNode = nodes.filter((node) => node.kind === incidentResponseRequiredKind).at(-1);
  const disconnectedIds = "topology" in responseMetrics
    ? new Set(responseMetrics.topology.disconnectedNodeIds)
    : null;
  const newCapacityDisconnected = newestResponseNode
    ? disconnectedIds?.has(String(newestResponseNode.id)) ?? false
    : true;
  if (topologyMode === "manual" && (!responseMetrics.hasCore || newCapacityDisconnected)) {
    incidentTaskCount.textContent = "Installed · not routed";
    incidentTaskProgress.style.scale = "0.82 1";
    incidentTaskTitle.textContent = `Wire ${definition.label} into the live path`;
    incidentTaskDescription.textContent = "The spare exists but carries no traffic. Connect compatible input and output ports before it can mitigate the incident.";
    return;
  }

  incidentTask.dataset.complete = "true";
  incidentTaskTitle.textContent = `${definition.label} capacity connected`;
  incidentTaskDescription.textContent = incidentResponseRequiredKind === "api"
    ? "The Load Balancer has added the replica to its request pool. Watch capacity recover."
    : `The new ${definition.role.toLowerCase()} has joined the live topology. Watch the affected tier recover.`;
  beginIncidentRecovery(false, `New ${definition.label} capacity joined the live topology`);
}

function checkTopologyIncidentResponse(allowExistingTopology = false) {
  if (incidentMode !== "active") return;
  if (currentPhaseIndex === 0) {
    checkTutorialIncidentResponse();
    return;
  }
  const topologyChanged = topologyFingerprint() !== incidentTopologyFingerprintAtTrigger;
  const recoveryThreshold = targetRps;
  const liveIncidentDemand = Math.round(targetRps * currentPhase.incident.loadMultiplier);
  const metrics = calculateMetrics(recoveryThreshold);
  const topology = "topology" in metrics ? metrics.topology : null;
  const structurallyHealthy = metrics.hasCore
    && metrics.capacity >= recoveryThreshold
    && topology?.hasResponsePath === true
    && topology.backgroundHealthy;

  if ((allowExistingTopology || topologyChanged) && structurallyHealthy) {
    incidentTask.dataset.complete = "true";
    incidentTaskCount.textContent = "Recovery threshold met";
    incidentTaskTitle.textContent = topologyChanged
      ? "Topology mitigation accepted"
      : "Existing redundancy absorbed the failure";
    incidentTaskDescription.textContent = topologyChanged
      ? "The revised graph restores baseline throughput and required background delivery, so controlled recovery can begin."
      : "Healthy connected capacity preserved the recovery envelope; no emergency purchase was required.";
    incidentTaskProgress.style.scale = "1 1";
    beginIncidentRecovery(false, topologyChanged
      ? "Player-authored topology restored the recovery envelope"
      : "Existing redundancy absorbed the failed machine");
    return;
  }

  const capacityRatio = Math.min(1, metrics.capacity / Math.max(1, recoveryThreshold));
  incidentTask.dataset.complete = "false";
  incidentTaskProgress.style.scale = `${Math.max(0.04, capacityRatio)} 1`;
  if (!metrics.hasCore || topology?.hasResponsePath === false) {
    incidentTaskCount.textContent = "Route incomplete";
    incidentTaskTitle.textContent = "Restore a complete response route";
    incidentTaskDescription.textContent = "The failure cut a required directed path. Reroute a healthy machine or attach spare capacity; installed but disconnected hardware does nothing.";
  } else if (topology && !topology.backgroundHealthy) {
    incidentTaskCount.textContent = topology.backgroundMode === "asynchronous"
      ? `+${Math.round(topology.backgroundBacklogRps).toLocaleString("en-US")}/s backlog`
      : "Background route missing";
    incidentTaskTitle.textContent = "Restore the background contract";
    incidentTaskDescription.textContent = "User traffic alone is not enough. Reconnect or scale the asynchronous path until its arrival rate can be drained.";
  } else {
    const structuralBottleneck = topology?.bottleneckKind as ComponentKind | null;
    const bottleneck = structuralBottleneck
      ? contextualComponentLabel(structuralBottleneck)
      : "connected path";
    incidentTaskCount.textContent = `${Math.round(metrics.capacity).toLocaleString("en-US")} / ${recoveryThreshold.toLocaleString("en-US")} r/s recovery`;
    incidentTaskTitle.textContent = `Relieve ${bottleneck}`;
    incidentTaskDescription.textContent = `Restore the baseline envelope to start recovery while ${liveIncidentDemand.toLocaleString("en-US")} r/s remains live. Reroute a spare, scale any limiting tier, or redesign the path.`;
  }
}

function topologyIncidentInstruction(kind: ComponentKind) {
  if (kind === "api") return { title: "Add one API Server", reason: "Add stateless compute behind the Load Balancer." };
  if (kind === "redis") return { title: "Add one Redis node", reason: "Split hot keys across another in-memory cache node." };
  if (kind === "postgres") return { title: "Add one PostgreSQL replica", reason: "Restore durable capacity with another database replica." };
  if (kind === "geoIndex") return { title: "Split with another Geo Index", reason: "Divide the hot geographic cells across another search partition." };
  if (kind === "cdn") return { title: "Add another CDN Edge", reason: "Shift playback traffic away from the degraded edge region." };
  const definition = componentDefinitions[kind];
  return { title: `Add one ${definition.label}`, reason: `Add capacity to the affected ${definition.role.toLowerCase()} tier.` };
}

function availableIncidentPolicy() {
  const kind = currentPhase.incident.affectedKind;
  if (kind === "postgres" && activeConfigs.has("multiAz")) {
    return { label: "Trigger automatic failover", durationFactor: 0.18, resolution: "Multi-AZ standby promoted" };
  }
  if (kind === "api" && activeConfigs.has("autoscaling")) {
    return { label: "Replace from warm pool", durationFactor: 0.32, resolution: "Autoscaler replaced failed capacity" };
  }
  if (activeConfigs.has("circuitBreaker")) {
    return { label: "Isolate and reroute", durationFactor: 0.46, resolution: "Circuit breaker isolated the fault" };
  }
  return null;
}

function triggerIncident() {
  if (incidentTriggered) return;
  selectNode(null);
  incidentTriggered = true;
  incidentMode = "active";
  const incident = currentPhase.incident;
  const targets = incident.affectedKind
    ? nodes.filter((node) => node.kind === incident.affectedKind && node.state === "healthy")
    : [];
  incidentAffectedNodeIds.clear();
  for (const affectedNode of targets) incidentAffectedNodeIds.add(affectedNode.id);
  const target = targets.length > 0 ? targets[targets.length - 1] : null;
  if (target) {
    target.state = "failed";
    incidentTargetNodeId = target.id;
    if (topologyMode === "automatic") rebuildConnections();
  }

  incidentCode.textContent = `SEV-${currentPhase.index < 2 ? "2" : "1"} · ${incident.code}`;
  incidentStatus.textContent = "Active incident";
  incidentTitle.textContent = incident.title;
  incidentSummary.textContent = incident.summary;
  incidentImpact.innerHTML = `
    <span><small>Demand</small><b>×${incident.loadMultiplier.toFixed(2)}</b></span>
    <span><small>Tier capacity</small><b>−${Math.round((1 - incident.capacityMultiplier) * 100)}%</b></span>
    <span><small>Error risk</small><b>+${incident.errorPenalty.toFixed(1)}%</b></span>
  `;
  incidentPrompt.textContent = incident.operatorPrompt;
  const policy = availableIncidentPolicy();
  incidentPanel.dataset.status = "active";
  incidentPanel.dataset.tutorial = String(currentPhaseIndex === 0);
  incidentPanel.dataset.visible = "true";
  missionCard.dataset.incident = "true";

  const automaticPolicy = currentPhaseIndex > 0 ? policy : null;
  if (automaticPolicy) {
    incidentResponseRequiredKind = null;
    incidentResponseRequiredCount = 0;
    incidentTask.hidden = false;
    incidentTask.dataset.complete = "true";
    incidentTaskCount.textContent = "Runbook active";
    incidentTaskTitle.textContent = `${automaticPolicy.label} engaged`;
    incidentTaskDescription.textContent = "The resilience policy you configured before the drill detected the failure and is executing automatically.";
    incidentTaskProgress.style.scale = "1 1";
    beginIncidentRecovery(true);
  } else if (currentPhaseIndex === 0) {
    const responseKind = incident.affectedKind ?? "api";
    const instruction = topologyIncidentInstruction(responseKind);
    const installedCount = nodes.filter((node) => node.kind === responseKind).length;
    incidentResponseRequiredKind = responseKind;
    incidentResponseRequiredCount = installedCount + 1;
    incidentBudgetCredit += componentDefinitions[responseKind].cost;
    incidentStatus.textContent = currentPhaseIndex === 0 ? "Topology change required · paused" : "Topology change required";
    incidentPrompt.textContent = currentPhaseIndex === 0
      ? "One API server is offline and launch demand exceeds the remaining capacity. Scale the stateless API tier horizontally."
      : `${incident.operatorPrompt} ${instruction.reason}`;
    incidentTask.hidden = false;
    incidentTask.dataset.complete = "false";
    incidentTaskTitle.textContent = instruction.title;
    incidentTaskDescription.textContent = `$${componentDefinitions[responseKind].cost} emergency budget added. Select ${componentDefinitions[responseKind].label} in the catalogue, then install it on a free floor tile.`;
    checkTopologyIncidentResponse();
    updateUi();
  } else {
    incidentResponseRequiredKind = null;
    incidentResponseRequiredCount = 0;
    incidentBudgetCredit += 600;
    incidentTopologyFingerprintAtTrigger = topologyFingerprint();
    incidentStatus.textContent = "Stabilize by topology · live";
    incidentPrompt.textContent = `${incident.operatorPrompt} Any connected design that restores the recovery envelope is valid.`;
    incidentTask.hidden = false;
    incidentTask.dataset.complete = "false";
    incidentTaskCount.textContent = "Evaluate live graph";
    incidentTaskTitle.textContent = "Restore the recovery envelope";
    incidentTaskDescription.textContent = "$600 incident reserve released. Restore baseline throughput and required background delivery; full SLO certification follows after recovery.";
    incidentTaskProgress.style.scale = "0.04 1";
    checkTopologyIncidentResponse(true);
    updateUi();
  }
  statusLight.textContent = "Incident";
  showToast(automaticPolicy
    ? `${automaticPolicy.label} detected ${incident.code} and started recovery.`
    : !isIncidentAwaitingResponse()
      ? `${incident.code}: the existing design absorbed the failure and entered recovery.`
      : `Incident ${incident.code}: restore the recovery envelope by any valid topology change.`);
}

function beginIncidentRecovery(automated: boolean, resolutionOverride?: string) {
  if (incidentMode !== "active") return;
  const policy = availableIncidentPolicy();
  if (automated && !policy) return;
  const observabilityFactor = activeConfigs.has("observability") ? 0.8 : 1;
  incidentRecoveryRemaining = currentPhase.incident.recoverySeconds
    * (automated ? policy!.durationFactor : 1)
    * observabilityFactor;
  incidentMode = "recovering";
  incidentResolution = resolutionOverride ?? (automated ? policy!.resolution : currentPhase.incident.manualAction);
  const target = nodes.find((node) => node.id === incidentTargetNodeId);
  if (target) target.state = "degraded";
  rebuildConnections();
  incidentPanel.dataset.status = "recovering";
  incidentStatus.textContent = "Mitigation running";
  incidentPrompt.textContent = currentPhaseIndex === 0
    ? "The new replica is taking traffic while the failed server returns to service."
    : incidentPrompt.textContent;
  showToast(`${incidentResolution}. Monitoring recovery signals.`);
}

function updateIncident(delta: number) {
  if (incidentMode !== "recovering") return;
  incidentRecoveryRemaining = Math.max(0, incidentRecoveryRemaining - delta);
  incidentStatus.textContent = `Recovering · ${incidentRecoveryRemaining.toFixed(1)}s`;
  if (incidentRecoveryRemaining > 0) return;

  incidentMode = "resolved";
  const target = nodes.find((node) => node.id === incidentTargetNodeId);
  if (target) target.state = "healthy";
  rebuildConnections();
  incidentPanel.dataset.status = "resolved";
  incidentStatus.textContent = "Resolved";
  incidentPrompt.textContent = `${incidentResolution}. Capacity and error rates have returned to their normal envelope.`;
  showToast(`Incident resolved: ${currentPhase.incident.title}. Hold the SLO to complete certification.`);
  const resolvedPhase = currentPhaseIndex;
  window.setTimeout(() => {
    if (incidentMode === "resolved" && currentPhaseIndex === resolvedPhase) {
      incidentPanel.dataset.visible = "false";
      missionCard.dataset.incident = "false";
    }
  }, 2200);
}

function isIncidentAwaitingResponse() {
  return incidentMode === "active";
}

function syncTestControls() {
  runButton.dataset.running = String(isRunning);
  statusLight.dataset.running = String(isRunning);
  signalTrack.dataset.running = String(isRunning);
  setRunButtonLabel(isSandboxMode
    ? isRunning ? "Stop lab workload · T" : "Start lab workload · T"
    : isRunning ? "Abort traffic test · T" : "Start traffic test · T");
  statusLight.textContent = isSandboxMode
    ? isRunning ? "Lab live" : "Sandbox"
    : isRunning ? "Live" : testPhase === "passed" ? "Certified" : "Standby";
  syncBlueprintUi();
}

function hideResult() {
  resultOverlay.dataset.visible = "false";
  resultOverlay.setAttribute("aria-hidden", "true");
}

let resultHintLevel = 0;

function renderResultHint(level: number) {
  resultHintLevel = Math.max(0, Math.min(2, level));
  resultHint.dataset.level = String(resultHintLevel);
  resultHintButton.setAttribute("aria-expanded", String(resultHintLevel > 0));
  resultHintCopy.hidden = resultHintLevel === 0;
  if (resultHintLevel === 0) {
    resultHintCopy.textContent = "";
    resultHintButton.textContent = "Reveal a hint";
  } else if (resultHintLevel === 1) {
    resultHintCopy.textContent = "Ask which work must finish before the user can receive the redirect response. Click tracking may have a different deadline.";
    resultHintButton.textContent = "Show a deeper hint";
  } else {
    resultHintCopy.textContent = "Look for a boundary that can accept click events quickly while Analytics Service processes them later, outside the user-facing request path.";
    resultHintButton.textContent = "Hints complete";
  }
  resultHintButton.disabled = resultHintLevel >= 2;
}

function populateOperationalReview(metrics: ReturnType<typeof calculateMetrics>, passed: boolean) {
  const topology = "topology" in metrics ? metrics.topology : null;
  const disconnectedIds = new Set(topology?.disconnectedNodeIds ?? []);
  const connectedNodeCount = nodes.filter((node) => !disconnectedIds.has(String(node.id))).length;
  const headroom = Math.max(0, metrics.capacity - targetRps);
  const backgroundMode = topology?.backgroundMode ?? "none";
  resultReview.dataset.outcome = passed ? "passed" : "failed";
  resultReviewProfile.textContent = `${topologyMode === "manual" ? "Manual" : "Auto"} graph · ${connectedNodeCount}/${nodes.length} connected`;

  if (passed && currentPhase.workload === "streaming" && topology && "routeCapacities" in topology) {
    resultProofTitle.textContent = "Three contracts held independently";
    resultProofCopy.textContent = `Metadata, playback, and transcode paths all cleared ${targetRps.toLocaleString("en-US")} r/s equivalent demand; p95 settled at ${metrics.latency} ms.`;
  } else if (passed && backgroundMode === "asynchronous") {
    resultProofTitle.textContent = "User and background work stayed isolated";
    resultProofCopy.textContent = `The request path met p95 ${metrics.latency} ms while ${metrics.correctness.deliveryPercent.toFixed(1)}% of background work arrived with ${metrics.correctness.lagSeconds.toFixed(1)}s lag.`;
  } else if (passed) {
    resultProofTitle.textContent = "The connected path survived the drill";
    resultProofCopy.textContent = `${targetRps.toLocaleString("en-US")} r/s held inside the ${latencySlo} ms SLO${headroom > 0 ? ` with ${Math.round(headroom).toLocaleString("en-US")} r/s spare capacity` : " at the tested capacity"}.`;
  } else if (metrics.hasCore) {
    resultProofTitle.textContent = "A usable response route exists";
    resultProofCopy.textContent = `The strongest connected path carried ${Math.round(metrics.capacity).toLocaleString("en-US")} r/s. That working slice is the baseline for the next experiment.`;
  } else {
    resultProofTitle.textContent = "No end-to-end behavior was proven";
    resultProofCopy.textContent = "Installed machines never formed a complete healthy response route, so capacity and latency could not be certified.";
  }

  if (metrics.correctness.required && !metrics.correctness.meetsContract) {
    resultRiskTitle.textContent = `${currentPhase.backgroundSlo?.label ?? "Background data"}: contract missed`;
    resultRiskCopy.textContent = metrics.correctness.status === "backlogged"
      ? `Only ${metrics.correctness.deliveryPercent.toFixed(1)}% is delivered at the offered load; the backlog grows by ${Math.round(metrics.correctness.backlogRps)}/s.`
      : `Delivery lag is ${Number.isFinite(metrics.correctness.lagSeconds) ? `${metrics.correctness.lagSeconds.toFixed(1)}s` : "unbounded"}, above the ${metrics.correctness.maxLagSeconds?.toFixed(1)}s limit.`;
  } else if (disconnectedIds.size > 0) {
    resultRiskTitle.textContent = `${disconnectedIds.size} machine${disconnectedIds.size === 1 ? " is" : "s are"} operationally idle`;
    resultRiskCopy.textContent = "They consume budget but sit outside every required request, background, delivery, or replication path.";
  } else if (backgroundMode === "synchronous") {
    resultRiskTitle.textContent = "A background dependency still blocks users";
    resultRiskCopy.textContent = "This graph may pass with enough compute, but dependency latency or failure still enters the user response deadline.";
  } else {
    const affectedKind = currentPhase.incident.affectedKind;
    const connectedAffectedCount = affectedKind
      ? nodes.filter((node) => node.kind === affectedKind && !disconnectedIds.has(String(node.id))).length
      : 0;
    if (affectedKind && connectedAffectedCount <= 1 && !availableIncidentPolicy()) {
      resultRiskTitle.textContent = `One ${contextualComponentLabel(affectedKind)} remains a failure domain`;
      resultRiskCopy.textContent = "The exercise recovered it manually; a second connected route or an explicit policy would change that operational tradeoff.";
    } else if (activeConfigs.size === 0 && currentPhaseIndex > 0) {
      resultRiskTitle.textContent = "Recovery depends on an operator";
      resultRiskCopy.textContent = "The topology works, but no runbook policy is configured to detect, isolate, or replace a failed dependency automatically.";
    } else {
      resultRiskTitle.textContent = "More machinery means more coordination";
      resultRiskCopy.textContent = `${nodes.length} machines and ${activeConfigs.size} runbook polic${activeConfigs.size === 1 ? "y" : "ies"} passed; cost and failure surface still matter beyond the SLO.`;
    }
  }

  if (!passed) {
    const bottleneck = metrics.bottleneckKind ? contextualComponentLabel(metrics.bottleneckKind) : "broken boundary";
    resultExperimentTitle.textContent = `Trace ${bottleneck}`;
    resultExperimentCopy.textContent = "Change one boundary or capacity tier, trace the affected path, then rerun. The comparison will reveal whether the bottleneck moved.";
  } else if (backgroundMode === "synchronous") {
    resultExperimentTitle.textContent = "Compare failure isolation";
    resultExperimentCopy.textContent = "Save this blueprint, then test a design where non-user work has a different completion deadline. Compare cost, p95, and dependency risk.";
  } else if (currentPhase.workload === "streaming") {
    resultExperimentTitle.textContent = "Shift the edge/origin balance";
    resultExperimentCopy.textContent = "Save this blueprint, vary CDN and Object Storage capacity, and inspect which of the three paths becomes limiting first.";
  } else if (currentPhase.workload === "matching" || currentPhase.workload === "dispatch") {
    resultExperimentTitle.textContent = "Change the partition shape";
    resultExperimentCopy.textContent = "Compare geographic shards against cache and compute headroom. A different balance may pass with a different cost and hotspot risk.";
  } else if (topology?.cacheOperational) {
    resultExperimentTitle.textContent = "Trade cache reliance for durable headroom";
    resultExperimentCopy.textContent = "Save this design, then compare a storage-heavy variant. The goal is not a winner—observe how latency, budget, and failure behavior move.";
  } else if (currentPhase.unlocks.includes("redis")) {
    resultExperimentTitle.textContent = "Trade storage scale for fast memory";
    resultExperimentCopy.textContent = "Compare this durable path with a cache-assisted graph and inspect both the latency gain and the new failure dependency.";
  } else {
    resultExperimentTitle.textContent = "Test the minimum safe headroom";
    resultExperimentCopy.textContent = "Save the blueprint, remove or reroute one spare, and rerun the same drill to find which redundancy is actually carrying risk.";
  }
}

function drillSnapshotStorageKey(phaseIndex = currentPhaseIndex) {
  if (isSandboxMode && phaseIndex === campaignPhases.length) {
    const dataContract = currentPhase.backgroundSlo
      ? `-${currentPhase.backgroundSlo.minimumDeliveryPercent}-${currentPhase.backgroundSlo.maxLagSeconds}`
      : "-none";
    return `sysbench-drill-snapshot-v1-lab-${currentPhase.workload}-${targetRps}-${latencySlo}-${errorSlo}${dataContract}-${sandboxTrafficPattern}-${sandboxTraceSeed}`;
  }
  return `sysbench-drill-snapshot-v1-${phaseIndex}`;
}

function normalizeDrillBackgroundMode(value: unknown): DrillBackgroundMode {
  if (value === "missing" || value === "synchronous" || value === "asynchronous") return value;
  return "none";
}

function createDrillSnapshot(metrics: ReturnType<typeof calculateMetrics>, passed: boolean): DrillSnapshotV1 {
  const topology = "topology" in metrics ? metrics.topology : null;
  const disconnectedNodeIds = new Set(topology?.disconnectedNodeIds ?? []);
  return {
    version: 1,
    phaseIndex: currentPhaseIndex,
    completedAt: Date.now(),
    passed,
    capacity: Math.max(0, metrics.capacity),
    latency: Math.max(0, metrics.latency),
    errors: Math.max(0, metrics.errors),
    spend: Math.max(0, installedMachineSpend() + configSpend()),
    machineCount: nodes.length,
    connectedMachineCount: nodes.filter((node) => !disconnectedNodeIds.has(String(node.id))).length,
    configCount: activeConfigs.size,
    backgroundMode: normalizeDrillBackgroundMode(topology?.backgroundMode),
    topologyMode,
  };
}

function readPreviousDrillSnapshot(): DrillSnapshotV1 | null {
  try {
    const raw = window.localStorage.getItem(drillSnapshotStorageKey());
    if (!raw) return null;
    return validateDrillSnapshot(JSON.parse(raw), currentPhaseIndex);
  } catch {
    return null;
  }
}

function saveDrillSnapshot(snapshot: DrillSnapshotV1) {
  try {
    window.localStorage.setItem(drillSnapshotStorageKey(), JSON.stringify(snapshot));
  } catch {
    // The comparison is a progressive enhancement when storage is unavailable.
  }
}

function setDrillDelta(element: HTMLElement, value: number, trend: DrillTrend, unit: string, prefix = "") {
  const rounded = Math.round(value * 10) / 10;
  const absolute = Math.abs(rounded).toLocaleString("en-US", { maximumFractionDigits: 1 });
  element.parentElement!.dataset.trend = trend;
  element.textContent = rounded === 0
    ? "No change"
    : `${rounded > 0 ? "+" : "−"}${prefix}${absolute}${unit}`;
}

function comparisonSummary(comparison: DrillComparison) {
  if (!comparison.previous.passed && comparison.current.passed) {
    return "The changed design turned a failed drill into certification. Use the deltas to identify what the extra safety cost.";
  }
  if (comparison.previous.passed && !comparison.current.passed) {
    return "This variant lost certification. Trace the regression, then decide whether its savings or simpler graph justify another change.";
  }
  if (comparison.backgroundModeChanged) {
    const labels: Record<DrillBackgroundMode, string> = {
      none: "no background path",
      missing: "an incomplete background path",
      synchronous: "blocking background work",
      asynchronous: "isolated asynchronous work",
    };
    return `Background behavior changed from ${labels[comparison.previous.backgroundMode]} to ${labels[comparison.current.backgroundMode]}. Compare the latency and spend tradeoff.`;
  }
  if (comparison.topologyModeChanged) {
    return `Routing changed from ${comparison.previous.topologyMode} to ${comparison.current.topologyMode}. The measurements show whether the authored graph changed behavior.`;
  }
  if (comparison.machineCount.value !== 0) {
    return `${Math.abs(comparison.machineCount.value)} machine${Math.abs(comparison.machineCount.value) === 1 ? "" : "s"} ${comparison.machineCount.value > 0 ? "added" : "removed"}. Capacity, latency, and spend show what that topology change bought.`;
  }
  const unchanged = comparison.capacity.value === 0
    && comparison.latency.value === 0
    && comparison.errors.value === 0
    && comparison.spend.value === 0;
  return unchanged
    ? "The observed result is unchanged. Modify one boundary, capacity tier, or runbook before the next drill to create a useful comparison."
    : "The graph shape stayed constant, but its policies or operating state changed. Inspect which measured tradeoff moved.";
}

function populateDrillComparison(previous: DrillSnapshotV1 | null, current: DrillSnapshotV1) {
  const comparison = previous ? compareDrillRuns(previous, current) : null;
  if (!comparison) {
    resultComparison.dataset.state = "baseline";
    resultComparisonLabel.textContent = "Experiment baseline";
    resultComparisonOutcome.textContent = current.passed ? "Certified baseline" : "Failed baseline";
    resultComparisonSummary.textContent = "This run is saved for this phase. Change one variable and rerun to see the measured tradeoff.";
    resultComparisonGrid.hidden = true;
    return;
  }

  resultComparison.dataset.state = "comparison";
  resultComparisonLabel.textContent = "Compared with previous drill";
  resultComparisonOutcome.textContent = `${comparison.previous.passed ? "Certified" : "Failed"} → ${comparison.current.passed ? "Certified" : "Failed"}`;
  resultComparisonSummary.textContent = comparisonSummary(comparison);
  resultComparisonGrid.hidden = false;
  setDrillDelta(resultDeltaLatency, comparison.latency.value, comparison.latency.trend, " ms");
  setDrillDelta(resultDeltaCapacity, comparison.capacity.value, comparison.capacity.trend, " r/s");
  setDrillDelta(resultDeltaSpend, comparison.spend.value, comparison.spend.trend, "", "$");
  setDrillDelta(resultDeltaMachines, comparison.machineCount.value, comparison.machineCount.trend, Math.abs(comparison.machineCount.value) === 1 ? " machine" : " machines");
}

function finishTest(passed: boolean) {
  closeRequestTrace(true);
  isRunning = false;
  testPhase = passed ? "passed" : "failed";
  currentDemand = targetRps;
  syncTestControls();

  const metrics = calculateMetrics(targetRps);
  const score = passed
    ? Math.round(1000 + (remainingBudget() / totalBudget) * 360 + (activeConfigs.has("observability") ? 90 : 0) + Math.max(0, testTimeLimit - testElapsed) * 7)
    : Math.max(0, Math.round(metrics.capacity * 0.45 + Math.max(0, 110 - metrics.latency) * 2));
  const grade = score >= 1400 ? "S" : score >= 1250 ? "A" : score >= 1080 ? "B" : "C";
  const isFinalPhase = currentPhaseIndex === campaignPhases.length - 1;
  const blockingAnalyticsFailure = !passed
    && currentPhase.workload === "analytics"
    && metrics.hasCore
    && metrics.counts.worker > 0
    && metrics.counts.queue === 0;
  if (passed) {
    const previousBest = Number(window.localStorage.getItem(`sysbench-best-${currentPhaseIndex}`) ?? 0);
    if (score > previousBest) window.localStorage.setItem(`sysbench-best-${currentPhaseIndex}`, String(score));
    unlockedPhaseIndex = Math.max(unlockedPhaseIndex, Math.min(campaignPhases.length - 1, currentPhaseIndex + 1));
    window.localStorage.setItem("sysbench-unlocked-phase", String(unlockedPhaseIndex));
    renderCampaignScreen();
  }
  resultCard.dataset.outcome = passed ? "passed" : "failed";
  resultKicker.textContent = passed ? `Phase ${currentPhaseIndex + 1} certified · Grade ${grade}` : `Phase ${currentPhaseIndex + 1} · Needs work`;
  resultTitle.textContent = passed ? (isFinalPhase ? "Staff simulation complete" : "Service survived production") : "Production drill failed";
  resultSummary.textContent = blockingAnalyticsFailure
    ? `Redirect throughput is healthy, but p95 missed its target by ${Math.max(0, metrics.latency - latencySlo)} ms because click tracking sits inside every user request.`
    : passed
    ? `${currentPhase.service} sustained ${targetRps.toLocaleString("en-US")} requests per second, recovered from ${currentPhase.incident.title.toLowerCase()}, and returned inside its SLO.`
    : `The design could not recover and hold all production targets before the ${testTimeLimit}-second incident window closed.`;
  resultScoreLabel.textContent = blockingAnalyticsFailure ? "Observed p95" : "Score";
  resultScore.textContent = blockingAnalyticsFailure ? `${metrics.latency} ms` : score.toLocaleString("en-US");
  resultBudgetLabel.textContent = blockingAnalyticsFailure ? "Target p95" : "Budget left";
  resultBudget.textContent = blockingAnalyticsFailure ? `≤ ${latencySlo} ms` : `$${remainingBudget().toLocaleString("en-US")}`;
  resultStabilityLabel.textContent = blockingAnalyticsFailure ? "Budget left" : "Stable for";
  resultStability.textContent = blockingAnalyticsFailure ? `$${remainingBudget().toLocaleString("en-US")}` : `${stableElapsed.toFixed(1)}s`;
  resultDiagnosis.textContent = metrics.diagnosis;
  populateOperationalReview(metrics, passed);
  const drillSnapshot = createDrillSnapshot(metrics, passed);
  populateDrillComparison(readPreviousDrillSnapshot(), drillSnapshot);
  saveDrillSnapshot(drillSnapshot);
  resultAnalysis.hidden = !blockingAnalyticsFailure;
  resultHint.hidden = !blockingAnalyticsFailure;
  if (blockingAnalyticsFailure) {
    const latencyGap = Math.max(0, metrics.latency - latencySlo);
    resultLatencyGap.textContent = `${latencyGap} ms over target`;
    resultLatencySloMarker.style.left = `${Math.min(92, (latencySlo / Math.max(1, metrics.latency)) * 100)}%`;
  }
  renderResultHint(0);
  retryButton.textContent = passed ? (isFinalPhase ? "Review campaign" : "Escalate to next phase") : "Retry production drill";
  dismissResultButton.textContent = passed ? "Review this topology" : "Return to build mode";
  resultOverlay.dataset.visible = "true";
  resultOverlay.setAttribute("aria-hidden", "false");
  missionPhaseElement.textContent = passed ? "Certified" : "Test failed";
  showToast(passed ? `Phase ${currentPhaseIndex + 1} certified. ${isFinalPhase ? "Campaign complete." : "The next scale tier is unlocked."}` : "Production drill failed. Follow the incident diagnosis and retry.");
}

function startTest() {
  hideResult();
  resetIncident();
  const topology = calculateMetrics(targetRps);
  if ((!isSandboxMode && !topology.hasCore) || (isSandboxMode && nodes.length === 0)) {
    testPhase = "idle";
    updateTelemetry();
    showToast(isSandboxMode
      ? "Place at least one machine before starting a lab workload. Broken and incomplete graphs are allowed after that."
      : `${topology.diagnosis} Install the highlighted machine before generating traffic.`);
    return;
  }
  isRunning = true;
  testPhase = "ramping";
  testElapsed = 0;
  stableElapsed = 0;
  currentDemand = Math.max(100, Math.round(targetRps * 0.2));
  packetAccumulator = 0;
  packetSequence = 0;
  nextTrafficRoute = 0;
  clearGroup(packetsGroup);
  packets.length = 0;
  testTimeElement.dataset.state = "live";
  syncTestControls();
  missionPhaseElement.textContent = "Traffic ramp";
  showToast(isSandboxMode
    ? `Free Lab workload online. Demand is ramping to ${targetRps.toLocaleString("en-US")} requests per second and will run until you stop it.`
    : `Traffic generator online. Demand is ramping to ${targetRps.toLocaleString("en-US")} requests per second.`);
}

function stopTest(silent = false) {
  isRunning = false;
  testPhase = "idle";
  testElapsed = 0;
  stableElapsed = 0;
  currentDemand = 0;
  resetIncident();
  syncTestControls();
  if (!silent) showToast(isSandboxMode
    ? "Lab workload stopped. Injected failures stay in place so you can save, share, or keep editing the scenario."
    : "Traffic test aborted. Topology returned to build mode.");
}

function sandboxTraceDemand(operatingSeconds: number) {
  return workloadDemandAt(sandboxTrafficPattern, targetRps, sandboxTraceSeed, operatingSeconds);
}

function updateTest(delta: number) {
  if (!isRunning) return;
  if (isSandboxMode) {
    testElapsed += delta;
    const rampProgress = THREE.MathUtils.clamp(testElapsed / rampDuration, 0, 1);
    const tracedDemand = sandboxTraceDemand(Math.max(0, testElapsed - rampDuration));
    currentDemand = rampProgress < 1
      ? Math.round(THREE.MathUtils.lerp(Math.max(100, targetRps * 0.2), tracedDemand, rampProgress))
      : tracedDemand;
    const metrics = calculateMetrics(currentDemand);
    const contractHealthy = !("contractSatisfied" in metrics) || metrics.contractSatisfied;
    const healthy = rampProgress >= 1
      && metrics.capacity >= targetRps
      && metrics.latency <= latencySlo
      && metrics.errors < errorSlo
      && contractHealthy;
    testPhase = rampProgress < 1 ? "ramping" : "holding";
    stableElapsed = healthy ? stableElapsed + delta : 0;
    const traceName = sandboxTrafficPatterns[sandboxTrafficPattern].name;
    missionPhaseElement.textContent = rampProgress < 1 ? "Lab ramp" : healthy ? `${traceName} trace · green` : `${traceName} trace · observing`;
    testPhaseElement.textContent = rampProgress < 1
      ? `Ramping · ${currentDemand.toLocaleString("en-US")} r/s`
      : `${traceName} trace · ${currentDemand.toLocaleString("en-US")} r/s${healthy ? " · all green" : " · inspect graph"}`;
    testTimeElement.textContent = rampProgress < 1 ? `${Math.ceil(rampDuration - testElapsed)}s` : `${Math.floor(testElapsed)}s live`;
    testProgressFill.style.scale = `${rampProgress < 1 ? rampProgress : THREE.MathUtils.clamp(currentDemand / targetRps, 0, 1)} 1`;
    return;
  }
  const waitingForTutorialResponse = currentPhaseIndex === 0 && incidentMode === "active";
  if (!waitingForTutorialResponse) testElapsed += delta;
  const rampProgress = THREE.MathUtils.clamp(testElapsed / rampDuration, 0, 1);
  if (!incidentTriggered && testElapsed >= currentPhase.incident.triggerAt) triggerIncident();
  updateIncident(delta);
  const incidentLoad = incidentTriggered && incidentMode !== "resolved" ? currentPhase.incident.loadMultiplier : 1;
  currentDemand = Math.round(THREE.MathUtils.lerp(Math.max(100, targetRps * 0.2), targetRps, rampProgress) * incidentLoad);
  const metrics = calculateMetrics(currentDemand);

  if (currentPhaseIndex === 0 && incidentMode === "active") {
    missionPhaseElement.textContent = "Response required";
    testPhaseElement.textContent = "Install another API Server";
    testTimeElement.textContent = "PAUSED";
    return;
  }

  if (rampProgress < 1) {
    testPhase = "ramping";
    missionPhaseElement.textContent = "Traffic ramp";
    testPhaseElement.textContent = `Ramping · ${currentDemand} r/s`;
    testTimeElement.textContent = `${Math.ceil(rampDuration - testElapsed)}s`;
    testProgressFill.style.scale = `${rampProgress} 1`;
    return;
  }

  testPhase = "holding";
  const contractHealthy = !("contractSatisfied" in metrics) || metrics.contractSatisfied;
  const healthy = incidentMode === "resolved"
    && metrics.capacity >= targetRps
    && metrics.latency <= latencySlo
    && metrics.errors < errorSlo
    && contractHealthy;
  stableElapsed = healthy
    ? Math.min(certificationDuration, stableElapsed + delta)
    : Math.max(0, stableElapsed - delta * 1.5);
  const holdProgress = stableElapsed / certificationDuration;
  missionPhaseElement.textContent = healthy ? "Certifying" : incidentMode === "active" ? "Incident active" : incidentMode === "recovering" ? "Recovering" : "Under load";
  testPhaseElement.textContent = healthy ? "Holding production SLO" : incidentMode === "active" ? currentPhase.incident.code : incidentMode === "recovering" ? "Mitigation in progress" : "Awaiting failure drill";
  testTimeElement.textContent = `${stableElapsed.toFixed(1)} / ${certificationDuration}s`;
  testProgressFill.style.scale = `${holdProgress} 1`;

  if (stableElapsed >= certificationDuration) {
    finishTest(true);
  } else if (testElapsed >= testTimeLimit) {
    finishTest(false);
  }
}

function spawnPacket() {
  if (trafficRoutes.length === 0 || packets.length >= 30) return;
  const route = trafficRoutes[nextTrafficRoute % trafficRoutes.length];
  nextTrafficRoute += 1;
  spawnPacketOnRoute(route);
}

function spawnPacketOnRoute(route: Connection[]) {
  if (route.length === 0 || packets.length >= 30) return;
  const asyncTraffic = route.some((connection) => connection.mode === "enqueue"
    || connection.mode === "consume"
    || connection.mode === "commit");
  const packetColor = asyncTraffic ? 0xa9b9ff : 0x9ff4e8;
  const packetMaterial = material(asyncTraffic ? 0x6578b9 : 0x3b91a0, {
    emissive: asyncTraffic ? 0x43538f : 0x236d78,
    emissiveIntensity: 1.8,
    roughness: 0.34,
    metalness: 0.26,
  });
  const mesh = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.07, 0.34), packetMaterial);
  frame.castShadow = true;
  mesh.add(frame);

  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.095, 0.17, 4),
    new THREE.MeshBasicMaterial({ color: packetColor, transparent: true, opacity: 0.86 }),
  );
  nose.position.z = 0.265;
  nose.rotation.x = Math.PI / 2;
  nose.rotation.y = Math.PI / 4;
  mesh.add(nose);

  const signal = new THREE.Mesh(
    new THREE.BoxGeometry(0.035, 0.068, 0.15),
    new THREE.MeshBasicMaterial({ color: packetColor, transparent: true, opacity: 0.8 }),
  );
  signal.position.y = 0.008;
  signal.userData.isPacketSignal = true;
  mesh.add(signal);

  for (let index = 0; index < 3; index += 1) {
    const trailSegment = new THREE.Mesh(
      new THREE.BoxGeometry(0.06 - index * 0.009, 0.018, 0.075),
      new THREE.MeshBasicMaterial({
        color: packetColor,
        transparent: true,
        opacity: 0.24 - index * 0.06,
        depthWrite: false,
      }),
    );
    trailSegment.position.z = -0.19 - index * 0.095;
    mesh.add(trailSegment);
  }
  packetsGroup.add(mesh);
  route[0].activity = 1;
  const packetIndex = packetSequence++;
  const visualSeed = isSandboxMode ? sandboxTraceSeed : currentPhaseIndex + 1;
  packets.push({
    mesh,
    route,
    segmentIndex: 0,
    progress: 0,
    speed: 0.82 + workloadSeedUnit(visualSeed, packetIndex * 2) * 0.22,
    phase: workloadSeedUnit(visualSeed, packetIndex * 2 + 1) * Math.PI * 2,
  });
}

function updatePackets(delta: number) {
  if (isRunning) {
    packetAccumulator += delta;
    const load = THREE.MathUtils.clamp(currentDemand / targetRps, 0, 1);
    const interval = trafficRoutes.length > 0 ? THREE.MathUtils.lerp(0.38, 0.14, load) : 0.5;
    while (packetAccumulator > interval) {
      packetAccumulator -= interval;
      spawnPacket();
    }
  }

  for (const connection of connections) {
    connection.activity = Math.max(0, connection.activity - delta * 2.8);
    const inspectionHighlight = activeInspectionConnections.has(connection) ? 0.78 : 0;
    connection.material.emissiveIntensity = 0.16 + connection.activity * 1.15 + inspectionHighlight + (connection === hoveredConnection ? 0.8 : 0);
    connection.annotation?.setAttribute("data-pulse", String(connection.activity > 0.18 || inspectionHighlight > 0));
  }

  for (let index = packets.length - 1; index >= 0; index -= 1) {
    const packet = packets[index];
    const connection = packet.route[packet.segmentIndex];
    connection.activity = 1;
    packet.progress += delta * packet.speed;
    if (packet.progress >= 1) {
      packet.segmentIndex += 1;
      packet.progress -= 1;
      if (packet.segmentIndex >= packet.route.length) {
        packetsGroup.remove(packet.mesh);
        packet.mesh.traverse((object) => {
          if (!(object instanceof THREE.Mesh)) return;
          object.geometry.dispose();
          const objectMaterial = object.material;
          if (Array.isArray(objectMaterial)) objectMaterial.forEach((item) => item.dispose());
          else objectMaterial.dispose();
        });
        packets.splice(index, 1);
        continue;
      }
      packet.route[packet.segmentIndex].activity = 1;
    }
    const activeConnection = packet.route[packet.segmentIndex];
    const position = activeConnection.curve.getPointAt(packet.progress);
    const lookAhead = activeConnection.curve.getPointAt(Math.min(0.999, packet.progress + 0.025));
    packet.mesh.position.copy(position);
    packet.mesh.position.y += 0.05;
    packet.mesh.lookAt(lookAhead.x, lookAhead.y + 0.05, lookAhead.z);
    const pulse = prefersReducedMotion ? 1 : 1 + Math.sin(elapsed * 8 + packet.phase) * 0.025;
    packet.mesh.scale.setScalar(pulse);
    const signal = packet.mesh.children.find((child) => child.userData.isPacketSignal) as THREE.Mesh | undefined;
    if (signal) {
      const signalMaterial = signal.material as THREE.MeshBasicMaterial;
      signalMaterial.opacity = prefersReducedMotion ? 0.62 : 0.48 + Math.sin(elapsed * 8 + packet.phase) * 0.14;
    }
  }
}

function showToast(message: string) {
  window.clearTimeout(toastTimeout);
  toastElement.textContent = message;
  toastElement.dataset.visible = "true";
  toastTimeout = window.setTimeout(() => {
    toastElement.dataset.visible = "false";
  }, 2600);
}

brandMark.addEventListener("click", () => {
  if (brandPreviewData.size !== componentOrder.length) return;
  brandItemIndex = (brandItemIndex + 1) % componentOrder.length;
  const kind = componentOrder[brandItemIndex];
  setBrandItem(kind);
  showToast(`Workshop emblem ${brandItemIndex + 1}/${componentOrder.length} · ${componentDefinitions[kind].label} discovered.`);
});

phaseList.addEventListener("click", (event) => {
  const option = (event.target as HTMLElement).closest<HTMLButtonElement>(".phase-option");
  if (!option || option.disabled) return;
  selectedCampaignPhase = Number(option.dataset.phase);
  renderCampaignScreen();
});

startPhaseButton.addEventListener("click", () => beginCampaignPhase(selectedCampaignPhase));
openSandboxButton.addEventListener("click", openSandboxSetup);
closeSandboxButton.addEventListener("click", () => {
  closeSandboxSetup();
  openSandboxButton.focus();
});
sandboxOverlay.addEventListener("click", (event) => {
  if (event.target === sandboxOverlay) {
    closeSandboxSetup();
    openSandboxButton.focus();
  }
});
sandboxWorkloads.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-workload]");
  if (!button) return;
  const workload = button.dataset.workload as WorkloadKind;
  if (!Object.prototype.hasOwnProperty.call(sandboxPresets, workload)) return;
  sandboxWorkload = workload;
  sandboxContract = defaultSandboxContract(workload);
  updateSandboxSetupUi();
});
sandboxDemandInput.addEventListener("input", () => {
  sandboxTargetRps = Number(sandboxDemandInput.value);
  updateSandboxSetupUi();
});
sandboxPatterns.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-pattern]");
  if (!button) return;
  const pattern = button.dataset.pattern as SandboxTrafficPattern;
  if (!Object.prototype.hasOwnProperty.call(sandboxTrafficPatterns, pattern)) return;
  sandboxTrafficPattern = pattern;
  updateSandboxSetupUi();
});
sandboxSeedInput.addEventListener("change", () => {
  sandboxTraceSeed = normalizeSandboxTraceSeed(Number(sandboxSeedInput.value));
  updateSandboxSetupUi();
});
[sandboxLatencyContract, sandboxErrorContract, sandboxDeliveryContractValue, sandboxLagContractValue]
  .forEach((input) => input.addEventListener("change", commitSandboxContractInputs));
resetSandboxContractButton.addEventListener("click", () => {
  sandboxContract = defaultSandboxContract(sandboxWorkload);
  updateSandboxSetupUi();
  showToast(`${sandboxPresets[sandboxWorkload].name} contract restored to its production preset.`);
});
enterSandboxButton.addEventListener("click", () => {
  commitSandboxContractInputs();
  sandboxTraceSeed = normalizeSandboxTraceSeed(Number(sandboxSeedInput.value));
  beginSandboxSession(sandboxWorkload, sandboxTargetRps, sandboxContract, sandboxTrafficPattern, sandboxTraceSeed);
});
dismissBriefingButton.addEventListener("click", dismissPhaseBriefing);
missionsButton.addEventListener("click", openCampaignScreen);
configsButton.addEventListener("click", openConfigScreen);
inventoryFooterButton.addEventListener("click", openCampaignScreen);
missionPhaseElement.addEventListener("click", openConfigScreen);
closeConfigButton.addEventListener("click", () => closeConfigScreen(false));
applyConfigButton.addEventListener("click", () => closeConfigScreen(true));
configList.addEventListener("click", (event) => {
  const option = (event.target as HTMLElement).closest<HTMLButtonElement>(".config-option");
  if (!option || option.disabled) return;
  const id = option.dataset.config as ConfigId;
  if (pendingConfigs.has(id)) pendingConfigs.delete(id);
  else pendingConfigs.add(id);
  renderConfigPanel();
});
configOverlay.addEventListener("click", (event) => {
  if (event.target === configOverlay) closeConfigScreen(false);
});
partsList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".part-card");
  if (!button || button.disabled) return;
  const kind = button.dataset.kind as ComponentKind;
  setActiveKind(activeKind === kind ? null : kind);
  showToast(activeKind ? `Place ${componentDefinitions[kind].label} on an open floor tile.` : "Placement cancelled.");
});

partsList.addEventListener("dragstart", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>(".part-card");
  if (!button || button.disabled) return;
  draggedPaletteKind = button.dataset.kind as ComponentKind;
  event.dataTransfer?.setData("text/plain", draggedPaletteKind);
  if (event.dataTransfer) event.dataTransfer.effectAllowed = "copy";
  setActiveKind(draggedPaletteKind);
});

partsList.addEventListener("dragend", () => {
  draggedPaletteKind = null;
  setActiveKind(null);
});

canvas.addEventListener("dragover", (event) => {
  event.preventDefault();
  if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
  const kind = draggedPaletteKind ?? activeKind;
  if (kind) updateGhost(kind, getGridAtPointer(event));
});

canvas.addEventListener("dragleave", (event) => {
  const rect = canvas.getBoundingClientRect();
  if (event.clientX <= rect.left || event.clientX >= rect.right || event.clientY <= rect.top || event.clientY >= rect.bottom) {
    removeGhost();
  }
});

canvas.addEventListener("drop", (event) => {
  event.preventDefault();
  const kind = (draggedPaletteKind ?? event.dataTransfer?.getData("text/plain")) as ComponentKind | null;
  const grid = getGridAtPointer(event);
  if (kind && grid) placeComponent(kind, grid);
  draggedPaletteKind = null;
  setActiveKind(null);
});

canvas.addEventListener("pointerdown", (event) => {
  if (event.button === 1 || event.button === 2) {
    event.preventDefault();
    isOrbiting = true;
    orbitPointerId = event.pointerId;
    orbitLastX = event.clientX;
    canvas.dataset.mode = "rotating";
    canvas.setPointerCapture(event.pointerId);
    return;
  }
  if (event.button !== 0) return;
  pointerDownPosition = { x: event.clientX, y: event.clientY };
  nodeHasMoved = false;

  if (wiringEditing) {
    const clickedConnection = getConnectionAtPointer(event);
    if (clickedConnection) {
      removeAuthoredConnection(clickedConnection);
      wiringSource = null;
      selectNode(null);
      syncWiringUi();
      return;
    }
    const clickedNode = getNodeAtPointer(event);
    if (clickedNode) {
      if (!wiringSource) {
        wiringSource = clickedNode;
        selectNode(clickedNode);
        showToast(`${contextualComponentLabel(clickedNode.kind)} selected as the source. Choose a destination.`);
      } else if (wiringSource === clickedNode) {
        wiringSource = null;
        selectNode(null);
        showToast("Cable source cancelled.");
      } else if (addAuthoredConnection(wiringSource, clickedNode)) {
        wiringSource = null;
        selectNode(null);
      }
      syncWiringUi();
      return;
    }
    wiringSource = null;
    selectNode(null);
    syncWiringUi();
    return;
  }

  if (activeKind) {
    const grid = getGridAtPointer(event);
    if (grid && placeComponent(activeKind, grid)) setActiveKind(null);
    return;
  }

  draggedNode = getNodeAtPointer(event);
  if (draggedNode) {
    selectNode(draggedNode);
    canvas.dataset.mode = "moving";
    canvas.setPointerCapture(event.pointerId);
  } else {
    selectNode(null);
    isOrbiting = true;
    orbitPointerId = event.pointerId;
    orbitLastX = event.clientX;
    canvas.dataset.mode = "rotating";
    canvas.setPointerCapture(event.pointerId);
  }
});

canvas.addEventListener("pointermove", (event) => {
  if (isOrbiting && event.pointerId === orbitPointerId) {
    const deltaX = event.clientX - orbitLastX;
    orbitLastX = event.clientX;
    targetCameraAzimuth -= deltaX * 0.009;
    return;
  }
  if (activeKind) {
    hoveredNode = null;
    updateGhost(activeKind, getGridAtPointer(event));
    return;
  }
  if (wiringEditing) {
    hoveredNode = getNodeAtPointer(event);
    hoveredConnection = hoveredNode ? null : getConnectionAtPointer(event);
    canvas.dataset.mode = hoveredNode ? "wiring-node" : hoveredConnection ? "wiring-remove" : "wiring";
    return;
  }
  if (!draggedNode) {
    hoveredNode = getNodeAtPointer(event);
    canvas.dataset.mode = hoveredNode ? "inspect" : "idle";
    return;
  }
  const distance = Math.hypot(event.clientX - pointerDownPosition.x, event.clientY - pointerDownPosition.y);
  if (distance < 4) return;
  const grid = getGridAtPointer(event);
  if (grid && !isOccupied(grid, draggedNode)) {
    moveNode(draggedNode, grid);
    nodeHasMoved = true;
  }
});

canvas.addEventListener("pointerup", (event) => {
  if (isOrbiting && event.pointerId === orbitPointerId) {
    isOrbiting = false;
    orbitPointerId = -1;
    canvas.dataset.mode = wiringEditing ? "wiring" : activeKind ? "placing" : "idle";
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    return;
  }
  if (wiringEditing) {
    canvas.dataset.mode = "wiring";
    return;
  }
  if (draggedNode && nodeHasMoved) showToast(`${componentDefinitions[draggedNode.kind].label} moved. Data cables rerouted.`);
  draggedNode = null;
  hoveredNode = getNodeAtPointer(event);
  canvas.dataset.mode = activeKind ? "placing" : "idle";
  if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
});

canvas.addEventListener("pointercancel", () => {
  isOrbiting = false;
  orbitPointerId = -1;
  draggedNode = null;
  hoveredNode = null;
  canvas.dataset.mode = wiringEditing ? "wiring" : activeKind ? "placing" : "idle";
});

canvas.addEventListener("pointerleave", () => {
  if (!draggedNode && !isOrbiting) {
    hoveredNode = null;
    hoveredConnection = null;
  }
});

canvas.addEventListener("contextmenu", (event) => event.preventDefault());

canvas.addEventListener("wheel", (event) => {
  event.preventDefault();
  camera.zoom = THREE.MathUtils.clamp(camera.zoom * (event.deltaY > 0 ? 0.9 : 1.1), 0.75, 1.5);
  camera.updateProjectionMatrix();
}, { passive: false });

window.addEventListener("keydown", (event) => {
  if (sandboxOverlay.dataset.visible === "true") {
    if (event.key === "Tab") {
      const focusable = [...sandboxOverlay.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled])")]
        .filter((element) => element.offsetParent !== null);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !sandboxOverlay.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !sandboxOverlay.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    } else if (event.key === "Escape") {
      event.preventDefault();
      closeSandboxSetup();
      openSandboxButton.focus();
    }
    return;
  }
  if (phaseBriefingOverlay.dataset.visible === "true") {
    if (event.key === "Tab") {
      event.preventDefault();
      dismissBriefingButton.focus();
    } else if (event.key === "Enter" || event.key === "Escape") {
      event.preventDefault();
      dismissPhaseBriefing();
    }
    return;
  }
  if (startOverlay.dataset.visible === "true") {
    if (event.key === "Enter") startPhaseButton.click();
    return;
  }
  if (configOverlay.dataset.visible === "true") {
    if (event.key === "Escape") closeConfigScreen(false);
    return;
  }
  const shortcutIndex = Number(event.key) - 1;
  if (shortcutIndex >= 0 && shortcutIndex < componentOrder.length && resultOverlay.dataset.visible !== "true") {
    event.preventDefault();
    const kind = componentOrder[shortcutIndex];
    const button = document.querySelector<HTMLButtonElement>(`.part-card[data-kind="${kind}"]`);
    if (button?.disabled) {
      showToast(`${componentDefinitions[kind].label} exceeds the remaining laboratory budget.`);
    } else {
      setActiveKind(activeKind === kind ? null : kind);
      showToast(activeKind ? `${event.key} · Place ${componentDefinitions[kind].label} on an open floor tile.` : "Placement cancelled.");
    }
    return;
  }
  if (event.key === "Escape") {
    if (resultOverlay.dataset.visible === "true") {
      hideResult();
      testPhase = "idle";
      updateTelemetry();
      return;
    }
    if (traceReadout.dataset.visible === "true") {
      event.preventDefault();
      closeRequestTrace();
      return;
    }
    if (wiringEditing) {
      event.preventDefault();
      if (wiringSource) {
        wiringSource = null;
        selectNode(null);
        syncWiringUi();
        showToast("Cable source cancelled.");
      } else {
        setWiringEditing(false);
      }
      return;
    }
    setActiveKind(null);
    selectNode(null);
  }
  if ((event.key === "Delete" || event.key === "Backspace") && selectedNode) {
    event.preventDefault();
    removeNode(selectedNode);
  }
  if (event.key.toLowerCase() === "q") {
    event.preventDefault();
    rotateView(-1);
  }
  if (event.key.toLowerCase() === "e") {
    event.preventDefault();
    rotateView(1);
  }
  if (event.key.toLowerCase() === "w" && resultOverlay.dataset.visible !== "true") {
    event.preventDefault();
    setWiringEditing(topologyMode === "automatic" || !wiringEditing);
  }
  if (event.key.toLowerCase() === "r" && resultOverlay.dataset.visible !== "true") {
    event.preventDefault();
    openOrCycleRequestTrace();
  }
  if (event.key.toLowerCase() === "t" && resultOverlay.dataset.visible !== "true") {
    event.preventDefault();
    if (isRunning) stopTest();
    else startTest();
  }
});

scrapButton.addEventListener("click", () => {
  if (selectedNode) removeNode(selectedNode);
});
chaosButton.addEventListener("click", toggleSandboxNodeFailure);

rotateLeftButton.addEventListener("click", () => rotateView(-1));
rotateRightButton.addEventListener("click", () => rotateView(1));
wiringButton.addEventListener("click", () => setWiringEditing(topologyMode === "automatic" || !wiringEditing));
restoreAutoButton.addEventListener("click", restoreAutomaticTopology);
traceButton.addEventListener("click", openOrCycleRequestTrace);
traceCloseButton.addEventListener("click", () => closeRequestTrace());
saveBlueprintButton.addEventListener("click", saveBlueprint);
loadBlueprintButton.addEventListener("click", restoreBlueprint);
shareBlueprintButton.addEventListener("click", () => void shareBlueprint());
telemetryExportButton.addEventListener("click", () => void shareBlueprint());

runButton.addEventListener("click", () => {
  if (isRunning) stopTest();
  else startTest();
});

retryButton.addEventListener("click", () => {
  if (testPhase !== "passed") {
    startTest();
    return;
  }
  if (currentPhaseIndex >= campaignPhases.length - 1) {
    hideResult();
    openCampaignScreen();
    return;
  }
  beginCampaignPhase(currentPhaseIndex + 1);
});
resultHintButton.addEventListener("click", () => renderResultHint(resultHintLevel + 1));
dismissResultButton.addEventListener("click", () => {
  hideResult();
  testPhase = "idle";
  resetIncident();
  updateTelemetry();
});

function positionComponentVisual(visual: HTMLImageElement, worldPosition: THREE.Vector3) {
  const rect = canvas.getBoundingClientRect();
  const projected = worldPosition.clone().project(camera);
  const x = (projected.x * 0.5 + 0.5) * rect.width;
  const y = (-projected.y * 0.5 + 0.5) * rect.height;
  const depthScale = THREE.MathUtils.clamp(0.8 + (y / Math.max(1, rect.height)) * 0.28, 0.84, 1.08);
  visual.style.left = `${x}px`;
  visual.style.top = `${y}px`;
  visual.style.zIndex = String(Math.round(y));
  visual.style.setProperty("--component-depth", depthScale.toFixed(3));
  visual.style.opacity = projected.z < 1 ? "1" : "0";
}

function updateLabels() {
  const rect = canvas.getBoundingClientRect();
  const occupiedLabels: Array<{ left: number; right: number; top: number; bottom: number }> = [];
  const overlapsLabel = (candidate: { left: number; right: number; top: number; bottom: number }) => occupiedLabels.some(
    (occupied) => candidate.left < occupied.right
      && candidate.right > occupied.left
      && candidate.top < occupied.bottom
      && candidate.bottom > occupied.top,
  );
  for (const node of nodes) {
    positionComponentVisual(node.visual, node.group.position);
    const projected = node.group.position.clone();
    projected.y += 1.95;
    projected.project(camera);
    const x = (projected.x * 0.5 + 0.5) * rect.width;
    const y = (-projected.y * 0.5 + 0.5) * rect.height;
    node.label.style.left = `${x}px`;
    node.label.style.top = `${y}px`;
    const labelVisible = projected.z < 1;
    node.label.style.opacity = labelVisible ? "1" : "0";
    if (labelVisible) {
      const nameLength = contextualComponentLabel(node.kind).length;
      const roleLength = contextualComponentRole(node.kind).length;
      const width = Math.max(74, Math.min(150, Math.max(nameLength, roleLength) * 5.4 + 16));
      occupiedLabels.push({ left: x - width / 2 - 4, right: x + width / 2 + 4, top: y - 34, bottom: y + 4 });
    }
  }
  if (ghost && ghostVisual) positionComponentVisual(ghostVisual, ghost.position);
  for (const connection of connections) {
    if (!connection.annotation) continue;
    const projected = connection.curve.getPointAt(0.52);
    projected.y -= 0.1;
    projected.project(camera);
    const x = (projected.x * 0.5 + 0.5) * rect.width;
    const y = (-projected.y * 0.5 + 0.5) * rect.height;
    const instructionalRoute = currentPhaseIndex === 1
      && (connection.label?.includes("BLOCKING") || connection.label?.includes("NON-BLOCKING"));
    const annotationVisible = (isRunning || instructionalRoute) && projected.z < 1;
    connection.annotation.dataset.visible = String(annotationVisible);
    let annotationX = x;
    let annotationY = y;
    if (annotationVisible) {
      const width = Math.max(54, Math.min(180, (connection.label?.length ?? 8) * 4.7 + 24));
      const height = 20;
      const offsets: ReadonlyArray<readonly [number, number]> = [
        [0, 0], [0, 20], [0, -20], [30, 12], [-30, 12], [32, -12], [-32, -12],
        [0, 40], [0, -40], [58, 0], [-58, 0], [54, 24], [-54, 24], [54, -24], [-54, -24],
      ];
      let bestCandidate: { left: number; right: number; top: number; bottom: number } | null = null;
      let bestPenalty = Number.POSITIVE_INFINITY;
      for (const [offsetX, offsetY] of offsets) {
        const candidate = {
          left: x + offsetX - width / 2 - 3,
          right: x + offsetX + width / 2 + 3,
          top: y + offsetY - height / 2 - 3,
          bottom: y + offsetY + height / 2 + 3,
        };
        if (candidate.left < 6 || candidate.right > rect.width - 6 || candidate.top < 6 || candidate.bottom > rect.height - 6) continue;
        const overlapPenalty = occupiedLabels.reduce((total, occupied) => {
          const overlapWidth = Math.max(0, Math.min(candidate.right, occupied.right) - Math.max(candidate.left, occupied.left));
          const overlapHeight = Math.max(0, Math.min(candidate.bottom, occupied.bottom) - Math.max(candidate.top, occupied.top));
          return total + overlapWidth * overlapHeight;
        }, 0);
        if (overlapPenalty >= bestPenalty) continue;
        bestPenalty = overlapPenalty;
        bestCandidate = candidate;
        annotationX = x + offsetX;
        annotationY = y + offsetY;
        if (!overlapsLabel(candidate)) break;
      }
      if (bestCandidate) occupiedLabels.push(bestCandidate);
    }
    connection.annotation.style.left = `${annotationX}px`;
    connection.annotation.style.top = `${annotationY}px`;
  }
}

function resize() {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  renderer.setSize(width, height, false);
  composer.setSize(width, height);
  const aspect = width / height;
  const viewHeight = 12.8;
  camera.left = -(viewHeight * aspect) / 2;
  camera.right = (viewHeight * aspect) / 2;
  camera.top = viewHeight / 2;
  camera.bottom = -viewHeight / 2;
  camera.updateProjectionMatrix();
}

function updateBoardActivity() {
  const load = isRunning ? THREE.MathUtils.clamp(currentDemand / Math.max(1, targetRps), 0.15, 1.5) : 0;
  for (const [index, signalMaterial] of boardActivityMaterials.entries()) {
    const wave = prefersReducedMotion ? 0.5 : 0.5 + 0.5 * Math.sin(elapsed * (isRunning ? 5.2 : 1.15) - index * 1.45);
    signalMaterial.emissiveIntensity = isRunning ? 0.28 + wave * 0.68 * load : 0.1 + wave * 0.08;
  }
}

function updateWorkshopAnimations() {
  const motionTime = prefersReducedMotion ? 0 : elapsed;
  for (const [index, light] of workshopPulseLights.entries()) {
    const baseIntensity = light.userData.baseIntensity as number ?? light.intensity;
    const phase = light.userData.phase as number ?? index * 1.7;
    const pulse = prefersReducedMotion ? 1 : 0.94 + Math.sin(motionTime * 1.8 + phase) * 0.06;
    light.intensity = baseIntensity * pulse;
  }
  for (const [index, pulseMaterial] of workshopPulseMaterials.entries()) {
    const baseIntensity = pulseMaterial.userData.baseEmissiveIntensity as number ?? pulseMaterial.emissiveIntensity;
    const pulse = prefersReducedMotion ? 1 : 0.92 + Math.sin(motionTime * 2.1 + index * 2.4) * 0.08;
    pulseMaterial.emissiveIntensity = baseIntensity * pulse;
  }
  for (const [index, portalGlow] of workshopPortalGlows.entries()) {
    portalGlow.opacity = prefersReducedMotion ? 0.34 : 0.28 + (0.5 + 0.5 * Math.sin(motionTime * 2.4 + index)) * 0.14;
  }
  for (const [index, prop] of workshopAnimatedProps.entries()) {
    const baseY = prop.userData.baseY as number ?? prop.position.y;
    const phase = prop.userData.motionPhase as number ?? index;
    prop.position.y = baseY + (prefersReducedMotion ? 0 : Math.sin(motionTime * 1.4 + phase) * 0.015);
    prop.rotation.z = prefersReducedMotion ? 0 : Math.sin(motionTime * 0.72 + phase) * 0.012;
  }
}

function animate() {
  requestAnimationFrame(animate);
  const delta = Math.min(clock.getDelta(), 0.05);
  elapsed += delta;
  updateCameraOrbit(delta);
  updateTest(delta);
  updatePackets(delta);
  updateMachineAnimations(delta);
  updateBoardActivity();
  updateWorkshopAnimations();
  updateTelemetry();
  updateLabels();
  composer.render(delta);
}

window.addEventListener("resize", resize);
resize();
renderCampaignScreen();
updateMissionContent();
updateUi();
updateTelemetry();
animate();
requestAnimationFrame(renderPartPreviews);

function placeDemoMachinesUntil(kind: ComponentKind, requiredCount: number) {
  for (let row = 0; row < rows && nodes.filter((node) => node.kind === kind).length < requiredCount; row += 1) {
    for (let col = 0; col < columns && nodes.filter((node) => node.kind === kind).length < requiredCount; col += 1) {
      const grid = { col, row };
      if (!isOccupied(grid)) placeComponent(kind, grid, true);
    }
  }
}

function provisionCertifiedSpecializedDemo() {
  if (currentPhase.workload !== "matching"
    && currentPhase.workload !== "streaming"
    && currentPhase.workload !== "dispatch") return;
  activeConfigs.add("autoscaling");
  activeConfigs.add("walTuning");
  activeConfigs.add("circuitBreaker");
  const drainDemandForFreshness = (arrivalRps: number) => currentPhase.backgroundSlo
    ? arrivalRps * 0.82 / Math.max(0.05, currentPhase.backgroundSlo.maxLagSeconds - 0.18)
    : arrivalRps;

  if (currentPhase.workload === "streaming") {
    const metadataDemand = targetRps * 0.22;
    const playbackDemand = targetRps * 0.78;
    const mediaJobDemand = targetRps * 0.18;
    const mediaDrainDemand = drainDemandForFreshness(mediaJobDemand);
    placeDemoMachinesUntil("loadBalancer", Math.ceil(metadataDemand / infrastructureComponentCapacity.loadBalancer));
    placeDemoMachinesUntil("api", Math.ceil(metadataDemand / (infrastructureComponentCapacity.api * 1.35)));
    placeDemoMachinesUntil("redis", Math.ceil(metadataDemand / infrastructureComponentCapacity.redis));
    placeDemoMachinesUntil("postgres", Math.ceil(metadataDemand / (infrastructureComponentCapacity.postgres * 1.25 * 3.125)));
    placeDemoMachinesUntil("queue", Math.ceil(mediaDrainDemand / infrastructureComponentCapacity.queue));
    placeDemoMachinesUntil("worker", Math.ceil(mediaDrainDemand / infrastructureComponentCapacity.worker));
    placeDemoMachinesUntil("objectStorage", Math.ceil(playbackDemand / infrastructureComponentCapacity.objectStorage));
    placeDemoMachinesUntil("cdn", Math.ceil(playbackDemand / infrastructureComponentCapacity.cdn));
    return;
  }

  placeDemoMachinesUntil("loadBalancer", Math.ceil(targetRps / infrastructureComponentCapacity.loadBalancer));
  placeDemoMachinesUntil("api", Math.ceil(targetRps / (infrastructureComponentCapacity.api * 1.35)));
  placeDemoMachinesUntil("redis", Math.ceil(targetRps / infrastructureComponentCapacity.redis));
  placeDemoMachinesUntil("postgres", Math.ceil(targetRps / (infrastructureComponentCapacity.postgres * 1.25 * 3.125)));
  placeDemoMachinesUntil("geoIndex", Math.ceil(targetRps / infrastructureComponentCapacity.geoIndex));
  if (currentPhase.workload === "dispatch") {
    const eventDemand = targetRps * 0.42;
    const eventDrainDemand = drainDemandForFreshness(eventDemand);
    placeDemoMachinesUntil("queue", Math.ceil(eventDrainDemand / infrastructureComponentCapacity.queue));
    placeDemoMachinesUntil("worker", Math.ceil(eventDrainDemand / infrastructureComponentCapacity.worker));
  }
}

function provisionCertifiedSandboxDemo() {
  activeConfigs.add("autoscaling");
  activeConfigs.add("walTuning");
  activeConfigs.add("circuitBreaker");
  if (currentPhase.workload === "matching"
    || currentPhase.workload === "streaming"
    || currentPhase.workload === "dispatch") {
    provisionCertifiedSpecializedDemo();
    return;
  }
  const effectiveDemand = targetRps;
  placeDemoMachinesUntil("loadBalancer", Math.ceil(effectiveDemand / infrastructureComponentCapacity.loadBalancer));
  placeDemoMachinesUntil("api", Math.ceil(effectiveDemand / (infrastructureComponentCapacity.api * 1.35)));
  placeDemoMachinesUntil("redis", Math.ceil(effectiveDemand / infrastructureComponentCapacity.redis));
  placeDemoMachinesUntil("postgres", Math.ceil(effectiveDemand / (infrastructureComponentCapacity.postgres * 1.25 * 3.125)));
  if (currentPhase.workload === "analytics") {
    const eventDemand = targetRps * 0.32;
    const freshnessDemand = currentPhase.backgroundSlo
      ? eventDemand * 0.82 / Math.max(0.05, currentPhase.backgroundSlo.maxLagSeconds - 0.18)
      : eventDemand;
    placeDemoMachinesUntil("queue", Math.ceil(freshnessDemand / infrastructureComponentCapacity.queue));
    placeDemoMachinesUntil("worker", Math.ceil(freshnessDemand / infrastructureComponentCapacity.worker));
  }
}

const searchParams = new URLSearchParams(window.location.search);
const requestedLab = searchParams.get("lab");
const requestedLabRps = Number(searchParams.get("rps"));
const requestedLabWorkload = requestedLab !== null && Object.prototype.hasOwnProperty.call(sandboxPresets, requestedLab)
  ? requestedLab as WorkloadKind
  : null;
const requestedSandboxContract = requestedLabWorkload
  ? sandboxContractFromSearch(searchParams, requestedLabWorkload)
  : null;
const requestedPatternValue = searchParams.get("shape") ?? "steady";
const requestedTrafficPattern = Object.prototype.hasOwnProperty.call(sandboxTrafficPatterns, requestedPatternValue)
  ? requestedPatternValue as SandboxTrafficPattern
  : null;
const requestedTraceSeed = searchParams.has("seed") ? Number(searchParams.get("seed")) : 42;
const requestedSandbox = requestedLabWorkload !== null
  && requestedSandboxContract !== null
  && requestedTrafficPattern !== null
  && Number.isFinite(requestedLabRps)
  && requestedLabRps >= 500
  && requestedLabRps <= 10_000
  && Number.isInteger(requestedTraceSeed)
  && requestedTraceSeed >= 1
  && requestedTraceSeed <= 9_999;
if (requestedSandbox && requestedLabWorkload && requestedSandboxContract && requestedTrafficPattern) {
  beginSandboxSession(
    requestedLabWorkload,
    requestedLabRps,
    requestedSandboxContract,
    requestedTrafficPattern,
    requestedTraceSeed,
  );
}
const requestedPhase = Number(searchParams.get("phase"));
if (!requestedSandbox && Number.isInteger(requestedPhase) && requestedPhase >= 0 && requestedPhase < campaignPhases.length) {
  unlockedPhaseIndex = Math.max(unlockedPhaseIndex, requestedPhase);
  selectedCampaignPhase = requestedPhase;
  setPhaseParameters(requestedPhase);
  updateMissionContent();
  updateUi();
  updateTelemetry();
  renderCampaignScreen();
}
const requestedAngle = Number(searchParams.get("angle"));
if (Number.isFinite(requestedAngle) && searchParams.has("angle")) {
  cameraAzimuth = requestedAngle;
  targetCameraAzimuth = requestedAngle;
  updateCameraOrbit(1);
}
const demoMode = searchParams.get("demo");
if (demoMode !== null) {
  const releaseDemo = demoMode === "release" || demoMode === "release-certified";
  const diagnosisDemo = demoMode === "diagnosis" || demoMode === "diagnosis-solved";
  const firstReleaseCertificationDemo = demoMode === "certified" && currentPhase.index === 0;
  const leanReleaseLayout = releaseDemo || firstReleaseCertificationDemo;
  if (!searchParams.has("phase") && !requestedSandbox) {
    setPhaseParameters(releaseDemo ? 0 : 1);
    updateMissionContent();
    updateUi();
    updateTelemetry();
  }
  closeCampaignScreen();
  if ((demoMode === "sandbox-certified" || demoMode === "sandbox-failure") && requestedSandbox) {
    provisionCertifiedSandboxDemo();
    updateUi();
    updateTelemetry();
    runButton.click();
    for (let second = 0; second < 12; second += 1) updateTest(1);
    if (demoMode === "sandbox-failure") {
      const failureKind: ComponentKind = currentPhase.workload === "streaming"
        ? "cdn"
        : currentPhase.workload === "matching" || currentPhase.workload === "dispatch"
          ? "geoIndex"
          : currentPhase.workload === "analytics"
            ? "queue"
            : "postgres";
      const target = nodes.find((node) => node.kind === failureKind);
      if (target) {
        selectNode(target);
        toggleSandboxNodeFailure();
      }
    }
    updateTelemetry();
  } else if (demoMode === "analytics-inherited" || demoMode === "analytics-queue" || demoMode === "analytics-scale" || demoMode === "analytics-backlog" || demoMode === "analytics-manual" || demoMode === "analytics-manual-cut" || demoMode === "analytics-failed") {
    loadInheritedScenario(1);
    if (demoMode === "analytics-queue" || demoMode === "analytics-backlog") placeComponent("queue", { col: 5, row: 4 });
    if (demoMode === "analytics-backlog") {
      const inheritedWorker = nodes.find((node) => node.kind === "worker");
      if (inheritedWorker) removeNode(inheritedWorker);
    }
    if (demoMode === "analytics-scale") placeComponent("worker", { col: 7, row: 5 });
    if (demoMode === "analytics-manual" || demoMode === "analytics-manual-cut") {
      setWiringEditing(true);
      if (demoMode === "analytics-manual-cut") {
        const blockingEdge = connections.find((connection) => connection.from.kind === "api" && connection.to.kind === "worker" && connection.mode === "request");
        if (blockingEdge) removeAuthoredConnection(blockingEdge);
      }
    }
    updateUi();
    updateTelemetry();
    if (demoMode === "analytics-failed") finishTest(false);
  } else if (demoMode === "briefing") {
    showPhaseBriefing();
  } else if (demoMode !== "empty") {
    placeComponent("loadBalancer", { col: 1, row: 3 });
    if (demoMode !== "failed" && !leanReleaseLayout) placeComponent("loadBalancer", { col: 1, row: 5 });
    if (demoMode !== "failed") placeComponent("api", { col: 3, row: 2 });
    placeComponent("api", { col: 3, row: 3 });
    if (demoMode !== "failed" && !leanReleaseLayout) placeComponent("api", { col: 3, row: 4 });
    if (demoMode !== "failed" && !leanReleaseLayout) placeComponent("api", { col: 3, row: 5 });
    if (!leanReleaseLayout && (!diagnosisDemo || demoMode === "diagnosis-solved")) placeComponent("redis", { col: 5, row: 2 });
    placeComponent("postgres", { col: 7, row: 3 });
    if (diagnosisDemo) placeComponent("postgres", { col: 7, row: 5 });
    const coreCertificationDemo = demoMode === "certified" && currentPhase.workload === "general";
    const specializedCertificationDemo = demoMode === "certified"
      && (currentPhase.workload === "matching" || currentPhase.workload === "streaming" || currentPhase.workload === "dispatch");
    if (!releaseDemo && !coreCertificationDemo && !specializedCertificationDemo) placeComponent("queue", { col: 5, row: 5 });
    if (!releaseDemo && !coreCertificationDemo && !specializedCertificationDemo) placeComponent("worker", { col: 5, row: 4 });
    if (coreCertificationDemo) {
      const capacityTarget = Math.ceil(targetRps * (latencySlo <= 75 ? 1.085 : 1));
      placeDemoMachinesUntil("loadBalancer", Math.ceil(capacityTarget / coreComponentCapacity.loadBalancer));
      placeDemoMachinesUntil("api", Math.ceil(capacityTarget / coreComponentCapacity.api));
      placeDemoMachinesUntil("redis", Math.ceil(capacityTarget / coreComponentCapacity.redis));
      placeDemoMachinesUntil("postgres", Math.ceil(capacityTarget / (coreComponentCapacity.postgres * 3.125)));
    }
    if (demoMode === "certified") provisionCertifiedSpecializedDemo();
    if (demoMode === "config") openConfigScreen();
    else if (!diagnosisDemo) runButton.click();
    if (demoMode === "packets") {
      currentDemand = targetRps;
      for (let index = 0; index < 18; index += 1) {
        spawnPacket();
        const packet = packets.at(-1);
        if (packet) packet.progress = 0.08 + (index % 8) * 0.11;
      }
      updateTelemetry();
    }
    // Deterministic visual-test modes exercise the same state machine without
    // making browser screenshots wait for the full certification window.
    if (demoMode === "incident" || releaseDemo) {
      for (let second = 0; second < Math.ceil(currentPhase.incident.triggerAt) + 1; second += 1) updateTest(1);
      updateTelemetry();
    }
    if (demoMode === "release-certified") {
      placeComponent("api", { col: 3, row: 4 });
      for (let second = 0; second < testTimeLimit; second += 1) updateTest(1);
      updateTelemetry();
    }
    if (demoMode === "certified" || demoMode === "failed") {
      for (let second = 0; second < testTimeLimit + 1; second += 1) {
        updateTest(1);
        if (demoMode === "certified" && isIncidentAwaitingResponse()) {
          const responseMetrics = calculateMetrics(targetRps);
          const responseTopology = "topology" in responseMetrics ? responseMetrics.topology : null;
          const responseKind = incidentResponseRequiredKind
            ?? (responseTopology?.hasResponsePath === false
              ? currentPhase.incident.affectedKind
              : responseTopology && !responseTopology.backgroundHealthy
                ? responseTopology.backgroundBottleneckKind as ComponentKind | null
                : responseTopology && responseTopology.latency > latencySlo && !responseTopology.cacheOperational
                  ? "redis"
                  : responseTopology?.bottleneckKind as ComponentKind | null)
            ?? currentPhase.incident.affectedKind;
          if (responseKind) {
            placeDemoMachinesUntil(responseKind, nodes.filter((node) => node.kind === responseKind).length + 1);
          }
        }
      }
      updateTelemetry();
    }
  }
} else if (!requestedSandbox) {
  openCampaignScreen();
}
const sharedDesign = searchParams.get("design");
if (sharedDesign !== null) {
  const blueprint = readSharedBlueprint(sharedDesign);
  if (blueprint) {
    closeCampaignScreen();
    phaseBriefingOverlay.dataset.visible = "false";
    phaseBriefingOverlay.setAttribute("aria-hidden", "true");
    restoreBlueprintData(blueprint, "shared");
  } else {
    showToast("This shared blueprint was rejected. It may be damaged, over budget, incompatible, or built for another phase.");
  }
}
if (searchParams.get("wiring") === "manual" && manualWiringAvailable() && topologyMode === "automatic") {
  setWiringEditing(true);
}
