// Resolves the shipped silence asset in the project root and prints its path.
//
// Asked for --help, this used to throw at MODULE SCOPE — before any argument could be
// read — so the one flag that must never do work was the one that crashed. The check now
// lives behind parseCli, and the missing-asset case is a CliError rather than a raw throw,
// so it reports `error: …` and exit 2 instead of a stack trace.
import fs from "node:fs";
import path from "node:path";
import { CliError, guard, parseCli } from "./cli-support.mjs";

const USAGE = `
silence-asset — print the path to the project's shipped silence.mp3.

  node silence-asset.mjs                 print the resolved path
  node silence-asset.mjs --project <dir> resolve inside another project root

Options
  --project <dir>   project root to look in (default: current directory)
  --help            show this message

Reads nothing and writes nothing; it only resolves and prints.

Exit codes: 0 success · 2 bad usage, or the asset is missing`.trim();

guard(() => {
  const { projectDir } = parseCli({ usage: USAGE });
  const silencePath = path.join(projectDir, "silence.mp3");

  if (!fs.existsSync(silencePath)) {
    throw new CliError(
      `missing ${silencePath}; copy the shipped mono 24 kHz silence.mp3 asset into the project dir`,
    );
  }

  console.log(silencePath);
});
