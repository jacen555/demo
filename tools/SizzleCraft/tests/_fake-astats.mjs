// A controlled ffmpeg for check-levels, so the GATE can be tested through the real CLI.
//
// WHY THIS EXISTS, AND WHY IT IS NOT tests/fixtures/fake-ffmpeg.mjs
//
// judgeDeliveredLevels can be tested as a function, and is. What that cannot show is that
// check-levels actually CALLS it, passes `wholeFile` to the right window, and turns its
// refusal into a non-zero exit. A gate that is correct but unwired exits 0 on a silent
// render, and every unit test still passes.
//
// The existing fixture intercepts `execFileSync` for remux-music. check-levels uses
// `spawnSync` and reads astats off stderr, so it needs a different interception, and
// tests/fixtures/ belongs to another stream. This pair is owned by
// delivered-level-gate.test.mjs and used by nothing else.
//
//   nodeArgs: ['--import', fakeAstats({ ffmpeg: MARKER, whole, window })]
//
// WHAT IT FAKES, AND ONLY THAT
//
// It redirects `node:child_process` in ONE child process to a wrapper that re-exports the
// real module with `spawnSync` replaced for ONE executable: the exact marker path the test
// passes as --ffmpeg. Every other executable and every other function is the real one.
// It answers with a canned astats block on stderr at status 0 — the WHOLE-FILE block when
// the argument list carries no window flag, and the WINDOW block when it carries `-t` or
// `-sseof`. That split is the point: it lets one run deliver a silent lead-in and measured
// audio overall, which is the correct render the gate must not refuse.
//
// LIMITS: it runs no ffmpeg and measures nothing. It proves what check-levels DOES with a
// reading, never that the reading is right — the readings it hands over are real astats
// output captured from real renders, and that is where their authority comes from.
//
// It is a TEST fixture. Nothing in src/ may import it.
import { register } from "node:module";

const params = new URL(import.meta.url).searchParams;
if (!params.get("ffmpeg") || !params.get("whole")) {
  throw new Error("fake-astats: its --import URL must carry ffmpeg and whole");
}

const backend = new URL("./_fake-astats-backend.mjs", import.meta.url);
backend.search = params.toString();
register("./fixtures/child-process-hooks.mjs", import.meta.url, {
  data: { backend: backend.href },
});
