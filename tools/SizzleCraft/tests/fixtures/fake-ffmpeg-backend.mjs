// The wrapper fake-ffmpeg-hooks.mjs puts in front of `node:child_process`. It re-exports
// the real module and replaces `execFileSync` for ONE executable — the marker path the
// test passes as --ffmpeg. fake-ffmpeg.mjs explains the model and the limits.
//
// A test may not import this directly: it is only meaningful behind the hook, whose
// parentURL exception is what lets the import below reach the real module.
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import * as real from 'node:child_process';
import { requireTestOwnedPath } from './suite-owned-path.mjs';

const params = new URL(import.meta.url).searchParams;
const dir = fs.realpathSync.native(params.get('dir'));
const FFMPEG = params.get('ffmpeg');
/** Opt-in: the remux alters the video stream, which remux-music must refuse to publish. */
const CORRUPT_VIDEO = params.get('corruptVideo') === 'true';

/**
 * Where the fake's output stops being the copied video stream and starts being everything
 * else. The real `-map 0:v -c copy` digest reads only the video stream, so a fake that
 * hashed the whole container would report every remux as having changed it — and the
 * guarantee under test is precisely that it did not.
 */
const AUDIO_MARK = Buffer.from('\u0000FAKE-FFMPEG-AUDIO\u0000', 'utf8');

/** The digest ffmpeg would print for a file's VIDEO STREAM, stable per those bytes. */
function digestOf(file) {
  const bytes = fs.readFileSync(file);
  const at = bytes.indexOf(AUDIO_MARK);
  const video = at === -1 ? bytes : bytes.subarray(0, at);
  return `MD5=${crypto.createHash('md5').update(video).digest('hex')}\n`;
}

/** The input named by the first `-i`: the video, which remux-music always passes first. */
function videoInputOf(args) {
  const i = args.indexOf('-i');
  if (i === -1 || args[i + 1] === undefined) {
    throw new Error(`fake-ffmpeg: no -i input in ${JSON.stringify(args)}`);
  }
  return args[i + 1];
}

function remux(args) {
  const outPath = args.at(-1);
  // The engine only ever asks for an output inside the project it was pointed at. A
  // fixture that wrote anywhere else would be a fixture that can destroy a real file.
  const target = requireTestOwnedPath(outPath, 'fake-ffmpeg output', { mayBeAbsent: true });
  if (!target.startsWith(`${dir}${path.sep}`)) {
    throw new Error(`fake-ffmpeg: refusing to write ${target}, which is outside ${dir}`);
  }
  if (args.includes('-n') && fs.existsSync(target)) {
    const err = new Error(`fake-ffmpeg: ${target} already exists and -n was passed`);
    err.status = 1;
    throw err;
  }
  const inputs = args.reduce((acc, arg, i) => (arg === '-i' ? [...acc, args[i + 1]] : acc), []);
  // The video stream COPIED, byte for byte, then everything else behind the mark — which
  // is what `-c:v copy` promises and what the verdict checks. With corruptVideo the copy
  // is not a copy, so the verdict must refuse the output.
  const video = fs.readFileSync(inputs[0]);
  const stream = CORRUPT_VIDEO ? Buffer.concat([video, Buffer.from('re-encoded', 'utf8')]) : video;
  const rest = inputs.slice(1).map((file) => fs.readFileSync(file));
  fs.writeFileSync(target, Buffer.concat([stream, AUDIO_MARK, ...rest]));
  return '';
}

export function execFileSync(file, args = [], options = {}) {
  if (file !== FFMPEG) return real.execFileSync(file, args, options);
  const out = args.includes('-f') && args[args.indexOf('-f') + 1] === 'md5'
    ? digestOf(videoInputOf(args))
    : remux(args);
  // `stdio: 'inherit'` means the caller wants nothing back, exactly as the real one.
  return options.encoding ? out : Buffer.from(out);
}

export const {
  exec, execFile, execSync, fork, spawn, spawnSync, ChildProcess,
} = real;

export default { ...real, execFileSync };
