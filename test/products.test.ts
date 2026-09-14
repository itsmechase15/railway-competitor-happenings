import { describe, expect, it } from "vitest";
import {
  CANONICAL_DOC_URLS,
  docUrlsForText,
  findProductByName,
  findRailwayProduct,
  matchCapabilities,
  matchProducts,
  productForDocUrl,
  RAILWAY_CAPABILITIES,
  RAILWAY_PRODUCTS,
} from "../src/railway/products.js";

/**
 * The catalog is the whole of this bot's knowledge of what Railway ships. A
 * surface missing from it is a recommendation with nothing to check it
 * against, and that is how "Railway has no CDN" gets shipped.
 */
describe("the Railway docs catalog", () => {
  it("covers every surface the plan lists", () => {
    const labels = RAILWAY_PRODUCTS.map((product) => product.label);
    for (const wanted of [
      "Deployments",
      "GitHub autodeploys",
      "Healthchecks",
      "Monorepo support",
      "Regions",
      "Scaling",
      "Serverless",
      "Builds",
      "Config as code",
      "Infrastructure as code",
      "Environments",
      "Variables",
      "Cron jobs",
      "Functions",
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
      "Pricing",
      "Enterprise and compliance",
      "Railway Agent",
      "MCP server",
      "Cloud agents",
      "Templates",
      "CLI",
      "Public API",
    ]) {
      expect(labels, wanted).toContain(wanted);
    }
  });

  it("gives every surface at least one docs page, overview first", () => {
    for (const product of RAILWAY_PRODUCTS) {
      expect(product.docs.length, product.label).toBeGreaterThan(0);
      for (const url of product.docs) {
        expect(url, product.label).toMatch(/^https:\/\/docs\.railway\.com\//);
      }
    }
  });

  it("gives every capability at least one docs page", () => {
    for (const capability of RAILWAY_CAPABILITIES) {
      expect(capability.docs.length, capability.name).toBeGreaterThan(0);
    }
  });

  it("names each surface once, so a label always resolves to one thing", () => {
    const labels = RAILWAY_PRODUCTS.map((product) => product.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("never gives the same alias to two surfaces", () => {
    const aliases = RAILWAY_PRODUCTS.flatMap((product) =>
      (product.aliases ?? []).map((alias) => alias.toLowerCase()),
    );
    expect(new Set(aliases).size).toBe(aliases.length);
  });

  it("deduplicates the canonical URL list the indexer keeps fresh", () => {
    expect(new Set(CANONICAL_DOC_URLS).size).toBe(CANONICAL_DOC_URLS.length);
  });

  it("maps an overview page back to the surface that owns it", () => {
    expect(productForDocUrl("https://docs.railway.com/networking/cdn")?.label).toBe("CDN");
  });
});

describe("finding the surface a model named", () => {
  it("accepts the catalog's own label in any casing", () => {
    expect(findRailwayProduct("cron jobs")?.label).toBe("Cron jobs");
    expect(findRailwayProduct("Cron  Jobs")?.label).toBe("Cron jobs");
  });

  it("accepts the names a competitor uses", () => {
    expect(findRailwayProduct("scale to zero")?.label).toBe("Serverless");
    expect(findRailwayProduct("persistent disk")?.label).toBe("Volumes");
    expect(findRailwayProduct("object storage")?.label).toBe("Storage buckets");
  });

  it("finds a surface inside a phrase a model wrote", () => {
    expect(findProductByName("Railway Serverless (app sleeping)")?.label).toBe("Serverless");
  });

  it("returns nothing for a surface it does not hold docs for", () => {
    expect(findRailwayProduct("Quantum tunnels")).toBeUndefined();
    expect(findRailwayProduct(undefined)).toBeUndefined();
  });
});

describe("picking the docs to put in front of the model", () => {
  it("reads a compute-plan launch as a scaling signal", () => {
    const products = matchProducts(
      "New compute plans for Render services, including memory-optimized plans and a 12-CPU tier",
      3,
    );
    expect(products[0]?.label).toBe("Scaling");
  });

  it("reads a cache launch as a CDN signal", () => {
    const products = matchProducts("Vercel now purges the edge cache on every deploy", 3);
    expect(products.map((product) => product.label)).toContain("CDN");
  });

  it("pulls the capability pages that qualify a gap claim, not just the surface's own", () => {
    const capabilities = matchCapabilities("Render services can now scale to zero when idle");
    expect(capabilities.map((capability) => capability.name)).toContain("Scale to zero");
  });

  it("puts capability pages first and stays inside the URL budget", () => {
    const urls = docUrlsForText("Render added scheduled tasks with a cron expression", {
      maxUrls: 4,
    });
    expect(urls[0]).toBe("https://docs.railway.com/cron-jobs");
    expect(urls.length).toBeLessThanOrEqual(4);
    expect(new Set(urls).size).toBe(urls.length);
  });

  it("returns nothing for a post about nothing we ship", () => {
    expect(docUrlsForText("We opened a new office in Lisbon")).toEqual([]);
  });
});
