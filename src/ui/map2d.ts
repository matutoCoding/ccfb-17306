import type { Project, ReplayFrame, ID } from '../domain/types';

export interface MapDrawOptions {
  selectedPipeId?: ID | null;
  showFlow?: boolean;
  showNetwork?: boolean;
  car?: boolean;
}

export function fitTransform(canvas: HTMLCanvasElement, project: Project, pad = 36) {
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(320, canvas.clientWidth || rect.width || 800);
  const cssH = Math.max(320, canvas.clientHeight || rect.height || 520);
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  const bw = project.bbox.maxX - project.bbox.minX;
  const bh = project.bbox.maxY - project.bbox.minY;
  const scale = Math.min((cssW - pad * 2) / bw, (cssH - pad * 2) / bh);
  const ox = (cssW - bw * scale) / 2 - project.bbox.minX * scale;
  const oy = (cssH - bh * scale) / 2 + project.bbox.maxY * scale;
  return {
    dpr, cssW, cssH, scale,
    X: (x: number) => ox + x * scale,
    Y: (y: number) => oy - y * scale,
    L: (len: number) => len * scale
  };
}

export function drawMapFrame(canvas: HTMLCanvasElement, project: Project, frame: ReplayFrame | null, opts: MapDrawOptions = {}) {
  const t = fitTransform(canvas, project);
  const ctx = canvas.getContext('2d')!;
  ctx.setTransform(t.dpr, 0, 0, t.dpr, 0, 0);
  ctx.clearRect(0, 0, t.cssW, t.cssH);

  const grad = ctx.createLinearGradient(0, 0, 0, t.cssH);
  grad.addColorStop(0, '#0b1220');
  grad.addColorStop(1, '#111827');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, t.cssW, t.cssH);

  // 街道格网：样例检查井坐标沿道路布置，提取唯一 x/y 后画道路廊道
  const xs = [...new Set(project.nodes.map(n => Math.round(n.x)))].sort((a, b) => a - b);
  const ys = [...new Set(project.nodes.map(n => Math.round(n.y)))].sort((a, b) => a - b);
  ctx.lineCap = 'butt';
  ctx.strokeStyle = 'rgba(30,41,59,.92)';
  ctx.lineWidth = 7;
  for (const x of xs) {
    ctx.beginPath(); ctx.moveTo(t.X(x), t.Y(project.bbox.minY)); ctx.lineTo(t.X(x), t.Y(project.bbox.maxY)); ctx.stroke();
  }
  for (const y of ys) {
    ctx.beginPath(); ctx.moveTo(t.X(project.bbox.minX), t.Y(y)); ctx.lineTo(t.X(project.bbox.maxX), t.Y(y)); ctx.stroke();
  }
  ctx.strokeStyle = 'rgba(148,163,184,.22)';
  ctx.lineWidth = 1;
  for (const x of xs) {
    ctx.beginPath(); ctx.moveTo(t.X(x), t.Y(project.bbox.minY)); ctx.lineTo(t.X(x), t.Y(project.bbox.maxY)); ctx.stroke();
  }
  for (const y of ys) {
    ctx.beginPath(); ctx.moveTo(t.X(project.bbox.minX), t.Y(y)); ctx.lineTo(t.X(project.bbox.maxX), t.Y(y)); ctx.stroke();
  }

  // 格网深度
  if (frame) {
    const cell = frame.cellSize * t.scale;
    for (let r = 0; r < frame.rows; r++) {
      for (let c = 0; c < frame.cols; c++) {
        const i = r * frame.cols + c;
        const d = frame.depth[i];
        if (d < 0.02 || frame.mask[i] === 0) continue;
        const x = frame.originX + c * frame.cellSize;
        const y = frame.originY + r * frame.cellSize;
        const alpha = Math.min(0.82, 0.18 + d * 0.32);
        const blue = d > 0.8 ? 235 : 205 + Math.floor(Math.min(1, d / 0.8) * 30);
        ctx.fillStyle = `rgba(${30 + Math.floor(Math.min(1, d / 2) * 20)},${120 + Math.floor(Math.min(1, d / 2) * 80)},${blue},${alpha})`;
        ctx.fillRect(t.X(x), t.Y(y + frame.cellSize), Math.max(1, cell + 0.6), Math.max(1, cell + 0.6));
      }
    }

    // 流向箭头
    if (opts.showFlow !== false && cell > 3) {
      ctx.strokeStyle = 'rgba(224,242,254,.72)';
      ctx.lineWidth = 1.2;
      const step = Math.max(2, Math.floor(28 / Math.max(2, cell)));
      for (let r = 0; r < frame.rows; r += step) {
        for (let c = 0; c < frame.cols; c += step) {
          const i = r * frame.cols + c;
          const h = Math.max(frame.depth[i], 0.05);
          const u = frame.u[i] / h, v = frame.v[i] / h;
          const sp = Math.hypot(u, v);
          if (sp < 0.35) continue;
          const x = frame.originX + (c + 0.5) * frame.cellSize;
          const y = frame.originY + (r + 0.5) * frame.cellSize;
          const len = Math.min(18, 5 + sp * 2.2);
          const sx = t.X(x), sy = t.Y(y);
          const ex = sx + (u / sp) * len;
          const ey = sy - (v / sp) * len;
          ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(ex, ey); ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - 5 * Math.cos(Math.atan2(ey - sy, ex - sx) - 0.45), ey - 5 * Math.sin(Math.atan2(ey - sy, ex - sx) - 0.45));
          ctx.moveTo(ex, ey);
          ctx.lineTo(ex - 5 * Math.cos(Math.atan2(ey - sy, ex - sx) + 0.45), ey - 5 * Math.sin(Math.atan2(ey - sy, ex - sx) + 0.45));
          ctx.stroke();
        }
      }
    }
  }

  // 建筑
  for (const b of project.terrain?.buildings ?? []) {
    ctx.beginPath();
    b.points.forEach((p, i) => i ? ctx.lineTo(t.X(p.x), t.Y(p.y)) : ctx.moveTo(t.X(p.x), t.Y(p.y)));
    ctx.closePath();
    ctx.fillStyle = 'rgba(71,85,105,.88)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(203,213,225,.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  // 下穿通道
  for (const u of project.terrain?.underpasses ?? []) {
    ctx.beginPath();
    u.alignment.forEach((p, i) => i ? ctx.lineTo(t.X(p.x), t.Y(p.y)) : ctx.moveTo(t.X(p.x), t.Y(p.y)));
    ctx.strokeStyle = 'rgba(250,204,21,.9)';
    ctx.lineWidth = 5;
    ctx.lineCap = 'round';
    ctx.stroke();
    if (opts.car !== false) {
      const k = Math.min(u.alignment.length - 2, Math.max(0, Math.floor(u.carPositionChainage / 50)));
      const p = u.alignment[k];
      if (p) {
        ctx.save();
        ctx.translate(t.X(p.x), t.Y(p.y));
        ctx.fillStyle = '#f97316';
        ctx.fillRect(-10, -5, 20, 10);
        ctx.fillStyle = '#fed7aa';
        ctx.fillRect(-4, -4, 8, 8);
        ctx.restore();
      }
    }
  }

  if (opts.showNetwork !== false) {
    const nodeById = new Map(project.nodes.map(n => [n.id, n]));
    for (const p of project.pipes) {
      const a = nodeById.get(p.fromNodeId), b = nodeById.get(p.toNodeId);
      if (!a || !b) continue;
      const q = frame?.pipeQ[p.id] ?? 0;
      const selected = opts.selectedPipeId === p.id;
      ctx.beginPath();
      ctx.moveTo(t.X(a.x), t.Y(a.y));
      ctx.lineTo(t.X(b.x), t.Y(b.y));
      ctx.strokeStyle = selected ? '#fde047' : Math.abs(q) > 0.05 ? 'rgba(34,211,238,.72)' : 'rgba(148,163,184,.42)';
      ctx.lineWidth = selected ? 4 : p.diameter && p.diameter >= 1.1 ? 2.4 : 1.2;
      ctx.stroke();
    }
    for (const n of project.nodes) {
      const st = frame?.nodeStates[n.id];
      ctx.beginPath();
      ctx.arc(t.X(n.x), t.Y(n.y), n.kind === 'pump' || n.kind === 'outfall' ? 4.5 : 2.6, 0, Math.PI * 2);
      if (st?.coverBlown) ctx.fillStyle = '#ef4444';
      else if (st?.flooded) ctx.fillStyle = '#38bdf8';
      else if (n.kind === 'pump') ctx.fillStyle = '#22c55e';
      else if (n.kind === 'outfall') ctx.fillStyle = '#a78bfa';
      else ctx.fillStyle = '#cbd5e1';
      ctx.fill();
      if (st?.coverBlown) {
        ctx.strokeStyle = 'rgba(239,68,68,.9)';
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(t.X(n.x), t.Y(n.y), 8 + (frame ? Math.sin(frame.tSec * 0.01) * 2 : 0), 0, Math.PI * 2); ctx.stroke();
      }
    }
  }

  // 比例尺
  const scaleLen = 200;
  ctx.strokeStyle = '#e2e8f0';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(18, t.cssH - 24); ctx.lineTo(18 + scaleLen * t.scale, t.cssH - 24);
  ctx.moveTo(18, t.cssH - 29); ctx.lineTo(18, t.cssH - 19);
  ctx.lineTo(18 + scaleLen * t.scale, t.cssH - 19);
  ctx.stroke();
  ctx.fillStyle = '#e2e8f0';
  ctx.font = '12px system-ui';
  ctx.fillText('200 m', 22, t.cssH - 30);
}
