import { FALLBACK_MODEL } from "../analysis/fallback.js";
import { COMPETITORS } from "../config.js";
import { actionTitleParts, IMPACT_COLOR, IMPACT_LABEL, SOURCE_LABEL } from "../labels.js";
import { entryUrl } from "../sources/link.js";
import type { ActionIssue, Alert, IssueRef, RecommendedAction, SourceId } from "../types.js";
import { firstSentence, sanitizeCopy, sentences, SPACED_EN_DASH, truncate } from "../util/text.js";

/**
 * One signal is one embed. Discord renders an embed in a fixed order – title,
 * description, fields, image, footer – so the feature image sits under the
 * fields rather than above them. That is the one place the rendered alert
 * cannot match the order the plan asks for, and splitting the image into a
 * message of its own would cost the thing the plan cares about more: one
 * signal arriving as one thing you can read without scrolling past a second
 * message to find its actions.
 */
export interface DiscordEmbedField {
  name: string;
  value: string;
  inline?: boolean;
}

export interface DiscordEmbed {
  title: string;
  url?: string;
  description: string;
  color: number;
  timestamp?: string;
  fields: DiscordEmbedField[];
  image?: { url: string };
  footer?: { text: string };
}

export interface DiscordMessage {
  embeds: DiscordEmbed[];
  /** Nothing in an alert should ever ping anyone. */
  allowed_mentions: { parse: [] };
}

/** Discord's own caps, which a message is trimmed to before it is sent. */
export const EMBED_LIMITS = {
  title: 256,
  description: 4_096,
  fieldName: 256,
  fieldValue: 1_024,
  fields: 25,
  footer: 2_048,
  total: 6_000,
} as const;

export const ISSUE_LINK_LABEL = "Access GitHub issue";

/** The one sentence lives under this heading; the bullets under the next one. */
export const KNOW_HEADING = "What you need to KNOW";
export const DETAIL_HEADING = "More detail";
export const IMPACT_HEADING = "Impact";
/** Plural in the heading, because an alert often needs a page fix and a feature gap. */
export const ACTION_HEADING = "Recommended action(s)";

/** Short enough that nothing in the embed wraps into a wall of text. */
const MAX_LEAD_CHARS = 240;
const MAX_POINT_CHARS = 160;
const MAX_POINTS = 4;
/**
 * The one sentence under an action title, which leads with the work to do and
 * so runs longer than a bare description of the gap. Two short lines on a
 * phone, not a paragraph, and the prompt asks for the same budget.
 */
export const MAX_ACTION_CHARS = 220;
const MAX_ACTIONS = 3;

/**
 * Discord markdown treats these as control characters. Every string routed
 * through here is also punctuated the way this bot writes, which is the last
 * gate before a message goes out.
 */
