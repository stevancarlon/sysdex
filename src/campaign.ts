export type ComponentKind =
  | "loadBalancer"
  | "api"
  | "redis"
  | "postgres"
  | "queue"
  | "worker"
  | "geoIndex"
  | "objectStorage"
  | "cdn";

export type WorkloadKind = "general" | "analytics" | "matching" | "streaming" | "dispatch";

export type ConfigId = "autoscaling" | "circuitBreaker" | "multiAz" | "observability" | "walTuning";

export type IncidentSpec = {
  code: string;
  title: string;
  summary: string;
  operatorPrompt: string;
  manualAction: string;
  affectedKind: ComponentKind | null;
  triggerAt: number;
  loadMultiplier: number;
  capacityMultiplier: number;
  latencyPenalty: number;
  errorPenalty: number;
  recoverySeconds: number;
};

export type CampaignPhase = {
  index: number;
  name: string;
  service: string;
  difficulty: "Apprentice" | "Operator" | "On-call" | "Senior" | "Staff";
  workload: WorkloadKind;
  objective: string;
  description: string;
  lesson: string;
  targetRps: number;
  latencySlo: number;
  errorSlo: number;
  backgroundSlo?: {
    label: string;
    maxLagSeconds: number;
    minimumDeliveryPercent: number;
  };
  budget: number;
  certificationSeconds: number;
  testTimeLimit: number;
  unlocks: ComponentKind[];
  configUnlocks: ConfigId[];
  incident: IncidentSpec;
};

export type ConfigDefinition = {
  id: ConfigId;
  label: string;
  category: string;
  cost: number;
  description: string;
  effect: string;
};

export const configDefinitions: ConfigDefinition[] = [
  {
    id: "observability",
    label: "Tracing + SLO alerts",
    category: "Observability",
    cost: 100,
    description: "Instrument the request path and page the operator with useful context.",
    effect: "Incident recovery is 20% faster and successful runs earn an operations bonus.",
  },
  {
    id: "autoscaling",
    label: "API autoscaling",
    category: "Compute policy",
    cost: 240,
    description: "Keep warm spare capacity and add API workers when saturation rises.",
    effect: "+35% API capacity; softens API node failures and sudden traffic spikes.",
  },
  {
    id: "circuitBreaker",
    label: "Circuit breaker",
    category: "Resilience policy",
    cost: 160,
    description: "Stop cascading retries when a downstream tier becomes unhealthy.",
    effect: "Cuts incident error amplification and unlocks fast traffic isolation.",
  },
  {
    id: "walTuning",
    label: "WAL + read replicas",
    category: "Data policy",
    cost: 220,
    description: "Move read traffic to replicas and tune PostgreSQL write-ahead logging.",
    effect: "+25% storage capacity and lower database queuing latency.",
  },
  {
    id: "multiAz",
    label: "Multi-AZ failover",
    category: "Availability",
    cost: 320,
    description: "Maintain a synchronous standby in a separate failure domain.",
    effect: "Database incidents retain most capacity and unlock automatic failover.",
  },
];

