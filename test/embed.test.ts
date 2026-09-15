import { describe, expect, it } from "vitest";
import {
  ACTION_HEADING,
  BLANK_FIELD_NAME,
  buildDiscordEmbed,
  buildDiscordMessage,
  DETAIL_HEADING,
  embedLength,
  EMBED_LIMITS,
  enforceEmbedLimits,
  IMPACT_HEADING,
  KNOW_HEADING,
  NO_ACTION_TITLE,
} from "../src/discord/embed.js";
import { IMPACT_COLOR } from "../src/labels.js";
import { alert, analysis, issuesFor, storedItem } from "./helpers.js";

/**
 * The plan fixes what an alert says and in what order: image, one sentence
 * with a labeled source link, impact, a few detail bullets, one field per
 * recommended action with its own issue link, and a footer naming the
 * competitor, the source, and the model. This is the contract a reader learns
 * once and then reads at a glance every morning.
 */
describe("the Discord embed", () => {
  it("leads the description with the one sentence under the KNOW heading", () => {
    const embed = buildDiscordEmbed(alert());
    expect(embed.description.startsWith(`**${KNOW_HEADING}**\n`)).toBe(true);
    expect(embed.description).toContain("Render added memory-optimized compute plans");
  });

  it("names the source link by its label, so the reader knows what they are opening", () => {
    const embed = buildDiscordEmbed(alert());
    expect(embed.description).toContain(
      "([changelog](https://render.com/changelog/new-compute-plans))",
    );
  });

  it("labels a blog post's link as an article", () => {
    const embed = buildDiscordEmbed(
      alert({ item: storedItem({ source: "blog", url: "https://render.com/blog/deploys-page" }) }),
    );
    expect(embed.description).toContain("[article](https://render.com/blog/deploys-page)");
  });

  it("leaves a newsletter unlinked, because its URL is a thread in our own inbox", () => {
    const embed = buildDiscordEmbed(
      alert({ item: storedItem({ source: "newsletter", url: "https://inbox.invalid/thread/1" }) }),
    );
    expect(embed.description).not.toContain("inbox.invalid");
  });

  it("orders the fields impact, detail, then one per action", () => {
    const verdict = analysis({
      actions: [
        { type: "consider_enhancing", feature: "Scaling", detail: "Add memory-heavy plans." },
        { type: "update_pages", detail: "On the compare to render page, say so." },
      ],
    });
    const embed = buildDiscordEmbed(
      alert({ analysis: verdict, issues: issuesFor(verdict.actions, [11, 12]) }),
    );

    expect(embed.fields.map((field) => field.name)).toEqual([
      IMPACT_HEADING,
      DETAIL_HEADING,
      ACTION_HEADING,
      // The heading is said once; the actions after it sit under a zero-width
      // space, because Discord will not render a field with an empty name.
      BLANK_FIELD_NAME,
    ]);
  });

  it("shows the impact as the bare label and colors the embed by it", () => {
    const embed = buildDiscordEmbed(alert({ analysis: analysis({ impact: "major" }) }));
    expect(embed.fields[0]).toEqual({ name: IMPACT_HEADING, value: "Major" });
    expect(embed.color).toBe(IMPACT_COLOR.major);
  });

  it("puts the detail in bullets and drops anything past the fourth", () => {
    const embed = buildDiscordEmbed(
      alert({
        analysis: analysis({ keyPoints: ["one", "two", "three", "four", "five"] }),
      }),
    );
    const detail = embed.fields.find((field) => field.name === DETAIL_HEADING);
    expect(detail?.value.split("\n")).toEqual(["- one", "- two", "- three", "- four"]);
  });

  it("gives each action a bold title, one sentence, and its own issue link", () => {
    const embed = buildDiscordEmbed(alert());
    const action = embed.fields.find((field) => field.name === ACTION_HEADING);
    const lines = action?.value.split("\n") ?? [];

    expect(lines[0]).toBe(
      "**Consider enhancing [Scaling](https://docs.railway.com/deployments/scaling)**",
    );
    expect(lines[1]).toBe(
      "Add memory-heavy plan shapes to Railway's vertical scaling so a 2 vCPU service can take 16 GB.",
    );
    expect(lines[2]).toBe(
      "[Access GitHub issue #11](https://github.com/itsmechase15/railway-competitor-happenings/issues/11)",
    );
  });

  it("numbers the issue links, so three of them are told apart on a phone", () => {
    const verdict = analysis({
      actions: [
        { type: "consider_enhancing", feature: "Scaling", detail: "Add memory-heavy plans." },
        { type: "consider_building", detail: "Build a workflow runner." },
        { type: "update_pages", detail: "On the compare to render page, say so." },
      ],
    });
    const embed = buildDiscordEmbed(
      alert({ analysis: verdict, issues: issuesFor(verdict.actions, [11, 12, 13]) }),
    );
    const links = embed.fields
      .flatMap((field) => field.value.split("\n"))
      .filter((line) => line.startsWith("[Access GitHub issue"));
    expect(links.map((line) => line.slice(0, 26))).toEqual([
      "[Access GitHub issue #11](",
      "[Access GitHub issue #12](",
      "[Access GitHub issue #13](",
    ]);
  });

  it("still shows every action when no issue was opened", () => {
    const verdict = analysis();
    const embed = buildDiscordEmbed(
      alert({ analysis: verdict, issues: issuesFor(verdict.actions, [null]) }),
    );
    const action = embed.fields.find((field) => field.name === ACTION_HEADING);
    expect(action?.value).toContain("Consider enhancing");
    expect(action?.value).not.toContain("Access GitHub issue");
  });

  it("caps the alert at three actions", () => {
    const verdict = analysis({
      actions: [
        { type: "consider_enhancing", feature: "Scaling", detail: "One." },
        { type: "consider_enhancing", feature: "CDN", detail: "Two." },
        { type: "consider_building", detail: "Three." },
        { type: "update_pages", detail: "On the compare to render page, four." },
      ],
    });
    const embed = buildDiscordEmbed(alert({ analysis: verdict, issues: [] }));
    const actionFields = embed.fields.filter(
      (field) => field.name === ACTION_HEADING || field.name === BLANK_FIELD_NAME,
    );
    expect(actionFields).toHaveLength(3);
  });

  /**
   * Zero actions is a normal answer, and the embed has to say so in words. A
   * launch that asks nothing of Railway is worth knowing about, and a blank
   * space where the actions go reads as an alert that broke halfway through.
   */
  it("says None, with the reason, when there is nothing to do", () => {
    const verdict = analysis({
      actions: [],
      noActionReason: "Railway already scales memory on every plan, so there is nothing to do.",
    });
    const embed = buildDiscordEmbed(alert({ analysis: verdict, issues: [] }));
    const action = embed.fields.find((field) => field.name === ACTION_HEADING);

    expect(action?.value).toBe(
      `**${NO_ACTION_TITLE}**\nRailway already scales memory on every plan, so there is nothing to do.`,
    );
  });

  it("still says None when nothing recorded a reason", () => {
    const embed = buildDiscordEmbed(
      alert({ analysis: analysis({ actions: [] }), issues: [] }),
    );
    const action = embed.fields.find((field) => field.name === ACTION_HEADING);
    expect(action?.value.startsWith(`**${NO_ACTION_TITLE}**`)).toBe(true);
  });

  /**
   * `[].every(...)` is true, so an alert with no actions used to carry a note
   * apologizing for the issue links it never asked for.
   */
  it("does not apologize for missing issue links on an alert that asked for none", () => {
    const embed = buildDiscordEmbed(
      alert({
        analysis: analysis({ actions: [], noActionReason: "Nothing to do." }),
        issues: [],
        issueNote: "GitHub issues not created – dry run",
      }),
    );
    expect(embed.fields.map((field) => field.name)).not.toContain("Note");
  });

  it("still explains missing issue links when there were actions to file", () => {
    const verdict = analysis();
    const embed = buildDiscordEmbed(
      alert({
        analysis: verdict,
        issues: issuesFor(verdict.actions, [null]),
        issueNote: "GitHub issues not created – dry run",
      }),
    );
    expect(embed.fields.find((field) => field.name === "Note")?.value).toContain("dry run");
  });

  it("carries the feature image, and always one", () => {
    const embed = buildDiscordEmbed(alert());
    expect(embed.image).toEqual({ url: "https://render.com/images/compute-plans.png" });
  });

  it("titles the embed with the competitor and links the entry it is about", () => {
    const embed = buildDiscordEmbed(alert());
    expect(embed.title).toBe("Render: New compute plans, and new IDs for existing plans");
    expect(embed.url).toBe("https://render.com/changelog/new-compute-plans");
  });

  it("footers with competitor, source, and model", () => {
    const embed = buildDiscordEmbed(alert());
    expect(embed.footer?.text).toBe("Render · changelog · claude-opus-5");
  });

  it("says outright when no model analyzed the item", () => {
    const embed = buildDiscordEmbed(alert({ model: "fallback-heuristic" }));
    expect(embed.footer?.text).toContain("not model-analyzed (CURSOR_API_KEY unset)");
  });

  it("never pings anyone", () => {
    expect(buildDiscordMessage(alert()).allowed_mentions).toEqual({ parse: [] });
  });

  it("escapes Discord markdown in copy, so a title cannot reformat the embed", () => {
    const embed = buildDiscordEmbed(
      alert({
        analysis: analysis({ summary: "Render shipped **bold** and _italic_ and `code`." }),
      }),
    );
    expect(embed.description).toContain("\\*\\*bold\\*\\*");
    expect(embed.description).toContain("\\_italic\\_");
  });

  it("replaces an em dash with a spaced en dash, wherever a model slipped one in", () => {
    const embed = buildDiscordEmbed(
      alert({ analysis: analysis({ summary: "Render shipped plans—lots of them." }) }),
    );
    expect(embed.description).not.toContain("—");
    expect(embed.description).toContain("plans \u2013 lots");
  });
});

