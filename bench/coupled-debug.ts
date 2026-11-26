import { createSampleProject } from '../src/data/sampleProject';
import { CoupledEngine } from '../src/sim/coupled';

const mins = Number(process.argv[2] ?? 20);
const cell = Number(process.argv[3] ?? 200);
const project = createSampleProject();
const engine = new CoupledEngine(project, { durationMin: mins, surfaceCellSize: cell, couplingDtSec: 1, engine:'cpu', recordIntervalSec: 600, maxReachLength: 200, preissmannCelerity: 18 }, 'base');
const t0=performance.now();
const result=engine.run(mins);
let negNet=0, negNetVol=0;
for(const c of engine.net.cells) if(c.volume<0){negNet++; negNetVol+=c.volume;}
console.log({ms:performance.now()-t0, clips:engine.swe.negativeDepthClips, sweClipM3:engine.swe.positivityClipM3, maxClip:engine.swe.maxClipDepthM, netClipM3:engine.net.volumeClipM3, sweVol:engine.swe.volume(), netVol:engine.net.totalVolume(), negNet, negNetVol, boundary:engine.swe.boundaryNetOutM3});
console.log(result.ledger);
