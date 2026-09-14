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
 *   npm run check-env               required secrets only
 *   npm run check-env -- --strict   every source too, for a full setup check
 */
function main(): void {
  const { values } = parseArgs({ options: { strict: { type: "boolean" } } });
  const strict = values.strict === true;

  const report = checkEnv(process.env);
  const text = formatReport(report, strict);

  if (isFailing(report, strict)) {
    log.error(`environment is not ready\n\n${text}\n`);
    process.exitCode = 1;
    return;
  }

  log.info(`environment looks runnable\n\n${text}\n`);
}

main();
