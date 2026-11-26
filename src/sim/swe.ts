import { G, manningSlope } from '../domain/hydraulics';

export interface SweOptions {
  cols: number;
  rows: number;
  cellSize: number;
  originX?: number;
  originY?: number;
  elevations?: Float64Array;
  roughness?: Float32Array | number;
  mask?: Uint8Array;
  dryDepth?: number;
  cfl?: number;
}

export class ShallowWaterGrid {
  cols: number;
  rows: number;
  dx: number;
  dy: number;
  originX: number;
  originY: number;
  z: Float64Array;
  h: Float64Array;
  hu: Float64Array;
  hv: Float64Array;
  zNew: Float64Array;
  hNew: Float64Array;
  huNew: Float64Array;
  hvNew: Float64Array;
  roughness: Float32Array;
  mask: Uint8Array;
  dryDepth: number;
  cfl: number;
  timeSec = 0;
  boundaryNetOutM3 = 0;
  negativeDepthClips = 0;
  positivityClipM3 = 0;
  maxClipDepthM = 0;

  constructor(opts: SweOptions) {
    const n = opts.cols * opts.rows;
    this.cols = opts.cols;
    this.rows = opts.rows;
    this.dx = opts.cellSize;
    this.dy = opts.cellSize;
    this.originX = opts.originX ?? 0;
    this.originY = opts.originY ?? 0;
    this.z = opts.elevations ? Float64Array.from(opts.elevations) : new Float64Array(n);
    this.h = new Float64Array(n);
    this.hu = new Float64Array(n);
    this.hv = new Float64Array(n);
    this.zNew = new Float64Array(n);
    this.hNew = new Float64Array(n);
    this.huNew = new Float64Array(n);
    this.hvNew = new Float64Array(n);
    this.roughness = new Float32Array(n);
    if (typeof opts.roughness === 'number') this.roughness.fill(opts.roughness);
    else if (opts.roughness) this.roughness.set(opts.roughness);
    else this.roughness.fill(0.035);
    this.mask = opts.mask ? Uint8Array.from(opts.mask) : new Uint8Array(n).fill(1);
    this.dryDepth = opts.dryDepth ?? 1e-5;
    this.cfl = opts.cfl ?? 0.42;
  }

  idx(c: number, r: number): number { return r * this.cols + c; }
  xAt(c: number): number { return this.originX + (c + 0.5) * this.dx; }
  yAt(r: number): number { return this.originY + (r + 0.5) * this.dy; }

  stableDt(maxDt = 1): number {
    let sx = 1e-6;
    let sy = 1e-6;
    for (let i = 0; i < this.h.length; i++) {
      if (!this.mask[i] || this.h[i] <= this.dryDepth) continue;
      const h = this.h[i];
      const u = this.hu[i] / h;
      const v = this.hv[i] / h;
      const c = Math.sqrt(G * h);
      sx = Math.max(sx, Math.abs(u) + c);
      sy = Math.max(sy, Math.abs(v) + c);
    }
    // 二维 Rusanov 的 x/y 数值粘性同时占用正性 CFL 预算，分母用 sx+sy
    return Math.min(maxDt, (this.cfl * Math.min(this.dx, this.dy)) / (sx + sy));
  }

