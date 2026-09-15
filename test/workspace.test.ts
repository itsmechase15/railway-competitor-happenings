import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_LABEL,
  renderPageFile,
  renderToc,
  TOC_FILENAME,
  writeDocsWorkspace,
} from "../src/railway/workspace.js";
import { corpusPage } from "./helpers.js";

const pages = [
  corpusPage({
    url: "https://docs.railway.com/deployments/serverless",
    title: "Serverless",
    text: "Serverless stops a service's container when it has no inbound traffic.",
  }),
  corpusPage({
    url: "https://docs.railway.com/platform/compare-to-render",
    title: "Compare to Render",
    kind: "marketing",
    text: "Railway and Render both deploy from a repository.",
  }),
  corpusPage({
    url: "https://railway.com/changelog/2026-09-01-metal",
    title: "Railway Metal",
    kind: "changelog",
    text: "Every region now runs on Railway Metal.",
  }),
];

async function workspace() {
  const dir = await mkdtemp(join(tmpdir(), "docs-workspace-"));
  return writeDocsWorkspace(dir, pages);
}

/**
 * The workspace is the corpus as something an analyst can actually search:
 * one file per page, a list of all of them, and a header on each file saying
 * what it is evidence of. Without the list, a page the analyst does not think
 * to look for is a page that may as well not exist.
 */
describe("the docs workspace on disk", () => {
  it("writes one file per page, plus a table of contents", async () => {
    const written = await workspace();

    expect(written.pageCount).toBe(3);
    expect(await readdir(written.dir)).toContain(TOC_FILENAME);
  });

  it("puts the source url in every file, so a citation is never a file path", async () => {
    const written = await workspace();
    const path = written.pathForUrl("https://docs.railway.com/deployments/serverless");
    expect(path).toBeDefined();

    const contents = await readFile(join(written.dir, path as string), "utf8");
    expect(contents).toContain("url: https://docs.railway.com/deployments/serverless");
    expect(contents).toContain("no inbound traffic");
  });

  /**
   * Railway ships things ahead of its docs, so the changelog is in the corpus.
   * An analyst that cannot tell a changelog entry from a docs page will either
   * invent a gap the changelog already answers or wave one away on a page that
   * proves nothing.
   */
  it("labels a changelog entry as shipped and possibly undocumented", async () => {
    const written = await workspace();
    const path = written.pathForUrl("https://railway.com/changelog/2026-09-01-metal");

    const contents = await readFile(join(written.dir, path as string), "utf8");
    expect(contents).toContain(`evidence: ${EVIDENCE_LABEL.changelog}`);
    expect(EVIDENCE_LABEL.changelog).toContain("may be undocumented");
  });

  it("labels a compare page as copy rather than as product documentation", () => {
    const contents = renderPageFile(
      corpusPage({ url: "https://railway.com/pricing", kind: "marketing", text: "Plans." }),
    );
    expect(contents).toContain("marketing copy");
  });

  it("reads an analyst's own file read back to the page it was", async () => {
    const written = await workspace();
    const path = written.pathForUrl("https://docs.railway.com/volumes");
    expect(path).toBeUndefined();

    const serverless = written.pathForUrl("https://docs.railway.com/deployments/serverless");
    expect(written.urlForPath(serverless as string)).toBe(
      "https://docs.railway.com/deployments/serverless",
    );
    expect(written.urlForPath(`./${serverless}`)).toBe(
      "https://docs.railway.com/deployments/serverless",
    );
    expect(written.urlForPath(join(written.dir, serverless as string))).toBe(
      "https://docs.railway.com/deployments/serverless",
    );
  });

  it("does not claim a page for a path nothing was written to", async () => {
    const written = await workspace();
    expect(written.urlForPath("pages/made/up.md")).toBeUndefined();
    expect(written.urlForPath("")).toBeUndefined();
  });

  it("rebuilds the directory, so a retired page cannot be quoted next run", async () => {
    const dir = await mkdtemp(join(tmpdir(), "docs-workspace-"));
    await writeDocsWorkspace(dir, pages);
    const second = await writeDocsWorkspace(dir, [pages[0] as never]);

    expect(second.pageCount).toBe(1);
    expect(second.pathForUrl("https://railway.com/changelog/2026-09-01-metal")).toBeUndefined();
  });
});

describe("the table of contents", () => {
  it("groups every page by section and names the file each one is in", async () => {
    const written = await workspace();
    const path = written.pathForUrl("https://docs.railway.com/deployments/serverless");

    expect(written.toc).toContain("## deployments (1)");
    expect(written.toc).toContain(`\`${path}\``);
    expect(written.toc).toContain("## changelog (1)");
  });

  it("marks the pages that are not product documentation", async () => {
    const written = await workspace();
    expect(written.toc).toContain("[changelog]");
    expect(written.toc).toContain("[marketing]");
  });

  it("says what each kind of page is evidence of", () => {
    const toc = renderToc([]);
    for (const label of Object.values(EVIDENCE_LABEL)) {
      expect(toc).toContain(label);
    }
  });
});
