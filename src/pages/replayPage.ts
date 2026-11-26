import { h, fmt, fmtTime } from '../ui/dom';
import { store } from '../state';
import { drawMapFrame } from '../ui/map2d';
import { GpuMapRenderer } from '../gpu/GpuFlood';
import type { ID, PipeSegment, ReplayFrame, RunRecord } from '../domain/types';

export function replayPage(): HTMLElement {
  if (!store.currentRun?.frames?.length) {
    return h('div', { class: 'card' }, h('h2', {}, '还没有可回放的推演结果'),
      h('p', { class: 'muted' }, '请先到“耦合推演”页面运行两小时样例，结果会存入 IndexedDB。'),
      h('a', { class: 'btn primary', href: '#/simulation' }, '前往耦合推演'));
  }
  const run: RunRecord = store.currentRun;

  let frameIndex = run.frames.length - 1;
  let playing = false;
  let timer: number | null = null;
  let gpuRenderer: GpuMapRenderer | null = null;
  let useGpu = false;
  let selectedPipeIds: ID[] = defaultTrunkIds(run);

  const canvas2d = h('canvas', { class: 'map' }) as HTMLCanvasElement;
  const canvasGpu = h('canvas', { class: 'map', style: 'display:none' }) as HTMLCanvasElement;
  const timeLabel = h('span', { class: 'time' });
  const slider = h('input', { type: 'range', min: '0', max: String(run.frames.length - 1), value: String(frameIndex) }) as HTMLInputElement;
  const profileCanvas = h('canvas', { class: 'profile' }) as HTMLCanvasElement;
  const carWater = h('div', { class: 'water-side', style: 'height:0%' }) as HTMLElement;
  const carCaption = h('div', { class: 'car-caption' }, '读取积水…') as HTMLElement;
  const pipeSelect = h('select', { multiple: true, size: 10, style: 'width:100%' }) as HTMLSelectElement;
  for (const p of store.project.pipes.slice(0, 650)) {
    const opt = h('option', { value: p.id, selected: selectedPipeIds.includes(p.id) }, `${p.code}（${fmt(p.length, 0)}m）`) as HTMLOptionElement;
    pipeSelect.append(opt);
  }
  pipeSelect.addEventListener('change', () => {
    selectedPipeIds = [...pipeSelect.selectedOptions].map(o => o.value);
    drawProfile();
  });

  function frame(): ReplayFrame { return run.frames[frameIndex]; }

  function updateCar() {
    const f = frame();
    const up = store.project.terrain?.underpasses[0];
    if (!up) return;
    const k = Math.min(up.alignment.length - 1, Math.max(0, Math.round(up.carPositionChainage / 50)));
    const pt = up.alignment[k];
    const c = Math.floor((pt.x - f.originX) / f.cellSize);
    const r = Math.floor((pt.y - f.originY) / f.cellSize);
    const d = c >= 0 && c < f.cols && r >= 0 && r < f.rows ? f.depth[r * f.cols + c] : 0;
    const pct = Math.min(100, d / 1.55 * 100);
    carWater.style.height = `${pct}%`;
    carCaption.innerHTML = `车旁水深 <b>${fmt(d, 2)} m</b><br/>${d < 0.3 ? '轮胎以下，可缓慢通行' : d < 0.6 ? '排气管/门槛，小车危险' : d < 1.0 ? '车窗下缘，禁止通行' : '车顶附近，车辆漂浮风险'}`;
  }

  function drawProfile() {
    drawPipeProfile(profileCanvas, run, frame(), selectedPipeIds);
  }

  function renderFrame() {
    const f = frame();
    timeLabel.textContent = `t=${fmt(f.tSec / 60, 1)} min`;
    slider.value = String(frameIndex);
    if (useGpu && gpuRenderer) {
      gpuRenderer.updateFrame(f, run.spots[0]?.maxDepthM ?? 2, f.tSec / 1000);
      gpuRenderer.render();
    } else {
      drawMapFrame(canvas2d, store.project, f, { selectedPipeId: selectedPipeIds[0] });
    }
    updateCar();
    drawProfile();
  }

  slider.addEventListener('input', () => { frameIndex = Number(slider.value); renderFrame(); });
  function stop() { playing = false; if (timer) window.clearInterval(timer); timer = null; }
  function play() {
    if (playing) { stop(); return; }
    playing = true;
    timer = window.setInterval(() => {
      frameIndex = (frameIndex + 1) % run.frames.length;
      renderFrame();
    }, 260);
  }

  async function toggleGpu() {
    useGpu = !useGpu;
    if (useGpu) {
      gpuRenderer = await GpuMapRenderer.create(canvasGpu);
      if (!gpuRenderer) {
        useGpu = false;
        alert('当前浏览器不支持 WebGPU 渲染，继续使用 Canvas2D；WGSL 着色器仍在 src/gpu/render.wgsl。');
        return;
      }
      canvas2d.style.display = 'none'; canvasGpu.style.display = 'block';
    } else {
      canvasGpu.style.display = 'none'; canvas2d.style.display = 'block';
    }
    renderFrame();
  }

  setTimeout(renderFrame, 40);

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, '积水回放与纵断面联动'),
        h('p', {}, '深度色阶、高流速流向纹理、冒溢井红圈、顶飞井盖脉冲和下穿车模对照；选择任意管串可叠看管底、地面与实时水力坡度线。')),
      h('div', { class: 'actions' },
        h('select', { onchange: (e: Event) => { const id = (e.target as HTMLSelectElement).value; const rr = store.runs.find(x => x.id === id); if (rr) { store.currentRun = rr; location.reload(); } } },
          ...store.runs.slice(0, 12).map(r => h('option', { value: r.id, selected: r.id === run.id }, `${fmtTime(r.startedAt)} · ${r.schemeId}`))
        ),
        h('button', { class: 'btn', onclick: () => void toggleGpu() }, '切换 WebGPU WGSL'),
        h('a', { class: 'btn primary', href: '#/report' }, '查看易涝报告')
      )
    ),
    h('div', { class: 'grid cols-3' },
      h('section', { class: 'card' },
        h('h3', {}, '回放控制'),
        h('div', { class: 'timeline' },
          h('button', { class: 'btn small primary', onclick: play }, '播放/暂停'),
          slider, timeLabel
        ),
        h('div', { class: 'legend' }, h('span', { class: 'ramp' }), h('span', {}, '浅→深')),
        h('h4', {}, '下穿车辆淹没对照'),
        h('div', { class: 'car-stage' }, carCaption, h('div', { class: 'car-svg' }, '🚙'), carWater),
        h('h4', {}, '纵断面管串选择'),
        pipeSelect,
        h('p', { class: 'muted' }, '按住 Ctrl/Shift 可多选连续或任意管段；默认选中下游 DN1200 主干串。')
      ),
      h('section', { class: 'card' },
        h('div', { class: 'canvas-box' },
          canvas2d, canvasGpu,
          h('div', { class: 'layer-label' }, `方案 ${run.schemeId} · ${run.frameCount} 帧 · ${run.engineInfo.slice(0, 28)}…`)
        )
      ),
      h('section', { class: 'card' }, h('h3', {}, '实时纵断面'), profileCanvas, profileLegend(),
        h('h4', {}, '当前帧冒溢/顶飞井'),
        overflowList(run, frameIndex)
      )
    )
  );
}