  /** 单个 Rusanov 有限体积步；dt 应由 stableDt 限制 */
  step(dt: number): number {
    const { cols, rows, dx, dy } = this;
    const n = cols * rows;
    const h = this.h, hu = this.hu, hv = this.hv, z = this.z, mask = this.mask;
    const hN = this.hNew, huN = this.huNew, hvN = this.hvNew;
    hN.set(h); huN.set(hu); hvN.set(hv);

    let boundaryOut = 0;

    // X 方向界面通量并直接做有限体积散度更新
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c <= cols; c++) {
        const iL = r * cols + Math.max(0, c - 1);
        const iR = r * cols + Math.min(cols - 1, c);
        const leftBoundary = c === 0;
        const rightBoundary = c === cols;
        if ((!leftBoundary && !mask[iL]) || (!rightBoundary && !mask[iR]) || (!mask[iL] && !mask[iR])) {
          // 阻挡单元界面：零通量
          continue;
        }
        let hL = leftBoundary ? h[iR] : h[iL];
        let qxL = leftBoundary ? hu[iR] : hu[iL];
        let qyL = leftBoundary ? hv[iR] : hv[iL];
        let zL = leftBoundary ? z[iR] : z[iL];
        let hR = rightBoundary ? h[iL] : h[iR];
        let qxR = rightBoundary ? hu[iL] : hu[iR];
        let qyR = rightBoundary ? hv[iL] : hv[iR];
        let zR = rightBoundary ? z[iL] : z[iR];

        // 建筑/阻水块或闭边界：边界用反射状态
        if (leftBoundary || rightBoundary) {
          if (leftBoundary) { qxL = -qxR; qyL = qyR; zL = zR; hL = hR; }
          if (rightBoundary) { qxR = -qxL; qyR = qyL; zR = zL; hR = hL; }
        }

        const zf = Math.max(zL, zR);
        const hrL = Math.max(0, hL + zL - zf);
        const hrR = Math.max(0, hR + zR - zf);
        const f = rusanovX(hrL, qxL, qyL, hrR, qxR, qyR);
        const edgeLength = dy;
        if (c > 0 && c < cols) {
          const il = r * cols + c - 1, ir = r * cols + c;
          if (mask[il]) {
            hN[il] -= dt / dx * f[0];
            huN[il] -= dt / dx * f[1];
            hvN[il] -= dt / dx * f[2];
          }
          if (mask[ir]) {
            hN[ir] += dt / dx * f[0];
            huN[ir] += dt / dx * f[1];
            hvN[ir] += dt / dx * f[2];
          }
        } else if (c === 0) {
          // 左边界 F_{1/2}：对首格是 +F_left，外法向质量通量为 -f[0]
          const ib0 = r * cols;
          if (mask[ib0]) {
            hN[ib0] += dt / dx * f[0];
            huN[ib0] += dt / dx * f[1];
            hvN[ib0] += dt / dx * f[2];
          }
          boundaryOut += -f[0] * dt * edgeLength;
        } else {
          const ib = r * cols + cols - 1;
          if (mask[ib]) {
            hN[ib] -= dt / dx * f[0];
            huN[ib] -= dt / dx * f[1];
            hvN[ib] -= dt / dx * f[2];
          }
          boundaryOut += f[0] * dt * edgeLength;
        }
      }
    }

    // Y 方向
    for (let r = 0; r <= rows; r++) {
      for (let c = 0; c < cols; c++) {
        const iB = Math.max(0, r - 1) * cols + c;
        const iT = Math.min(rows - 1, r) * cols + c;
        const bottomBoundary = r === 0;
        const topBoundary = r === rows;
        let hB = bottomBoundary ? h[iT] : h[iB];
        let qxB = bottomBoundary ? hu[iT] : hu[iB];
        let qyB = bottomBoundary ? hv[iT] : hv[iB];
        let zB = bottomBoundary ? z[iT] : z[iB];
        let hT = topBoundary ? h[iB] : h[iT];
        let qxT = topBoundary ? hu[iB] : hu[iT];
        let qyT = topBoundary ? hv[iB] : hv[iT];
        let zT = topBoundary ? z[iB] : z[iB];
        if (bottomBoundary) { qyB = -qyT; qxB = qxT; zB = zT; hB = hT; }
        if (topBoundary) { qyT = -qyB; qxT = qxB; zT = zB; hT = hB; }

        const zf = Math.max(zB, zT);
        const hrB = Math.max(0, hB + zB - zf);
        const hrT = Math.max(0, hT + zT - zf);
        const f = rusanovY(hrB, qxB, qyB, hrT, qxT, qyT);
        const edgeLength = dx;
        if (r > 0 && r < rows) {
          const ib = (r - 1) * cols + c, it = r * cols + c;
          if (mask[ib]) {
            hN[ib] -= dt / dy * f[0];
            huN[ib] -= dt / dy * f[1];
            hvN[ib] -= dt / dy * f[2];
          }
          if (mask[it]) {
            hN[it] += dt / dy * f[0];
            huN[it] += dt / dy * f[1];
            hvN[it] += dt / dy * f[2];
          }
        } else if (r === 0) {
          const ib0 = c;
          if (mask[ib0]) {
            hN[ib0] += dt / dy * f[0];
            huN[ib0] += dt / dy * f[1];
            hvN[ib0] += dt / dy * f[2];
          }
          boundaryOut += -f[0] * dt * edgeLength;
        } else {
          const it = (rows - 1) * cols + c;
          if (mask[it]) {
            hN[it] -= dt / dy * f[0];
            huN[it] -= dt / dy * f[1];
            hvN[it] -= dt / dy * f[2];
          }
          boundaryOut += f[0] * dt * edgeLength;
        }
      }
    }

    // 底坡源（中心差分）+ Manning 摩擦；建筑格强制 dry
    let clips = 0;
    let negativeDepthSum = 0;
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        if (!mask[i]) {
          hN[i] = 0; huN[i] = 0; hvN[i] = 0;
          continue;
        }
        if (hN[i] < 0) {
          // 记录被抬升回零的负深；循环结束后按比例从有水格扣回，保证总质量不变
          negativeDepthSum += -hN[i];
          this.positivityClipM3 += -hN[i] * dx * dy;
          this.maxClipDepthM = Math.max(this.maxClipDepthM, -hN[i]);
          hN[i] = 0;
          clips++;
        }
        if (hN[i] <= this.dryDepth) {
          // 只清零动量；极小水膜保留质量，避免 dry cutoff 本身制造水量误差
          huN[i] = 0; hvN[i] = 0;
          continue;
        }

        let dzdx = 0;
        if (c > 0 && c < cols - 1) dzdx = (z[i + 1] - z[i - 1]) / (2 * dx);
        else if (c === 0 && cols > 1) dzdx = (z[i + 1] - z[i]) / dx;
        else if (cols > 1) dzdx = (z[i] - z[i - 1]) / dx;
        let dzdy = 0;
        if (r > 0 && r < rows - 1) dzdy = (z[i + cols] - z[i - cols]) / (2 * dy);
        else if (r === 0 && rows > 1) dzdy = (z[i + cols] - z[i]) / dy;
        else if (rows > 1) dzdy = (z[i] - z[i - cols]) / dy;

        const hm = Math.max(hN[i], this.dryDepth);
        huN[i] += -G * hm * dzdx * dt;
        hvN[i] += -G * hm * dzdy * dt;

        const u = huN[i] / hm;
        const v = hvN[i] / hm;
        const speed = Math.hypot(u, v);
        const n = this.roughness[i];
        const frictionDen = n > 0 ? 1 + dt * G * n * n * speed / Math.pow(hm, 1 / 3) : 1;
        huN[i] /= frictionDen;
        hvN[i] /= frictionDen;
      }
    }

    if (negativeDepthSum > 0) {
      let positiveDepthSum = 0;
      for (let i = 0; i < n; i++) if (this.mask[i] && hN[i] > 0) positiveDepthSum += hN[i];
      if (positiveDepthSum > negativeDepthSum) {
        const correction = (positiveDepthSum - negativeDepthSum) / positiveDepthSum;
        for (let i = 0; i < n; i++) {
          if (this.mask[i] && hN[i] > 0) {
            hN[i] *= correction;
            huN[i] *= correction;
            hvN[i] *= correction;
          }
        }
      }
    }

    this.boundaryNetOutM3 += boundaryOut;
    this.negativeDepthClips += clips;
    this.swap();
    this.timeSec += dt;
    return dt;
  }

  swap() {
    [this.h, this.hNew] = [this.hNew, this.h];
    [this.hu, this.huNew] = [this.huNew, this.hu];
    [this.hv, this.hvNew] = [this.hvNew, this.hv];
  }

  volume(): number {
    let v = 0;
    const area = this.dx * this.dy;
    for (let i = 0; i < this.h.length; i++) if (this.mask[i]) v += Math.max(0, this.h[i]) * area;
    return v;
  }
}

