// Resolve hook behind fake-ffmpeg.mjs and _fake-astats.mjs. In one child process it sends
// `node:child_process` to the wrapper whose URL (query string included) its registrar passes
// as `data.backend`. Every other specifier resolves normally, and the wrapper's own import of
// the real module is let through — without that exception it would resolve to itself.
let backend;

export function initialize(data) {
  backend = data.backend;
}

const CHILD_PROCESS = new Set(['node:child_process', 'child_process']);

export async function resolve(specifier, context, nextResolve) {
  if (CHILD_PROCESS.has(specifier) && context.parentURL !== backend) {
    return { url: backend, format: 'module', shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