export function escape(text: string): string {
  return sanitizeCopy(text).replace(/([*_`~|\\])/g, "\\$1");
}

function link(url: string, label: string): string {
  // A label is escaped; a URL inside `()` is not, because escaping it breaks it.
  return `[${escape(truncate(label, 140))}](${url})`;
}

/**
 * The link under one action. Every action has an issue of its own, so the
 * number is part of the label: three links reading "Access GitHub issue"
 * would be indistinguishable on a phone.
 */
export function issueLinkLabel(issue: IssueRef): string {
  return `${ISSUE_LINK_LABEL} #${issue.number}`;
}

/**
 * The one sentence under "What you need to KNOW". It has to say which
 * competitor did what, so the competitor's name is added only when the
 * sentence lacks it.
 */
export function leadSentence(alert: Alert): string {
  const label = COMPETITORS[alert.item.competitor].label;
  const lead = firstSentence(alert.analysis.summary, MAX_LEAD_CHARS);
  return lead.toLowerCase().includes(label.toLowerCase()) ? lead : `${label}: ${lead}`;
}

/**
 * The sources the KNOW line can link, labeled by `SOURCE_LABEL` like every
 * other place the source is tagged. A newsletter is not one of them: its URL
 * is a thread in our own inbox, which nobody else can open.
 */
const LINKED_SOURCES: readonly SourceId[] = ["changelog", "blog", "x"];

/** The source link that sits with the KNOW sentence, named by its label. */
export function knowSourceLink(alert: Alert): string | null {
  if (!LINKED_SOURCES.includes(alert.item.source)) return null;
  const url = entryUrl(alert.item);
  return /^https?:\/\//i.test(url) ? link(url, SOURCE_LABEL[alert.item.source]) : null;
}

/**
 * The bullets that elaborate on the one sentence, never repeat it. Analyses
 * written before key points existed fall back to the rest of their summary.
 */
export function detailPoints(alert: Alert): string[] {
  const { keyPoints, summary } = alert.analysis;
  const source = keyPoints.length > 0 ? keyPoints : sentences(summary).slice(1);
  return source
    .map((point) => truncate(point.trim(), MAX_POINT_CHARS))
    .filter(Boolean)
    .slice(0, MAX_POINTS);
}

/**
 * One action, as the embed shows it: a bold title, one short sentence under
 * it, then the link to that action's own issue. The title is in the value
 * rather than the field name because Discord renders a field name as plain
 * text, and the Railway surface in it is worth linking.
 */
export function actionFieldValue(action: RecommendedAction, issue: IssueRef | null): string {
  const { label, feature } = actionTitleParts(action);
  const title = !feature
    ? escape(label)
    : `${escape(label)} ${feature.url ? link(feature.url, feature.label) : escape(feature.label)}`;
  const lines = [`**${title}**`, escape(firstSentence(action.detail, MAX_ACTION_CHARS))];
  if (issue) lines.push(link(issue.url, issueLinkLabel(issue)));
  return lines.join("\n");
}

/**
 * Discord will not render a field with an empty name, so the actions after the
 * first sit under a zero-width space: the heading is said once, and every
 * action after it reads as another entry under the same heading.
 */
export const BLANK_FIELD_NAME = "\u200b";

/**
 * The actions to render, each paired with its own issue. The analysis is the
 * spine, so an alert whose issues were never opened – a dry run, or a run with
 * no token – still shows every action, just without a link under it.
 */
export function actionEntries(alert: Alert): ActionIssue[] {
  return alert.analysis.actions.slice(0, MAX_ACTIONS).map((action, index) => ({
    action,
    issue: alert.issues[index]?.issue ?? null,
  }));
}

/** What the action field says when there is nothing to do. */
export const NO_ACTION_TITLE = "None";
const FALLBACK_NO_ACTION_REASON =
  "Nothing here asks anything of Railway, and no reason was recorded.";

/**
 * Zero actions rendered as an answer rather than as a blank.
 *
 * A launch that asks nothing of Railway is a normal outcome and a useful one:
 * it says somebody looked. An empty field would read as a broken alert, and a
 * missing field would read as an alert nobody finished, so the reason goes
 * where the actions would have been.
 */
export function noActionValue(alert: Alert): string {
  const reason = alert.analysis.noActionReason?.trim() || FALLBACK_NO_ACTION_REASON;
  return [`**${NO_ACTION_TITLE}**`, escape(truncate(reason, EMBED_LIMITS.fieldValue - 40))].join(
    "\n",
  );
}

/** How much of Discord's 6000-character budget an embed spends. */
export function embedLength(embed: DiscordEmbed): number {
  return (
    embed.title.length +
    embed.description.length +
    (embed.footer?.text.length ?? 0) +
    embed.fields.reduce((total, field) => total + field.name.length + field.value.length, 0)
  );
}

/**
 * Bring an embed inside Discord's caps. Fields are dropped from the end, which
 * is the detail and then the last action, because the first thing anyone reads
 * is the sentence and the impact. An embed over the limit is rejected outright
 * by the API, so this runs before every post.
 */
export function enforceEmbedLimits(embed: DiscordEmbed): DiscordEmbed {
  const trimmed: DiscordEmbed = {
    ...embed,
    title: truncate(embed.title, EMBED_LIMITS.title),
    description: truncate(embed.description, EMBED_LIMITS.description),
    fields: embed.fields.slice(0, EMBED_LIMITS.fields).map((field) => ({
      ...field,
      name: truncate(field.name, EMBED_LIMITS.fieldName),
      value: truncate(field.value, EMBED_LIMITS.fieldValue),
    })),
    ...(embed.footer ? { footer: { text: truncate(embed.footer.text, EMBED_LIMITS.footer) } } : {}),
  };

  while (embedLength(trimmed) > EMBED_LIMITS.total && trimmed.fields.length > 0) {
    trimmed.fields = trimmed.fields.slice(0, -1);
  }

  // With no fields left there is only the sentence to give back. A real alert
  // never gets here – its description is a couple of hundred characters – but
  // an embed over the budget is refused outright, so the guard has to be able
  // to return something postable rather than something nearly postable.
  const overflow = embedLength(trimmed) - EMBED_LIMITS.total;
  if (overflow > 0) {
    trimmed.description = truncate(
      trimmed.description,
      Math.max(0, trimmed.description.length - overflow),
    );
  }

  return trimmed;
}

export function buildDiscordEmbed(alert: Alert): DiscordEmbed {
  const { item, analysis, model, image, issueNote } = alert;
  const competitor = COMPETITORS[item.competitor];
  const lead = leadSentence(alert);
  const sourceLink = knowSourceLink(alert);
  const points = detailPoints(alert);

  const fields: DiscordEmbedField[] = [
    { name: IMPACT_HEADING, value: IMPACT_LABEL[analysis.impact] },
  ];

  if (points.length > 0) {
    fields.push({
      name: DETAIL_HEADING,
      value: points.map((point) => `- ${escape(point)}`).join("\n"),
    });
  }

  const entries = actionEntries(alert);
  for (const [index, entry] of entries.entries()) {
    fields.push({
      name: index === 0 ? ACTION_HEADING : BLANK_FIELD_NAME,
      value: actionFieldValue(entry.action, entry.issue),
    });
  }
  if (entries.length === 0) {
    fields.push({ name: ACTION_HEADING, value: noActionValue(alert) });
  }

  // `every` on an empty list is true, which used to put "GitHub issues not
  // created" under an alert that never asked for one.
  if (issueNote && entries.length > 0 && entries.every((entry) => entry.issue === null)) {
    fields.push({ name: "Note", value: escape(issueNote) });
  }

  const footer = [
    competitor.label,
    SOURCE_LABEL[item.source],
    model === FALLBACK_MODEL
      ? `not model-analyzed (CURSOR_API_KEY unset)${SPACED_EN_DASH}the summary is lifted from the source`
      : model,
  ].join(" · ");

  return enforceEmbedLimits({
    title: sanitizeCopy(`${competitor.label}: ${item.title}`),
    url: entryUrl(item),
    description: `**${KNOW_HEADING}**\n${escape(lead)}${sourceLink ? ` (${sourceLink})` : ""}`,
    color: IMPACT_COLOR[analysis.impact],
    ...(item.publishedAt ? { timestamp: item.publishedAt.toISOString() } : {}),
    fields,
    image: { url: image.url },
    footer: { text: sanitizeCopy(footer) },
  });
}

export function buildDiscordMessage(alert: Alert): DiscordMessage {
  return { embeds: [buildDiscordEmbed(alert)], allowed_mentions: { parse: [] } };
}

/** The embed as text, for logs and dry-run artifacts. */
export function renderEmbedText(message: DiscordMessage): string {
  const [embed] = message.embeds;
  if (!embed) return "";

  const parts = [`**${embed.title}**`, embed.description];
  for (const field of embed.fields) {
    parts.push(`**${field.name}**\n${field.value}`);
  }
  if (embed.image) parts.push(`![feature image](${embed.image.url})`);
  if (embed.footer) parts.push(`_${embed.footer.text}_`);
  return parts.join("\n\n");
}
