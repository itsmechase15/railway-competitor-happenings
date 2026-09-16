/**
 * The Railway teams an issue can be routed to, read off the employee titles on
 * https://railway.com/about.
 *
 * Railway publishes no team pages. What it publishes is a flat grid of people
 * with a title under each name, and the titles are the org: twelve
 * Infrastructure Engineers, seven Product Engineers, four Support Engineers,
 * four Solutions Engineers, and single people carrying brand, ops, talent, and
 * agentic experience. So a team here is a group of titles, not a page, and
 * every entry's `url` is the about page itself because that is the only place
 * any of this is stated.
 *
 * Read from that page on 2026-09-16: 42 people, 18 distinct titles. Refreshing
 * this list means reading the page again. Nothing here is derived from the
 * product catalog, so a team Railway grows into stays missing until someone
 * changes this file.
 *
 * Three deliberate absences:
 *
 * - **No Inference Engineering.** Nobody on the page carries the title. It is
 *   not here because we do not route to teams we invented.
 * - **No CEO, and no Head of Engineering.** Both are on the page and neither is
 *   a routing target. Leadership picks up whatever it picks up; Product
 *   Engineering and Infrastructure Engineering cover the work itself.
 * - **No emoji.** PostHog's teams publish a spirit animal and this one is the
 *   port of that catalog, but Railway publishes nothing of the kind, and an
 *   invented one would read as Railway's own.
 *
 * `ownsFeatures` names surfaces from `products.ts` in that catalog's own
 * casing, which is what makes an action about the CDN land on Infrastructure
 * Engineering and one about cost control land on Product Engineering. It is
 * the first thing routing looks at. `keywords` is the wider vocabulary of the
 * team's work, for an action that names no surface we recognize.
 */
export interface RailwayTeam {
  /** The team name as this file writes it: "Infrastructure Engineering", "Customer Success". */
  name: string;
  /** The `team:` label slug on an issue. */
  slug: string;
  /** Always the about page. Railway publishes no per-team page. */
  url: string;
  /** Lowercase words in an action that point at this team's work. */
  keywords?: string[];
  /** The surfaces the team builds, as `products.ts` labels them. */
  ownsFeatures?: string[];
}

export const RAILWAY_ABOUT_URL = "https://railway.com/about";

/**
 * Ordered by how many people on the about page carry the titles behind each
 * team, largest first, which is the closest thing the page has to an order.
 */
export const RAILWAY_TEAMS: RailwayTeam[] = [
  {
    // Infrastructure Engineer, twelve of them, and Railway runs its own metal.
    name: "Infrastructure Engineering",
    slug: "infrastructure-engineering",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "railway metal",
      "bare metal",
      "container runtime",
      "orchestration",
      "hypervisor",
      "capacity",
      "throughput",
      "packet",
      "routing layer",
      "storage layer",
      "replication",
      "failover",
      "availability zone",
    ],
    ownsFeatures: [
      "Deployments",
      "GitHub autodeploys",
      "Healthchecks",
      "Regions",
      "Scaling",
      "Serverless",
      "Builds",
      "Databases",
      "Volumes",
      "Storage buckets",
      "Public networking",
      "Private networking",
      "Domains",
      "Static outbound IPs",
      "Edge networking",
      "CDN",
      "WAF",
      "Observability",
      "Services",
    ],
  },
  {
    // Product Engineer, seven of them: the dashboard, the API, and everything
    // a customer configures rather than everything a container runs on.
    name: "Product Engineering",
    slug: "product-engineering",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "dashboard",
      "canvas",
      "project settings",
      "usage limit",
      "cost control",
      "budget",
      "spend",
      "invoice",
      "per-seat",
      "access group",
      "audit log",
      "developer workflow",
    ],
    ownsFeatures: [
      "Environments",
      "Variables",
      "Cron jobs",
      "Functions",
      "Config as code",
      "Infrastructure as code",
      "Templates",
      "CLI",
      "Public API",
      "Pricing",
      "Enterprise and compliance",
    ],
  },
  {
    // Support Engineer, four of them. They own no surface; they own what
    // arrives when one of them breaks for somebody.
    name: "Support Engineering",
    slug: "support-engineering",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "support ticket",
      "support request",
      "customer report",
      "escalation",
      "troubleshoot",
      "runbook",
      "incident response",
      "help center",
    ],
  },
  {
    // Solutions Engineer, four of them, and the team a competitor's migration
    // story lands on: moving a real workload off Render or Vercel is their job.
    name: "Solutions Engineering",
    slug: "solutions-engineering",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "migration",
      "migrating",
      "lift and shift",
      "proof of concept",
      "pilot",
      "reference architecture",
      "solution architecture",
      "enterprise onboarding",
      "evaluation",
    ],
  },
  {
    // Customer Success Engineer, two of them.
    name: "Customer Success",
    slug: "customer-success",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "renewal",
      "churn",
      "account health",
      "expansion",
      "upsell",
      "adoption",
      "customer onboarding",
      "quarterly review",
    ],
  },
  {
    // Marketer, Founding Growth Marketer, Head of Brand, and GTM. They own the
    // pages every update_pages action is asking someone to edit.
    name: "Marketing",
    slug: "marketing",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "compare page",
      "comparison page",
      "migrate page",
      "migration page",
      "pricing page",
      "features page",
      "marketing page",
      "positioning",
      "messaging",
      "brand",
      "launch post",
      "go to market",
      "campaign",
      "seo",
    ],
    ownsFeatures: ["Compare pages", "Migrate pages", "Pricing page", "Features pages"],
  },
  {
    // Designer and Product Designer.
    name: "Design",
    slug: "design",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "design system",
      "visual design",
      "product design",
      "interface",
      "layout",
      "iconography",
      "illustration",
      "empty state",
      "wordmark",
    ],
  },
  {
    // Developer Relations Engineer. Templates are shared with Product
    // Engineering, which is right: one team ships the surface, the other ships
    // what is on it.
    name: "Developer Relations",
    slug: "developer-relations",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "tutorial",
      "quickstart",
      "sample app",
      "example app",
      "starter",
      "developer advocacy",
      "developer relations",
      "community",
      "conference talk",
      "livestream",
    ],
    ownsFeatures: ["Templates"],
  },
  {
    // GM, Agentic Experience. One person, and the reason an MCP or coding-agent
    // launch does not land on Product Engineering by default.
    name: "Agentic Experience",
    slug: "agentic-experience",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "agentic",
      "coding agent",
      "background agent",
      "agent sandbox",
      "model context protocol",
      "tool calling",
      "llm",
      "natural language",
    ],
    ownsFeatures: ["Railway Agent", "MCP server", "Cloud agents"],
  },
  {
    // Head of Operations.
    name: "Operations",
    slug: "operations",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "internal process",
      "back office",
      "vendor contract",
      "procurement",
      "legal review",
      "company policy",
      "finance process",
    ],
  },
  {
    // Recruiter and Talent Lead.
    name: "Talent",
    slug: "talent",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "hiring",
      "recruiting",
      "candidate",
      "job ad",
      "interview process",
      "headcount",
      "new hire",
    ],
  },
  {
    // The one team here with no employee title behind it: the about page lists
    // Logistics as a department it is hiring into. Kept because Railway says
    // the department exists, and an issue about racking hardware or shipping
    // swag has somewhere to go.
    name: "Logistics",
    slug: "logistics",
    url: RAILWAY_ABOUT_URL,
    keywords: [
      "logistics",
      "shipping",
      "freight",
      "inventory",
      "swag",
      "merch",
      "hardware procurement",
      "rack",
      "event booth",
    ],
  },
];

