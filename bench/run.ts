import { createSampleProject } from '../src/data/sampleProject';
import { CoupledEngine } from '../src/sim/coupled';
import { ShallowWaterGrid } from '../src/sim/swe';
import { ritterAt, ritterErrorMetrics } from '../src/sim/analytical';
import { NetworkRuntime } from '../src/sim/network1d';
import { manningFlow, sectionGeometry } from '../src/domain/hydraulics';
import { validateNetwork } from '../src/domain/validation';

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
  console.log(`  ✅ ${msg}`);
}

function ritterCheck() {
  console.log('\n[1/4] Ritter 溃坝解析解');
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
  const massErr = 100 * Math.abs(g.volume() - initial) / initial;
  console.log(m);
  assert(m.rmsePctOfH0 < 2, `Ritter RMSE = ${m.rmsePctOfH0.toFixed(3)}% h0 (<2%)`);
  assert(massErr < 1e-7, `Ritter 水量误差 = ${massErr.toExponential(2)}%`);
  assert(Math.abs(ritterAt(0, tEnd, h0).h - 40 / 9) < 1e-9, 'Ritter 坝址理论水深 4h0/9');
}

function pressurizedCheck() {
  console.log('\n[2/4] DN1200 满管恒定流 / Preissmann');
  const project = createSampleProject();
  const pipe = project.pipes.find(p => p.id === 'P-OUTFALL-DN1200')!;
  pipe.sedimentDepth = 0;
  const nodes = project.nodes.filter(n => ['W-18-08', 'OUT-RIVER'].includes(n.id));
  const net = new NetworkRuntime(20);
  net.buildFromNetwork(nodes, [pipe], 25);
  const ui = net.nodeCell.get('W-18-08')!;
  const di = net.nodeCell.get('OUT-RIVER')!;
  net.cells[ui].fixedHead = pipe.upstreamInvert + 2;
  net.cells[di].fixedHead = pipe.downstreamInvert + 2;
  const qTheory = manningFlow(Math.PI * 0.6 ** 2, 0.3, (pipe.upstreamInvert - pipe.downstreamInvert) / pipe.length, pipe.manningN);
  const reachIds = net.pipeReachCells.get(pipe.id)!;
  const reachLen = pipe.length / reachIds.length;
  const headUp = net.cells[ui].fixedHead!;
  const headDown = net.cells[di].fixedHead!;
  reachIds.forEach((ci, k) => {
    const c = net.cells[ci];
    const distance = (k + 0.5) * reachLen;
    const hgl = headUp - (headUp - headDown) * distance / pipe.length;
    c.depth = hgl - c.invert;
    c.volume = sectionGeometry(pipe, c.depth, 20).area * c.length;
  });
  for (const ii of net.pipeInterfaces.get(pipe.id)!) net.interfaces[ii].q = qTheory;
  for (let k = 0; k < 3000; k++) net.step(0.25);
  const err = 100 * Math.abs(net.pipeFlow(pipe.id) - qTheory) / qTheory;
  console.log({ qTheory, qNumerical: net.pipeFlow(pipe.id), errPct: err });
  assert(err < 2, `满管恒定流误差 = ${err.toFixed(3)}% (<2%)`);
}

function validationCheck() {
  console.log('\n[3/4] 300+ 井样例与导入校核');
  const p = createSampleProject();
  const issues = validateNetwork(p.nodes, p.pipes);
  console.log({ nodes: p.nodes.length, pipes: p.pipes.length, issues: issues.length });
  assert(p.nodes.length >= 300, `检查井/节点数 ${p.nodes.length} ≥ 300`);
  assert(issues.some(i => i.type === 'reverse-slope'), '列出倒坡');
  assert(issues.some(i => i.type === 'invert-mismatch'), '列出版高对不上');
  assert(issues.some(i => i.type === 'isolated'), '列出孤立管段');
}

function coupledCheck() {
  console.log('\n[4/4] 两小时降雨耦合水量平衡');
  const project = createSampleProject();
  const t0 = performance.now();
  const engine = new CoupledEngine(project, {
    durationMin: 120,
    surfaceCellSize: 500,
    couplingDtSec: 2,
    engine: 'cpu',
    recordIntervalSec: 600,
    maxReachLength: 120,
    preissmannCelerity: 18
  }, 'base');
  const result = engine.run(120);
  const spots = engine.buildFloodSpots();
  const wallMs = performance.now() - t0;
  console.log({ wallMs: wallMs.toFixed(0), ledger: result.ledger, spots: spots.length });
  assert(result.ledger.relativeErrorPct < 0.5, `两小时体积平衡误差 = ${result.ledger.relativeErrorPct.toFixed(6)}% (<0.5%)`);
  assert(result.ledger.rainfallM3 > 150000, `降雨体积 ${result.ledger.rainfallM3.toFixed(0)} m³`);
  assert(spots.length > 20, `统计易涝点 ${spots.length} 个`);
}

console.log('城市内涝管网耦合推演系统 — 数值校核');
validationCheck();
ritterCheck();
pressurizedCheck();
coupledCheck();
console.log('\n全部校核通过。');
