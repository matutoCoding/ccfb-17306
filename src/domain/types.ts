export type ID = string;

export type NodeKind = 'inspection' | 'outfall' | 'pump' | 'gate';
export type PipeSectionShape = 'circular' | 'rectangular' | 'trapezoidal';
export type DefectLevel = 0 | 1 | 2 | 3 | 4;

export interface GeoPoint {
  x: number;
  y: number;
}

export interface BBox {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}

export interface NetworkNode extends GeoPoint {
  id: ID;
  code: string;
  name: string;
  kind: NodeKind;
  groundElev: number;
  /** 井底/集水池底高程，m */
  invert: number;
  /** 检查井或集水池直径，m */
  chamberDiameter: number;
  coverDiameter?: number;
  /** 井盖顶飞压力水头阈值（相对地面），m */
  coverLiftHead?: number;
  riverStageSeries?: TimeValue[];
  pumpStation?: PumpStation;
  gateOpening?: number;
}

export interface TimeValue {
  tMin: number;
  value: number;
}

export interface PumpUnit {
  id: ID;
  capacity: number; // m3/s
  startLevel: number; // 集水池水位，绝对高程 m
  stopLevel: number;
}

export interface PumpStation {
  wetWellDiameter: number;
  units: PumpUnit[];
  /** 调度规则修改时刻，分钟；用于增量重算 */
  ruleChangedAtMin?: number;
}

export interface PipeSegment {
  id: ID;
  code: string;
  fromNodeId: ID;
  toNodeId: ID;
  length: number;
  shape: PipeSectionShape;
  diameter?: number;
  width?: number;
  height?: number;
  bottomWidth?: number;
  sideSlope?: number;
  upstreamInvert: number;
  downstreamInvert: number;
  manningN: number;
  /** CCTV 淤积深度，m */
  sedimentDepth: number;
  defectLevel: DefectLevel;
  defectNote?: string;
  inspectionDate?: string;
}

export interface ValidationIssue {
  level: 'error' | 'warning';
  type: 'reverse-slope' | 'invert-mismatch' | 'isolated' | 'sediment' | 'defect' | 'duplicate';
  entityId: ID;
  message: string;
}

export type SurfaceClass = 'road' | 'green' | 'roof' | 'water' | 'other';

export interface LandCoverCell {
  cls: SurfaceClass;
  /** Horton 初始下渗率 mm/h */
  f0: number;
  /** 稳定下渗率 mm/h */
  fc: number;
  /** 衰减系数 1/h */
  k: number;
  roughness: number;
}

export interface TerrainModel {
  id: ID;
  name: string;
  cols: number;
  rows: number;
  cellSize: number;
  originX: number;
  originY: number;
  /** 行优先，长度 cols*rows，单位 m */
  elevations: Float64Array;
  landCover: Uint8Array; // SurfaceClass 枚举索引
  infiltrationParams: Float32Array; // 每类或每格 f0,fc,k,n? 这里存 f0/fc/k 三连
  buildings: BuildingPolygon[];
  underpasses: UnderpassZone[];
}

export interface BuildingPolygon {
  id: ID;
  name?: string;
  points: GeoPoint[];
  /** 挡水块顶面/抬高值；计算时建筑内部设为阻挡 */
  height: number;
}

export interface UnderpassZone {
  id: ID;
  name: string;
  alignment: GeoPoint[];
  chainage: number[];
  elevations: number[];
  lowPointChainage: number;
  bottomElev: number;
  width: number;
  carPositionChainage: number;
}

export interface RainfallConfig {
  source: 'chicago' | 'gauge';
  /** 重现期，年 */
  returnPeriod: number;
  durationMin: number;
  /** 雨峰位置系数 0-1 */
  peakRatio: number;
  intervalMin: number;
  /** 本地暴雨强度公式 q = A1*(1+C*lgP)/(t+b)^n，单位 L/(s·ha) */
  formula: { A1: number; C: number; b: number; n: number };
  gauges?: RainGauge[];
  thiessenPolygons?: ThiessenPolygon[];
}

export interface RainGauge extends GeoPoint {
  id: ID;
  name: string;
  minutes: number[];
  depthMm: number[];
}

export interface ThiessenPolygon {
  gaugeId: ID;
  areaM2: number;
  points: GeoPoint[];
}

export interface RainfallSeries {
  intervalMin: number;
  /** 每个时段降雨强度 mm/h */
  intensityMmH: number[];
  /** 每个时段雨量 mm */
  depthMm: number[];
}

export interface Project {
  id: ID;
  name: string;
  createdAt: number;
  updatedAt: number;
  bbox: BBox;
  nodes: NetworkNode[];
  pipes: PipeSegment[];
  terrain?: TerrainModel;
  rainfall: RainfallConfig;
  schemes: Scheme[];
}

export interface Scheme {
  id: ID;
  name: string;
  description: string;
  pipeSedimentOverrides?: Record<ID, number>;
  pumpRuleOverrides?: Record<ID, PumpUnit[]>;
  addedPumps?: { nodeId: ID; units: PumpUnit[] }[];
}

export interface SimulationOptions {
  durationMin: number;
  surfaceCellSize?: number;
  couplingDtSec?: number;
  engine: 'cpu' | 'webgpu';
  recordIntervalSec?: number;
  /** Preissmann 等效波速 m/s，决定窄缝宽度 */
  preissmannCelerity?: number;
  /** 1D 每段最大长度 m */
  maxReachLength?: number;
}

export interface MassLedger {
  rainfallM3: number;
  infiltrationM3: number;
  outfallM3: number;
  riverBackflowM3: number;
  pumpM3: number;
  surfaceBoundaryM3: number;
  initialStorageM3: number;
  finalStorageM3: number;
  couplingExchangedM3: number;
  residualM3: number;
  relativeErrorPct: number;
}

export interface FloodSpotStat {
  id: ID;
  name: string;
  kind: 'underpass' | 'low-road' | 'well' | 'area';
  x: number;
  y: number;
  maxDepthM: number;
  maxTimeMin: number;
  durationMin: number;
  recessionMin: number | null;
  cellCountOverThreshold: number;
}

export interface RunSummary {
  id: ID;
  projectId: ID;
  schemeId: ID;
  startedAt: number;
  options: SimulationOptions;
  ledger: MassLedger;
  spots: FloodSpotStat[];
  maxDepthM: number;
  elapsedMs: number;
  engineInfo: string;
  frameCount: number;
}

export interface ReplayFrame {
  tSec: number;
  cols: number;
  rows: number;
  cellSize: number;
  originX: number;
  originY: number;
  depth: Float32Array;
  u: Float32Array;
  v: Float32Array;
  elev: Float32Array;
  mask: Uint8Array;
  nodeHeads: Record<ID, number>;
  nodeStates: Record<ID, NodeRuntimeSnapshot>;
  pipeQ: Record<ID, number>;
}

export interface NodeRuntimeSnapshot {
  head: number;
  depth: number;
  volume: number;
  flooded: boolean;
  coverBlown: boolean;
  exchangeQ: number;
}

export interface RunRecord extends RunSummary {
  frames: ReplayFrame[];
  hydrographs: {
    rainfallMmH: number[];
    outfallM3s: number[];
    pumpM3s: number[];
    timeMin: number[];
  };
}
