import type { RecommendedAction } from "../types.js";

/**
 * A Railway product surface: what to call it, the words that point at it, and
 * the docs pages that say what it can already do.
 *
 * The docs are why this list is more than a link table. A compare page is
 * marketing copy written on some past date, so it is the wrong evidence for
 * "Railway can't do X". Before the bot recommends building or enhancing
 * anything, the docs for the surface it names go in front of the model.
 *
 * `docs` is deliberately short. The first entry is the surface's overview
 * page, and the ones after it answer the questions Render and Vercel keep
 * shipping against. Every URL here has been requested and returned 200.
 *
 * A surface missing from here is a recommendation with nothing to check it
 * against, and that is how "Railway has no CDN" gets shipped.
 */
export interface RailwayProduct {
  /** Railway's own casing, which is sentence case: "Static outbound IPs". */
  label: string;
  /**
   * A product surface someone owns a roadmap for, or a platform capability
   * that sits under all of them. The two are labelled differently on an issue.
   */
  kind: "product" | "platform";
  /** Other ways a model, or a competitor, writes the same thing. */
  aliases?: string[];
  /** Lowercase substrings in a signal, or in a model's own words, that point here. */
  keywords: string[];
  /** Canonical docs.railway.com pages, overview first. */
  docs: string[];
}

