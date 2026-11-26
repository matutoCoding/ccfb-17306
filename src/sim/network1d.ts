import { G, SectionTable, sectionGeometry } from '../domain/hydraulics';
import type { NetworkNode, PipeSegment, TimeValue } from '../domain/types';

export interface NetCell {
  index: number;
  kind: 'node' | 'reach';
  refId: string;
  invert: number;
  length: number;
  storageArea: number;
  volume: number;
  depth: number;
  head: number;
  groundElev?: number;
  pipe?: PipeSegment;
  node?: NetworkNode;
  fixedHead?: number;
}

export interface NetInterface {
  index: number;
  a: number;
  b: number;
  pipeId?: string;
  pipe?: PipeSegment;
  /** 动量方程中两控制体中心距离 */
  dx: number;
  /** 接口两侧用于断面要素的管底高程 */
  invertA: number;
  invertB: number;
  manningN: number;
  q: number;
  gateOpening: number;
}

export interface RiverBoundary {
  nodeIndex: number;
  pipe?: PipeSegment;
  invert: number;
  stage: number;
  q: number;
  cumulativeM3: number;
  diameter: number;
  manningN: number;
  series?: TimeValue[];
}

export interface ExternalFlow {
  cellIndex: number;
  /** m3/s，正为进入管网（例如倒灌），负为泵/出流抽出 */
  q: number;
  kind?: 'pump' | 'coupling' | 'other';
}

export class NetworkRuntime {
  cells: NetCell[] = [];
  interfaces: NetInterface[] = [];
  nodeCell = new Map<string, number>();
  pipeReachCells = new Map<string, number[]>();
  pipeInterfaces = new Map<string, number[]>();
  rivers: RiverBoundary[] = [];
  sectionTables = new Map<string, SectionTable>();
  celerity: number;
  timeSec = 0;
  pumpOutM3 = 0;
  externalInM3 = 0;
  volumeClipM3 = 0;
  /** 被可用性限制后的泵/外部实际流量，按 cell 记账 */
  lastExternalActual = new Map<number, number>();

  constructor(celerity = 12) {
    this.celerity = celerity;
  }

  addNode(node: NetworkNode): number {
    const index = this.cells.length;
    const d = node.chamberDiameter || 1.2;
    this.cells.push({
      index,
      kind: 'node',
      refId: node.id,
      invert: node.invert,
      length: 1,
      storageArea: Math.PI * d * d / 4,
      volume: 0,
      depth: 0,
      head: node.invert,
      groundElev: node.groundElev,
      node
    });
    this.nodeCell.set(node.id, index);
    return index;
  }

  buildFromNetwork(nodes: NetworkNode[], pipes: PipeSegment[], maxReachLength = 25) {
    for (const n of nodes) this.addNode(n);
    for (const p of pipes) {
      const aNode = this.nodeCell.get(p.fromNodeId);
      const bNode = this.nodeCell.get(p.toNodeId);
      if (aNode === undefined || bNode === undefined) continue;
      const reachCount = Math.max(2, Math.ceil(p.length / maxReachLength));
      const reachLen = p.length / reachCount;
      const reachIndices: number[] = [];
      const ifIndices: number[] = [];
      for (let k = 0; k < reachCount; k++) {
        const frac = (k + 0.5) / reachCount;
        const invert = p.upstreamInvert + (p.downstreamInvert - p.upstreamInvert) * frac;
        const index = this.cells.length;
        this.cells.push({
          index,
          kind: 'reach',
          refId: `${p.id}:r${k}`,
          invert,
          length: reachLen,
          storageArea: 0,
          volume: 0,
          depth: 0,
          head: invert,
          pipe: p
        });
        reachIndices.push(index);
      }
      this.pipeReachCells.set(p.id, reachIndices);

      const addInterface = (a: number, b: number, dx: number, invertA: number, invertB: number) => {
        const idx = this.interfaces.length;
        this.interfaces.push({
          index: idx, a, b, pipeId: p.id, pipe: p, dx: Math.max(0.25, dx),
          invertA, invertB, manningN: p.manningN, q: 0, gateOpening: 1
        });
        ifIndices.push(idx);
      };

      addInterface(aNode, reachIndices[0], reachLen / 2 + 0.25, p.upstreamInvert, this.cells[reachIndices[0]].invert);
      for (let k = 0; k < reachIndices.length - 1; k++) {
        addInterface(reachIndices[k], reachIndices[k + 1], reachLen, this.cells[reachIndices[k]].invert, this.cells[reachIndices[k + 1]].invert);
      }
      addInterface(reachIndices[reachIndices.length - 1], bNode, reachLen / 2 + 0.25, this.cells[reachIndices[reachIndices.length - 1]].invert, p.downstreamInvert);
      this.pipeInterfaces.set(p.id, ifIndices);

      const gateNode = nodes.find(n => n.kind === 'gate' && (n.id === p.fromNodeId || n.id === p.toNodeId));
      if (gateNode) for (const ii of ifIndices) this.interfaces[ii].gateOpening = gateNode.gateOpening ?? 1;
    }

    for (const n of nodes.filter(n => n.kind === 'outfall' && n.riverStageSeries?.length)) {
      const idx = this.nodeCell.get(n.id)!;
      const series = n.riverStageSeries!;
      const pipe = pipes.find(p => p.fromNodeId === n.id || p.toNodeId === n.id);
      this.rivers.push({
        nodeIndex: idx,
        pipe,
        invert: n.invert,
        stage: series[0].value,
        q: 0,
        cumulativeM3: 0,
        diameter: pipe?.diameter ?? 1.2,
        manningN: pipe?.manningN ?? 0.015,
        series: series
      });
    }
  }

