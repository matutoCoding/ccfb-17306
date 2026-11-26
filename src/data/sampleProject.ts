import type { BuildingPolygon, ID, NetworkNode, PipeSegment, Project, TerrainModel, ValidationIssue } from '../domain/types';
import { SURFACE_CLASS_INDEX } from '../sim/coupled';

function mulberry32(seed: number) {
  return function () {
    let t = seed += 0x6D2B79F5;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const BBOX = { minX: 0, minY: 0, maxX: 2000, maxY: 1000 };

export function sampleGroundElev(x: number, y: number): number {
  return 45.6 - 0.0028 * x + 0.0011 * (y - 500) + 0.18 * Math.sin(x / 170) * Math.cos(y / 130);
}

export function sewerInvert(x: number, y: number): number {
  return 39.35 - 0.00135 * (x - 1000) + 0.00055 * (y - 500);
}

function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const vx = bx - ax, vy = by - ay;
  const wx = px - ax, wy = py - ay;
  const c1 = vx * wx + vy * wy;
  if (c1 <= 0) return Math.hypot(px - ax, py - ay);
  const c2 = vx * vx + vy * vy;
  if (c2 <= c1) return Math.hypot(px - bx, py - by);
  const t = c1 / c2;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

export function createSampleTerrain(cols = 200, rows = 100): TerrainModel {
  const cellSize = 10;
  const elevations = new Float64Array(cols * rows);
  const landCover = new Uint8Array(cols * rows);
  const infiltrationParams = new Float32Array(cols * rows * 3);
  const rand = mulberry32(20260718);

  const underpassAlignment = [
    { x: 1000, y: 340 }, { x: 1000, y: 410 }, { x: 1000, y: 470 },
    { x: 1000, y: 500 }, { x: 1000, y: 535 }, { x: 1000, y: 600 }, { x: 1000, y: 660 }
  ];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = (c + 0.5) * cellSize;
      const y = (r + 0.5) * cellSize;
      let z = sampleGroundElev(x, y);

      // 下穿纵坡与最低点加密表达：地形上切出 V 型槽，最低点 39.15m
      let minD = Infinity;
      let projT = 0;
      let segLenSum = 0;
      for (let k = 0; k < underpassAlignment.length - 1; k++) {
        const a = underpassAlignment[k], b = underpassAlignment[k + 1];
        const d = distToSegment(x, y, a.x, a.y, b.x, b.y);
        if (d < minD) {
          minD = d;
          const total = Math.hypot(b.x - a.x, b.y - a.y);
          const t = ((x - a.x) * (b.x - a.x) + (y - a.y) * (b.y - a.y)) / (total * total);
          projT = segLenSum + Math.max(0, Math.min(1, t)) * total;
        }
        segLenSum += Math.hypot(b.x - a.x, b.y - a.y);
      }
      const lowChain = 160; // 从 y=340 起约 160m 到 y=500
      if (minD < 24) {
        const along = Math.abs(projT - lowChain);
        const design = 39.15 + 0.022 * along; // 约 2.2% 纵坡
        const blend = Math.max(0, 1 - minD / 24);
        z = z * (1 - blend * 0.92) + Math.min(z, design) * blend * 0.92 + z * 0.08 * blend;
        if (minD < 9) z = Math.min(z, design);
      }

      elevations[r * cols + c] = z;

      const onEastWestRoad = Math.abs(y - 500) < 11 || [200, 300, 700, 800].some(v => Math.abs(y - v) < 8);
      const onNorthSouthRoad = [300, 600, 1000, 1400, 1700].some(v => Math.abs(x - v) < 10);
      const inUnderpass = Math.abs(x - 1000) < 18 && y > 330 && y < 670;
      let cls = SURFACE_CLASS_INDEX.other;
      if (inUnderpass || onEastWestRoad || onNorthSouthRoad) cls = SURFACE_CLASS_INDEX.road;
      else if (x > 120 && x < 1880 && y > 120 && y < 880 && rand() < 0.42) cls = SURFACE_CLASS_INDEX.roof;
      else if (rand() < 0.28) cls = SURFACE_CLASS_INDEX.green;
      landCover[r * cols + c] = cls;

      const params = [
        [12, 2, 2.5], [70, 18, 3.2], [0, 0, 1], [1000, 1000, 0], [35, 8, 2]
      ][cls];
      infiltrationParams.set(params, (r * cols + c) * 3);
    }
  }

  const buildings: BuildingPolygon[] = [];
  let bi = 0;
  const xs = Array.from({ length: 19 }, (_, i) => 100 + i * 100);
  const ys = Array.from({ length: 17 }, (_, j) => 100 + j * 50);
  for (let i = 0; i < xs.length - 1; i++) {
    for (let j = 0; j < ys.length - 1; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2 + (rand() - 0.5) * 8;
      const cy = (ys[j] + ys[j + 1]) / 2 + (rand() - 0.5) * 5;
      if (Math.abs(cx - 1000) < 48 && cy > 320 && cy < 680) continue;
      if (Math.abs(cy - 500) < 28) continue;
      const w = 48 + rand() * 24;
      const h = 20 + rand() * 12;
      buildings.push({
        id: `B-${++bi}`,
        name: `老城建${bi}号楼`,
        height: 9 + rand() * 24,
        points: [
          { x: cx - w / 2, y: cy - h / 2 }, { x: cx + w / 2, y: cy - h / 2 },
          { x: cx + w / 2, y: cy + h / 2 }, { x: cx - w / 2, y: cy + h / 2 }
        ]
      });
    }
  }

  return {
    id: 'terrain-oldcity', name: '老城片区 DEM/下垫面', cols, rows, cellSize,
    originX: 0, originY: 0, elevations, landCover, infiltrationParams,
    buildings,
    underpasses: [{
      id: 'UP-RAIL', name: '老铁路桥下穿', alignment: underpassAlignment,
      chainage: underpassAlignment.map((_, i) => i * 50),
      elevations: underpassAlignment.map(p => p.y === 500 ? 39.15 : 40 + Math.abs(p.y - 500) * 0.022),
      lowPointChainage: 160, bottomElev: 39.15, width: 22, carPositionChainage: 175
    }]
  };
}

