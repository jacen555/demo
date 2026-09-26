/*
 * The video-stream verdict for the cheap remux path.
 *
 * `remux-music.mjs` copies the video stream with `-c:v copy` and then hashes it before
 * and after. That hash is the entire justification for the cheap path: if the stream
 * changed, the output is a re-encode wearing the cheap path's name and must not be
 * published as the approved render.
 *
 * This lives in its own module because `remux-music.mjs` executes on import, so the
 * branch could not be reached by a test while it was inline — which is how it survived
 * a round of review still only printing a warning and exiting 0.
 */
import { EXIT } from './cli-support.mjs';

/**
 * ffmpeg's `-f md5 -` muxer emits exactly one line: `MD5=<32 lowercase hex digits>`.
 *
 * Parsing it is the point. Comparing two unvalidated strings answers "are these equal",
 * when the property is "are these both well-formed digests AND equal" — `oops` equals
 * `oops`, and an ffmpeg that printed a warning instead of a digest would have been
 * reported as proof the video stream survived.
 */
const MD5_LINE = /^MD5=([0-9a-fA-F]{32})$/;

function parseDigest(raw) {
  const match = MD5_LINE.exec(String(raw ?? '').trim());
  return match ? match[1].toLowerCase() : null;
}

/**
 * Decides whether the remux preserved the video stream.
 *
 * @param {string} beforeOutput ffmpeg's `-f md5` output for the source video stream
 * @param {string} afterOutput  ffmpeg's `-f md5` output for the remuxed video stream
 * @param {string} outputName   basename of the output, for the message
 * @returns {{identical: boolean, exitCode: number, message: string}}
 */
export function videoStreamVerdict(beforeOutput, afterOutput, outputName = 'the output') {
  const before = parseDigest(beforeOutput);
  const after = parseDigest(afterOutput);

  if (before === null || after === null) {
    const bad = [
      before === null ? `source=${JSON.stringify(String(beforeOutput ?? '').trim())}` : null,
      after === null ? `remuxed=${JSON.stringify(String(afterOutput ?? '').trim())}` : null,
    ].filter(Boolean).join(', ');
    return {
      identical: false,
      exitCode: EXIT.FAILED,
      message:
        `could not read an MD5 digest from ffmpeg (${bad}). Equal-but-unparsed output is not ` +
        `evidence that either digest was computed, so the bit-identical guarantee is ` +
        `unverified and ${outputName} must not be published.`,
    };
  }

  if (before !== after) {
    return {
      identical: false,
      exitCode: EXIT.FAILED,
      message:
        `the video stream CHANGED (${before} -> ${after}). The whole point of this path is a ` +
        `bit-identical video stream, so ${outputName} must not be treated as the approved ` +
        `render. Investigate before publishing.`,
    };
  }

  return { identical: true, exitCode: EXIT.OK, message: 'VIDEO STREAM IDENTICAL' };
}
