// Resolve hook behind fail-probe.mjs. Sends `music-metadata` to a wrapper that counts
// calls and throws once the configured number of successes has been used up. Every other
// specifier resolves normally, so this composes with fake-audio-hooks.mjs, which claims a
// disjoint set of specifiers.
const WRAPPER = new URL("./fail-probe-backend.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (
    specifier === "music-metadata" &&
    (process.env.FAIL_PROBE_AFTER !== undefined ||
      process.env.FAIL_PROBE_ONLY !== undefined)
  ) {
    return { url: WRAPPER, format: "module", shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
