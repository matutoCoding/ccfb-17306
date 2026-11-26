import { h, readJsonFile } from '../ui/dom';
import { store } from '../state';
import { drawMapFrame } from '../ui/map2d';
import { drawLineChart } from '../ui/charts';
import { SURFACE_CLASSES } from '../sim/coupled';
import type { BuildingPolygon } from '../domain/types';

export function terrainPage(): HTMLElement {
  const p = store.project;
  const terrain = p.terrain!;
  const canvas = h('canvas', { class: 'map' }) as HTMLCanvasElement;
  const profile = h('canvas', { class: 'chart' }) as HTMLCanvasElement;
  const wrap = h('div', { class: 'canvas-box' }, canvas, h('div', { class: 'layer-label' }, 'DEM 晕渲 / 建筑挡水块 / 下穿加密槽'));

  setTimeout(() => {
    drawMapFrame(canvas, p, null, { showFlow: false });
    const up = terrain.underpasses[0];
    drawLineChart(profile, up.chainage, [
      { label: '下穿设计纵坡 m', color: '#facc15', values: up.elevations },
      { label: '最低点', color: '#38bdf8', values: up.chainage.map(() => up.bottomElev) }
    ], { yLabel: '高程 m', xLabel: '链距 m' });
  }, 30);

  const counts = new Array(SURFACE_CLASSES.length).fill(0);
  terrain.landCover.forEach(c => counts[c]++);
  const cells = terrain.cols * terrain.rows;

  async function importDem(file: File) {
    try {
      const data = await readJsonFile<{
        cols?: number; rows?: number; cellSize?: number; originX?: number; originY?: number;
        elevations: number[]; landCover?: number[];
      }>(file);
      const n = data.elevations.length;
      const cols = data.cols ?? Math.round(Math.sqrt(n));
      const rows = data.rows ?? Math.floor(n / cols);
      p.terrain = {
        ...terrain,
        cols, rows,
        cellSize: data.cellSize ?? terrain.cellSize,
        originX: data.originX ?? terrain.originX,
        originY: data.originY ?? terrain.originY,
        elevations: Float64Array.from(data.elevations),
        landCover: data.landCover ? Uint8Array.from(data.landCover) : new Uint8Array(cols * rows).fill(4)
      };
      await store.saveProject(p);
      location.reload();
    } catch (e) { alert(`DEM 导入失败：${(e as Error).message}`); }
  }

  async function importBuildings(file: File) {
    try {
      const data = JSON.parse(await file.text());
      const features = data.features ?? (Array.isArray(data) ? data : [data]);
      let added = 0;
      for (const f of features) {
        const geom = f.geometry ?? f;
        const coords = geom.coordinates?.[0] ?? geom.points;
        if (!coords) continue;
        const points = coords.map((q: number[] | { x: number; y: number }) => Array.isArray(q) ? { x: q[0], y: q[1] } : q);
        const poly: BuildingPolygon = { id: `B-IMP-${Date.now()}-${added}`, name: f.properties?.name ?? `导入建筑${added + 1}`, points, height: f.properties?.height ?? 12 };
        terrain.buildings.push(poly); added++;
      }
      await store.saveProject(p);
      drawMapFrame(canvas, p, null, { showFlow: false });
      alert(`已导入 ${added} 栋建筑，二维计算时轮廓内部将设为阻水 mask。`);
    } catch (e) { alert(`建筑轮廓导入失败：${(e as Error).message}`); }
  }

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, '地形、下垫面与下穿加密'),
        h('p', {}, `DEM ${terrain.cols}×${terrain.rows}，格网 ${terrain.cellSize} m；建筑轮廓挖为挡水块，道路、绿地和屋面分别赋 Horton 下渗与糙率。`)),
      h('div', { class: 'actions' },
        h('label', { class: 'btn' }, '导入 DEM JSON', h('input', { type: 'file', accept: '.json', hidden: true, onchange: (e: Event) => {
          const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importDem(f);
        } })),
        h('label', { class: 'btn' }, '导入建筑 GeoJSON', h('input', { type: 'file', accept: '.json,.geojson', hidden: true, onchange: (e: Event) => {
          const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importBuildings(f);
        } })),
        h('button', { class: 'btn primary', onclick: () => alert('下穿通道已用 2.2% 纵坡和最低点 39.15m 做局部槽形加密；正式工程可替换为 1–2m 实测 DEM。') }, '下穿加密说明')
      )
    ),
    h('div', { class: 'grid cols-3' },
      h('section', { class: 'card' },
        h('h3', {}, '下垫面参数'),
        h('div', { class: 'table-wrap', style: 'max-height:330px' }, h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '类别'), h('th', {}, '占比'), h('th', {}, 'f0/fc mm/h'), h('th', {}, 'n'))),
          h('tbody', {}, ...SURFACE_CLASSES.map((s, i) => h('tr', {},
            h('td', {}, h('span', { style: `display:inline-block;width:9px;height:9px;border-radius:2px;background:${s.color};margin-right:6px` }), s.label),
            h('td', {}, `${(100 * counts[i] / cells).toFixed(1)}%`),
            h('td', {}, `${s.f0}/${s.fc}`), h('td', {}, s.n)
          )))
        )),
        h('h4', {}, '下穿通道'),
        h('div', { class: 'kv' },
          h('span', { class: 'k' }, '名称'), h('b', {}, terrain.underpasses[0].name),
          h('span', { class: 'k' }, '最低点高程'), h('b', {}, `${terrain.underpasses[0].bottomElev} m`),
          h('span', { class: 'k' }, '槽宽'), h('b', {}, `${terrain.underpasses[0].width} m`),
          h('span', { class: 'k' }, '车模位置链距'), h('b', {}, `${terrain.underpasses[0].carPositionChainage} m`)
        )
      ),
      h('section', { class: 'card' }, wrap),
      h('section', { class: 'card' }, h('h3', {}, '下穿纵断面加密'), profile)
    )
  );
}