describe("Discord's own limits", () => {
  it("is inside every cap for a normal alert", () => {
    const embed = buildDiscordEmbed(alert());
    expect(embed.title.length).toBeLessThanOrEqual(EMBED_LIMITS.title);
    expect(embed.description.length).toBeLessThanOrEqual(EMBED_LIMITS.description);
    expect(embed.fields.length).toBeLessThanOrEqual(EMBED_LIMITS.fields);
    expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_LIMITS.total);
  });

  it("trims an oversized title, field name, field value, and footer", () => {
    const embed = enforceEmbedLimits({
      title: "t".repeat(400),
      description: "d".repeat(100),
      color: 0,
      fields: [{ name: "n".repeat(400), value: "v".repeat(2_000) }],
      footer: { text: "f".repeat(3_000) },
    });

    expect(embed.title.length).toBe(EMBED_LIMITS.title);
    expect(embed.fields[0]?.name.length).toBe(EMBED_LIMITS.fieldName);
    expect(embed.fields[0]?.value.length).toBe(EMBED_LIMITS.fieldValue);
    expect(embed.footer?.text.length).toBe(EMBED_LIMITS.footer);
    expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_LIMITS.total);
  });

  it("gives back the description when dropping every field is still not enough", () => {
    const embed = enforceEmbedLimits({
      title: "Render: something",
      description: "d".repeat(5_000),
      color: 0,
      fields: [{ name: "Impact", value: "Major" }],
      footer: { text: "f".repeat(2_000) },
    });

    expect(embed.description.length).toBeLessThan(5_000);
    expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_LIMITS.total);
  });

  it("drops fields from the end until the whole embed fits the 6000-character budget", () => {
    const embed = enforceEmbedLimits({
      title: "Render: something",
      description: "d".repeat(4_000),
      color: 0,
      fields: Array.from({ length: 10 }, (_, index) => ({
        name: `field ${index}`,
        value: "v".repeat(1_000),
      })),
    });

    expect(embedLength(embed)).toBeLessThanOrEqual(EMBED_LIMITS.total);
    // The sentence and the impact are what anyone reads first, so the cut
    // comes off the far end.
    expect(embed.fields[0]?.name).toBe("field 0");
    expect(embed.fields.length).toBeLessThan(10);
  });

  it("keeps at most 25 fields", () => {
    const embed = enforceEmbedLimits({
      title: "t",
      description: "d",
      color: 0,
      fields: Array.from({ length: 40 }, (_, index) => ({ name: `f${index}`, value: "v" })),
    });
    expect(embed.fields).toHaveLength(EMBED_LIMITS.fields);
  });
});
