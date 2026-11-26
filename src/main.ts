import './styles.css';
import { h, clear } from './ui/dom';
import { store } from './state';
import { networkPage } from './pages/networkPage';
import { terrainPage } from './pages/terrainPage';
import { rainfallPage } from './pages/rainfallPage';
import { simulationPage } from './pages/simulationPage';
import { replayPage } from './pages/replayPage';
import { reportPage } from './pages/reportPage';

const NAV = [
  { hash: '#/network', label: '管网模型', icon: '🕳️' },
  { hash: '#/terrain', label: '地形下垫面', icon: '🗺️' },
  { hash: '#/rainfall', label: '降雨情景', icon: '🌧️' },
  { hash: '#/simulation', label: '耦合推演', icon: '⚙️' },
  { hash: '#/replay', label: '积水回放', icon: '▶️' },
  { hash: '#/report', label: '易涝报告', icon: '📊' }
];

function currentRoute() {
  const hash = location.hash || '#/network';
  return NAV.some(n => n.hash === hash) ? hash : '#/network';
}

function render() {
  const app = document.getElementById('app')!;
  const route = currentRoute();
  clear(app);
  const main = h('main', { class: 'main' });
  const shell = h('div', { class: 'app-shell' },
    h('aside', { class: 'sidebar' },
      h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }),
        h('div', {}, h('h1', {}, '内涝管网耦合推演'), h('p', {}, 'TypeScript · WebGPU · WGSL'))),
      h('nav', { class: 'nav' }, ...NAV.map(n => h('button', {
        class: route === n.hash ? 'active' : '',
        onclick: () => { location.hash = n.hash; }
      }, h('span', { class: 'ico' }, n.icon), h('span', { class: 'label' }, n.label)))),
      h('div', { class: 'side-card' },
        h('div', {}, h('span', { class: 'status-dot' }), 'IndexedDB 工程已连接'),
        h('div', { class: 'mt8' }, '一维动力波 / Preissmann 窄缝 · 二维 GPU 有限体积 · 水量闭合校核'),
        h('div', { class: 'mt8' }, `当前样例：${store.project.nodes.length} 节点 / ${store.project.pipes.length} 管段`)
      )
    ),
    main
  );
  app.append(shell);
  const page = route === '#/network' ? networkPage()
    : route === '#/terrain' ? terrainPage()
    : route === '#/rainfall' ? rainfallPage()
    : route === '#/simulation' ? simulationPage()
    : route === '#/replay' ? replayPage()
    : reportPage();
  main.append(page);
}

window.addEventListener('hashchange', render);
void store.init().then(render);
render();
