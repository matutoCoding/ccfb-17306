import { NetworkRuntime } from '../src/sim/network1d';
import { manningFlow, sectionGeometry } from '../src/domain/hydraulics';
import type { NetworkNode, PipeSegment } from '../src/domain/types';

const pipe: PipeSegment = {
  id: 'p1', code: 'DN1200-test', fromNodeId: 'u', toNodeId: 'd', length: 200,
  shape: 'circular', diameter: 1.2, upstreamInvert: 100.2, downstreamInvert: 100.0,
  manningN: 0.013, sedimentDepth: 0, defectLevel: 0
};
const nodes: NetworkNode[] = [
  { id:'u', code:'U', name:'u', kind:'inspection', x:0,y:0,groundElev:103,invert:99.8,chamberDiameter:1.2 },
  { id:'d', code:'D', name:'d', kind:'outfall', x:200,y:0,groundElev:103,invert:99.7,chamberDiameter:1.2 }
];
const net = new NetworkRuntime(20);
net.buildFromNetwork(nodes,[pipe],25);
const ui=net.nodeCell.get('u')!, di=net.nodeCell.get('d')!;
net.cells[ui].fixedHead=102.2;
net.cells[di].fixedHead=102.0;
const A=Math.PI*1.2**2/4, R=.3, S=.001;
const qTheory=manningFlow(A,R,S,.013);
net.pipeReachCells.get('p1')!.forEach((ci, k) => {
  const c=net.cells[ci];
  const distance = (k + 0.5) * 25;
  const hgl = 102.2 - 0.2 * distance / pipe.length;
  c.depth = hgl - c.invert;
  c.volume=sectionGeometry(pipe,c.depth,net.celerity).area*c.length;
});
for (const ii of net.pipeInterfaces.get('p1')!) net.interfaces[ii].q = qTheory;
net.updateHeadsFromVolumes();
for(let k=0;k<4000;k++) net.step(.25);
const q=net.pipeFlow('p1');
const qs=net.pipeInterfaces.get('p1')!.map(i=>net.interfaces[i].q);
console.log({qTheory,q,qErrorPct:100*Math.abs(q-qTheory)/qTheory, minQ:Math.min(...qs),maxQ:Math.max(...qs), heads:[net.cells[ui].head,net.cells[di].head], vol:net.totalVolume()});