export const campaignPhases: CampaignPhase[] = [
  {
    index: 0,
    name: "First Release",
    service: "URL Shortener",
    difficulty: "Apprentice",
    workload: "general",
    objective: "Build a production URL shortener.",
    description: "Ship a small but complete request path before launch day traffic arrives.",
    lesson: "Build the minimum durable path, then scale stateless compute horizontally.",
    targetRps: 500,
    latencySlo: 160,
    errorSlo: 2,
    budget: 850,
    certificationSeconds: 6,
    testTimeLimit: 24,
    unlocks: ["loadBalancer", "api", "postgres"],
    configUnlocks: [],
    incident: {
      code: "TRAFFIC-210",
      title: "Launch traffic spike",
      summary: "A newsletter sent the product link early. Demand is 30% above forecast.",
      operatorPrompt: "Protect the latency SLO while the launch wave passes.",
      manualAction: "Provision burst capacity",
      affectedKind: "api",
      triggerAt: 6.5,
      loadMultiplier: 1.3,
      capacityMultiplier: 0.9,
      latencyPenalty: 18,
      errorPenalty: 0.8,
      recoverySeconds: 4.5,
    },
  },
  {
    index: 1,
    name: "Growth Loop",
    service: "Social Redirects",
    difficulty: "Operator",
    workload: "analytics",
    objective: "Decouple click analytics from the redirect request path.",
    description: "You inherited a working redirect service, but the API now waits for Analytics Service to record every click before responding.",
    lesson: "First ask which work must finish before the user gets a response. Move everything else behind an asynchronous boundary.",
    targetRps: 1_200,
    latencySlo: 115,
    errorSlo: 1.5,
    backgroundSlo: {
      label: "Click analytics",
      maxLagSeconds: 1,
      minimumDeliveryPercent: 99.5,
    },
    budget: 1_790,
    certificationSeconds: 7,
    testTimeLimit: 27,
    unlocks: ["loadBalancer", "api", "redis", "postgres", "queue", "worker"],
    configUnlocks: ["observability"],
    incident: {
      code: "CACHE-429",
      title: "Cache stampede",
      summary: "A hot-key expiry pushed thousands of concurrent reads back to PostgreSQL.",
      operatorPrompt: "Warm the cache and prevent the storage tier from being overwhelmed.",
      manualAction: "Warm cache from archive",
      affectedKind: "redis",
      triggerAt: 7,
      loadMultiplier: 1.12,
      capacityMultiplier: 0.48,
      latencyPenalty: 64,
      errorPenalty: 2.4,
      recoverySeconds: 5.5,
    },
  },
  {
    index: 2,
    name: "On-call Rotation",
    service: "Checkout API",
    difficulty: "On-call",
    workload: "general",
    objective: "Keep a checkout API available when an API server fails.",
    description: "Revenue traffic needs predictable latency even when a compute node disappears.",
    lesson: "Design for partial failure, contain retries, and preserve enough spare capacity.",
    targetRps: 1_800,
    latencySlo: 95,
    errorSlo: 0.8,
    budget: 2_500,
    certificationSeconds: 8,
    testTimeLimit: 30,
    unlocks: ["loadBalancer", "api", "redis", "postgres", "queue", "worker"],
    configUnlocks: ["observability", "autoscaling", "circuitBreaker"],
    incident: {
      code: "API-503",
      title: "API node crash",
      summary: "A memory leak killed one request processor during peak checkout traffic.",
      operatorPrompt: "Isolate the dead instance without creating a retry storm.",
      manualAction: "Restart failed instance",
      affectedKind: "api",
      triggerAt: 7.5,
      loadMultiplier: 1.08,
      capacityMultiplier: 0.58,
      latencyPenalty: 42,
      errorPenalty: 8,
      recoverySeconds: 6,
    },
  },
  {
    index: 3,
    name: "Regional Scale",
    service: "Realtime Workspace",
    difficulty: "Senior",
    workload: "general",
    objective: "Keep a realtime workspace available through database failure.",
    description: "A regional customer launch makes the database failure domain the main risk.",
    lesson: "Capacity is not availability. Replicate state and practice controlled failover.",
    targetRps: 3_000,
    latencySlo: 85,
    errorSlo: 0.4,
    budget: 3_850,
    certificationSeconds: 9,
    testTimeLimit: 34,
    unlocks: ["loadBalancer", "api", "redis", "postgres", "queue", "worker"],
    configUnlocks: ["observability", "autoscaling", "circuitBreaker", "walTuning", "multiAz"],
    incident: {
      code: "DB-701",
      title: "Primary database failure",
      summary: "The PostgreSQL primary stopped responding after its storage volume detached.",
      operatorPrompt: "Restore durable reads without corrupting the source of truth.",
      manualAction: "Promote a read replica",
      affectedKind: "postgres",
      triggerAt: 8,
      loadMultiplier: 1.05,
      capacityMultiplier: 0.3,
      latencyPenalty: 115,
      errorPenalty: 13,
      recoverySeconds: 7,
    },
  },
  {
    index: 4,
    name: "Planetary Event",
    service: "Global Live Platform",
    difficulty: "Staff",
    workload: "general",
    objective: "Operate a global live platform through compound failure.",
    description: "A live event creates global load while two dependencies degrade at once.",
    lesson: "Balance efficiency, headroom, isolation, observability, and recovery under compound failure.",
    targetRps: 5_200,
    latencySlo: 75,
    errorSlo: 0.2,
    budget: 6_000,
    certificationSeconds: 10,
    testTimeLimit: 38,
    unlocks: ["loadBalancer", "api", "redis", "postgres", "queue", "worker"],
    configUnlocks: ["observability", "autoscaling", "circuitBreaker", "walTuning", "multiAz"],
    incident: {
      code: "SEV-001",
      title: "Compound regional degradation",
      summary: "A traffic surge landed while an API pool was recycling unhealthy nodes.",
      operatorPrompt: "Shed noncritical work, reroute traffic, and keep the global SLO intact.",
      manualAction: "Shed noncritical traffic",
      affectedKind: "api",
      triggerAt: 8.5,
      loadMultiplier: 1.48,
      capacityMultiplier: 0.65,
      latencyPenalty: 55,
      errorPenalty: 5.5,
      recoverySeconds: 8,
    },
  },
  {
    index: 5,
    name: "Discovery Grid",
    service: "Nearby Matching",
    difficulty: "Senior",
    workload: "matching",
    objective: "Design a nearby-matching service for a global dating platform.",
    description: "Millions of active profiles must be filtered by distance without scanning the entire user base.",
    lesson: "Partition location data into balanced geographic cells and keep frequently queried profiles close to users.",
    targetRps: 6_200,
    latencySlo: 68,
    errorSlo: 0.18,
    budget: 9_600,
    certificationSeconds: 10,
    testTimeLimit: 40,
    unlocks: ["loadBalancer", "api", "redis", "postgres", "queue", "worker", "geoIndex"],
    configUnlocks: ["observability", "autoscaling", "circuitBreaker", "walTuning", "multiAz"],
    incident: {
      code: "GEO-718",
      title: "Downtown geoshard hotspot",
      summary: "A major event concentrated discovery traffic inside one small geographic cell.",
      operatorPrompt: "Rebalance the hot location partition without widening the search radius.",
      manualAction: "Split hot geoshard",
      affectedKind: "geoIndex",
      triggerAt: 8.5,
      loadMultiplier: 1.24,
      capacityMultiplier: 0.46,
      latencyPenalty: 72,
      errorPenalty: 3.4,
      recoverySeconds: 7.5,
    },
  },
  {
    index: 6,
    name: "Premiere Night",
    service: "Video Streaming",
    difficulty: "Staff",
    workload: "streaming",
    objective: "Design a Netflix-like video platform for a global premiere.",
    description: "Video uploads, transcoding jobs, metadata requests, and playback traffic peak at the same time.",
    lesson: "Separate metadata from media, process uploads asynchronously, and deliver popular content from the edge.",
    targetRps: 8_000,
    latencySlo: 58,
    errorSlo: 0.12,
    backgroundSlo: {
      label: "Transcode jobs",
      maxLagSeconds: 1,
      minimumDeliveryPercent: 99.5,
    },
    budget: 12_800,
    certificationSeconds: 11,
    testTimeLimit: 43,
    unlocks: ["loadBalancer", "api", "redis", "postgres", "queue", "worker", "objectStorage", "cdn"],
    configUnlocks: ["observability", "autoscaling", "circuitBreaker", "walTuning", "multiAz"],
    incident: {
      code: "EDGE-206",
      title: "Regional edge cache eviction",
      summary: "A deployment flushed the hottest video segments from one CDN region minutes before the premiere.",
      operatorPrompt: "Protect the origin while viewers refill the affected edge cache.",
      manualAction: "Warm alternate edge",
      affectedKind: "cdn",
      triggerAt: 9,
      loadMultiplier: 1.32,
      capacityMultiplier: 0.42,
      latencyPenalty: 88,
      errorPenalty: 4.2,
      recoverySeconds: 8,
    },
  },
  {
    index: 7,
    name: "City Surge",
    service: "Ride Dispatch",
    difficulty: "Staff",
    workload: "dispatch",
    objective: "Design an Uber-like dispatch system during a citywide storm.",
    description: "Rider requests and driver location updates create a fast-moving hotspot across several districts.",
    lesson: "Combine geographic partitioning, asynchronous location processing, caching, and failure isolation.",
    targetRps: 8_500,
    latencySlo: 48,
    errorSlo: 0.1,
    backgroundSlo: {
      label: "Driver locations",
      maxLagSeconds: 0.8,
      minimumDeliveryPercent: 99.8,
    },
    budget: 16_000,
    certificationSeconds: 12,
    testTimeLimit: 46,
    unlocks: ["loadBalancer", "api", "redis", "postgres", "queue", "worker", "geoIndex", "objectStorage", "cdn"],
    configUnlocks: ["observability", "autoscaling", "circuitBreaker", "walTuning", "multiAz"],
    incident: {
      code: "MAP-911",
      title: "Airport pickup hotspot",
      summary: "Thousands of riders and drivers converged on the same location cells after flight cancellations.",
      operatorPrompt: "Split the hotspot and preserve low-latency nearby-driver queries.",
      manualAction: "Repartition location cells",
      affectedKind: "geoIndex",
      triggerAt: 9.5,
      loadMultiplier: 1.38,
      capacityMultiplier: 0.52,
      latencyPenalty: 78,
      errorPenalty: 4.8,
      recoverySeconds: 8.5,
    },
  },
];
