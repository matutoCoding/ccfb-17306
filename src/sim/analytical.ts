import { G } from '../domain/hydraulics';

export interface RitterPoint {
  x: number;
  h: number;
  u: number;
}

/**
 * Ritter 溃坝解析解：平底、无摩阻、下游干床。
 * 坝址 x=0；初始上游水深 h0，x<0。
 */
export function ritterAt(x: number, tSec: number, h0: number): RitterPoint {
  const c0 = Math.sqrt(G * h0);
  if (tSec <= 0) {
    return x < 0 ? { x, h: h0, u: 0 } : { x, h: 0, u: 0 };
  }
  const tailX = -c0 * tSec;
  const frontX = 2 * c0 * tSec;
  if (x <= tailX) return { x, h: h0, u: 0 };
  if (x >= frontX) return { x, h: 0, u: 0 };
  const h = ((2 * c0 - x / tSec) ** 2) / (9 * G);
  const u = (2 / 3) * (c0 + x / tSec);
  return { x, h: Math.max(0, h), u };
}

export function ritterErrorMetrics(
  xs: ArrayLike<number>,
  hs: ArrayLike<number>,
  tSec: number,
  h0: number,
  xMin?: number,
  xMax?: number
) {
  let sumSq = 0;
  let sumAbs = 0;
  let maxNorm = 0;
  let count = 0;
  let smoothSumSq = 0;
  let smoothCount = 0;
  const c0 = Math.sqrt(G * h0);
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (xMin !== undefined && x < xMin) continue;
    if (xMax !== undefined && x > xMax) continue;
    const exact = ritterAt(x, tSec, h0);
    const err = hs[i] - exact.h;
    sumSq += err * err;
    sumAbs += Math.abs(err);
    maxNorm = Math.max(maxNorm, Math.abs(err) / h0);
    count++;
    // 排除两个导数间断/干湿锋面附近，检查稀疏波主体精度
    if (x > -0.85 * c0 * tSec && x < 1.75 * c0 * tSec) {
      smoothSumSq += err * err;
      smoothCount++;
    }
  }
  return {
    rmseM: Math.sqrt(sumSq / Math.max(1, count)),
    rmsePctOfH0: 100 * Math.sqrt(sumSq / Math.max(1, count)) / h0,
    maePctOfH0: 100 * sumAbs / Math.max(1, count) / h0,
    maxPctOfH0: 100 * maxNorm,
    smoothRmsePctOfH0: 100 * Math.sqrt(smoothSumSq / Math.max(1, smoothCount)) / h0,
    count
  };
}
