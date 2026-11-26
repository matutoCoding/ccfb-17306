import { ShallowWaterGrid } from '../src/sim/swe';
const cols=4000, dx=.5, h0=10;
const g=new ShallowWaterGrid({cols,rows:1,cellSize:dx,originX:-1000,roughness:0,cfl:.4});
for(let c=0;c<cols;c++) if(g.xAt(c)<0) g.h[c]=h0;
for(let k=0;k<20;k++){
 const dt=g.stableDt(.2);
 let maxu=0,maxs=0,arg=0;
 for(let i=0;i<g.h.length;i++){if(g.h[i]>1e-5){const u=Math.abs(g.hu[i]/g.h[i]); const s=u+Math.sqrt(9.81*g.h[i]); if(s>maxs){maxs=s;arg=i;} maxu=Math.max(maxu,u)}}
 console.log(k,'t',g.timeSec.toFixed(4),'dt',dt.toExponential(3),'maxu',maxu.toFixed(3),'maxs',maxs.toFixed(3),'arg',arg,'h',g.h[arg]?.toExponential(3),'hu',g.hu[arg]?.toExponential(3));
 g.step(dt);
}
for(const x of [-100,-10,-.25,.25,10,100]){const c=Math.floor((x+1000)/.5); console.log(x,c,g.h[c]?.toFixed(4),g.hu[c]?.toFixed(2));}
