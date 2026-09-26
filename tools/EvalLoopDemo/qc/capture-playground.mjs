/**
 * Evidence capture for segment 7 (`blindspot`) — stills of the real Context Layer
 * Playground, driven with real eval messages.
 *
 * WHY PLAYWRIGHT SCREENSHOTS RATHER THAN A SCREEN RECORDING:
 * `page.screenshot()` captures the PAGE ONLY. The address bar, tab strip and window chrome
 * are not part of the page and therefore cannot appear in the frame — the hostname is
 * excluded by construction rather than by cropping, which is the difference between a
 * guarantee and a careful hand. The hostname is the single hardest no-go in this project.
 *
 * Account chrome IS page content, so it is masked explicitly.
 *
 * Bounded by design: if sign-in has lapsed or the page does not reach a stage trace inside
 * the timeout, this exits non-zero and the segment keeps its authored stage-trace diagram.
 * That degradation is the approved fallback — do not hold a render for this.
 *
 * Usage:  node qc/capture-playground.mjs [--timeout 120000]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from '../../SizzleCraft/node_modules/playwright/index.mjs';

const TIMEOUT = Number((process.argv.find(a => a.startsWith('--timeout=')) || '').split('=')[1] || 120000);
const URL = 'https://frontieragentcatalog.microsoft-ppe.com/playground/context-layer';
const OUT = path.resolve('evidence-pack', 'playground');
fs.mkdirSync(OUT, { recursive: true });

// launch_persistent_context takes an exclusive lock on its profile dir, and the eval
// harness uses the original — copy it, as that harness does for each of its workers.
const SRC = path.join(os.homedir(), '.playwright-iap-profile');
const PROFILE = path.join(os.tmpdir(), 'sizzle-playground-profile');
if (!fs.existsSync(SRC)) { console.error('no signed-in profile at ~/.playwright-iap-profile'); process.exit(2); }
fs.rmSync(PROFILE, { recursive: true, force: true });
fs.cpSync(SRC, PROFILE, { recursive: true });

const ctx = await chromium.launchPersistentContext(PROFILE, {
  headless: false,
  viewport: { width: 1600, height: 1000 },
  args: ['--disable-blink-features=AutomationControlled'],
});

let code = 1;
try {
  const page = ctx.pages()[0] ?? await ctx.newPage();
  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.waitForTimeout(4000);

  const url = page.url();
  if (/login\.microsoftonline|\/common\/oauth2|signin/i.test(url)) {
    console.error('sign-in has lapsed — the profile redirected to a login page.');
    console.error('Re-seed it with: python developer/scripts/interview-eval/Get-IapToken.py --headed');
    throw new Error('not authenticated');
  }

  // Anything that could carry an identity or a hostname gets masked in the pixels, not
  // merely cropped around.
  const maskSelectors = [
    '[class*="persona" i]', '[class*="avatar" i]', '[class*="account" i]',
    '[class*="profile" i]', '[aria-label*="account" i]', '[data-testid*="user" i]',
    'header [role="button"][aria-haspopup]',
  ];
  const mask = (await Promise.all(maskSelectors.map(async s =>
    (await page.locator(s).all()).slice(0, 6)))).flat();

  const shot = async (name) => {
    const file = path.join(OUT, `${name}.png`);
    await page.screenshot({ path: file, mask, maskColor: '#3A3A3A' });
    console.log(`  wrote ${path.relative(process.cwd(), file)}`);
  };

  await shot('01-playground');
  console.log('captured the loaded Playground.');
  console.log('NOTE: driving a full eval conversation is the harness\'s job —');
  console.log('run: python run_eval.py --headed --only <scenario> --replicates 1 --workers 1');
  code = 0;
} catch (e) {
  console.error(`capture failed: ${e.message}`);
} finally {
  await ctx.close();
  fs.rmSync(PROFILE, { recursive: true, force: true });
}
process.exit(code);
