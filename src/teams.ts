import { ACTION_OWNER } from "./labels.js";
import { productsForAction } from "./railway/products.js";
import {
  findTeam,
  matchTeams,
  teamLabel,
  teamsOwningFeature,
  type RailwayTeam,
} from "./railway/teams.js";
import type { RecommendedAction } from "./types.js";

/**
 * Which Railway team an issue is for.
 *
 * `owner:product` says a roadmap owns it and names nobody. Railway's about
 * page names people by title, and the titles are the org, so an action about
 * per-request billing on an idle service is for Infrastructure Engineering,
 * one about a usage limit is for Product Engineering, and one about an MCP
 * launch is for Agentic Experience. Every one of those is a filter somebody
 * can subscribe to, which "product" never was.
 *
 * The model chooses, and everything else is the fallback for when it did not.
 * It is the only reader with the whole signal in front of it, and the prompt
 * gives it every team name and what each one owns, so a list it wrote wins
 * outright once each name has been found in the catalog. A team that is not on
 * the about page is dropped rather than mapped to something near it, which is
 * why the fallback has to be good: a reply that names only departments falls
 * all the way through it.
 *
 * Falling through, strongest first:
 *
 * 1. Who owns the surface the action names, and the surfaces its own words are
 *    about. The app already knows which Railway product a signal is about, and
 *    the catalog says who builds it.
 * 2. The team vocabulary in the action's own text, for a signal that names no
 *    surface we recognize.
 * 3. A default, used only when both of those found nothing at all, so an issue
 *    never lands with nobody's name on it.
 */

/**
 * Three is the cap, and it is a real one: a list of teams that long is the same
 * as naming none of them. One or two is the normal answer.
 */
export const MAX_TEAMS = 3;

/**
 * Where an action goes when nothing else matched, and only then. Page work
 * belongs to Marketing, who write the compare, migrate, pricing, and features
 * pages. Product work with no recognizable surface goes to Product
 * Engineering, the seven people whose title is the work – a guess, but a named
 * one somebody can reroute, which is more than "product" ever was.
 */
const DEFAULT_TEAM_NAMES: Record<"marketing" | "product", string> = {
  marketing: "Marketing",
  product: "Product Engineering",
};

/** The words one action is routed on: the surface it names and its detail. */
function actionText(action: RecommendedAction): string {
  return `${action.feature ?? ""} ${action.detail}`;
}

/** The model's own suggestions, minus anything that is not a Railway team. */
function suggestedTeams(action: RecommendedAction): RailwayTeam[] {
  return (action.teams ?? [])
    .map((name) => findTeam(name))
    .filter((team): team is RailwayTeam => team !== undefined);
}

/**
 * The teams that own what this action is about: the surface it names first,
 * then the owners of the Railway products its own words match. Reusing the
 * product matcher is the point – it is already tuned to read a signal, and the
 * team catalog turns each surface it finds into the team that builds it.
 */
function featureOwners(action: RecommendedAction): RailwayTeam[] {
  const features = [
    ...(action.feature ? [action.feature] : []),
    ...productsForAction(action).map((product) => product.label),
  ];
  return features.flatMap((feature) => teamsOwningFeature(feature));
}

function defaultTeams(action: RecommendedAction): RailwayTeam[] {
  const team = findTeam(DEFAULT_TEAM_NAMES[ACTION_OWNER[action.type]]);
  return team ? [team] : [];
}

/**
 * The teams one action is for, most involved first. Always at least one, never
 * more than three, and every one of them a team the about page names.
 */
export function relatedTeams(action: RecommendedAction): RailwayTeam[] {
  const suggested = suggestedTeams(action);
  if (suggested.length > 0) return [...new Set(suggested)].slice(0, MAX_TEAMS);

  const derived = new Set([...featureOwners(action), ...matchTeams(actionText(action), MAX_TEAMS)]);
  const teams = derived.size > 0 ? [...derived] : defaultTeams(action);
  return teams.slice(0, MAX_TEAMS);
}

/** The teams as an issue reads them: "Infrastructure Engineering, Marketing". */
export function relatedTeamsLabel(action: RecommendedAction): string {
  return relatedTeams(action).map(teamLabel).join(", ");
}
