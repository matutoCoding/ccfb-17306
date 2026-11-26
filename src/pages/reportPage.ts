import { h, clear, fmt, fmtTime, fmtClock, downloadJson } from '../ui/dom';
import { store } from '../state';
import { runSimulationTask } from '../sim/runTask';
import type { FloodSpotStat, RunRecord } from '../domain/types';

export function reportPage(): HTMLElement {
  if (!store.currentRun) {
    return h('div', { class: 'card' }, h('h2', {}, '暂无报告'), h('p', { class: 'muted' }, '请先运行推演。'), h('a', { class: 'btn primary', href: '#/simulation' }, '去推演'));
  }
  const current: RunRecord = store.currentRun;

  let filter: 'all' | 'underpass' | 'low-road' = 'all';
  const tableBox = h('div', { class: 'table-wrap' });
  const compareBox = h('div', { class: 'grid side-by-side' });
  let runA = store.runs.find(r => r.schemeId === 'dredge') ?? store.runs[0] ?? current;
  let runB = store.runs.find(r => r.schemeId === 'pump-plus') ?? store.runs[1] ?? current;

  function renderTable() {
    clear(tableBox);
    const spots = current.spots.filter(s => filter === 'all' || s.kind === filter);
    tableBox.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '排名'), h('th', {}, '易涝点'), h('th', {}, '类别'), h('th', {}, '最大水深 m'), h('th', {}, '峰现 min'), h('th', {}, '积水历时 min'), h('th', {}, '退水 min'))),
      h('tbody', {}, ...spots.slice(0, 80).map((s, i) => h('tr', {},
        h('td', {}, String(i + 1)),
        h('td', {}, s.name),
        h('td', {}, kindLabel(s.kind)),
        h('td', {}, h('b', { style: s.maxDepthM > 0.5 ? 'color:#fca5a5' : s.maxDepthM > 0.2 ? 'color:#fde68a' : 'color:#bbf7d0' }, fmt(s.maxDepthM, 2))),
        h('td', {}, fmt(s.maxTimeMin, 0)),
        h('td', {}, fmt(s.durationMin, 0)),
        h('td', {}, s.recessionMin === null ? '未退水' : fmt(s.recessionMin, 0))
      )))
    ));
  }

  function renderCompare() {
    clear(compareBox);
    compareBox.append(compareCard(runA, runB), compareCard(runB, runA));
    const diffs = comparisonDiffs(runA, runB).slice(0, 10);
    compareBox.append(h('div', { class: 'card', style: 'grid-column:1/-1' },
      h('h3', {}, '同一点位最大水深并排差值'),
      h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, h('th', {}, '点位'), h('th', {}, runA.schemeId), h('th', {}, runB.schemeId), h('th', {}, 'B−A m'), h('th', {}, '判断'))),
        h('tbody', {}, ...diffs.map(d => h('tr', {},
          h('td', {}, d.name), h('td', {}, fmt(d.a, 2)), h('td', {}, fmt(d.b, 2)),
          h('td', { class: d.diff < -0.02 ? 'diff-negative' : d.diff > 0.02 ? 'diff-positive' : '' }, `${d.diff > 0 ? '+' : ''}${fmt(d.diff, 2)}`),
          h('td', {}, Math.abs(d.diff) < 0.02 ? '基本持平' : d.diff < 0 ? 'B 方案降低水深' : 'B 方案反而升高')
        )))
      ))
    ));
  }

  async function runTwoSchemes() {
    const btn = document.getElementById('compare-run-btn') as HTMLButtonElement;
    btn.disabled = true; btn.textContent = '正在并排计算…';
    try {
      const opts = { ...current.options, surfaceCellSize: 100, recordIntervalSec: 120 };
      const a = await runSimulationTask(structuredClone(store.project), opts, 'dredge', undefined, 100000);
      await store.saveRun(a.record); runA = a.record;
      const b = await runSimulationTask(structuredClone(store.project), opts, 'pump-plus', undefined, 100000);
      await store.saveRun(b.record); runB = b.record;
      renderCompare();
    } finally { btn.disabled = false; btn.textContent = '一键计算疏通/加泵对比'; }
  }

  renderTable();
  renderCompare();

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, '易涝点统计与改造方案对比'),
        h('p', {}, '按最大水深、超 0.15m 积水历时和雨停后退水时间统计；下穿与低洼路段单独排名，两套方案可并排比较。')),
      h('div', { class: 'actions' },
        h('button', { id: 'compare-run-btn', class: 'btn primary', onclick: () => void runTwoSchemes() }, '一键计算疏通/加泵对比'),
        h('button', { class: 'btn', onclick: () => downloadJson({ summary: current.ledger, spots: current.spots }, 'flood-report.json') }, '导出报告 JSON')
      )
    ),
    h('div', { class: 'grid cols-4' },
      metric('最大水深', fmt(current.maxDepthM, 2), 'm', current.maxDepthM > 0.5 ? 'bad' : 'warn'),
      metric('易涝点', `${current.spots.filter(s => s.maxDepthM > 0.15).length}`, '处', ''),
      metric('水量误差', fmt(current.ledger.relativeErrorPct, 4), '%', current.ledger.relativeErrorPct < 0.5 ? 'good' : 'bad'),
      metric('推演耗时', fmt(current.elapsedMs / 1000, 1), 's', '')
    ),
    h('section', { class: 'card mt16' },
      h('h3', {}, '易涝点排名', h('div', { class: 'tabs', style: 'margin:0' },
        ...(['all', 'underpass', 'low-road'] as const).map(k => h('button', { class: filter === k ? 'active' : '', onclick: () => { filter = k; renderTable(); } }, k === 'all' ? '全部' : k === 'underpass' ? '下穿通道' : '低洼路段'))
      )),
      tableBox
    ),
    h('section', { class: 'mt16' },
      h('div', { class: 'flex-between' }, h('h3', {}, '方案并排对比'),
        h('div', { class: 'flex' }, runSelect(runA.id, r => { runA = r; renderCompare(); }), runSelect(runB.id, r => { runB = r; renderCompare(); }))
      ),
      compareBox
    )
  );
}

