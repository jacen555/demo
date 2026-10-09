// The wrapper _fake-astats-hooks.mjs puts in front of `node:child_process`. It re-exports
// the real module and replaces `spawnSync` for ONE executable — the marker path the test
// passes as --ffmpeg. _fake-astats.mjs explains the model and the limits.
//
// A test may not import this directly: it is only meaningful behind the hook, whose
// parentURL exception is what lets the import below reach the real module.
import * as real from "node:child_process";

const params = new URL(import.meta.url).searchParams;
const FFMPEG = params.get("ffmpeg");
/** The reading for the whole-file run: no window flag in the argument list. */
const WHOLE = params.get("whole");
/** The reading for the lead-in and tail runs. Defaults to the whole-file one. */
const WINDOW = params.get("window") ?? WHOLE;

/** The input dump ffmpeg prints before the measurement, declaring a real audio stream. */
const INPUT_DUMP = `Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'render.mp4':
  Duration: 00:04:12.19, start: 0.000000, bitrate: 12043 kb/s
  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p, 3840x2160, 30 fps
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 191 kb/s (default)
`;

/** astats as ffmpeg prints it, on stderr, which is where check-levels reads it from. */
function astats(peak, rms) {
    return `${INPUT_DUMP}[Parsed_astats_0 @ 000001f2c0] Channel: 1
[Parsed_astats_0 @ 000001f2c0] Peak level dB: ${peak}
[Parsed_astats_0 @ 000001f2c0] RMS level dB: ${rms}
[Parsed_astats_0 @ 000001f2c0] RMS trough dB: -inf
[Parsed_astats_0 @ 000001f2c0] Noise floor dB: -inf
[Parsed_astats_0 @ 000001f2c0] Overall
[Parsed_astats_0 @ 000001f2c0] Peak level dB: ${peak}
[Parsed_astats_0 @ 000001f2c0] RMS level dB: ${rms}
`;
}

/**
 * Which window check-levels asked for. It measures the whole file with no seek flags, the
 * lead-in with `-t`, and the tail with `-sseof`, so the absence of both IS the whole-file
 * run. Reading it off the arguments rather than off a call counter means the fake does not
 * care what order the windows are measured in.
 */
function readingFor(args) {
    const windowed = args.includes("-t") || args.includes("-sseof");
    const [peak, rms] = (windowed ? WINDOW : WHOLE).split(",");
    return astats(peak, rms);
}

export function spawnSync(file, args = [], options = {}) {
    if (file !== FFMPEG) return real.spawnSync(file, args, options);
    return {
        status: 0,
        signal: null,
        pid: 0,
        stdout: "",
        stderr: readingFor(args),
        output: [],
    };
}

export const {
    exec,
    execFile,
    execFileSync,
    execSync,
    fork,
    spawn,
    ChildProcess,
} = real;

export default { ...real, spawnSync };
