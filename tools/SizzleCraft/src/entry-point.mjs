import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Was the module at `importMetaUrl` the file Node was asked to execute, as opposed to one
 * merely imported?
 *
 * Decided by filesystem identity (device + inode), never by comparing path spellings.
 * `process.argv[1]` keeps the spelling the caller typed while `import.meta.url` is
 * resolved through links, so a directory junction made every string comparison false:
 * the CLI block was skipped and the tool exited 0 having done nothing.
 *
 * This module imports only node built-ins so that any module, including cli-support.mjs
 * and the CLIs it imports, can depend on it without an import cycle.
 *
 * Not `import.meta.main`: it is undefined before Node 24 and this engine pins node >=22,
 * where an `undefined` guard would silently never run the CLI.
 *
 * CONSUMERS(isEntryPoint): audio-probe.mjs, canonical-json.mjs, coach-rulings.mjs
 *
 * @param {string} importMetaUrl the caller's own `import.meta.url`
 * @returns {boolean} true only when argv[1] and the caller are the same file; false when
 *   there is no entry script (`node -e`, REPL) or either path cannot be statted
 */
export function isEntryPoint(importMetaUrl) {
  const entry = process.argv[1];
  if (!entry) return false;
  const identity = (p) => {
    try {
      const s = fs.statSync(p, { bigint: true });
      return `${s.dev}:${s.ino}`;
    } catch {
      return null;
    }
  };
  const self = identity(fileURLToPath(importMetaUrl));
  return self !== null && self === identity(entry);
}
