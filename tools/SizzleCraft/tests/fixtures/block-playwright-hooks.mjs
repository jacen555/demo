// Block `playwright` resolution for a single child process, so the import-before-wipe
// ordering can be tested with a real module-resolution failure rather than simulated
// with a lock that stops the run earlier for a different reason.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'playwright' || specifier.startsWith('playwright/')) {
    const err = new Error("Cannot find package 'playwright' imported from the engine");
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return nextResolve(specifier, context);
}
