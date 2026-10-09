// The counted `music-metadata` stand-in. Delegates to the REAL library for the first
// `FAIL_PROBE_AFTER` calls, then throws on every call after that.
//
// It delegates rather than fabricating durations because the measurements before the
// injected failure must stay real — a stand-in that invented them would change the gap
// solve and the reflow, and the test would no longer be exercising the code it claims to.
const REAL = await import(
    new URL("../../node_modules/music-metadata/lib/index.js", import.meta.url)
        .href
);

let calls = 0;
const limit = Number(process.env.FAIL_PROBE_AFTER ?? 0);
// Fail ONLY this call number (1-based), then behave normally. Lets a test exercise the
// retry RECOVERING, which `FAIL_PROBE_AFTER` cannot: that one throws on every later call,
// so the run can only ever exhaust its attempts.
const only =
    process.env.FAIL_PROBE_ONLY === undefined
        ? null
        : Number(process.env.FAIL_PROBE_ONLY);

export async function parseFile(...args) {
    calls++;
    const fails = only === null ? calls > limit : calls === only;
    if (fails) {
        const err = new Error(
            `fail-probe: refusing to measure audio (call ${calls}${only === null ? `, limit ${limit}` : ", one-shot"})`,
        );
        err.code = "FAIL_PROBE";
        throw err;
    }
    return REAL.parseFile(...args);
}

export default { parseFile };
