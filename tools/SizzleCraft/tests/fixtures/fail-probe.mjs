// FAIL THE AUDIO PROBE, ON DEMAND.
//
// voice.mjs stages a clip and only then probes it. The per-attempt cleanup in `synth`
// exists for exactly that window — a failure AFTER `stageBytes` has created a staging file
// — and nothing in the fake TTS service can produce one: every failure it can raise
// (empty stream, no boundaries) happens before the clip is staged.
//
// So the cleanup path was unreachable from the tests that claimed to cover it, which is
// the same shape as a guard that cannot fire. This loader substitutes `music-metadata` so
// that `parseFile` throws on the Nth call, putting a real failure in that window.
//
// Pass it ALONGSIDE fake-audio, which substitutes different modules:
//   nodeArgs: ['--import', FAKE_AUDIO, '--import', FAIL_PROBE]
//   env: { FAIL_PROBE_AFTER: '1' }   // succeed once, then throw on every later call
//
// With FAIL_PROBE_AFTER unset the loader does nothing, so an inherited environment cannot
// arm it in an unrelated run.
import { register } from 'node:module';

register('./fail-probe-hooks.mjs', import.meta.url);