export function createSampleProject(): Project {
  const nodes: NetworkNode[] = [];
  const pipes: PipeSegment[] = [];
  const xs = Array.from({ length: 19 }, (_, i) => 100 + i * 100);
  const ys = Array.from({ length: 17 }, (_, j) => 100 + j * 50);
  const idAt = (i: number, j: number) => `W-${String(i).padStart(2, '0')}-${String(j).padStart(2, '0')}`;

  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length; j++) {
      const x = xs[i], y = ys[j];
      nodes.push({
        id: idAt(i, j), code: `J${i + 1}${String(j + 1).padStart(2, '0')}`,
        name: `检查井 ${i + 1}-${j + 1}`, kind: 'inspection', x, y,
        groundElev: sampleGroundElev(x, y), invert: sewerInvert(x, y) - 0.18,
        chamberDiameter: 1.5, coverDiameter: 0.7, coverLiftHead: 0.85
      });
    }
  }

  let pipeNo = 0;
  const addPipeBetween = (aId: string, bId: string, opts: Partial<PipeSegment> = {}) => {
    const a = nodes.find(n => n.id === aId)!;
    const b = nodes.find(n => n.id === bId)!;
    const len = Math.hypot(a.x - b.x, a.y - b.y);
    const za = sewerInvert(a.x, a.y);
    const zb = sewerInvert(b.x, b.y);
    // 让 from 始终为上游
    const [up, down] = za >= zb ? [a, b] : [b, a];
    const [zUp, zDown] = za >= zb ? [za, zb] : [zb, za];
    const id = opts.id ?? `P-${String(++pipeNo).padStart(4, '0')}`;
    pipes.push({
      id, code: opts.code ?? `GD-${String(pipeNo).padStart(3, '0')}`,
      fromNodeId: up.id, toNodeId: down.id, length: len,
      shape: 'circular', diameter: len > 80 ? 0.8 : 0.6,
      upstreamInvert: zUp, downstreamInvert: zDown,
      manningN: 0.013, sedimentDepth: 0.05 + ((pipeNo * 37) % 9) * 0.012,
      defectLevel: ((pipeNo * 13) % 17 === 0 ? 2 : (pipeNo * 7) % 11 === 0 ? 1 : 0) as PipeSegment['defectLevel'],
      ...opts
    });
  };

  // 横纵格网，形成环状老城管网
  for (let j = 0; j < ys.length; j++) {
    for (let i = 0; i < xs.length - 1; i++) addPipeBetween(idAt(i, j), idAt(i + 1, j));
  }
  for (let i = 0; i < xs.length; i++) {
    for (let j = 0; j < ys.length - 1; j++) addPipeBetween(idAt(i, j), idAt(i, j + 1));
  }

  // 下游 DN1200 主干管与 CCTV 重大淤积
  for (let i = 9; i < xs.length - 1; i++) {
    const bad = i === 16; // x=1700->1800
    const target = pipes.find(p =>
      (p.fromNodeId === idAt(i, 8) && p.toNodeId === idAt(i + 1, 8)) ||
      (p.fromNodeId === idAt(i + 1, 8) && p.toNodeId === idAt(i, 8))
    );
    if (target) {
      target.diameter = 1.2;
      target.code = bad ? 'DN1200-YU-01' : `DN1200-${i - 8}`;
      target.manningN = bad ? 0.017 : 0.013;
      if (bad) {
        target.sedimentDepth = 0.45;
        target.defectLevel = 3;
        target.defectNote = 'CCTV 显示Ⅲ级破裂、树根侵入，淤堵约三分之一过水断面';
      }
    }
  }

  // 排口与河道水位过程线：洪峰期高于管顶，形成顶托倒灌
  const outfall: NetworkNode = {
    id: 'OUT-RIVER', code: 'PK-01', name: '河东排口', kind: 'outfall',
    x: 1960, y: 500, groundElev: 40.6, invert: 37.72, chamberDiameter: 2.2,
    coverDiameter: 1.2,
    riverStageSeries: [
      { tMin: 0, value: 37.35 }, { tMin: 20, value: 37.7 }, { tMin: 45, value: 38.7 },
      { tMin: 70, value: 39.55 }, { tMin: 90, value: 39.45 }, { tMin: 120, value: 38.5 },
      { tMin: 180, value: 37.7 }
    ]
  };
  nodes.push(outfall);
  pipes.push({
    id: 'P-OUTFALL-DN1200', code: 'DN1200-排口管', fromNodeId: idAt(18, 8), toNodeId: 'OUT-RIVER',
    length: 72, shape: 'circular', diameter: 1.2, upstreamInvert: sewerInvert(1900, 500),
    downstreamInvert: 37.72, manningN: 0.013, sedimentDepth: 0.08, defectLevel: 1
  });

  // 下穿雨水泵站，分级启停
  const pump: NetworkNode = {
    id: 'PU-UNDER', code: 'BZ-01', name: '铁路桥下穿泵站', kind: 'pump',
    x: 1045, y: 520, groundElev: 41.9, invert: sewerInvert(1045, 520) - 0.35,
    chamberDiameter: 4.2, coverDiameter: 1.0, coverLiftHead: 1.2,
    pumpStation: {
      wetWellDiameter: 4.2,
      units: [
        { id: 'PU1', capacity: 0.65, startLevel: sewerInvert(1045, 520) + 1.15, stopLevel: sewerInvert(1045, 520) + 0.45 },
        { id: 'PU2', capacity: 0.65, startLevel: sewerInvert(1045, 520) + 1.55, stopLevel: sewerInvert(1045, 520) + 0.75 },
        { id: 'PU3', capacity: 0.9, startLevel: sewerInvert(1045, 520) + 1.95, stopLevel: sewerInvert(1045, 520) + 1.05 }
      ]
    }
  };
  nodes.push(pump);
  pipes.push({
    id: 'P-PUMP-SUCTION', code: 'BZ-吸水管', fromNodeId: idAt(9, 8), toNodeId: 'PU-UNDER',
    length: 56, shape: 'circular', diameter: 1.0, upstreamInvert: sewerInvert(1000, 500),
    downstreamInvert: pump.invert + 0.35, manningN: 0.013, sedimentDepth: 0.1, defectLevel: 1
  });

  // 导入校核问题样例（也进入当前网络，便于验证页面直接看到清单）
  nodes.push(
    { id: 'BAD-N1', code: 'ERR-01', name: '标高异常井', kind: 'inspection', x: 360, y: 930, groundElev: 44, invert: 42.8, chamberDiameter: 1.2 },
    { id: 'BAD-N2', code: 'ERR-02', name: '孤立井 A', kind: 'inspection', x: 80, y: 940, groundElev: 45, invert: 42.0, chamberDiameter: 1.2 },
    { id: 'BAD-N3', code: 'ERR-03', name: '孤立井 B', kind: 'inspection', x: 150, y: 950, groundElev: 44.8, invert: 41.8, chamberDiameter: 1.2 }
  );
  pipes.push(
    { id: 'BAD-REVERSE', code: '问题倒坡管', fromNodeId: idAt(3, 16), toNodeId: 'BAD-N1', length: 42, shape: 'circular', diameter: 0.5, upstreamInvert: 40.8, downstreamInvert: 41.35, manningN: 0.013, sedimentDepth: 0.05, defectLevel: 2, defectNote: '测量复核发现倒坡' },
    { id: 'BAD-MISMATCH', code: '问题标高错位管', fromNodeId: 'BAD-N1', toNodeId: idAt(4, 16), length: 55, shape: 'circular', diameter: 0.5, upstreamInvert: 41.9, downstreamInvert: sewerInvert(500, 900), manningN: 0.013, sedimentDepth: 0.05, defectLevel: 1 },
    { id: 'BAD-ISOLATED', code: '孤立接入管', fromNodeId: 'BAD-N2', toNodeId: 'BAD-N3', length: 78, shape: 'circular', diameter: 0.4, upstreamInvert: 42.0, downstreamInvert: 41.8, manningN: 0.013, sedimentDepth: 0.02, defectLevel: 0 }
  );

  const now = Date.now();
  const project: Project = {
    id: 'oldcity-2km2', name: '老城铁路桥片区（2 km² 校核样例）', createdAt: now, updatedAt: now,
    bbox: BBOX, nodes, pipes, terrain: createSampleTerrain(),
    rainfall: {
      source: 'chicago', returnPeriod: 5, durationMin: 120, peakRatio: 0.4, intervalMin: 2,
      formula: { A1: 2860, C: 0.88, b: 10.2, n: 0.69 },
      gauges: [
        { id: 'G1', name: '铁西雨量站', x: 350, y: 720, minutes: Array.from({ length: 121 }, (_, i) => i), depthMm: [] },
        { id: 'G2', name: '桥南雨量站', x: 1050, y: 260, minutes: Array.from({ length: 121 }, (_, i) => i), depthMm: [] },
        { id: 'G3', name: '河东雨量站', x: 1750, y: 760, minutes: Array.from({ length: 121 }, (_, i) => i), depthMm: [] }
      ]
    },
    schemes: [
      { id: 'base', name: '现状管网', description: '含 DN1200 淤积 0.45m、3 台泵站和河道顶托' },
      {
        id: 'dredge', name: '方案一：疏通 DN1200', description: '清除下游淤堵段 0.45m 淤积，恢复全断面',
        pipeSedimentOverrides: { 'P-TRUNK-BAD': 0 }
      },
      {
        id: 'pump-plus', name: '方案二：下穿加泵', description: '新增一台 1.2 m³/s 泵并优化分级启泵水位',
        pumpRuleOverrides: {
          'PU-UNDER': [
            { id: 'PU1', capacity: 0.65, startLevel: sewerInvert(1045, 520) + 1.0, stopLevel: sewerInvert(1045, 520) + 0.4 },
            { id: 'PU2', capacity: 0.65, startLevel: sewerInvert(1045, 520) + 1.35, stopLevel: sewerInvert(1045, 520) + 0.65 },
            { id: 'PU3', capacity: 0.9, startLevel: sewerInvert(1045, 520) + 1.7, stopLevel: sewerInvert(1045, 520) + 0.9 },
            { id: 'PU-NEW', capacity: 1.2, startLevel: sewerInvert(1045, 520) + 1.45, stopLevel: sewerInvert(1045, 520) + 0.75 }
          ]
        },
        addedPumps: []
      },
      {
        id: 'combined', name: '组合方案', description: '疏通淤堵并新增泵',
        pipeSedimentOverrides: { 'P-TRUNK-BAD': 0 },
        pumpRuleOverrides: { 'PU-UNDER': [
          { id: 'PU1', capacity: 0.65, startLevel: sewerInvert(1045, 520) + 1.0, stopLevel: sewerInvert(1045, 520) + 0.4 },
          { id: 'PU2', capacity: 0.65, startLevel: sewerInvert(1045, 520) + 1.35, stopLevel: sewerInvert(1045, 520) + 0.65 },
          { id: 'PU3', capacity: 0.9, startLevel: sewerInvert(1045, 520) + 1.7, stopLevel: sewerInvert(1045, 520) + 0.9 },
          { id: 'PU-NEW', capacity: 1.2, startLevel: sewerInvert(1045, 520) + 1.45, stopLevel: sewerInvert(1045, 520) + 0.75 }
        ] }
      }
    ]
  };

  // 让方案覆盖使用真实问题管 ID
  for (const s of project.schemes) {
    if (s.pipeSedimentOverrides && 'P-TRUNK-BAD' in s.pipeSedimentOverrides) {
      s.pipeSedimentOverrides['DN1200-YU-01'] = 0;
      delete s.pipeSedimentOverrides['P-TRUNK-BAD'];
    }
  }

  // 给三个雨量站造实测分钟雨量（确定性、空间略有差异）
  for (const g of project.rainfall.gauges!) {
    g.depthMm = Array.from({ length: 121 }, (_, minute) => {
      if (minute === 0 || minute > 120) return 0;
      const peak = 48;
      const sigma = minute < peak ? 16 : 28;
      const base = 1.15 * Math.exp(-((minute - peak) ** 2) / (2 * sigma * sigma));
      const spatial = g.id === 'G1' ? 0.92 : g.id === 'G2' ? 1.08 : 0.98;
      return Number((base * spatial * (1 + 0.08 * Math.sin(minute * 1.7))).toFixed(3));
    });
  }

  return project;
}

export function createImportIssueFixture(): ValidationIssue[] {
  return [
    { level: 'error', type: 'reverse-slope', entityId: 'RAW-1', message: 'RAW-12 倒坡：上游管底 41.20m，下游 41.48m' },
    { level: 'error', type: 'invert-mismatch', entityId: 'RAW-2', message: 'RAW-18 上下游管底与 J-102 井底标高差 1.40m' },
    { level: 'warning', type: 'isolated', entityId: 'RAW-9', message: 'RAW-9 为孤立管段，未连接任何排口或泵站' }
  ];
}
