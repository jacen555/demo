// Resolve hook behind fake-audio.mjs. In one child process it sends `msedge-tts` and
// `playwright` to the in-process fakes. Every other specifier resolves normally.
const FAKE_BACKENDS = new URL("./fake-audio-backends.mjs", import.meta.url)
    .href;
const FAKED = new Set(["msedge-tts", "playwright"]);

export async function resolve(specifier, context, nextResolve) {
    if (FAKED.has(specifier))
        return { url: FAKE_BACKENDS, format: "module", shortCircuit: true };
    return nextResolve(specifier, context);
}
