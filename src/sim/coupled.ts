import type { Project, SimulationOptions, MassLedger, ReplayFrame, FloodSpotStat, PumpUnit, ID } from '../domain/types';
import { ShallowWaterGrid } from './swe';
import { NetworkRuntime } from './network1d';
import { buildChicagoSeries, gaugeSeries, thiessenWeights } from '../domain/rainfall';
import { pointInPolygon } from '../domain/hydraulics';

export const SURFACE_CLASS_INDEX: Record<string, number> = { road: 0, green: 1, roof: 2, water: 3, other: 4 };
export const SURFACE_CLASSES = [
  { id: 'road', label: '道路/硬化', f0: 12, fc: 2, k: 2.5, n: 0.018, color: '#4b5563' },
  { id: 'green', label: '绿地', f0: 70, fc: 18, k: 3.2, n: 0.06, color: '#16a34a' },
  { id: 'roof', label: '屋面', f0: 0, fc: 0, k: 1, n: 0.012, color: '#7c3aed' },
  { id: 'water', label: '水体', f0: 1000, fc: 1000, k: 0, n: 0.03, color: '#0ea5e9' },
  { id: 'other', label: '其他透水', f0: 35, fc: 8, k: 2.0, n: 0.035, color: '#a3a3a3' }
] as const;

export interface CoupledCheckpoint {
  timeSec: number;
  sweH: Float64Array;
  sweHu: Float64Array;
  sweHv: Float64Array;
  boundaryOutM3: number;
  netVolumes: Float64Array;
  interfaceQ: Float64Array;
  riverQ: Float64Array;
  riverCumulative: Float64Array;
  pumpOn: Record<string, boolean>;
  ledger: Omit<MassLedger, 'residualM3' | 'relativeErrorPct' | 'initialStorageM3' | 'finalStorageM3'>;
  rainfallM3: number;
  infiltrationM3: number;
  pumpM3: number;
  outfallM3: number;
  riverBackflowM3: number;
  couplingM3: number;
}

export interface CoupledRunResult {
  frames: ReplayFrame[];
  ledger: MassLedger;
  maxDepth: Float64Array;
  maxTimeSec: Float64Array;
  exceedDurationSec: Float64Array;
  lastExceedSec: Float64Array;
  rainEndSec: number;
  elapsedMs: number;
  engine: CoupledEngine;
}

export class CoupledEngine {
  project: Project;
  options: SimulationOptions;
  schemeId: ID;
  swe: ShallowWaterGrid;
  net: NetworkRuntime;
  nodeGridIndex = new Map<string, number>();
  rainSeries: { intensityMmH: number[]; depthMm: number[]; intervalMin: number };
  rainDtSec: number;
  timeSec = 0;
  rainfallM3 = 0;
  infiltrationM3 = 0;
  pumpM3 = 0;
  outfallM3 = 0;
  riverBackflowM3 = 0;
  couplingM3 = 0;
  initialStorageM3 = 0;
  maxDepth: Float64Array;
  maxTimeSec: Float64Array;
  exceedDurationSec: Float64Array;
  lastExceedSec: Float64Array;
  thresholdM = 0.15;
  pumpOn = new Map<string, boolean>();
  pumpOverrides: Record<string, PumpUnit[]> = {};
  ruleChangeSec: number | null = null;
  frames: ReplayFrame[] = [];
  recordIntervalSec: number;
  nextRecordSec = 0;
  rainEndSec: number;
  lastPumpQ = 0;
  hydrographs: { timeMin: number[]; rainfallMmH: number[]; outfallM3s: number[]; pumpM3s: number[] } = { timeMin: [], rainfallMmH: [], outfallM3s: [], pumpM3s: [] };
  thiessen?: ReturnType<typeof thiessenWeights>;
  gaugeRainSeries?: ReturnType<typeof gaugeSeries>[];

