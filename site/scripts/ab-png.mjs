// Turn one A/B case into three PNGs (A, B and a red diff mask) so a human — or
// a model with eyes — can see what moved. Uses Chrome as the PNG encoder.
//
//   node scripts/genesis-ab-png.mjs <dirA> <dirB> <caseId> [outDir]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import puppeteer from 'puppeteer-core';

const [aDir, bDir, id, outDir = '/tmp/ab/png'] = process.argv.slice(2);
const ai = JSON.parse(readFileSync(join(aDir, 'index.json'), 'utf8'))[id];
const { w, h } = ai;
const A = gunzipSync(readFileSync(join(aDir, `${id}.raw.gz`)));
const B = gunzipSync(readFileSync(join(bDir, `${id}.raw.gz`)));

// Diff mask: the B frame, dimmed, with every changed pixel in magenta.
const D = Buffer.from(B);
let n = 0;
for (let i = 0; i < A.length; i += 4) {
  const same =
    A[i] === B[i] && A[i + 1] === B[i + 1] && A[i + 2] === B[i + 2] && A[i + 3] === B[i + 3];
  if (same) {
    D[i] = (D[i] * 0.35) | 0;
    D[i + 1] = (D[i + 1] * 0.35) | 0;
    D[i + 2] = (D[i + 2] * 0.35) | 0;
  } else {
    n++;
    D[i] = 255;
    D[i + 1] = 0;
    D[i + 2] = 255;
    D[i + 3] = 255;
  }
}
console.log(`${id}: ${n} differing px of ${w * h}`);

mkdirSync(outDir, { recursive: true });
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome',
  headless: 'new',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-first-run'],
});
const page = await browser.newPage();
await page.goto('about:blank');
for (const [name, buf] of [['a', A], ['b', B], ['diff', D]]) {
  const dataUrl = await page.evaluate(
    (w, h, b64) => {
      const bin = atob(b64);
      const arr = new Uint8ClampedArray(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const c = document.createElement('canvas');
      c.width = w;
      c.height = h;
      c.getContext('2d').putImageData(new ImageData(arr, w, h), 0, 0);
      return c.toDataURL('image/png');
    },
    w,
    h,
    buf.toString('base64')
  );
  const out = join(outDir, `${id}.${name}.png`);
  writeFileSync(out, Buffer.from(dataUrl.split(',')[1], 'base64'));
  console.log('  ', out);
}
await browser.close();
