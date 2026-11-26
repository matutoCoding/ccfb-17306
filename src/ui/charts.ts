export interface LineSeries {
  label: string;
  color: string;
  values: number[];
  width?: number;
}

export function drawLineChart(
  canvas: HTMLCanvasElement,
  x: number[],
  series: LineSeries[],
  opts: { yLabel?: string; xLabel?: string; zeroLine?: boolean; height?: number } = {}
) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 640;
  const cssH = opts.height ?? (canvas.clientHeight || 260);
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, cssW, cssH);
  const m = { l: 58, r: 18, t: 18, b: 42 };
  const w = cssW - m.l - m.r, h = cssH - m.t - m.b;
  const allY = series.flatMap(s => s.values).filter(Number.isFinite);
  let ymin = Math.min(0, ...allY);
  let ymax = Math.max(1, ...allY);
  if (ymax - ymin < 1e-6) ymax = ymin + 1;
  const pad = (ymax - ymin) * 0.08;
  ymin -= pad; ymax += pad;
  const xmin = Math.min(...x), xmax = Math.max(...x);
  const X = (v: number) => m.l + ((v - xmin) / Math.max(1e-9, xmax - xmin)) * w;
  const Y = (v: number) => m.t + h - ((v - ymin) / (ymax - ymin)) * h;

  ctx.strokeStyle = 'rgba(148,163,184,.25)';
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui';
  ctx.fillStyle = '#94a3b8';
  for (let k = 0; k <= 5; k++) {
    const yv = ymin + (k / 5) * (ymax - ymin);
    const yy = Y(yv);
    ctx.beginPath(); ctx.moveTo(m.l, yy); ctx.lineTo(m.l + w, yy); ctx.stroke();
    ctx.fillText(yv.toFixed(ymax - ymin < 5 ? 2 : 0), 8, yy + 4);
  }
  for (let k = 0; k <= 6; k++) {
    const xv = xmin + (k / 6) * (xmax - xmin);
    ctx.fillText(`${xv.toFixed(0)}`, X(xv) - 8, m.t + h + 18);
  }
  if (opts.zeroLine !== false && ymin < 0 && ymax > 0) {
    ctx.strokeStyle = 'rgba(248,113,113,.55)';
    ctx.beginPath(); ctx.moveTo(m.l, Y(0)); ctx.lineTo(m.l + w, Y(0)); ctx.stroke();
  }
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(opts.xLabel ?? '', m.l + w / 2 - 30, cssH - 8);
  ctx.save();
  ctx.translate(14, m.t + h / 2 + 30);
  ctx.rotate(-Math.PI / 2);
  ctx.fillText(opts.yLabel ?? '', 0, 0);
  ctx.restore();

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width ?? 2;
    ctx.beginPath();
    let started = false;
    s.values.forEach((v, i) => {
      if (!Number.isFinite(v)) return;
      const xx = X(x[i] ?? i), yy = Y(v);
      if (!started) { ctx.moveTo(xx, yy); started = true; } else ctx.lineTo(xx, yy);
    });
    ctx.stroke();
  }
  let lx = m.l + 8;
  ctx.font = '12px system-ui';
  for (const s of series) {
    ctx.fillStyle = s.color;
    ctx.fillRect(lx, 8, 18, 3);
    ctx.fillStyle = '#e2e8f0';
    ctx.fillText(s.label, lx + 24, 13);
    lx += ctx.measureText(s.label).width + 58;
  }
}
