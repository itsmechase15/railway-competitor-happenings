import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createLogger } from "../log.js";
import type { PageKind, RailwayPage } from "../types.js";
import { titleFromUrl } from "../util/text.js";
import { sectionOf } from "./retrieval.js";

const log = createLogger("docs-workspace");

/** The name the analyst is told to start from. */
export const TOC_FILENAME = "TOC.md";
const PAGES_DIRNAME = "pages";

/**
 * What each kind of page is evidence of, stated on the page itself.
 *
 * The changelog line is the one that matters. Railway ships things the docs
 * have not caught up with, so a changelog entry is proof the capability
 * exists and no proof at all that it is documented – and an analyst that
 * cannot tell those apart will either invent a gap or wave one away.
 */
export const EVIDENCE_LABEL: Record<PageKind, string> = {
  docs: "product documentation: what Railway ships today",
  marketing: "marketing copy: written on some past date, not evidence about the product",
  changelog: "shipped, may be undocumented",
};

export interface DocsWorkspace {
  /** Absolute path the analyst runs in. */
  dir: string;
  /** The table of contents, as written to disk and as handed to the analyst. */
  toc: string;
  pageCount: number;
  /** The corpus URL a file holds, for reading an analyst's own file reads back. */
  urlForPath(path: string): string | undefined;
  /** Where a corpus URL was written, relative to `dir`. */
  pathForUrl(url: string): string | undefined;
}

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "page"
  );
}

/** A stable, readable file path per URL: the docs section, then the rest of the path. */
function relativePathFor(url: string, taken: Set<string>): string {
  let tail = url;
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    tail = segments.slice(1).join("-") || segments[0] || parsed.hostname;
  } catch {
    tail = slugify(url);
  }

  const base = `${PAGES_DIRNAME}/${slugify(sectionOf(url))}/${slugify(tail)}`;
  let candidate = `${base}.md`;
  let counter = 2;
  while (taken.has(candidate)) {
    candidate = `${base}-${counter}.md`;
    counter += 1;
  }
  taken.add(candidate);
  return candidate;
}

function day(date: Date): string {
  return date.getTime() === 0 ? "unknown" : date.toISOString().slice(0, 10);
}

/** One page as a file: what it is, where it came from, and its text. */
export function renderPageFile(page: RailwayPage): string {
  const title = page.title || titleFromUrl(page.url);
  return [
    "---",
    `url: ${page.url}`,
    `title: ${title}`,
    `kind: ${page.kind}`,
    `evidence: ${EVIDENCE_LABEL[page.kind]}`,
    `read: ${day(page.fetchedAt)}`,
    `last_changed: ${day(page.changedAt)}`,
    "---",
    "",
    `# ${title}`,
    "",
    page.text,
    "",
  ].join("\n");
}

interface TocEntry {
  path: string;
  page: RailwayPage;
}

/**
 * The whole corpus as one list, grouped by section.
 *
 * The analyst gets this in its prompt as well as on disk, because the failure
 * it prevents is not "could not find the page" – it is not knowing the page
 * exists to look for. A list of every page is the difference between "Railway
 * has no consent controls" and "there is a privacy section, let me read it".
 */
export function renderToc(entries: TocEntry[]): string {
  const bySection = new Map<string, TocEntry[]>();
  for (const entry of entries) {
    const section = sectionOf(entry.page.url);
    const group = bySection.get(section) ?? [];
    group.push(entry);
    bySection.set(section, group);
  }

  const lines = [
    "# Railway docs workspace",
    "",
    `${entries.length} pages, one file each, grouped by the section of the site they sit in.`,
    "Every file opens with its source URL and what it is evidence of:",
    "",
    ...Object.entries(EVIDENCE_LABEL).map(([kind, label]) => `- \`${kind}\` ${label}`),
    "",
    "A page with no label is product documentation. Cite the `url` from the",
    "file's own header, never the file path.",
    "",
  ];

  for (const section of [...bySection.keys()].sort()) {
    const group = (bySection.get(section) ?? []).sort((a, b) =>
      a.page.url.localeCompare(b.page.url),
    );
    lines.push(`## ${section} (${group.length})`);
    for (const entry of group) {
      const title = entry.page.title || titleFromUrl(entry.page.url);
      const label = entry.page.kind === "docs" ? "" : ` [${entry.page.kind}]`;
      // Title and path only. The list goes into every prompt, so a few hundred
      // pages of URLs would cost more than the page names are worth – and the
      // URL to cite is in the file's own header, which has to be opened anyway
      // to quote it.
      lines.push(`- ${title}${label} \`${entry.path}\``);
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Write the corpus to disk as markdown, one file per page, with a table of
 * contents.
 *
 * The directory is rebuilt each run rather than updated: a file left behind
 * for a page that has since been retired is a page the analyst can still
 * quote, which is the one thing the corpus is supposed to prevent.
 */
export async function writeDocsWorkspace(
  dir: string,
  pages: RailwayPage[],
): Promise<DocsWorkspace> {
  const root = resolve(dir);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });

  const taken = new Set<string>();
  const entries: TocEntry[] = [];
  const byPath = new Map<string, string>();
  const byUrl = new Map<string, string>();

  for (const page of [...pages].sort((a, b) => a.url.localeCompare(b.url))) {
    if (page.text.trim().length === 0) continue;
    const path = relativePathFor(page.url, taken);
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, renderPageFile(page), "utf8");
    entries.push({ path, page });
    byPath.set(path, page.url);
    byUrl.set(page.url, path);
  }

  const toc = renderToc(entries);
  await writeFile(join(root, TOC_FILENAME), toc, "utf8");

  log.info(`docs workspace: wrote ${entries.length} pages and a table of contents to ${root}`);

  return {
    dir: root,
    toc,
    pageCount: entries.length,

    urlForPath(path) {
      if (!path) return undefined;
      const candidate = isAbsolute(path) ? relative(root, path) : path.replace(/^\.\//, "");
      return byPath.get(candidate.split(sep).join("/"));
    },

    pathForUrl(url) {
      return byUrl.get(url);
    },
  };
}
