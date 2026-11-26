import type { Project, RainfallConfig, RainfallSeries, RainGauge, GeoPoint, BBox } from './types';

/** 本地暴雨强度公式，返回 L/(s·ha) */
export function stormIntensityLsHa(cfg: RainfallConfig['formula'], returnPeriod: number, durationMin: number): number {
  const t = Math.max(1, durationMin);
  const p = Math.max(0.1, returnPeriod);
  return (cfg.A1 * (1 + cfg.C * Math.log10(p))) / Math.pow(t + cfg.b, cfg.n);
}

/** 芝加哥雨型瞬时强度，L/(s·ha)；side=before/after peak */
export function chicagoInstantLsHa(cfg: RainfallConfig['formula'], returnPeriod: number, offsetMin: number, scale: number): number {
  const a = cfg.A1 * (1 + cfg.C * Math.log10(Math.max(0.1, returnPeriod)));
  const t = Math.max(0, offsetMin);
  const denom = t / Math.max(0.05, scale) + cfg.b;
  return (a * ((1 - cfg.n) * t / Math.max(0.05, scale) + cfg.b)) / Math.pow(denom, cfg.n + 1);
}

export function buildChicagoSeries(cfg: RainfallConfig): RainfallSeries {
  const dt = cfg.intervalMin;
  const count = Math.round(cfg.durationMin / dt);
  const peakIndex = Math.round(cfg.peakRatio * count);
  const intensityMmH: number[] = [];
  const depthMm: number[] = [];

  for (let k = 0; k < count; k++) {
    // 时段中点，减少峰值恰好落在边界造成的锯齿
    const stepStart = k * dt;
    const stepEnd = (k + 1) * dt;
    let qSum = 0;
    const sub = 4;
    for (let s = 0; s < sub; s++) {
      const t = stepStart + ((s + 0.5) / sub) * dt;
      let q: number;
      if (t <= cfg.peakRatio * cfg.durationMin) {
        q = chicagoInstantLsHa(cfg.formula, cfg.returnPeriod, cfg.peakRatio * cfg.durationMin - t, cfg.peakRatio);
      } else {
        q = chicagoInstantLsHa(cfg.formula, cfg.returnPeriod, t - cfg.peakRatio * cfg.durationMin, 1 - cfg.peakRatio);
      }
      qSum += q;
    }
    const q = qSum / sub;
    const mmH = q * 0.36; // L/(s·ha) -> mm/h
    intensityMmH.push(mmH);
    depthMm.push((mmH * dt) / 60);
  }
  // 保证总雨量与强度公式设计雨量一致到 0.5% 以内（芝加哥采样误差修正）
  const targetDepthMm = stormIntensityLsHa(cfg.formula, cfg.returnPeriod, cfg.durationMin) * 0.36 * cfg.durationMin / 60;
  const sum = depthMm.reduce((a, b) => a + b, 0);
  if (sum > 0) {
    const correction = targetDepthMm / sum;
    for (let i = 0; i < depthMm.length; i++) {
      depthMm[i] *= correction;
      intensityMmH[i] *= correction;
    }
  }
  return { intervalMin: dt, intensityMmH, depthMm };
}

export function gaugeSeries(gauge: RainGauge): RainfallSeries {
  // minutes 为累计分钟轴，depthMm 为逐分钟或逐时段增量；样例直接给逐分钟增量
  const intervalMin = gauge.minutes.length > 1 ? gauge.minutes[1] - gauge.minutes[0] : 1;
  const depthMm = [...gauge.depthMm];
  const intensityMmH = depthMm.map(d => (d * 60) / intervalMin);
  return { intervalMin, intensityMmH, depthMm };
}

export function projectRainfallSeries(project: Project): RainfallSeries {
  if (project.rainfall.source === 'gauge' && project.rainfall.gauges?.length) {
    // 单站/加权在耦合器中按 Thiessen 处理；这里返回第一站用于图表
    return gaugeSeries(project.rainfall.gauges[0]);
  }
  return buildChicagoSeries(project.rainfall);
}

export interface ThiessenWeight {
  gaugeId: string;
  areaFraction: number;
  areaM2: number;
}

/** 用规则采样格网做最近雨量站泰森权重，面积守恒 */
export function thiessenWeights(gauges: (GeoPoint & { id: string })[], bbox: BBox, sampleCols = 200, sampleRows = 100): ThiessenWeight[] {
  const counts = new Map<string, number>();
  let total = 0;
  for (let r = 0; r < sampleRows; r++) {
    const y = bbox.minY + ((r + 0.5) / sampleRows) * (bbox.maxY - bbox.minY);
    for (let c = 0; c < sampleCols; c++) {
      const x = bbox.minX + ((c + 0.5) / sampleCols) * (bbox.maxX - bbox.minX);
      let best = gauges[0]?.id;
      let bestD = Infinity;
      for (const g of gauges) {
        const d = (g.x - x) ** 2 + (g.y - y) ** 2;
        if (d < bestD) { bestD = d; best = g.id; }
      }
      if (best) counts.set(best, (counts.get(best) ?? 0) + 1);
      total++;
    }
  }
  const area = (bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY);
  return gauges.map(g => {
    const n = counts.get(g.id) ?? 0;
    return { gaugeId: g.id, areaFraction: n / total, areaM2: area * n / total };
  });
}

/** Horton 下渗能力，mm/h */
export function hortonCapacityMMH(f0: number, fc: number, kPerH: number, elapsedH: number): number {
  return fc + (f0 - fc) * Math.exp(-kPerH * Math.max(0, elapsedH));
}
