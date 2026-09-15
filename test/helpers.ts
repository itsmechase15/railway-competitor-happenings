import { buildCorpusIndex, type CorpusIndex } from "../src/railway/retrieval.js";
import type {
  ActionIssue,
  Alert,
  Analysis,
  CompetitorId,
  FeatureImage,
  RailwayPage,
  RecommendedAction,
  SourceId,
  StoredItem,
} from "../src/types.js";

/** A corpus row, with the bookkeeping filled in so a test only states the text. */
export function corpusPage(overrides: Partial<RailwayPage> = {}): RailwayPage {
  const fetchedAt = overrides.fetchedAt ?? new Date("2026-09-01T00:00:00.000Z");
  return {
    url: "https://docs.railway.com/deployments/scaling",
    title: "Scaling",
    text: "Railway scales a service vertically and horizontally.",
    mentions: [],
    kind: "docs",
    contentHash: "hash",
    fetchedAt,
    changedAt: fetchedAt,
    discoveredFrom: ["sitemap"],
    missingStreak: 0,
    lastUsedAt: null,
    retiredAt: null,
    ...overrides,
  };
}

export function corpusIndex(pages: Array<Partial<RailwayPage>>): CorpusIndex {
  return buildCorpusIndex(pages.map((page) => corpusPage(page)));
}

export function storedItem(overrides: Partial<StoredItem> = {}): StoredItem {
  return {
    id: "1",
    competitor: "render" as CompetitorId,
    source: "changelog" as SourceId,
    externalId: "https://render.com/changelog/new-compute-plans",
    title: "New compute plans, and new IDs for existing plans",
    url: "https://render.com/changelog/new-compute-plans",
    publishedAt: new Date("2026-08-26T00:00:00.000Z"),
    raw: { body: "Render is introducing memory-optimized compute plans." },
    ...overrides,
  };
}

export function analysis(overrides: Partial<Analysis> = {}): Analysis {
  return {
    impact: "notable",
    summary: "Render added memory-optimized compute plans and a 12-CPU tier for web services.",
    keyPoints: [
      "Multiple RAM options at every tier from 2 CPU up",
      "New spec-based plan IDs such as 4c-32g",
    ],
    actions: [
      {
        type: "consider_enhancing",
        feature: "Scaling",
        detail:
          "Add memory-heavy plan shapes to Railway's vertical scaling so a 2 vCPU service can take 16 GB. Railway scales CPU and memory together today.",
      },
    ],
    railwayRefs: [
      {
        url: "https://docs.railway.com/deployments/scaling",
        claim: "Railway scales services vertically and horizontally.",
      },
    ],
    openQuestions: [],
    ...overrides,
  };
}

export function featureImage(overrides: Partial<FeatureImage> = {}): FeatureImage {
  return {
    url: "https://render.com/images/compute-plans.png",
    altText: "Render: New compute plans",
    origin: "feed",
    ...overrides,
  };
}

export function issuesFor(
  actions: RecommendedAction[],
  numbers: Array<number | null>,
): ActionIssue[] {
  return actions.map((action, index) => {
    const number = numbers[index];
    return {
      action,
      issue:
        number === null || number === undefined
          ? null
          : {
              number,
              url: `https://github.com/itsmechase15/railway-competitor-happenings/issues/${number}`,
            },
    };
  });
}

export function alert(overrides: Partial<Alert> = {}): Alert {
  const verdict = overrides.analysis ?? analysis();
  return {
    item: storedItem(),
    analysis: verdict,
    model: "claude-opus-5",
    image: featureImage(),
    issues: issuesFor(verdict.actions, [11]),
    ...overrides,
  };
}
