/*
 * Audio-only remux: mixes the ambient bed under the narration and muxes it
 * back onto the ALREADY-ENCODED video stream with -c:v copy, so the video is
 * bit-identical and no re-render is needed (~1 min instead of ~27).
 *
 * Levels are the ones approved on Part 1:
 *   voice  volume=<encoder normalisation gain>   (encode-mp4 logs it; 1.14 this run)
 *   music  volume=1.50                           (+3.5 dB, the "slightly louder" pass)
 *   amix   normalize=0                           (do NOT let amix halve both buses)
 *   alimiter limit=0.891                         (-1.0 dBFS ceiling)
 *
 * Mono -> stereo uses pan, NOT aformat: aformat applies -3 dB power
 * compensation and quietly drops the narration level.
 *
 * Output is 24 kHz stereo to match the delivered Part 1 exactly.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import crypto from 'node:crypto';

const FF = fs.readFileSync('ffmpeg-path.txt', 'utf8').trim();
const VIDEO = 'interviewer-qna-delta.mp4';
const OUT = 'interviewer-qna-delta-with-music.mp4';
const VOICE_GAIN = process.argv[2] || '1.14';
const MUSIC_GAIN = process.argv[3] || '1.50';

const filter =
  `[1:a]volume=${VOICE_GAIN},pan=stereo|c0=c0|c1=c0[vo];` +
  `[2:a]volume=${MUSIC_GAIN}[mu];` +
  `[vo][mu]amix=inputs=2:duration=longest:normalize=0[mx];` +
  `[mx]alimiter=limit=0.891:level=disabled[out]`;

console.log(`voice ${VOICE_GAIN} · music ${MUSIC_GAIN}`);
execFileSync(FF, [
  '-y', '-hide_banner', '-loglevel', 'error',
  '-i', VIDEO, '-i', 'voiceover.mp3', '-i', 'music.wav',
  '-filter_complex', filter,
  '-map', '0:v', '-c:v', 'copy',
  '-map', '[out]', '-c:a', 'aac', '-b:a', '160k', '-ar', '24000', '-ac', '2',
  '-movflags', '+faststart',
  OUT
], { stdio: 'inherit' });

// prove the video stream survived untouched
const md5 = f => {
  const raw = execFileSync(FF, ['-hide_banner', '-loglevel', 'error', '-i', f,
    '-map', '0:v', '-c', 'copy', '-f', 'md5', '-'], { encoding: 'utf8' });
  return raw.trim();
};
const a = md5(VIDEO), b = md5(OUT);
console.log(`video ${a}`);
console.log(`music ${b}`);
console.log(a === b ? 'VIDEO STREAM IDENTICAL' : '!! VIDEO STREAM CHANGED !!');
console.log(`${OUT} ${(fs.statSync(OUT).size / 1048576).toFixed(2)} MB`);