function profileLegend() {
  return h('div', { class: 'legend' },
    h('span', {}, h('i', { style: 'display:inline-block;width:14px;height:3px;background:#64748b;margin-right:5px' }), '管底'),
    h('span', {}, h('i', { style: 'display:inline-block;width:14px;height:3px;background:#a3a3a3;margin-right:5px' }), '地面'),
    h('span', {}, h('i', { style: 'display:inline-block;width:14px;height:3px;background:#22d3ee;margin-right:5px' }), '水力坡线'),
    h('span', {}, h('i', { style: 'display:inline-block;width:14px;height:4px;background:#fb923c;margin-right:5px' }), '满管段')
  );
}

function overflowList(run: RunRecord, index: number) {
  const f = run.frames[index];
  const items = Object.values(f.nodeStates).filter(s => s.flooded || s.coverBlown).slice(0, 12);
  if (!items.length) return h('p', { class: 'muted' }, '当前时刻无冒溢井。');
  return h('div', { class: 'table-wrap', style: 'max-height:220px' }, h('table', {}, h('tbody', {},
    ...Object.entries(f.nodeStates).filter(([, s]) => s.flooded || s.coverBlown).slice(0, 20).map(([id, s]) =>
      h('tr', {}, h('td', {}, id), h('td', {}, `水头${fmt(s.head, 2)}`), h('td', {}, s.coverBlown ? h('span', { class: 'badge error' }, '井盖顶飞') : h('span', { class: 'badge warning' }, '冒溢')))
    )
  )));
}