function dryVelocity(q: number, h: number, eps = 1e-8): number {
  return h > eps ? q / h : 0;
}

export function rusanovX(hL: number, qxL: number, qyL: number, hR: number, qxR: number, qyR: number): [number, number, number] {
  const eps = 1e-8;
  if (hL <= eps && hR <= eps) return [0, 0, 0];
  const uL = dryVelocity(qxL, hL), vL = dryVelocity(qyL, hL);
  const uR = dryVelocity(qxR, hR), vR = dryVelocity(qyR, hR);
  const cL = Math.sqrt(G * Math.max(0, hL));
  const cR = Math.sqrt(G * Math.max(0, hR));
  const s = Math.max(Math.abs(uL) + cL, Math.abs(uR) + cR);
  const fL0 = qxL;
  const fL1 = hL > eps ? qxL * qxL / hL + 0.5 * G * hL * hL : 0.5 * G * hL * hL;
  const fL2 = hL > eps ? qxL * qyL / hL : 0;
  const fR0 = qxR;
  const fR1 = hR > eps ? qxR * qxR / hR + 0.5 * G * hR * hR : 0.5 * G * hR * hR;
  const fR2 = hR > eps ? qxR * qyR / hR : 0;
  return [
    0.5 * (fL0 + fR0) - 0.5 * s * (hR - hL),
    0.5 * (fL1 + fR1) - 0.5 * s * (qxR - qxL),
    0.5 * (fL2 + fR2) - 0.5 * s * (qyR - qyL)
  ];
}

function rusanovY(hB: number, qxB: number, qyB: number, hT: number, qxT: number, qyT: number): [number, number, number] {
  // 返回数组第 0 质量通量、第 1 x动量、第 2 y动量；调用处按顺序取
  const eps = 1e-8;
  if (hB <= eps && hT <= eps) return [0, 0, 0];
  const uB = dryVelocity(qxB, hB), vB = dryVelocity(qyB, hB);
  const uT = dryVelocity(qxT, hT), vT = dryVelocity(qyT, hT);
  const cB = Math.sqrt(G * Math.max(0, hB));
  const cT = Math.sqrt(G * Math.max(0, hT));
  const s = Math.max(Math.abs(vB) + cB, Math.abs(vT) + cT);
  const fB0 = qyB;
  const fB1 = hB > eps ? qxB * qyB / hB : 0;
  const fB2 = hB > eps ? qyB * qyB / hB + 0.5 * G * hB * hB : 0.5 * G * hB * hB;
  const fT0 = qyT;
  const fT1 = hT > eps ? qxT * qyT / hT : 0;
  const fT2 = hT > eps ? qyT * qyT / hT + 0.5 * G * hT * hT : 0.5 * G * hT * hT;
  return [
    0.5 * (fB0 + fT0) - 0.5 * s * (hT - hB),
    0.5 * (fB1 + fT1) - 0.5 * s * (qxT - qxB),
    0.5 * (fB2 + fT2) - 0.5 * s * (qyT - qyB)
  ];
}
