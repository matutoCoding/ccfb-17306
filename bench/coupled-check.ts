import { createSampleProject } from '../src/data/sampleProject';
import { CoupledEngine } from '../src/sim/coupled';

const t0 = performance.now();
const project = createSampleProject();
const engine = new CoupledEngine(project, {
  durationMin: 120,
  surfaceCellSize: 100,
  couplingDtSec: 1,
  engine: 'cpu',
  recordIntervalSec: 60,
  maxReachLength: 80,
  preissmannCelerity: 18
}, 'base');
const cp60 = engine.createCheckpoint(); // t=0 initially; will replace after run-to? For demo only.
const result = engine.run(120);
console.log('elapsed wall ms', performance.now() - t0, 'sim elapsed reported', result.elapsedMs);
console.log(result.ledger);
console.log('frames', result.frames.length);
const spots = engine.buildFloodSpots().slice(0, 12).map(s => ({ name:s.name, max:s.maxDepthM.toFixed(2), dur:s.durationMin.toFixed(0), rec:s.recessionMin?.toFixed(0) }));
console.table(spots);
console.log('cover blown', [...engine.coverBlown]);