/**
 * A team as an issue reads it. Railway publishes no team emoji, so this is the
 * name – it exists so there is one place to change if that ever stops being
 * true.
 */
export function teamLabel(team: RailwayTeam): string {
  return team.name;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * A name as a lookup key, forgiving about the ways a model writes one: "the
 * Product Engineering team" and "Product Engineering" are the same team.
 */
function lookupKey(value: string): string {
  return normalize(
    value
      .replace(/[^\p{Letter}\p{Number}&\-. ]+/gu, " ")
      .replace(/^the\s+/i, "")
      .replace(/\s+team$/i, ""),
  );
}

const BY_KEY = new Map<string, RailwayTeam>(
  RAILWAY_TEAMS.flatMap((team) =>
    [team.slug, team.name].map((key) => [normalize(key), team] as const),
  ),
);

/**
 * The team a name or slug refers to, or undefined when it is not one of
 * Railway's. Unforgiving about names that are not on the about page, which is
 * the point: a model that suggests "Product", "Engineering", or "Inference
 * Engineering" gets nothing back.
 */
export function findTeam(name: string): RailwayTeam | undefined {
  const wanted = normalize(name);
  if (!wanted) return undefined;
  return BY_KEY.get(wanted) ?? BY_KEY.get(lookupKey(name));
}

/**
 * The teams that build a surface, by the names `products.ts` uses. Matched both
 * ways round, so "CDN" finds the team that owns "CDN" and "Railway's CDN
 * (edge caching)" finds it too.
 */
export function teamsOwningFeature(feature: string): RailwayTeam[] {
  const wanted = normalize(feature);
  if (!wanted) return [];

  const named = findTeam(feature);
  const owners = RAILWAY_TEAMS.filter((team) =>
    (team.ownsFeatures ?? []).some((owned) => {
      const key = normalize(owned);
      return key === wanted || wanted.includes(key);
    }),
  );

  return [...new Set([...(named ? [named] : []), ...owners])];
}

/**
 * The teams a piece of text is about, most relevant first.
 *
 * An owned surface outscores a keyword, because the catalog saying a team
 * builds the CDN is stronger evidence than the word "cache" appearing once.
 */
export function matchTeams(text: string, limit = RAILWAY_TEAMS.length): RailwayTeam[] {
  const haystack = ` ${normalize(text)} `;

  const scored = RAILWAY_TEAMS.map((team) => {
    let score = 0;
    for (const owned of team.ownsFeatures ?? []) {
      if (haystack.includes(normalize(owned))) score += 4;
    }
    for (const keyword of team.keywords ?? []) {
      if (haystack.includes(normalize(keyword))) score += 2;
    }
    return { team, score };
  }).filter((entry) => entry.score > 0);

  scored.sort((a, b) => b.score - a.score || a.team.name.localeCompare(b.team.name));
  return scored.slice(0, limit).map((entry) => entry.team);
}
