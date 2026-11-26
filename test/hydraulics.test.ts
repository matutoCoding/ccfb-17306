import { describe, expect, it } from 'vitest';
import { circularSegmentArea, fullPhysicalArea, sectionGeometry } from '../src/domain/hydraulics';
import type { PipeSegment } from '../src/domain/types';

const dn1200: PipeSegment = {
  id: 'p', code: 'p', fromNodeId: 'a', toNodeId: 'b', length: 100, shape: 'circular',
  diameter: 1.2, upstreamInvert: 1, downstreamInvert: 0.9, manningN: 0.013,
  sedimentDepth: 0.45, defectLevel: 3
};

describe('断面与淤积折减', () => {
  it('圆管全断面面积正确', () => {
    expect(circularSegmentArea(1.2, 1.2)).toBeCloseTo(Math.PI * 0.6 ** 2, 8);
  });

  it('0.45m 淤积直接扣除约三分之一断面', () => {
    const full = Math.PI * 0.6 ** 2;
    const sediment = circularSegmentArea(1.2, 0.45);
    expect(sediment / full).toBeGreaterThan(0.31);
    expect(sediment / full).toBeLessThan(0.37);
    expect(fullPhysicalArea(dn1200)).toBeCloseTo(full - sediment, 6);
  });

  it('Preissmann 窄缝在管顶以上给出随压力水头增长的等效面积', () => {
    const atCrown = sectionGeometry({ ...dn1200, sedimentDepth: 0 }, 1.2, 20);
    const pressurized = sectionGeometry({ ...dn1200, sedimentDepth: 0 }, 2.2, 20);
    expect(pressurized.area).toBeGreaterThan(atCrown.physicalArea);
    expect(pressurized.topWidth).toBeLessThan(0.2);
  });
});
