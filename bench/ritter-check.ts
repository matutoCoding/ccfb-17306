import { ShallowWaterGrid } from '../src/sim/swe';
import { ritterAt, ritterErrorMetrics } from '../src/sim/analytical';

const cols = Number(process.argv[2] ?? 4000);
const dx = Number(process.argv[3] ?? 0.5);
const h0 = 10;
const tEnd = 30;
const originX = -cols * dx / 2;
const cfl = Number(process.argv[4] ?? 0.4);
const g = new ShallowWaterGrid({ cols, rows: 1, cellSize: dx, originX, roughness: 0, cfl });
for (let c = 0; c < cols; c++) {
  const x = g.xAt(c);
  g.h[c] = x < 0 ? h0 : 0;
}
let t = 0;
let steps = 0;
while (t < tEnd - 1e-9) {
  const dt = Math.min(g.stableDt(0.2), tEnd - t);
  g.step(dt);
  t += dt;
  steps++;
}
const xs: number[] = [];
const hs: number[] = [];
for (let c = 0; c < cols; c++) { xs.push(g.xAt(c)); hs.push(g.h[c]); }
const m = ritterErrorMetrics(xs, hs, tEnd, h0, -450, 450);
console.log({ steps, dtAvg: tEnd / steps, ...m, volume: g.volume(), boundary: g.boundaryNetOutM3, clips: g.negativeDepthClips });
for (const x of [-250, -150, 0, 50, 100, 190, 250]) {
  const idx = Math.round((x - originX) / dx - 0.5);
  console.log(x, 'num', g.h[idx]?.toFixed(4), 'exact', ritterAt(x, tEnd, h0).h.toFixed(4));
}
