/**
 * Pixel analysis, performed inside Chromium (canvas) so the spike stays on its
 * single dependency. Used to
 *   - confirm a byte-level hash mismatch is a real visual difference,
 *   - measure how much detail a zoom mechanism preserves.
 *
 * All functions take an already-open Playwright `page` — decoding is cheap but
 * launching a browser is not, so callers share one.
 */

/** Decode a PNG buffer to {width,height} plus a handle usable by other helpers. */
export async function imageSize(page, pngBuffer) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    return { width: img.naturalWidth, height: img.naturalHeight };
  }, pngBuffer.toString('base64'));
}

/**
 * Per-pixel comparison of two PNGs of identical dimensions.
 * Returns the number of differing pixels, the max channel delta, and RMSE
 * across RGB (0-255). RMSE is the headline number for "how far from reference".
 */
export async function comparePngs(page, aBuffer, bBuffer) {
  return page.evaluate(
    async ([aB64, bB64]) => {
      const load = async (b64) => {
        const img = new Image();
        img.src = 'data:image/png;base64,' + b64;
        await img.decode();
        const c = document.createElement('canvas');
        c.width = img.naturalWidth;
        c.height = img.naturalHeight;
        const ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const a = await load(aB64);
      const b = await load(bB64);
      if (a.width !== b.width || a.height !== b.height) {
        return { comparable: false, aSize: [a.width, a.height], bSize: [b.width, b.height] };
      }

      let differing = 0;
      let maxDelta = 0;
      let sumSq = 0;
      const n = a.width * a.height;
      for (let i = 0; i < n; i++) {
        const o = i * 4;
        let pixelDiffers = false;
        for (let ch = 0; ch < 3; ch++) {
          const d = Math.abs(a.data[o + ch] - b.data[o + ch]);
          if (d > 0) pixelDiffers = true;
          if (d > maxDelta) maxDelta = d;
          sumSq += d * d;
        }
        if (pixelDiffers) differing++;
      }
      return {
        comparable: true,
        width: a.width,
        height: a.height,
        pixels: n,
        differingPixels: differing,
        differingPercent: +((differing / n) * 100).toFixed(4),
        maxChannelDelta: maxDelta,
        rmse: +Math.sqrt(sumSq / (n * 3)).toFixed(4),
      };
    },
    [aBuffer.toString('base64'), bBuffer.toString('base64')]
  );
}

/**
 * Mean gradient magnitude over a PNG — a standard proxy for acutance ("how
 * crisp"). Upscaled pixels have measurably lower gradient energy than natively
 * rasterised ones at the same output resolution, because interpolation smears
 * edges that were never sampled.
 */
export async function gradientEnergy(page, pngBuffer) {
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const { data, width, height } = ctx.getImageData(0, 0, c.width, c.height);

    const lum = new Float32Array(width * height);
    for (let i = 0; i < width * height; i++) {
      const o = i * 4;
      lum[i] = 0.2126 * data[o] + 0.7152 * data[o + 1] + 0.0722 * data[o + 2];
    }

    let sum = 0;
    let count = 0;
    for (let y = 1; y < height - 1; y++) {
      for (let x = 1; x < width - 1; x++) {
        const i = y * width + x;
        const gx = lum[i + 1] - lum[i - 1];
        const gy = lum[i + width] - lum[i - width];
        sum += Math.sqrt(gx * gx + gy * gy);
        count++;
      }
    }
    return { width, height, meanGradient: +(sum / Math.max(1, count)).toFixed(4) };
  }, pngBuffer.toString('base64'));
}

/**
 * Crop a region from a PNG and rescale it to `outW x outH` using the browser's
 * highest-quality resampler. This models "crop-and-scale at capture time"
 * (zoom option 2) as favourably as a raster resize can be done.
 */
export async function cropAndScale(page, pngBuffer, region, outW, outH) {
  const b64 = await page.evaluate(
    async ([src, r, w, h]) => {
      const img = new Image();
      img.src = 'data:image/png;base64,' + src;
      await img.decode();
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, r.x, r.y, r.width, r.height, 0, 0, w, h);
      return c.toDataURL('image/png').split(',')[1];
    },
    [pngBuffer.toString('base64'), region, outW, outH]
  );
  return Buffer.from(b64, 'base64');
}
