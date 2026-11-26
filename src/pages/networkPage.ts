import { h, clear, fmt, readJsonFile } from '../ui/dom';
import { store } from '../state';
import { validateNetwork, validationSummary } from '../domain/validation';
import type { PipeSegment, Project, ValidationIssue } from '../domain/types';

export function networkPage(): HTMLElement {
  const project = store.project;
  let selectedId = project.pipes[0]?.id;
  let filter: 'all' | 'error' | 'warning' = 'all';
  const issueBox = h('div', { class: 'table-wrap' });
  const pipeBox = h('div', { class: 'table-wrap' });
  const editor = h('div');

  const issues = validateNetwork(project.nodes, project.pipes);
  const summary = validationSummary(issues);

  function renderIssues() {
    clear(issueBox);
    const list = issues.filter(i => filter === 'all' || i.level === filter);
    issueBox.append(h('table', {},
      h('thead', {}, h('tr', {}, h('th', {}, '级别'), h('th', {}, '类型'), h('th', {}, '对象'), h('th', { class: 'wrap' }, '说明'))),
      h('tbody', {}, ...list.map(i => h('tr', {},
        h('td', {}, h('span', { class: `badge ${i.level}` }, i.level === 'error' ? '错误' : '警告')),
        h('td', {}, issueTypeLabel(i.type)),
        h('td', {}, i.entityId),
        h('td', { class: 'wrap' }, i.message)
      )))
    ));
  }

  function renderPipes() {
    clear(pipeBox);
    pipeBox.append(h('table', {},
      h('thead', {}, h('tr', {},
        h('th', {}, '管段编号'), h('th', {}, '上游→下游'), h('th', {}, 'L(m)'), h('th', {}, '断面'),
        h('th', {}, '上/下底(m)'), h('th', {}, 'n'), h('th', {}, '淤积(m)'), h('th', {}, '缺陷')
      )),
      h('tbody', {}, ...project.pipes.slice(0, 500).map(p => h('tr', {
        style: p.id === selectedId ? 'background:rgba(56,189,248,.14)' : '',
        onclick: () => { selectedId = p.id; renderPipes(); renderEditor(); }
      },
        h('td', {}, p.code),
        h('td', {}, `${shortNode(p.fromNodeId)} → ${shortNode(p.toNodeId)}`),
        h('td', {}, fmt(p.length, 0)),
        h('td', {}, p.shape === 'circular' ? `D${fmt(p.diameter, 2)}` : `${fmt(p.width, 1)}×${fmt(p.height, 1)}`),
        h('td', {}, `${fmt(p.upstreamInvert, 2)}/${fmt(p.downstreamInvert, 2)}`),
        h('td', {}, fmt(p.manningN, 3)),
        h('td', {}, h('span', { class: p.sedimentDepth > 0.3 ? 'badge error' : 'badge' }, fmt(p.sedimentDepth, 2))),
        h('td', {}, h('span', { class: `badge ${p.defectLevel >= 3 ? 'error' : p.defectLevel >= 1 ? 'warning' : 'ok'}` }, `${p.defectLevel}级`))
      )))
    ));
  }

  function renderEditor() {
    clear(editor);
    const p = project.pipes.find(x => x.id === selectedId);
    if (!p) { editor.append(h('p', { class: 'muted' }, '请选择管段')); return; }
    const num = (key: keyof PipeSegment, label: string, step = 0.01) => h('div', { class: 'field' },
      h('label', {}, label),
      h('input', { type: 'number', step, value: String(p[key] ?? 0), onchange: (e: Event) => {
        (p[key] as number) = Number((e.target as HTMLInputElement).value);
        void store.saveProject(project); renderPipes();
      } })
    );
    editor.append(
      h('h4', {}, `编辑 ${p.code}`),
      h('div', { class: 'form-row' }, num('upstreamInvert', '上游管底高程 m')),
      h('div', { class: 'form-row' }, num('downstreamInvert', '下游管底高程 m'), num('length', '管长 m', 1)),
      h('div', { class: 'form-row' }, num('diameter', '直径 D m'), num('manningN', '曼宁糙率', 0.001)),
      h('div', { class: 'form-row' }, num('sedimentDepth', 'CCTV 淤积深度 m', 0.01),
        h('div', { class: 'field' }, h('label', {}, '结构缺陷等级'),
          h('select', { onchange: (e: Event) => { p.defectLevel = Number((e.target as HTMLSelectElement).value) as PipeSegment['defectLevel']; void store.saveProject(project); renderPipes(); } },
            ...[0, 1, 2, 3, 4].map(v => h('option', { value: String(v), selected: p.defectLevel === v }, `${v} 级`))
          )
        )
      ),
      h('div', { class: 'field' }, h('label', {}, '缺陷描述'),
        h('textarea', { rows: 3, onchange: (e: Event) => { p.defectNote = (e.target as HTMLTextAreaElement).value; void store.saveProject(project); } }, p.defectNote ?? '')
      ),
      h('p', { class: 'muted' }, '淤积深度会直接调用圆形/矩形/梯形断面积分扣除过水面积，并同步改变水力半径与过流能力。')
    );
  }

  async function importFile(file: File) {
    try {
      const data = await readJsonFile<Partial<Project> | PipeSegment[]>(file);
      if (Array.isArray(data)) project.pipes.push(...data);
      else if (data.pipes) {
        project.pipes = data.pipes;
        if (data.nodes) project.nodes = data.nodes;
        if (data.name) project.name = data.name;
      }
      await store.saveProject(project);
      location.reload();
    } catch (e) {
      alert(`导入失败：${(e as Error).message}`);
    }
  }

  renderIssues(); renderPipes(); renderEditor();

  return h('div', {},
    h('div', { class: 'page-head' },
      h('div', {}, h('h2', {}, '管网模型与导入校核'),
        h('p', {}, '检查井、管段、排口、泵站和闸门统一建模；倒坡、标高错位与孤立管段在导入时立即列出。')),
      h('div', { class: 'actions' },
        h('label', { class: 'btn' }, '导入 JSON', h('input', { type: 'file', accept: '.json', hidden: true, onchange: (e: Event) => {
          const f = (e.target as HTMLInputElement).files?.[0]; if (f) void importFile(f);
        } })),
        h('button', { class: 'btn', onclick: () => downloadProject(project) }, '导出工程'),
        h('button', { class: 'btn primary', onclick: () => alert('可直接在表格右侧修改高程、淤积和缺陷，改动自动写入 IndexedDB。') }, '录入说明')
      )
    ),
    h('div', { class: 'grid cols-4' },
      metric('检查井/节点', `${project.nodes.length}`, '座', ''),
      metric('管段', `${project.pipes.length}`, '段', ''),
      metric('导入错误', `${summary.errors}`, '项', summary.errors ? 'bad' : 'good'),
      metric('警告', `${summary.warnings}`, '项', summary.warnings ? 'warn' : 'good')
    ),
    h('div', { class: 'grid cols-2 mt16' },
      h('section', { class: 'card' },
        h('h3', {}, '导入校核清单', h('div', { class: 'tabs', style: 'margin:0' },
          ...(['all', 'error', 'warning'] as const).map(k => h('button', { class: filter === k ? 'active' : '', onclick: () => { filter = k; renderIssues(); } }, k === 'all' ? '全部' : k === 'error' ? '错误' : '警告'))
        )),
        issueBox
      ),
      h('section', { class: 'card' }, h('h3', {}, '管段/CCTV 台账'), pipeBox, editor)
    )
  );
}

function metric(k: string, v: string, u: string, cls: string) {
  return h('div', { class: `metric ${cls}` }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v, ' ', h('span', { class: 'u' }, u)));
}

function shortNode(id: string) { return id.replace('W-', 'J').replace('-0', ''); }
function issueTypeLabel(t: ValidationIssue['type']) {
  return { 'reverse-slope': '倒坡/缓坡', 'invert-mismatch': '标高对不上', isolated: '孤立管段', sediment: 'CCTV 淤积', defect: '结构缺陷', duplicate: '编号重复' }[t];
}
function downloadProject(p: Project) {
  const blob = new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${p.id}.json`; a.click();
}
