import { h } from '../ui/dom';
import { store } from '../state';
import { buildChicagoSeries, thiessenWeights } from '../domain/rainfall';
import { drawLineChart } from '../ui/charts';
import type { RainGauge } from '../domain/types';

export function rainfallPage(): HTMLElement {
  const p = store.project;
  const cfg = p.rainfall;
  const canvas = h('canvas', { class: 'chart' }) as HTMLCanvasElement;
  const weightBox = h('div', { class: 'table-wrap mt12' });

  function refresh() {
    const s = buildChicagoSeries(cfg);
    drawLineChart(canvas, s.intensityMmH.map((_, i) => (i + 0.5) * cfg.intervalMin), [
      { label: '芝加哥雨型 mm/h', color: '#38bdf8', values: s.intensityMmH },
      { label: '累计雨量 mm', color: '#f59e0b', values: s.depthMm.map((_, i) => s.depthMm.slice(0, i + 1).reduce((a, b) => a + b, 0)) }
    ], { xLabel: 'min', yLabel: 'mm/h / mm' });
    if (cfg.gauges?.length) {
      const w = thiessenWeights(cfg.gauges, p.bbox, 120, 60);
      const rows = w.map(x => {
        const g = cfg.gauges!.find(z => z.id === x.gaugeId)!;
        return h('tr', {},
          h('td', {}, g.name),
          h('td', {}, `${(100 * x.areaFraction).toFixed(1)}%`),
          h('td', {}, (x.areaM2 / 10000).toFixed(1))
        );
      });
      weightBox.replaceChildren(
        h('table', {},
          h('thead', {}, h('tr', {}, h('th', {}, '雨量站'), h('th', {}, '泰森权重'), h('th', {}, '面积 ha'))),
          h('tbody', {}, ...rows)
        )
      );
    }
  }
  setTimeout(refresh, 30);

  function rangeNumber(key: 'returnPeriod' | 'durationMin' | 'peakRatio', label: string, min: number, max: number, step: number) {
    return h('div', { class: 'field' },
      h('label', {}, h('span', {}, label), h('b', {}, String(cfg[key]))),
      h('input', { type: 'range', min, max, step, value: String(cfg[key]), oninput: (e: Event) => {
        cfg[key] = Number((e.target as HTMLInputElement).value);
        refresh(); void store.saveProject(p);
      } })
    );
  }

  async function importGauge(file: File) {
    try {
      const rows = JSON.parse(await file.text()) as Array<{ name?: string; x: number; y: number; minutes?: number[]; depthMm?: number[] }>;
      cfg.source = 'gauge';
      cfg.gauges = rows.map((r, i): RainGauge => ({
        id: `G-IMP-${i + 1}`, name: r.name ?? `实测站${i + 1}`, x: r.x, y: r.y,
        minutes: r.minutes ?? Array.from({ length: r.depthMm?.length ?? 121 }, (_, k) => k),
        depthMm: r.depthMm ?? []
      }));
      await store.saveProject(p);
      refresh();
      alert('实测分钟雨量已导入，并按最近站/泰森分区参与耦合。');
    } catch (e) { alert(`雨量文件格式错误：${(e as Error).message}`); }
  }

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, '降雨情景与泰森分区'),
        h('p', {}, '按本地暴雨强度公式生成芝加哥雨型；重现期、历时和雨峰系数实时可调，也可导入多站实测分钟雨量。')),
      h('div', { class: 'actions' },
        h('button', { class: cfg.source === 'chicago' ? 'btn primary' : 'btn', onclick: () => { cfg.source = 'chicago'; void store.saveProject(p); location.reload(); } }, '芝加哥雨型'),
        h('label', { class: cfg.source === 'gauge' ? 'btn primary' : 'btn' }, '导入实测雨量', h('input', { type: 'file', accept: '.json', hidden: true, onchange: (e: Event) => {
          const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importGauge(f);
        } }))
      )
    ),
    h('div', { class: 'grid cols-2' },
      h('section', { class: 'card' },
        h('h3', {}, '暴雨参数'),
        rangeNumber('returnPeriod', '重现期 P（年）', 1, 100, 1),
        rangeNumber('durationMin', '降雨历时（min）', 30, 360, 10),
        rangeNumber('peakRatio', '雨峰位置系数 r', 0.1, 0.9, 0.05),
        h('div', { class: 'form-row' },
          h('div', { class: 'field' }, h('label', {}, '公式 A1'), h('input', { type: 'number', value: String(cfg.formula.A1), onchange: (e: Event) => { cfg.formula.A1 = Number((e.target as HTMLInputElement).value); refresh(); void store.saveProject(p); } })),
          h('div', { class: 'field' }, h('label', {}, 'C'), h('input', { type: 'number', step: '.01', value: String(cfg.formula.C), onchange: (e: Event) => { cfg.formula.C = Number((e.target as HTMLInputElement).value); refresh(); void store.saveProject(p); } })),
          h('div', { class: 'field' }, h('label', {}, 'b'), h('input', { type: 'number', step: '.1', value: String(cfg.formula.b), onchange: (e: Event) => { cfg.formula.b = Number((e.target as HTMLInputElement).value); refresh(); void store.saveProject(p); } })),
          h('div', { class: 'field' }, h('label', {}, 'n'), h('input', { type: 'number', step: '.01', value: String(cfg.formula.n), onchange: (e: Event) => { cfg.formula.n = Number((e.target as HTMLInputElement).value); refresh(); void store.saveProject(p); } }))
        ),
        h('p', { class: 'muted' }, `当前来源：${cfg.source === 'chicago' ? '公式设计雨型' : '雨量站实测'}；时段 ${cfg.intervalMin} min。`)
      ),
      h('section', { class: 'card' }, h('h3', {}, '降雨过程'), h('div', { class: 'canvas-box' }, canvas)),
      h('section', { class: 'card', style: 'grid-column:1/-1' }, h('h3', {}, '雨量站与泰森多边形权重'),
        h('p', { class: 'muted' }, '样例内置铁西、桥南、河东三站；耦合时按格网最近站取雨强，全流域总量按泰森面积权重校核。'),
        weightBox
      )
    )
  );
}