export const RAILWAY_PRODUCTS: RailwayProduct[] = [
  {
    label: "Deployments",
    kind: "product",
    aliases: ["deploys", "deploy", "deployment"],
    keywords: [
      "deploy",
      "deployment",
      "rollback",
      "zero downtime",
      "blue-green",
      "canary",
      "pre-deploy",
      "restart policy",
      "staged change",
    ],
    docs: [
      "https://docs.railway.com/deployments",
      "https://docs.railway.com/deployments/deployment-actions",
      "https://docs.railway.com/deployments/restart-policy",
      "https://docs.railway.com/deployments/staged-changes",
    ],
  },
  {
    label: "GitHub autodeploys",
    kind: "product",
    aliases: ["autodeploy", "auto-deploy", "git deploys"],
    keywords: [
      "github autodeploy",
      "auto deploy",
      "auto-deploy",
      "deploy on push",
      "git integration",
      "branch deploy",
    ],
    docs: [
      "https://docs.railway.com/deployments/github-autodeploys",
      "https://docs.railway.com/deployments/image-auto-updates",
    ],
  },
  {
    label: "Healthchecks",
    kind: "product",
    aliases: ["health check", "health checks", "healthcheck"],
    keywords: ["healthcheck", "health check", "readiness", "liveness", "probe"],
    docs: ["https://docs.railway.com/deployments/healthchecks"],
  },
  {
    label: "Monorepo support",
    kind: "product",
    aliases: ["monorepo", "monorepos"],
    keywords: ["monorepo", "workspace root", "turborepo", "nx", "sub-directory deploy"],
    docs: [
      "https://docs.railway.com/deployments/monorepo",
      "https://docs.railway.com/guides/deploying-a-monorepo",
    ],
  },
  {
    label: "Regions",
    kind: "product",
    aliases: ["region", "multi-region", "geography"],
    keywords: ["region", "multi-region", "data residency", "eu-west", "us-east", "availability zone"],
    docs: ["https://docs.railway.com/deployments/regions", "https://docs.railway.com/platform/railway-metal"],
  },
  {
    label: "Scaling",
    kind: "product",
    aliases: ["autoscaling", "horizontal scaling", "replicas"],
    keywords: [
      "scale",
      "scaling",
      "autoscal",
      "replica",
      "horizontal",
      "vertical",
      "instance type",
      "compute plan",
      "concurrency",
      // What a vertical-scaling launch is actually written in: a bigger shape,
      // named by its CPU and memory rather than by the word "scaling".
      "cpu",
      "vcpu",
      "memory",
      "ram",
    ],
    docs: [
      "https://docs.railway.com/deployments/scaling",
      "https://docs.railway.com/guides/autoscale-horizontally",
      "https://docs.railway.com/deployments/optimize-performance",
    ],
  },
  {
    label: "Serverless",
    kind: "product",
    aliases: ["app sleeping", "scale to zero", "sleep"],
    keywords: [
      "serverless",
      "scale to zero",
      "scale-to-zero",
      "app sleeping",
      "idle",
      "spin down",
      "cold start",
      "pay per request",
    ],
    docs: ["https://docs.railway.com/deployments/serverless"],
  },
  {
    label: "Builds",
    kind: "product",
    aliases: ["build", "railpack", "buildpacks", "nixpacks"],
    keywords: [
      "build",
      "builder",
      "buildpack",
      "railpack",
      "dockerfile",
      "build cache",
      "build time",
      "image build",
      "private registry",
    ],
    docs: [
      "https://docs.railway.com/builds",
      "https://docs.railway.com/builds/railpack",
      "https://docs.railway.com/builds/dockerfiles",
      "https://docs.railway.com/builds/build-configuration",
    ],
  },
  {
    label: "Config as code",
    kind: "product",
    aliases: ["railway.json", "railway.toml", "blueprint", "blueprints"],
    keywords: [
      "config as code",
      "configuration as code",
      "blueprint",
      "railway.json",
      "railway.toml",
      "yaml config",
      "declarative config",
    ],
    docs: ["https://docs.railway.com/config-as-code", "https://docs.railway.com/config-as-code/reference"],
  },
  {
    label: "Infrastructure as code",
    kind: "product",
    aliases: ["terraform", "iac", "pulumi"],
    keywords: ["infrastructure as code", "terraform", "pulumi", "iac", "provider"],
    docs: ["https://docs.railway.com/infrastructure-as-code"],
  },
  {
    label: "Environments",
    kind: "product",
    aliases: ["pr environments", "preview environments", "environment"],
    keywords: [
      "environment",
      "pr environment",
      "preview environment",
      "preview deploy",
      "ephemeral environment",
      "staging",
      "branch environment",
    ],
    docs: ["https://docs.railway.com/environments", "https://docs.railway.com/feature-flags"],
  },
  {
    label: "Variables",
    kind: "product",
    aliases: ["environment variables", "secrets", "env vars"],
    keywords: [
      "variable",
      "environment variable",
      "secret",
      "secrets manager",
      "shared variable",
      "build-time secret",
    ],
    docs: [
      "https://docs.railway.com/variables",
      "https://docs.railway.com/guides/build-time-vs-runtime-secrets",
      "https://docs.railway.com/guides/external-secrets-manager",
    ],
  },
  {
    label: "Cron jobs",
    kind: "product",
    aliases: ["cron", "scheduled jobs", "scheduler"],
    keywords: ["cron", "scheduled job", "scheduler", "recurring job", "background job", "queue worker"],
    docs: ["https://docs.railway.com/cron-jobs", "https://docs.railway.com/guides/cron-workers-queues"],
  },
  {
    label: "Functions",
    kind: "product",
    aliases: ["function", "edge functions", "serverless functions"],
    keywords: ["function", "edge function", "lambda", "handler", "single-file service"],
    docs: ["https://docs.railway.com/functions"],
  },
  {
    label: "Databases",
    kind: "product",
    aliases: ["database", "postgres", "managed postgres", "redis", "mysql", "mongodb"],
    keywords: [
      "database",
      "postgres",
      "postgresql",
      "mysql",
      "mongodb",
      "redis",
      "valkey",
      "key value",
      "connection pool",
      "pgbouncer",
      "read replica",
      "high availability",
    ],
    docs: [
      "https://docs.railway.com/databases",
      "https://docs.railway.com/databases/postgresql",
      "https://docs.railway.com/databases/postgresql-ha",
      "https://docs.railway.com/databases/redis",
    ],
  },
  {
    label: "Volumes",
    kind: "product",
    aliases: ["volume", "persistent disk", "disks"],
    keywords: ["volume", "persistent disk", "disk", "mount", "block storage", "snapshot"],
    docs: [
      "https://docs.railway.com/volumes",
      "https://docs.railway.com/volumes/backups",
      "https://docs.railway.com/volumes/point-in-time-recovery",
    ],
  },
  {
    label: "Storage buckets",
    kind: "product",
    aliases: ["object storage", "bucket", "buckets", "blob storage"],
    keywords: [
      "storage bucket",
      "object storage",
      "s3",
      "blob",
      "bucket",
      "file upload",
      "asset hosting",
      "storage",
    ],
    docs: [
      "https://docs.railway.com/storage-buckets",
      "https://docs.railway.com/storage-buckets/uploading-serving",
    ],
  },
  {
    label: "Public networking",
    kind: "product",
    aliases: ["ingress", "public network", "tcp proxy"],
    keywords: ["public networking", "ingress", "tcp proxy", "port", "http2", "websocket", "request limit"],
    docs: [
      "https://docs.railway.com/networking/public-networking",
      "https://docs.railway.com/networking/public-networking/specs-and-limits",
      "https://docs.railway.com/networking/tcp-proxy",
    ],
  },
  {
    label: "Private networking",
    kind: "product",
    aliases: ["private network", "vpc", "service discovery"],
    keywords: ["private network", "private networking", "vpc", "internal dns", "service discovery", "ipv6 internal"],
    docs: [
      "https://docs.railway.com/networking/private-networking",
      "https://docs.railway.com/networking/private-networking/how-it-works",
    ],
  },
  {
    label: "Domains",
    kind: "product",
    aliases: ["custom domains", "domain", "dns", "tls"],
    keywords: ["custom domain", "domain", "dns", "cname", "apex", "wildcard domain", "certificate", "tls", "ssl"],
    docs: [
      "https://docs.railway.com/networking/domains",
      "https://docs.railway.com/networking/domains/working-with-domains",
      "https://docs.railway.com/networking/domains/railway-domains",
    ],
  },
  {
    label: "Static outbound IPs",
    kind: "product",
    aliases: ["static ip", "static ips", "dedicated ip", "egress ip"],
    keywords: ["static outbound", "static ip", "dedicated ip", "egress", "outbound network", "ip allowlist"],
    docs: [
      "https://docs.railway.com/networking/static-outbound-ips",
      "https://docs.railway.com/networking/outbound-networking",
    ],
  },
  {
    label: "Edge networking",
    kind: "platform",
    aliases: ["edge", "edge rules", "anycast"],
    keywords: ["edge network", "edge rule", "anycast", "global network", "routing rule", "rewrite", "redirect"],
    docs: [
      "https://docs.railway.com/networking/edge-networking",
      "https://docs.railway.com/networking/edge-rules",
    ],
  },
  {
    label: "CDN",
    kind: "product",
    aliases: ["caching", "cache", "content delivery network"],
    keywords: ["cdn", "cache", "caching", "cache header", "static asset", "edge cache", "purge", "stale-while-revalidate"],
    docs: ["https://docs.railway.com/networking/cdn", "https://docs.railway.com/guides/cache-headers-cdn"],
  },
  {
    label: "WAF",
    kind: "product",
    aliases: ["firewall", "web application firewall", "ddos protection", "bot protection"],
    keywords: ["waf", "firewall", "ddos", "rate limit", "bot", "ip block", "managed ruleset", "attack"],
    docs: ["https://docs.railway.com/networking/waf"],
  },
  {
    label: "Observability",
    kind: "product",
    aliases: ["logs", "metrics", "monitoring", "alerts", "alerting", "tracing"],
    keywords: [
      "observability",
      "log",
      "logging",
      "metric",
      "monitoring",
      "alert",
      "notification",
      "trace",
      "otel",
      "opentelemetry",
      "dashboard",
    ],
    docs: [
      "https://docs.railway.com/observability",
      "https://docs.railway.com/observability/logs",
      "https://docs.railway.com/observability/metrics",
      "https://docs.railway.com/observability/webhooks",
    ],
  },
  {
    label: "Pricing",
    kind: "platform",
    aliases: ["plans", "billing", "cost", "usage-based pricing"],
    keywords: [
      "pricing",
      "price",
      "plan",
      "billing",
      "bill",
      "cost",
      "free tier",
      "usage-based",
      "credit",
      "committed spend",
      "seat",
    ],
    docs: [
      "https://docs.railway.com/pricing",
      "https://docs.railway.com/pricing/plans",
      "https://docs.railway.com/pricing/cost-control",
      "https://docs.railway.com/pricing/committed-spend",
    ],
  },
  {
    label: "Enterprise and compliance",
    kind: "platform",
    aliases: ["enterprise", "compliance", "soc 2", "hipaa", "sso", "saml", "rbac", "audit logs"],
    keywords: [
      "enterprise",
      "compliance",
      "soc 2",
      "soc2",
      "hipaa",
      "iso 27001",
      "gdpr",
      "audit log",
      "saml",
      "sso",
      "rbac",
      "access group",
      "guardrail",
      "permission",
    ],
    docs: [
      "https://docs.railway.com/enterprise",
      "https://docs.railway.com/enterprise/compliance",
      "https://docs.railway.com/enterprise/saml",
      "https://docs.railway.com/enterprise/audit-logs",
      "https://docs.railway.com/enterprise/environment-rbac",
    ],
  },
  {
    label: "Railway Agent",
    kind: "product",
    aliases: ["agent", "ai agent", "railway ai"],
    keywords: ["railway agent", "ai agent", "assistant", "natural language", "chat with your infra", "copilot"],
    docs: ["https://docs.railway.com/ai", "https://docs.railway.com/ai/railway-agent"],
  },
  {
    label: "MCP server",
    kind: "product",
    aliases: ["mcp", "model context protocol"],
    keywords: ["mcp", "model context protocol", "mcp server", "tool calling", "agent integration"],
    docs: ["https://docs.railway.com/ai/mcp-server", "https://docs.railway.com/ai/agent-integrations"],
  },
  {
    label: "Cloud agents",
    kind: "product",
    aliases: ["cloud agent", "coding agents", "background agents", "sandboxes"],
    keywords: [
      "cloud agent",
      "coding agent",
      "background agent",
      "codex",
      "claude code",
      "opencode",
      "agent sandbox",
      "sandbox",
    ],
    docs: ["https://docs.railway.com/cloud-agents", "https://docs.railway.com/sandboxes"],
  },
  {
    label: "Templates",
    kind: "product",
    aliases: ["template", "starters", "marketplace"],
    keywords: ["template", "starter", "one-click deploy", "marketplace", "kickback"],
    docs: ["https://docs.railway.com/templates", "https://docs.railway.com/templates/create"],
  },
  {
    label: "CLI",
    kind: "product",
    aliases: ["command line", "terminal"],
    keywords: ["cli", "command line", "terminal", "railway up", "local dev"],
    docs: ["https://docs.railway.com/cli"],
  },
  {
    label: "Public API",
    kind: "product",
    aliases: ["api", "graphql api", "sdk"],
    keywords: ["public api", "graphql", "api token", "rest api", "sdk", "webhook api", "oauth"],
    docs: [
      "https://docs.railway.com/integrations/api",
      "https://docs.railway.com/integrations/api/graphql-overview",
    ],
  },
  {
    label: "Services",
    kind: "platform",
    aliases: ["workloads", "private services", "background workers"],
    // Never a bare "service": Render and Vercel write the word into every post
    // they publish, so it points at nothing. The kinds of service do.
    keywords: ["private service", "background worker", "static site", "service variable"],
    docs: ["https://docs.railway.com/services", "https://docs.railway.com/overview/the-basics"],
  },
];

