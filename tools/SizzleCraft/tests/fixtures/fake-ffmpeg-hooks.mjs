// Resolve hook behind fake-ffmpeg.mjs. In one child process it sends `node:child_process`
// to the wrapper in fake-ffmpeg-backend.mjs. Every other specifier resolves normally, and
// the wrapper's own import of the real module is let through — without that exception it
// would resolve to itself.
const params = new URL(import.meta.url).searchParams;
const backend = new URL("./fake-ffmpeg-backend.mjs", import.meta.url);
backend.search = params.toString();

const CHILD_PROCESS = new Set(["node:child_process", "child_process"]);

export async function resolve(specifier, context, nextResolve) {
    if (CHILD_PROCESS.has(specifier) && context.parentURL !== backend.href) {
        return { url: backend.href, format: "module", shortCircuit: true };
    }
    return nextResolve(specifier, context);
}
