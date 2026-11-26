// @vitest-environment jsdom
import { beforeAll, describe, expect, it } from 'vitest';
import { store } from '../src/state';
import { createSampleProject } from '../src/data/sampleProject';
import { CoupledEngine } from '../src/sim/coupled';
import { networkPage } from '../src/pages/networkPage';
import { terrainPage } from '../src/pages/terrainPage';
import { rainfallPage } from '../src/pages/rainfallPage';
import { simulationPage } from '../src/pages/simulationPage';
import { replayPage } from '../src/pages/replayPage';
import { reportPage } from '../src/pages/reportPage';
import type { RunRecord } from '../src/domain/types';

beforeAll(() => {
  const ctxProxy = new Proxy({}, {
    get(_target, prop) {
      if (prop === 'createLinearGradient' || prop === 'createRadialGradient') return () => ({ addColorStop() {} });
      if (prop === 'measureText') return () => ({ width: 12 });
      if (prop === 'getImageData') return () => ({ data: new Uint8ClampedArray(4) });
      return () => {};
    },
    set() { return true; }
  });
  HTMLCanvasElement.prototype.getContext = (() => ctxProxy) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientWidth', { configurable: true, value: 900 });
  Object.defineProperty(HTMLCanvasElement.prototype, 'clientHeight', { configurable: true, value: 560 });
});

describe('六个业务页面 DOM 冒烟', () => {
  it('全部能渲染并执行延迟图表/地图绘制', async () => {
    const project = createSampleProject();
    store.project = project;
    const engine = new CoupledEngine(project, { durationMin: 1, surfaceCellSize: 500, couplingDtSec: 2, engine: 'cpu', recordIntervalSec: 60 });
    const frame = engine.takeFrame();
    const run: RunRecord = {
      id: 'smoke-run', projectId: project.id, schemeId: 'base', startedAt: 0,
      options: { durationMin: 1, engine: 'cpu' },
      ledger: engine.buildLedger(), spots: engine.buildFloodSpots(), maxDepthM: 0.2,
      elapsedMs: 1, engineInfo: 'smoke', frameCount: 1, frames: [frame],
      hydrographs: { timeMin: [0], rainfallMmH: [0], outfallM3s: [0], pumpM3s: [0] }
    };
    store.currentRun = run;
    store.runs = [run];

    document.body.innerHTML = '<div id="root"></div>';
    const root = document.getElementById('root')!;
    const pages = [networkPage(), terrainPage(), rainfallPage(), simulationPage(), replayPage(), reportPage()];
    for (const page of pages) root.append(page);
    await new Promise(resolve => setTimeout(resolve, 500));
    expect(document.querySelectorAll('.card').length).toBeGreaterThan(15);
    expect(document.querySelectorAll('table').length).toBeGreaterThan(5);
    expect(root.textContent).toContain('管网模型');
    expect(root.textContent).toContain('易涝点');
  }, 15000);
});
