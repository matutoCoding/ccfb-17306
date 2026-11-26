import { describe, expect, it } from 'vitest';
import { createSampleProject } from '../src/data/sampleProject';
import { validateNetwork } from '../src/domain/validation';
import { buildChicagoSeries } from '../src/domain/rainfall';
import { ritterAt, ritterErrorMetrics } from '../src/sim/analytical';
import { ShallowWaterGrid } from '../src/sim/swe';
import { NetworkRuntime } from '../src/sim/network1d';
import { manningFlow, sectionGeometry } from '../src/domain/hydraulics';

describe('降雨与导入校核', () => {
  it('芝加哥雨型总雨量与暴雨强度公式一致', () => {
    const p = createSampleProject();
    const s = buildChicagoSeries(p.rainfall);
    const total = s.depthMm.reduce((a, b) => a + b, 0);
    expect(total).toBeGreaterThan(90);
    expect(total).toBeLessThan(130);
    expect(Math.max(...s.intensityMmH)).toBeGreaterThan(Math.min(...s.intensityMmH));
  });

  it('样例数据能列出倒坡、标高异常和孤立管段', () => {
    const p = createSampleProject();
    const issues = validateNetwork(p.nodes, p.pipes);
    expect(issues.some(i => i.type === 'reverse-slope')).toBe(true);
    expect(issues.some(i => i.type === 'invert-mismatch')).toBe(true);
    expect(issues.some(i => i.type === 'isolated')).toBe(true);
  });
});

describe('Ritter 溃坝解析解校核', () => {
  it('RMSE 小于初始水深 2%，且水量守恒', () => {
    const cols = 4000, dx = 0.5, h0 = 10, tEnd = 30;
    const g = new ShallowWaterGrid({ cols, rows: 1, cellSize: dx, originX: -1000, roughness: 0, cfl: 0.4 });
    for (let c = 0; c < cols; c++) if (g.xAt(c) < 0) g.h[c] = h0;
    const initial = g.volume();
    let t = 0;
    while (t < tEnd - 1e-9) {
      const dt = Math.min(g.stableDt(0.2), tEnd - t);
      g.step(dt);
      t += dt;
    }
    const xs = Array.from({ length: cols }, (_, c) => g.xAt(c));
    const m = ritterErrorMetrics(xs, Array.from(g.h), tEnd, h0, -450, 450);
    expect(m.rmsePctOfH0).toBeLessThan(2);
    expect(Math.abs(g.volume() - initial) / initial).toBeLessThan(1e-9);
    expect(ritterAt(0, tEnd, h0).h).toBeCloseTo(40 / 9, 5);
  }, 60000);
});

describe('满管恒定流校核', () => {
  it('动力波/Preissmann 解与 Manning 恒定流相差小于 2%', () => {
    const p = createSampleProject();
    const pipe = p.pipes.find(x => x.id === 'P-OUTFALL-DN1200')!;
    pipe.sedimentDepth = 0;
    const nodes = p.nodes.filter(n => ['W-18-08', 'OUT-RIVER'].includes(n.id));
    const net = new NetworkRuntime(20);
    net.buildFromNetwork(nodes, [pipe], 25);
    const ui = net.nodeCell.get('W-18-08')!;
    const di = net.nodeCell.get('OUT-RIVER')!;
    net.cells[ui].fixedHead = pipe.upstreamInvert + 2.0;
    net.cells[di].fixedHead = pipe.downstreamInvert + 2.0;
    const qTheory = manningFlow(Math.PI * 0.6 ** 2, 0.3, (pipe.upstreamInvert - pipe.downstreamInvert) / pipe.length, pipe.manningN);
    const reachIds = net.pipeReachCells.get(pipe.id)!;
    const reachLen = pipe.length / reachIds.length;
    reachIds.forEach((ci, k) => {
      const c = net.cells[ci];
      const distance = (k + 0.5) * reachLen;
      const hgl = net.cells[ui].fixedHead! - ((net.cells[ui].fixedHead! - net.cells[di].fixedHead!) * distance) / pipe.length;
      c.depth = hgl - c.invert;
      c.volume = sectionGeometry(pipe, c.depth, 20).area * c.length;
    });
    for (const ii of net.pipeInterfaces.get(pipe.id)!) net.interfaces[ii].q = qTheory;
    for (let k = 0; k < 3000; k++) net.step(0.25);
    expect(Math.abs(net.pipeFlow(pipe.id) - qTheory) / qTheory).toBeLessThan(0.02);
  });
});
