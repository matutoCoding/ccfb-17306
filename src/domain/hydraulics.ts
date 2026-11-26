import type { PipeSegment } from './types';

export const G = 9.81;

export interface SectionGeometry {
  /** 用于连续方程/波速的等效过水面积，满管后含 Preissmann 窄缝 */
  area: number;
  /** 真实过水面积（扣除淤积，不含窄缝） */
  physicalArea: number;
  topWidth: number;
  wettedPerimeter: number;
  hydraulicRadius: number;
  /** 管顶/渠顶相对管底高度 */
  crownHeight: number;
  fullArea: number;
  slotWidth: number;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

export function manningFlow(area: number, hydraulicRadius: number, slope: number, n: number): number {
  if (area <= 1e-9 || hydraulicRadius <= 1e-9 || slope <= 0) return 0;
  return (area * Math.pow(hydraulicRadius, 2 / 3) * Math.sqrt(slope)) / n;
}

export function manningSlope(q: number, area: number, radius: number, n: number): number {
  if (area <= 1e-10 || radius <= 1e-10) return 0;
  const k = (n * Math.abs(q)) / (area * Math.pow(radius, 2 / 3));
  return k * k;
}

/** 圆管从管底到高度 h 的弓形面积 */
export function circularSegmentArea(diameter: number, h: number): number {
  if (diameter <= 0) return 0;
  const r = diameter / 2;
  const hh = clamp(h, 0, diameter);
  if (hh <= 0) return 0;
  if (hh >= diameter) return Math.PI * r * r;
  const d = r - hh;
  return r * r * Math.acos(clamp(d / r, -1, 1)) - d * Math.sqrt(Math.max(0, 2 * r * hh - hh * hh));
}

/** 圆管高度 h 处的水面宽度 */
export function circularWidth(diameter: number, h: number): number {
  const r = diameter / 2;
  const y = clamp(h, 0, diameter);
  return 2 * Math.sqrt(Math.max(0, r * r - (y - r) * (y - r)));
}

export function crownHeight(pipe: PipeSegment): number {
  if (pipe.shape === 'circular') return pipe.diameter ?? 1;
  return pipe.height ?? 1;
}

export function fullPhysicalArea(pipe: PipeSegment): number {
  const s = clamp(pipe.sedimentDepth ?? 0, 0, crownHeight(pipe) - 1e-6);
  if (pipe.shape === 'circular') {
    const d = pipe.diameter ?? 1;
    return Math.max(0, circularSegmentArea(d, d) - circularSegmentArea(d, s));
  }
  const b = pipe.width ?? pipe.bottomWidth ?? 1;
  const h = pipe.height ?? 1;
  const m = pipe.sideSlope ?? 0;
  const topAtSediment = b + 2 * m * s;
  return Math.max(0, h * (topAtSediment + b + 2 * m * h) / 2 - s * (b + (b + 2 * m * s)) / 2);
}

export function preissmannSlotWidth(pipe: PipeSegment, celerity = 20): number {
  const a = fullPhysicalArea(pipe);
  return (G * Math.max(a, 1e-6)) / (celerity * celerity);
}

/**
 * 给定相对管底的水深/测压管高度 y（m），返回水力断面要素。
 * y > crownHeight 时按 Preissmann 窄缝处理有压管。
 */
export function sectionGeometry(pipe: PipeSegment, y: number, celerity = 20): SectionGeometry {
  const crown = crownHeight(pipe);
  const sediment = clamp(pipe.sedimentDepth ?? 0, 0, crown - 1e-5);
  const fullArea = fullPhysicalArea(pipe);
  const slotWidth = preissmannSlotWidth(pipe, celerity);
  const yy = Math.max(0, y);

  let physicalArea = 0;
  let topWidth = 0;
  let wettedPerimeter = 0;

  if (pipe.shape === 'circular') {
    const d = pipe.diameter ?? 1;
    if (yy <= sediment) {
      physicalArea = 0;
      topWidth = 0;
      wettedPerimeter = 0;
    } else if (yy < d) {
      physicalArea = Math.max(0, circularSegmentArea(d, yy) - circularSegmentArea(d, sediment));
      topWidth = circularWidth(d, yy);
      const arcTo = 2 * (d / 2) * Math.acos(clamp((d / 2 - clamp(yy, 0, d)) / (d / 2), -1, 1));
      const arcSed = 2 * (d / 2) * Math.acos(clamp((d / 2 - sediment) / (d / 2), -1, 1));
      const sedimentTopWidth = circularWidth(d, sediment);
      wettedPerimeter = Math.max(0, arcTo - arcSed) + (sediment > 0.001 ? sedimentTopWidth : 0);
    } else {
      physicalArea = fullArea;
      topWidth = 0;
      const arcFull = Math.PI * d;
      const arcSed = 2 * (d / 2) * Math.acos(clamp((d / 2 - sediment) / (d / 2), -1, 1));
      wettedPerimeter = Math.max(0, arcFull - arcSed) + (sediment > 0.001 ? circularWidth(d, sediment) : 0);
    }
  } else {
    const h = pipe.height ?? 1;
    const b = pipe.width ?? pipe.bottomWidth ?? 1;
    const m = pipe.sideSlope ?? 0;
    if (yy <= sediment) {
      physicalArea = 0;
    } else {
      const waterTop = Math.min(yy, h);
      const d = Math.max(0, waterTop - sediment);
      const widthSed = b + 2 * m * sediment;
      const widthTop = b + 2 * m * waterTop;
      physicalArea = d * (widthSed + widthTop) / 2;
      topWidth = yy < h ? widthTop : 0;
      wettedPerimeter = widthSed + 2 * d * Math.sqrt(1 + m * m);
    }
  }

  let area = physicalArea;
  if (yy > crown) {
    const pressureHead = yy - crown;
    area += slotWidth * pressureHead;
    topWidth = slotWidth;
  } else if (yy >= crown - 1e-6) {
    topWidth = slotWidth;
  }

  if (physicalArea < 1e-10) {
    physicalArea = 0;
    wettedPerimeter = 0;
  }
  const hydraulicRadius = wettedPerimeter > 1e-10 ? physicalArea / wettedPerimeter : 0;
  return { area, physicalArea, topWidth: Math.max(topWidth, 0), wettedPerimeter, hydraulicRadius, crownHeight: crown, fullArea, slotWidth };
}

export function depthFromEffectiveArea(pipe: PipeSegment, targetArea: number, celerity = 20): number {
  if (targetArea <= 1e-12) return 0;
  const crown = crownHeight(pipe);
  const fullEff = sectionGeometry(pipe, crown, celerity).area;
  if (targetArea <= fullEff + 1e-12) {
    let lo = 0;
    let hi = crown;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (sectionGeometry(pipe, mid, celerity).area < targetArea) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  }
  const slot = preissmannSlotWidth(pipe, celerity);
  return crown + (targetArea - fullEff) / Math.max(slot, 1e-9);
}

/** 单调断面面积查表；一维网络每步由体积反算水深时使用 */
export class SectionTable {
  readonly depths: Float64Array;
  readonly areas: Float64Array;
  readonly crown: number;
  readonly maxDepth: number;

  constructor(pipe: PipeSegment, celerity = 18, samples = 96, maxPressureHead = 12) {
    this.crown = crownHeight(pipe);
    this.maxDepth = this.crown + maxPressureHead;
    this.depths = new Float64Array(samples + 1);
    this.areas = new Float64Array(samples + 1);
    for (let i = 0; i <= samples; i++) {
      const y = (i / samples) * this.maxDepth;
      this.depths[i] = y;
      this.areas[i] = sectionGeometry(pipe, y, celerity).area;
    }
  }

  depthForArea(target: number): number {
    if (target <= 1e-12) return 0;
    const a = this.areas;
    if (target >= a[a.length - 1]) return this.maxDepth;
    let lo = 0, hi = a.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid] < target) lo = mid;
      else hi = mid;
    }
    const a0 = a[lo], a1 = a[hi];
    const k = (target - a0) / Math.max(1e-12, a1 - a0);
    return this.depths[lo] + k * (this.depths[hi] - this.depths[lo]);
  }
}

export function pointInPolygon(x: number, y: number, points: { x: number; y: number }[]): boolean {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    const intersect = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi + 1e-15) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}