  constructor(project: Project, options: SimulationOptions, schemeId = 'base') {
    this.project = project;
    this.options = options;
    this.schemeId = schemeId;
    const terrain = project.terrain!;
    const cellSize = options.surfaceCellSize && options.surfaceCellSize > terrain.cellSize
      ? options.surfaceCellSize
      : terrain.cellSize;
    const stride = Math.max(1, Math.round(cellSize / terrain.cellSize));
    const cols = Math.floor(terrain.cols / stride);
    const rows = Math.floor(terrain.rows / stride);
    const elev = new Float64Array(cols * rows);
    const rough = new Float32Array(cols * rows);
    const mask = new Uint8Array(cols * rows).fill(1);
    const outCell = terrain.cellSize * stride;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        let sumZ = 0, zCount = 0;
        const clsCount = new Map<number, number>();
        for (let rr = r * stride; rr < Math.min(terrain.rows, (r + 1) * stride); rr++) {
          for (let cc = c * stride; cc < Math.min(terrain.cols, (c + 1) * stride); cc++) {
            const ti = rr * terrain.cols + cc;
            sumZ += terrain.elevations[ti]; zCount++;
            const cls = terrain.landCover[ti] ?? 4;
            clsCount.set(cls, (clsCount.get(cls) ?? 0) + 1);
          }
        }
        const i = r * cols + c;
        elev[i] = sumZ / Math.max(1, zCount);
        let bestCls = 4, bestN = -1;
        for (const [cls, n] of clsCount) if (n > bestN) { bestN = n; bestCls = cls; }
        rough[i] = SURFACE_CLASSES[bestCls]?.n ?? 0.035;
        const wx = terrain.originX + (c + 0.5) * outCell;
        const wy = terrain.originY + (r + 0.5) * outCell;
        for (const b of terrain.buildings) {
          if (pointInPolygon(wx, wy, b.points)) { mask[i] = 0; rough[i] = 0.08; break; }
        }
      }
    }

    this.swe = new ShallowWaterGrid({
      cols, rows, cellSize: outCell,
      originX: terrain.originX, originY: terrain.originY,
      elevations: elev, roughness: rough, mask, cfl: 0.38
    });

    this.net = new NetworkRuntime(options.preissmannCelerity ?? 18);
    this.net.buildFromNetwork(project.nodes, project.pipes, options.maxReachLength ?? 30);
    for (const n of project.nodes) {
      const c = Math.floor((n.x - terrain.originX) / outCell);
      const r = Math.floor((n.y - terrain.originY) / outCell);
      if (c >= 0 && c < cols && r >= 0 && r < rows) this.nodeGridIndex.set(n.id, r * cols + c);
    }

    if (project.rainfall.source === 'gauge' && project.rainfall.gauges?.length) {
      this.gaugeRainSeries = project.rainfall.gauges.map(gaugeSeries);
      this.thiessen = thiessenWeights(project.rainfall.gauges, project.bbox);
      this.rainSeries = this.gaugeRainSeries[0];
    } else {
      this.rainSeries = buildChicagoSeries(project.rainfall);
    }
    this.rainDtSec = this.rainSeries.intervalMin * 60;
    this.rainEndSec = project.rainfall.durationMin * 60;
    this.recordIntervalSec = options.recordIntervalSec ?? 30;

    const nGrid = cols * rows;
    this.maxDepth = new Float64Array(nGrid);
    this.maxTimeSec = new Float64Array(nGrid);
    this.exceedDurationSec = new Float64Array(nGrid);
    this.lastExceedSec = new Float64Array(nGrid).fill(-1);

    // 方案改造：清淤覆盖
    const scheme = project.schemes.find(s => s.id === schemeId);
    if (scheme?.pipeSedimentOverrides) {
      for (const p of project.pipes) {
        const sed = scheme.pipeSedimentOverrides[p.id];
        if (sed !== undefined) p.sedimentDepth = sed;
      }
      // 重建断面几何所依赖的 pipe 对象已原地修改；reach 持有同一引用，无需重建
    }
    if (scheme?.pumpRuleOverrides) this.pumpOverrides = scheme.pumpRuleOverrides;
    for (const add of scheme?.addedPumps ?? []) {
      const node = project.nodes.find(n => n.id === add.nodeId);
      if (node?.pumpStation) node.pumpStation.units.push(...add.units);
    }

    this.initialStorageM3 = this.swe.volume() + this.net.totalVolume();
  }

  rainRateMS(tSec: number, cellIndex?: number): number {
    if (tSec >= this.rainEndSec + 1e-6) return 0;
    const k = Math.min(this.rainSeries.intensityMmH.length - 1, Math.floor(tSec / this.rainDtSec));
    let mmH = 0;
    if (this.gaugeRainSeries && this.thiessen && cellIndex !== undefined) {
      // 最近站空间分配；权重用于总量校核
      const c = cellIndex % this.swe.cols;
      const r = Math.floor(cellIndex / this.swe.cols);
      const x = this.swe.xAt(c), y = this.swe.yAt(r);
      let best = this.project.rainfall.gauges![0].id;
      let bd = Infinity;
      for (const g of this.project.rainfall.gauges!) {
        const d = (g.x - x) ** 2 + (g.y - y) ** 2;
        if (d < bd) { bd = d; best = g.id; }
      }
      const gi = this.project.rainfall.gauges!.findIndex(g => g.id === best);
      mmH = this.gaugeRainSeries[gi]?.intensityMmH[k] ?? 0;
    } else if (this.thiessen && this.gaugeRainSeries) {
      for (let i = 0; i < this.thiessen.length; i++) {
        mmH += this.thiessen[i].areaFraction * (this.gaugeRainSeries[i]?.intensityMmH[k] ?? 0);
      }
    } else {
      mmH = this.rainSeries.intensityMmH[k] ?? 0;
    }
    return mmH / 3.6e6; // mm/h -> m/s
  }

  infiltrationRateMS(cellIndex: number, elapsedSec: number): number {
    const terrain = this.project.terrain!;
    const c = cellIndex % this.swe.cols;
    const r = Math.floor(cellIndex / this.swe.cols);
    const stride = Math.max(1, Math.round(this.swe.dx / terrain.cellSize));
    const tc = Math.min(terrain.cols - 1, c * stride);
    const tr = Math.min(terrain.rows - 1, r * stride);
    const cls = terrain.landCover[tr * terrain.cols + tc] ?? 4;
    const def = SURFACE_CLASSES[cls] ?? SURFACE_CLASSES[4];
    const hHours = elapsedSec / 3600;
    const fMMH = def.fc + (def.f0 - def.fc) * Math.exp(-def.k * hHours);
    return fMMH / 3.6e6;
  }

  applyHydrology(dtSec: number) {
    const area = this.swe.dx * this.swe.dy;
    const h = this.swe.h;
    for (let i = 0; i < h.length; i++) {
      if (!this.swe.mask[i]) continue;
      const rainRate = this.rainRateMS(this.timeSec, i);
      const rainVol = rainRate * dtSec * area;
      h[i] += rainRate * dtSec;
      this.rainfallM3 += rainVol;

      const infRate = this.infiltrationRateMS(i, this.timeSec);
      const infDepth = Math.min(h[i], infRate * dtSec);
      h[i] -= infDepth;
      this.infiltrationM3 += infDepth * area;
    }
  }

  updatePumps(dtSec: number) {
    this.lastPumpQ = 0;
    for (const node of this.project.nodes) {
      if (node.kind !== 'pump' || !node.pumpStation) continue;
      const ci = this.net.nodeCell.get(node.id);
      if (ci === undefined) continue;
      const cell = this.net.cells[ci];
      const units = this.pumpOverrides[node.id] ?? node.pumpStation.units;
      for (const u of units) {
        const key = `${node.id}:${u.id}`;
        const level = cell.invert + cell.depth;
        let on = this.pumpOn.get(key) ?? false;
        if (!on && level >= u.startLevel) on = true;
        if (on && level <= u.stopLevel) on = false;
        this.pumpOn.set(key, on);
        if (on) {
          const available = Math.max(0, cell.volume);
          const q = Math.min(u.capacity, available / Math.max(dtSec, 1e-6));
          cell.volume -= q * dtSec;
          this.pumpM3 += q * dtSec;
          this.lastPumpQ += q;
        }
      }
    }
  }

  applyCoupling(dtSec: number) {
    const area = this.swe.dx * this.swe.dy;
    for (const node of this.project.nodes) {
      const ni = this.net.nodeCell.get(node.id);
      const gi = this.nodeGridIndex.get(node.id);
      if (ni === undefined || gi === undefined || !this.swe.mask[gi]) continue;
      const nc = this.net.cells[ni];
      const ground = node.groundElev;
      const surfaceHead = this.swe.z[gi] + this.swe.h[gi];
      const nodeHead = nc.head;
      const rim = ground;
      const coverD = node.coverDiameter ?? node.chamberDiameter ?? 0.7;
      const area0 = Math.PI * coverD * coverD / 4;
      let q = 0; // 正：地面 -> 井
      if (nodeHead > rim + 0.02 && nodeHead > surfaceHead) {
        // 孔口出流/顶托冒水：井 -> 地面
        const head = Math.max(0, nodeHead - Math.max(rim, surfaceHead));
        q = -0.62 * area0 * Math.sqrt(2 * 9.81 * head);
      } else if (surfaceHead > rim + 0.02 && surfaceHead > nodeHead) {
        // 堰流灌回井
        const hw = surfaceHead - rim;
        const perimeter = Math.PI * coverD;
        q = 0.56 * 1.84 * perimeter * Math.pow(hw, 1.5);
      }

      if (q > 0) {
        // 地面水可供量限制
        const maxQ = Math.max(0, this.swe.h[gi]) * area / dtSec;
        q = Math.min(q, maxQ);
        this.swe.h[gi] -= q * dtSec / area;
        nc.volume += q * dtSec;
        this.couplingM3 += q * dtSec;
      } else if (q < 0) {
        // 井水可供量限制，先在表面增加；网络负外部流也会做 donor limit
        const maxQ = Math.max(0, nc.volume) / dtSec;
        q = Math.max(q, -maxQ);
        nc.volume += q * dtSec; // q 负
        this.swe.h[gi] += -q * dtSec / area;
        this.couplingM3 += -q * dtSec;
      }

      // 井盖顶飞状态由统计/快照读取 node 字段外的 map
      const pressureHead = nodeHead - ground;
      if ((node.coverLiftHead ?? 0.8) > 0 && pressureHead > (node.coverLiftHead ?? 0.8)) {
        this.coverBlown.add(node.id);
      }
    }
  }

  coverBlown = new Set<string>();

  advanceSurface(dtSec: number) {
    let remaining = dtSec;
    let guard = 0;
    while (remaining > 1e-6 && guard < 100000) {
      const dt = Math.min(remaining, this.swe.stableDt(Math.min(0.5, remaining)));
      this.swe.step(dt);
      remaining -= dt;
      guard++;
    }
  }

  trackStats(dtSec: number) {
    for (let i = 0; i < this.swe.h.length; i++) {
      const d = Math.max(0, this.swe.h[i]);
      if (d > this.maxDepth[i]) {
        this.maxDepth[i] = d;
        this.maxTimeSec[i] = this.timeSec;
      }
      if (d >= this.thresholdM) {
        this.exceedDurationSec[i] += dtSec;
        this.lastExceedSec[i] = this.timeSec;
      }
    }
  }

  takeFrame(): ReplayFrame {
    const nodeHeads: Record<ID, number> = {};
    const nodeStates: ReplayFrame['nodeStates'] = {};
    const pipeQ: Record<ID, number> = {};
    for (const n of this.project.nodes) {
      const ci = this.net.nodeCell.get(n.id);
      if (ci === undefined) continue;
      const c = this.net.cells[ci];
      nodeHeads[n.id] = c.head;
      const gi = this.nodeGridIndex.get(n.id);
      const exQ = 0;
      nodeStates[n.id] = {
        head: c.head,
        depth: c.depth,
        volume: c.volume,
        flooded: gi !== undefined && this.swe.h[gi] > 0.15,
        coverBlown: this.coverBlown.has(n.id),
        exchangeQ: exQ
      };
    }
    for (const p of this.project.pipes) pipeQ[p.id] = this.net.pipeFlow(p.id);
    this.hydrographs.timeMin.push(this.timeSec / 60);
    this.hydrographs.rainfallMmH.push(this.rainRateMS(this.timeSec) * 3.6e6);
    this.hydrographs.outfallM3s.push(this.net.rivers.reduce((s, r) => s + r.q, 0));
    this.hydrographs.pumpM3s.push(this.lastPumpQ);
    return {
      tSec: this.timeSec,
      cols: this.swe.cols,
      rows: this.swe.rows,
      cellSize: this.swe.dx,
      originX: this.swe.originX,
      originY: this.swe.originY,
      depth: Float32Array.from(this.swe.h),
      u: Float32Array.from(this.swe.hu),
      v: Float32Array.from(this.swe.hv),
      elev: Float32Array.from(this.swe.z),
      mask: Uint8Array.from(this.swe.mask),
      nodeHeads,
      nodeStates,
      pipeQ
    };
  }

  step(dtSec: number) {
    this.applyHydrology(dtSec);
    this.net.updateHeadsFromVolumes();
    this.updatePumps(dtSec);
    this.applyCoupling(dtSec);
    this.net.updateRiverStages(this.timeSec);
    this.net.step(dtSec, []);
    // 河口水账
    for (const r of this.net.rivers) {
      if (r.q >= 0) this.outfallM3 += r.q * dtSec;
      else this.riverBackflowM3 += -r.q * dtSec;
    }
    this.advanceSurface(dtSec);
    this.trackStats(dtSec);
    this.timeSec += dtSec;
    if (this.timeSec + 1e-6 >= this.nextRecordSec) {
      this.frames.push(this.takeFrame());
      this.nextRecordSec += this.recordIntervalSec;
    }
  }

  run(durationMin = this.options.durationMin): CoupledRunResult {
    const start = performance.now();
    const dt = this.options.couplingDtSec ?? 1;
    const end = durationMin * 60;
    // 初始帧
    this.frames.push(this.takeFrame());
    this.nextRecordSec = this.recordIntervalSec;
    let guard = 0;
    while (this.timeSec < end - 1e-6 && guard < 1_000_000) {
      const h = Math.min(dt, end - this.timeSec);
      this.step(h);
      guard++;
    }
    if (this.frames[this.frames.length - 1]?.tSec < end - 1) this.frames.push(this.takeFrame());
    const ledger = this.buildLedger();
    const elapsedMs = performance.now() - start;
    return {
      frames: this.frames,
      ledger,
      maxDepth: this.maxDepth,
      maxTimeSec: this.maxTimeSec,
      exceedDurationSec: this.exceedDurationSec,
      lastExceedSec: this.lastExceedSec,
      rainEndSec: this.rainEndSec,
      elapsedMs,
      engine: this
    };
  }

  buildLedger(): MassLedger {
    const finalStorageM3 = this.swe.volume() + this.net.totalVolume();
    const surfaceBoundaryM3 = this.swe.boundaryNetOutM3;
    const residualM3 = finalStorageM3 - this.initialStorageM3
      - this.rainfallM3 + this.infiltrationM3 + this.pumpM3 + this.outfallM3
      - this.riverBackflowM3 + surfaceBoundaryM3;
    const denom = Math.max(Math.abs(this.rainfallM3), Math.abs(this.initialStorageM3), 1);
    return {
      rainfallM3: this.rainfallM3,
      infiltrationM3: this.infiltrationM3,
      outfallM3: this.outfallM3,
      riverBackflowM3: this.riverBackflowM3,
      pumpM3: this.pumpM3,
      surfaceBoundaryM3,
      initialStorageM3: this.initialStorageM3,
      finalStorageM3,
      couplingExchangedM3: this.couplingM3,
      residualM3,
      relativeErrorPct: 100 * Math.abs(residualM3) / denom
    };
  }

  createCheckpoint(): CoupledCheckpoint {
    return {
      timeSec: this.timeSec,
      sweH: Float64Array.from(this.swe.h),
      sweHu: Float64Array.from(this.swe.hu),
      sweHv: Float64Array.from(this.swe.hv),
      boundaryOutM3: this.swe.boundaryNetOutM3,
      netVolumes: Float64Array.from(this.net.cells.map(c => c.volume)),
      interfaceQ: Float64Array.from(this.net.interfaces.map(i => i.q)),
      riverQ: Float64Array.from(this.net.rivers.map(r => r.q)),
      riverCumulative: Float64Array.from(this.net.rivers.map(r => r.cumulativeM3)),
      pumpOn: Object.fromEntries(this.pumpOn),
      ledger: {} as MassLedger,
      rainfallM3: this.rainfallM3,
      infiltrationM3: this.infiltrationM3,
      pumpM3: this.pumpM3,
      outfallM3: this.outfallM3,
      riverBackflowM3: this.riverBackflowM3,
      couplingM3: this.couplingM3
    };
  }

  restoreCheckpoint(cp: CoupledCheckpoint) {
    this.timeSec = cp.timeSec;
    this.swe.h.set(cp.sweH);
    this.swe.hu.set(cp.sweHu);
    this.swe.hv.set(cp.sweHv);
    this.swe.hNew.set(cp.sweH);
    this.swe.huNew.set(cp.sweHu);
    this.swe.hvNew.set(cp.sweHv);
    this.swe.boundaryNetOutM3 = cp.boundaryOutM3;
    this.net.cells.forEach((c, i) => { c.volume = cp.netVolumes[i]; });
    this.net.interfaces.forEach((f, i) => { f.q = cp.interfaceQ[i]; });
    this.net.rivers.forEach((r, i) => { r.q = cp.riverQ[i]; r.cumulativeM3 = cp.riverCumulative[i]; });
    this.pumpOn = new Map(Object.entries(cp.pumpOn));
    this.rainfallM3 = cp.rainfallM3;
    this.infiltrationM3 = cp.infiltrationM3;
    this.pumpM3 = cp.pumpM3;
    this.outfallM3 = cp.outfallM3;
    this.riverBackflowM3 = cp.riverBackflowM3;
    this.couplingM3 = cp.couplingM3;
    this.net.updateHeadsFromVolumes();
  }

  /** 从调度改动时刻的检查点之后重算，不触碰此前帧/水量过程 */
  recomputeFromCheckpoint(cp: CoupledCheckpoint, overrides: Record<string, PumpUnit[]>, durationMin: number): CoupledRunResult {
    this.restoreCheckpoint(cp);
    this.pumpOverrides = overrides;
    this.ruleChangeSec = cp.timeSec;
    this.frames = this.frames.filter(f => f.tSec <= cp.timeSec + 1e-6);
    this.nextRecordSec = cp.timeSec + this.recordIntervalSec;
    return this.run(durationMin);
  }

  buildFloodSpots(): FloodSpotStat[] {
    const spots: FloodSpotStat[] = [];
    const addSpot = (id: string, name: string, kind: FloodSpotStat['kind'], x: number, y: number) => {
      const c = Math.floor((x - this.swe.originX) / this.swe.dx);
      const r = Math.floor((y - this.swe.originY) / this.swe.dy);
      if (c < 0 || c >= this.swe.cols || r < 0 || r >= this.swe.rows) return;
      const i = r * this.swe.cols + c;
      const last = this.lastExceedSec[i];
      spots.push({
        id, name, kind, x, y,
        maxDepthM: this.maxDepth[i],
        maxTimeMin: this.maxTimeSec[i] / 60,
        durationMin: this.exceedDurationSec[i] / 60,
        recessionMin: last >= 0 && last >= this.rainEndSec ? (last - this.rainEndSec) / 60 : null,
        cellCountOverThreshold: 0
      });
    };
    for (const u of this.project.terrain?.underpasses ?? []) {
      addSpot(u.id, u.name, 'underpass', u.alignment[Math.floor(u.lowPointChainage)]?.x ?? u.alignment[0].x, u.alignment[Math.floor(u.lowPointChainage)]?.y ?? u.alignment[0].y);
    }
    for (const n of this.project.nodes) {
      if (n.kind === 'inspection' || n.kind === 'pump') addSpot(n.id, n.name || n.code, 'well', n.x, n.y);
    }
    // 低洼路段：取最大水深前 12 个格网聚合成点
    const candidates: { i: number; d: number }[] = [];
    for (let i = 0; i < this.maxDepth.length; i++) if (this.swe.mask[i] && this.maxDepth[i] > 0.2) candidates.push({ i, d: this.maxDepth[i] });
    candidates.sort((a, b) => b.d - a.d);
    for (const cand of candidates.slice(0, 12)) {
      const c = cand.i % this.swe.cols, r = Math.floor(cand.i / this.swe.cols);
      addSpot(`low-${cand.i}`, `低洼路段 (${c},${r})`, 'low-road', this.swe.xAt(c), this.swe.yAt(r));
    }
    return spots.sort((a, b) => b.maxDepthM - a.maxDepthM);
  }
}