/**
 * A capability that cuts across surfaces, and the pages that show where
 * Railway already has it.
 *
 * Surfaces alone are not enough. A signal about a scheduled task reads as a
 * Cron jobs signal, but the page that decides whether "Railway cannot run
 * anything on a schedule" is true may be the cron guide instead. Without
 * these, the docs in context only ever confirm a gap and never qualify it.
 */
export interface RailwayCapability {
  name: string;
  keywords: string[];
  docs: string[];
}

export const RAILWAY_CAPABILITIES: RailwayCapability[] = [
  {
    name: "Scheduling",
    keywords: ["schedule", "scheduled", "scheduling", "cron", "recurring", "time-based", "nightly"],
    docs: ["https://docs.railway.com/cron-jobs", "https://docs.railway.com/guides/cron-workers-queues"],
  },
  {
    name: "Autoscaling",
    keywords: ["autoscal", "auto scale", "scale up", "scale out", "replica count", "concurrency target"],
    docs: [
      "https://docs.railway.com/deployments/scaling",
      "https://docs.railway.com/guides/autoscale-horizontally",
    ],
  },
  {
    name: "Scale to zero",
    keywords: ["scale to zero", "scale-to-zero", "idle", "spin down", "sleep", "cold start", "pay per request"],
    docs: ["https://docs.railway.com/deployments/serverless", "https://docs.railway.com/guides/cut-idle-costs-serverless"],
  },
  {
    name: "Preview environments",
    keywords: ["preview environment", "pr environment", "per-pull-request", "ephemeral environment", "preview url"],
    docs: ["https://docs.railway.com/environments"],
  },
  {
    name: "Zero-downtime deploys",
    keywords: ["zero downtime", "zero-downtime", "blue-green", "canary", "traffic split", "rolling deploy"],
    docs: [
      "https://docs.railway.com/deployments/healthchecks",
      "https://docs.railway.com/deployments/deployment-actions",
    ],
  },
  {
    name: "Alerting",
    keywords: ["alert", "alerting", "notify", "notification", "incident", "crash", "failed deploy", "webhook"],
    docs: [
      "https://docs.railway.com/observability/webhooks",
      "https://docs.railway.com/guides/alerts-crashes-failed-deploys",
    ],
  },
  {
    name: "Edge caching",
    keywords: ["edge cache", "cdn", "cache header", "static asset", "purge", "revalidate", "stale"],
    docs: ["https://docs.railway.com/networking/cdn", "https://docs.railway.com/guides/cache-headers-cdn"],
  },
  {
    name: "Cost control",
    keywords: ["cost", "spend", "budget", "usage limit", "idle cost", "overage", "invoice"],
    docs: [
      "https://docs.railway.com/pricing/cost-control",
      "https://docs.railway.com/pricing/understanding-your-bill",
    ],
  },
  {
    name: "Compliance",
    keywords: ["soc 2", "soc2", "hipaa", "iso 27001", "gdpr", "baa", "pen test", "data residency"],
    docs: ["https://docs.railway.com/enterprise/compliance"],
  },
];

