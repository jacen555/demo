// FAKE FFMPEG: a controlled ffmpeg, so remux-music's --apply path can be tested.
//
// WHY THIS EXISTS
//
// remux-music does its real work only under --apply, and everything interesting happens
// AFTER ffmpeg returns: the video-stream md5 comparison, the verdict, and the publish of
// the gain pin. With no ffmpeg on the machine every --apply test stops at "ffmpeg failed",
// three checks short of the pin — so removing the `writeGainLock` call entirely left the
// whole suite green. The pin is the point of the mix registry; it had no test that it is
// ever actually written.
//
//   nodeArgs: ['--import', fakeFfmpeg({ dir, ffmpeg: FAKE_FFMPEG })]
//   runScript('remux-music.mjs', [..., '--ffmpeg', FAKE_FFMPEG, '--apply'], dir, {...})
//
// WHAT IT FAKES, AND ONLY THAT
//
// It redirects `node:child_process` for ONE child process to a wrapper that re-exports the
// real module with `execFileSync` intercepted — and intercepted ONLY when the executable
// is the exact marker path the test passed as --ffmpeg. Every other call, and every other
// child_process function, goes to the real implementation untouched.
//
// Two invocations are recognised, which are the two remux-music makes:
//   - `-f md5 -`  : the digest probe. It reads the VIDEO STREAM only — the bytes before
//                   the mark the fake writes between the copied stream and everything
//                   else — so the before/after comparison is a real comparison. A fake
//                   returning one constant would report the streams identical whatever
//                   happened, which is the guarantee under test.
//   - otherwise   : the remux itself. It writes the output file named last in the
//                   argument list: the first input copied byte for byte, then the mark,
//                   then the other inputs. It honours -n by refusing to overwrite.
//
// `corruptVideo=true` makes the copy NOT a copy, so a test can prove the verdict is live
// rather than always passing.
//
// It never runs ffmpeg, never touches the network, and writes only the output path the
// engine asked for, which must be inside the suite-owned temp directory (see
// suite-owned-path.mjs). Anything else throws, loudly, and writes nothing.
//
// LIMITS: it proves what happens AROUND ffmpeg, never what ffmpeg does. No audio is
// mixed, no filter graph is executed, and a graph that ffmpeg would reject is accepted
// here. Tests that need real mixing need real ffmpeg; tests of the engine's own
// decisions — the verdict, the pin — are what this is for.
//
// It is a TEST fixture. Nothing in src/ may import it.
import { register } from "node:module";

const params = new URL(import.meta.url).searchParams;
if (!params.get("dir") || !params.get("ffmpeg")) {
    throw new Error("fake-ffmpeg: its --import URL must carry dir and ffmpeg");
}

const hooks = new URL("./fake-ffmpeg-hooks.mjs", import.meta.url);
hooks.search = params.toString();
register(hooks.href, import.meta.url);
