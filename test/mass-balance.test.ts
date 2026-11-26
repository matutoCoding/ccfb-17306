import { describe, expect, it } from 'vitest';
import { createSampleProject } from '../src/data/sampleProject';
import { CoupledEngine } from '../src/sim/coupled';

describe('城市雨-管-地表耦合水量平衡', () => {
  it('两小时暴雨各项水量对平，体积平衡误差 < 0.5%', () => {
    const project = createSampleProject();
    const engine = new CoupledEngine(project, {
      durationMin: 120,
      surfaceCellSize: 500,
      couplingDtSec: 2,
      engine: 'cpu',
      recordIntervalSec: 600,
      maxReachLength: 120,
      preissmannCelerity: 18
    }, 'base');
    const result = engine.run(120);
    const l = result.ledger;
    expect(l.rainfallM3).toBeGreaterThan(150000);
    expect(l.infiltrationM3).toBeGreaterThan(1000);
    expect(l.pumpM3 + l.outfallM3).toBeGreaterThan(100);
    expect(l.relativeErrorPct).toBeLessThan(0.5);
    expect(Math.abs(l.residualM3) / l.rainfallM3).toBeLessThan(0.005);
  }, 180000);
});