function metric(k: string, v: string, u: string, cls: string) {
  return h('div', { class: `metric ${cls}` }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v, ' ', h('span', { class: 'u' }, u)));
}
function kindLabel(k: FloodSpotStat['kind']) {
  return { underpass: '下穿', 'low-road': '低洼路段', well: '井位', area: '片区' }[k];
}
function compareCard(run: RunRecord, other: RunRecord) {
  const top = run.spots.slice(0, 5);
  return h('section', { class: 'card' },
    h('h3', {}, schemeName(run.schemeId), h('span', { class: 'badge ok' }, `误差 ${run.ledger.relativeErrorPct.toFixed(3)}%`)),
    h('div', { class: 'kv' },
      h('span', { class: 'k' }, '最大水深'), h('b', {}, `${fmt(run.maxDepthM, 2)} m`),
      h('span', { class: 'k' }, '峰值降雨'), h('b', {}, `${fmt(Math.max(...run.hydrographs.rainfallMmH), 1)} mm/h`),
      h('span', { class: 'k' }, '泵排总量'), h('b', {}, `${fmt(run.ledger.pumpM3, 0)} m³`),
      h('span', { class: 'k' }, '排口总量'), h('b', {}, `${fmt(run.ledger.outfallM3, 0)} m³`)
    ),
    h('h4', {}, 'Top 易涝点'),
    ...top.map(s => h('div', { class: 'flex-between', style: 'padding:6px 0;border-bottom:1px solid var(--line)' }, h('span', {}, s.name), h('b', {}, `${fmt(s.maxDepthM, 2)}m`))),
    other === run ? null : null
  );
}
function schemeName(id: string) {
  return { base: '现状方案', dredge: '方案一 · 疏通 DN1200', 'pump-plus': '方案二 · 加泵优化', combined: '组合方案' }[id] ?? id;
}
function runSelect(value: string, onPick: (r: RunRecord) => void) {
  return h('select', { onchange: (e: Event) => { const r = store.runs.find(x => x.id === (e.target as HTMLSelectElement).value); if (r) onPick(r); } },
    ...store.runs.slice(0, 30).map(r => h('option', { value: r.id, selected: r.id === value }, `${schemeName(r.schemeId)} · ${fmtClock(r.startedAt)}`))
  );
}
function comparisonDiffs(a: RunRecord, b: RunRecord) {
  const bm = new Map(b.spots.map(s => [stableSpotKey(s), s]));
  const out: { name: string; a: number; b: number; diff: number }[] = [];
  for (const s of a.spots) {
    const z = bm.get(stableSpotKey(s));
    if (z && (s.kind === 'underpass' || s.kind === 'well')) out.push({ name: s.name, a: s.maxDepthM, b: z.maxDepthM, diff: z.maxDepthM - s.maxDepthM });
  }
  return out.sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff));
}
function stableSpotKey(s: FloodSpotStat) {
  return s.kind === 'low-road' ? `${s.kind}:${Math.round(s.x / 100)}:${Math.round(s.y / 100)}` : s.id;
}