  updateHeadsFromVolumes() {
    for (const c of this.cells) {
      if (c.fixedHead !== undefined) {
        c.head = c.fixedHead;
        c.depth = Math.max(0, c.head - c.invert);
        c.volume = c.kind === 'reach' && c.pipe
          ? sectionGeometry(c.pipe, c.depth, this.celerity).area * c.length
          : c.depth * c.storageArea;
        continue;
      }
      if (c.kind === 'reach' && c.pipe) {
        const areaEff = c.volume / c.length;
        let table = this.sectionTables.get(c.pipe.id);
        if (!table) {
          table = new SectionTable(c.pipe, this.celerity);
          this.sectionTables.set(c.pipe.id, table);
        }
        c.depth = table.depthForArea(areaEff);
      } else {
        c.depth = Math.max(0, c.volume / Math.max(1e-6, c.storageArea));
      }
      c.head = c.invert + c.depth;
    }
  }

  totalVolume(): number {
    return this.cells.reduce((s, c) => s + Math.max(0, c.volume), 0);
  }

  pipeFlow(pipeId: string): number {
    const ids = this.pipeInterfaces.get(pipeId);
    if (!ids?.length) return 0;
    // 管段两端节点交换量比内部平均更适合过程线；取首尾符号统一为 from->to
    return this.interfaces[ids[0]].q;
  }

  updateRiverStages(timeSec: number) {
    const tMin = timeSec / 60;
    for (const r of this.rivers) {
      const s = r.series;
      if (!s?.length) continue;
      if (tMin <= s[0].tMin) { r.stage = s[0].value; continue; }
      if (tMin >= s[s.length - 1].tMin) { r.stage = s[s.length - 1].value; continue; }
      for (let i = 0; i < s.length - 1; i++) {
        if (tMin >= s[i].tMin && tMin <= s[i + 1].tMin) {
          const a = s[i], b = s[i + 1];
          const k = (tMin - a.tMin) / Math.max(1e-9, b.tMin - a.tMin);
          r.stage = a.value + (b.value - a.value) * k;
          break;
        }
      }
    }
  }

  /** 计算所有界面的新流量，但不改变体积 */
  computeFlows(dt: number) {
    this.updateHeadsFromVolumes();
    for (const f of this.interfaces) {
      const A = this.cells[f.a], B = this.cells[f.b];
      const ya = A.head - f.invertA;
      const yb = B.head - f.invertB;
      if ((ya <= 1e-5 && yb <= 1e-5) || f.gateOpening <= 0.001) {
        f.q *= Math.exp(-dt * 4); // 干界面快速归零，避免数值惯性
        if (Math.abs(f.q) < 1e-7) f.q = 0;
        continue;
      }
      const ga = f.pipe ? sectionGeometry(f.pipe, Math.max(0, ya), this.celerity) : undefined;
      const gb = f.pipe ? sectionGeometry(f.pipe, Math.max(0, yb), this.celerity) : undefined;
      let area = ga && gb ? 0.5 * (ga.physicalArea + gb.physicalArea) : Math.max(0, ya, yb) * 1;
      let radius = ga && gb ? 0.5 * (ga.hydraulicRadius + gb.hydraulicRadius) : 0.2;
      if (ya < 0 || yb < 0) {
        // 一端低于管底时用过水端断面，并限制驱动水头
        if (ya > 0 && ga) { area = ga.physicalArea; radius = ga.hydraulicRadius; }
        else if (yb > 0 && gb) { area = gb.physicalArea; radius = gb.hydraulicRadius; }
        else { f.q = 0; continue; }
      }
      area = Math.max(area, 1e-8);
      radius = Math.max(radius, 1e-4);
      const slopeHead = (A.head - B.head) / f.dx;
      const qOld = f.q;
      const frictionDen = 1 + dt * G * f.manningN * f.manningN * Math.abs(qOld) / Math.max(1e-8, area * Math.pow(radius, 4 / 3));
      let qNew = (qOld + dt * G * area * slopeHead) / frictionDen;
      // 闸门局部开度：用一阶松弛逼近期望节流，避免瞬时硬缩放造成振荡
      qNew *= 0.25 + 0.75 * f.gateOpening;
      // 防反向过冲
      if (slopeHead * qNew < 0 && Math.abs(qNew) > 0.05) qNew *= 0.5;
      f.q = qNew;
    }

    for (const r of this.rivers) {
      const node = this.cells[r.nodeIndex];
      const dz = node.head - r.stage;
      const yNode = node.depth;
      const geom = r.pipe ? sectionGeometry(r.pipe, Math.min(yNode, r.diameter * 3), this.celerity) : undefined;
      const area = geom?.physicalArea ?? Math.PI * r.diameter * r.diameter / 4;
      const radius = geom?.hydraulicRadius ?? r.diameter / 4;
      const dx = 2;
      const frictionDen = 1 + dt * G * r.manningN * r.manningN * Math.abs(r.q) / Math.max(1e-8, area * Math.pow(radius, 4 / 3));
      r.q = (r.q + dt * G * area * dz / dx) / frictionDen;
    }
  }

