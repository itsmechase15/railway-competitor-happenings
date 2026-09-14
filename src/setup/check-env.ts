#!/usr/bin/env node
import { parseArgs } from "node:util";
import "dotenv/config";
import { createLogger } from "../log.js";
import { checkEnv, formatReport, isFailing } from "./requirements.js";

const log = createLogger("check-env");

/**
 * Preflight for the daily job, and the first thing to run on a fresh clone.
 *
 * The workflows run it before the pipeline so a missing secret fails in the
 * first ten seconds, naming the variable and where its value comes from,
 * instead of surfacing as a Postgres timeout or an empty channel twenty
 * minutes in.
 *
 * Only the required secrets fail it. A missing source secret – X today – is
 * named and skipped, because the plan has X optional from phase 1 on and a run
 * without it still posts both changelogs and both blogs.
 *
 *   npm run check-env               what is missing, and what that costs
 *   npm run check-env -- --strict   every variable and whether it is set
 */
function main(): void {
  const { values } = parseArgs({ options: { strict: { type: "boolean" } } });
  const strict = values.strict === true;

  const report = checkEnv(process.env);
  const text = formatReport(report, strict);

  if (isFailing(report)) {
    log.error(`environment is not ready\n\n${text}\n`);
    process.exitCode = 1;
    return;
  }

  log.info(`environment looks runnable\n\n${text}\n`);
}

main();