/**
 * Every canonical docs URL, deduplicated. This is the whole set the indexer is
 * asked to keep fresh: a bounded, hand-listed catalog, not a crawl of
 * docs.railway.com.
 */
export const CANONICAL_DOC_URLS: string[] = [
  ...new Set([
    ...RAILWAY_PRODUCTS.flatMap((product) => product.docs),
    ...RAILWAY_CAPABILITIES.flatMap((capability) => capability.docs),
  ]),
];

/** A model writes "cron jobs", "Cron Jobs", and "Cron  jobs" for the same thing. */
function normalize(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

const BY_NAME = new Map<string, RailwayProduct>(
  RAILWAY_PRODUCTS.flatMap((product) =>
    [product.label, ...(product.aliases ?? [])].map((name) => [normalize(name), product] as const),
  ),
);

/**
 * The surface a feature name refers to, or undefined when the name is not one
 * we recognize.
 */
export function findRailwayProduct(feature: string | undefined): RailwayProduct | undefined {
  return feature ? BY_NAME.get(normalize(feature)) : undefined;
}

/**
 * The same lookup, but forgiving, for a feature name a model wrote in its own
 * words: "Railway Serverless (app sleeping)" has to find Serverless.
 */
export function findProductByName(name: string): RailwayProduct | undefined {
  const wanted = normalize(name);
  if (!wanted) return undefined;

  const exact = findRailwayProduct(name);
  if (exact) return exact;

  return RAILWAY_PRODUCTS.find(
    (product) =>
      wanted.includes(normalize(product.label)) ||
      (product.aliases ?? []).some((alias) => wanted.includes(normalize(alias))) ||
      product.keywords.some((keyword) => wanted === keyword),
  );
}

/** Which surface a canonical docs URL belongs to. */
export function productForDocUrl(url: string): RailwayProduct | undefined {
  return RAILWAY_PRODUCTS.find((product) => product.docs.includes(url));
}

/**
 * Where to send a reader who wants to know what a surface already does. The
 * overview docs page, because Railway publishes no separate marketing page for
 * most of these, and a guessed URL sends the reader to a 404.
 */
export function productReferenceUrl(product: RailwayProduct): string | undefined {
  return product.docs[0];
}

/**
 * The surfaces a piece of text is about, most-mentioned first. Used on a
 * competitor signal to pick which docs to put in the prompt, and on a model's
 * own action detail to find the docs that could contradict it.
 */
export function matchProducts(text: string, limit = RAILWAY_PRODUCTS.length): RailwayProduct[] {
  const lower = ` ${text.toLowerCase()} `;

  const scored = RAILWAY_PRODUCTS.map((product) => {
    let score = 0;
    for (const [index, keyword] of product.keywords.entries()) {
      const hits = countOccurrences(lower, keyword);
      if (hits === 0) continue;
      // A surface's first keyword is the one it is usually named by, and a
      // multi-word keyword is a phrase somebody chose rather than a word that
      // could be anywhere, so both count for more.
      const weight = index === 0 ? 3 : keyword.includes(" ") ? 2 : 1;
      score += hits * weight;
    }
    // Only when the label is not already one of the keywords, so a surface
    // whose name is its own first keyword is not counted twice.
    const label = normalize(product.label);
    if (!product.keywords.includes(label) && lower.includes(label)) score += 3;
    return { product, score };
  }).filter((entry) => entry.score > 0);

  scored.sort((a, b) => b.score - a.score || a.product.label.localeCompare(b.product.label));
  return scored.slice(0, limit).map((entry) => entry.product);
}

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count += 1;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

/**
 * The surfaces one action is about: the one it names in `feature` first, then
 * whatever its own words are about. Order matters, because the first match is
 * the surface an action is read as being for.
 */
export function productsForAction(action: RecommendedAction): RailwayProduct[] {
  const named = action.feature ? findProductByName(action.feature) : undefined;
  const fromDetail = matchProducts(action.detail, 3);
  return [...new Set([...(named ? [named] : []), ...fromDetail])];
}

/** The cross-surface capabilities a piece of text is about. */
export function matchCapabilities(text: string): RailwayCapability[] {
  const lower = ` ${text.toLowerCase()} `;
  return RAILWAY_CAPABILITIES.filter((capability) =>
    capability.keywords.some((keyword) => lower.includes(keyword)),
  );
}

/**
 * The docs URLs to put in front of the model for one signal, bounded so a
 * signal that touches everything cannot fill the prompt.
 *
 * Capability pages come first: they are what tells "Railway cannot cache
 * anything at the edge" apart from "Railway has a CDN, and it does not do
 * this one thing". Surfaces follow in relevance order, each contributing its
 * overview page before any of them contributes a second.
 */
export function docUrlsForText(
  text: string,
  options: { maxProducts?: number; maxUrls?: number; maxCapabilityUrls?: number } = {},
): string[] {
  const maxProducts = options.maxProducts ?? 3;
  const maxUrls = options.maxUrls ?? 6;
  const maxCapabilityUrls = options.maxCapabilityUrls ?? 3;
  const products = matchProducts(text, maxProducts);
  if (products.length === 0) return [];

  const picked: string[] = [];
  const add = (url: string | undefined): void => {
    if (!url || picked.includes(url) || picked.length >= maxUrls) return;
    picked.push(url);
  };

  const capabilityUrls = [
    ...new Set(matchCapabilities(text).flatMap((capability) => capability.docs)),
  ].slice(0, maxCapabilityUrls);
  for (const url of capabilityUrls) add(url);

  const depth = Math.max(...products.map((product) => product.docs.length));
  for (let rank = 0; rank < depth && picked.length < maxUrls; rank += 1) {
    for (const product of products) add(product.docs[rank]);
  }

  return picked;
}