  /** 按 donors 限制流量，保证节点/管段体积不为负 */
  limitFlows(dt: number, external: ExternalFlow[] = []): Map<number, number> {
    const outRate = new Array<number>(this.cells.length).fill(0);
    const extByCell = new Map<number, number>();
    for (const e of external) extByCell.set(e.cellIndex, (extByCell.get(e.cellIndex) ?? 0) + e.q);

    for (const f of this.interfaces) {
      if (f.q > 0) outRate[f.a] += f.q;
      else if (f.q < 0) outRate[f.b] += -f.q;
    }
    for (const [idx, q] of extByCell) if (q < 0) outRate[idx] += -q;
    // 河口出流同样是节点的刚性流出，必须参与 donor 限制
    for (const r of this.rivers) if (r.q > 0) outRate[r.nodeIndex] += r.q;

    const factor = new Array<number>(this.cells.length).fill(1);
    for (let i = 0; i < this.cells.length; i++) {
      const out = outRate[i];
      if (out * dt > this.cells[i].volume && out > 0) {
        factor[i] = Math.max(0, this.cells[i].volume / (out * dt));
      }
    }

    for (const f of this.interfaces) {
      if (f.q > 0) f.q *= Math.min(1, factor[f.a]);
      else if (f.q < 0) f.q *= Math.min(1, factor[f.b]);
    }

    const actualExt = new Map<number, number>();
    for (const [idx, q] of extByCell) {
      let qa = q;
      if (q < 0) qa = q * Math.min(1, factor[idx]);
      actualExt.set(idx, (actualExt.get(idx) ?? 0) + qa);
    }
    for (const r of this.rivers) {
      if (r.q > 0) r.q *= Math.min(1, factor[r.nodeIndex]);
    }
    this.lastExternalActual = actualExt;
    return actualExt;
  }

  step(dt: number, external: ExternalFlow[] = []): { minVolume: number; externalActual: Map<number, number> } {
    this.computeFlows(dt);
    const ext = this.limitFlows(dt, external);

    for (const f of this.interfaces) {
      this.cells[f.a].volume -= dt * f.q;
      this.cells[f.b].volume += dt * f.q;
    }
    for (const [idx, q] of ext) this.cells[idx].volume += dt * q;

    for (const r of this.rivers) {
      // limitFlows 已按节点总出流限制；这里仅保留浮点安全钳制
      if (r.q > 0) {
        const maxQ = Math.max(0, this.cells[r.nodeIndex].volume) / dt;
        if (r.q > maxQ) r.q = maxQ;
      }
      this.cells[r.nodeIndex].volume -= dt * r.q;
      r.cumulativeM3 += dt * r.q;
    }

    let minVolume = Infinity;
    let negativeSum = 0;
    for (const c of this.cells) {
      if (c.volume < 0) {
        negativeSum += -c.volume;
        this.volumeClipM3 += -c.volume;
        c.volume = 0;
      }
      minVolume = Math.min(minVolume, c.volume);
    }
    if (negativeSum > 0) {
      let positiveSum = 0;
      for (const c of this.cells) if (c.volume > 0) positiveSum += c.volume;
      if (positiveSum > negativeSum) {
        const correction = (positiveSum - negativeSum) / positiveSum;
        for (const c of this.cells) if (c.volume > 0) c.volume *= correction;
      }
    }
    this.timeSec += dt;
    this.pumpOutM3 += dt * [...ext.values()].filter(q => q < 0).reduce((s, q) => s - q, 0);
    this.externalInM3 += dt * [...ext.values()].filter(q => q > 0).reduce((s, q) => s + q, 0);
    this.updateHeadsFromVolumes();
    return { minVolume, externalActual: ext };
  }

  stableDt(maxDt = 1): number {
    let dt = maxDt;
    for (const f of this.interfaces) {
      const a = this.cells[f.a], b = this.cells[f.b];
      const wave = this.celerity + Math.max(Math.abs(f.q) / Math.max(0.1, a.storageArea || 1), 0.1);
      dt = Math.min(dt, 0.35 * f.dx / wave);
    }
    return Math.max(0.05, dt);
  }
}