function defaultTrunkIds(run: RunRecord): ID[] {
  const p = store.project;
  return p.pipes.filter(x => x.code.includes('DN1200') || x.id === 'P-OUTFALL-DN1200').map(x => x.id).slice(0, 12);
}

function drawPipeProfile(canvas: HTMLCanvasElement, run: RunRecord, frame: ReplayFrame, pipeIds: ID[]) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth || 420, h = 300;
  canvas.width = w * dpr; canvas.height = h * dpr; canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(dpr, dpr); ctx.clearRect(0, 0, w, h);
  const project = store.project;
  const nodeMap = new Map(project.nodes.map(n => [n.id, n]));
  const pipes = pipeIds.map(id => project.pipes.find(p => p.id === id)).filter(Boolean) as PipeSegment[];
  if (!pipes.length) { ctx.fillStyle = '#94a3b8'; ctx.fillText('请选择管段', 20, 30); return; }

  type Pt = { x: number; invert: number; ground: number; hgl: number; full: boolean; code: string };
  let chain = 0;
  const pts: Pt[] = [];
  for (const p of pipes) {
    const a = nodeMap.get(p.fromNodeId), b = nodeMap.get(p.toNodeId);
    if (!a || !b) continue;
    pts.push({ x: chain, invert: p.upstreamInvert, ground: a.groundElev, hgl: frame.nodeHeads[p.fromNodeId] ?? p.upstreamInvert, full: (frame.nodeHeads[p.fromNodeId] ?? 0) > (p.upstreamInvert + (p.diameter ?? p.height ?? 1)), code: p.code });
    chain += p.length;
    pts.push({ x: chain, invert: p.downstreamInvert, ground: b.groundElev, hgl: frame.nodeHeads[p.toNodeId] ?? p.downstreamInvert, full: (frame.nodeHeads[p.toNodeId] ?? 0) > (p.downstreamInvert + (p.diameter ?? p.height ?? 1)), code: p.code });
  }
  const vals = pts.flatMap(q => [q.invert, q.ground, q.hgl]);
  let ymin = Math.min(...vals) - 1, ymax = Math.max(...vals) + 1;
  if (ymax - ymin < 2) ymax = ymin + 2;
  const ml = 48, mr = 14, mt = 18, mb = 34;
  const X = (x: number) => ml + x / chain * (w - ml - mr);
  const Y = (y: number) => mt + (ymax - y) / (ymax - ymin) * (h - mt - mb);
  ctx.strokeStyle = 'rgba(148,163,184,.25)';
  for (let i = 0; i <= 4; i++) { const y = ymin + i / 4 * (ymax - ymin); ctx.beginPath(); ctx.moveTo(ml, Y(y)); ctx.lineTo(w - mr, Y(y)); ctx.stroke(); ctx.fillStyle = '#94a3b8'; ctx.font = '10px system-ui'; ctx.fillText(y.toFixed(1), 8, Y(y) + 3); }

  drawSeries(pts.map(q => [q.x, q.ground]), '#a3a3a3', 2);
  drawSeries(pts.map(q => [q.x, q.invert]), '#64748b', 3);

  // 满管段：测压管水头超过管顶时，在管顶线上用橙色粗段标出
  let cursor = 0;
  for (const p of pipes) {
    const crown = p.diameter ?? p.height ?? 1;
    const hUp = frame.nodeHeads[p.fromNodeId] ?? p.upstreamInvert;
    const hDown = frame.nodeHeads[p.toNodeId] ?? p.downstreamInvert;
    const full = hUp > p.upstreamInvert + crown + 0.03 || hDown > p.downstreamInvert + crown + 0.03;
    if (full) {
      ctx.strokeStyle = '#fb923c';
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(X(cursor), Y(p.upstreamInvert + crown));
      ctx.lineTo(X(cursor + p.length), Y(p.downstreamInvert + crown));
      ctx.stroke();
    }
    cursor += p.length;
  }

  drawSeries(pts.map(q => [q.x, q.hgl]), '#22d3ee', 2.5);
  for (const q of pts) {
    if (q.hgl > q.ground + 0.05) {
      ctx.fillStyle = '#ef4444'; ctx.beginPath(); ctx.arc(X(q.x), Y(q.ground), 4, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.fillStyle = '#94a3b8'; ctx.fillText('链距 m →', w - 70, h - 10);

  function drawSeries(data: number[][], color: string, width: number) {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    data.forEach(([x, y], i) => i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)));
    ctx.stroke();
  }
}
