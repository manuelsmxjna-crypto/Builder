
'use strict';

let cancelled=false;

function postProgress(pct,label){
  self.postMessage({type:'progress',pct,label});
}
function cmpScore(a,b){
  for(let i=0;i<a.length;i++){
    if(a[i]<b[i]) return -1;
    if(a[i]>b[i]) return 1;
  }
  return 0;
}
function collides(shape,x,y,grid,gw,gh){
  x|=0;y|=0;
  if(x<0||y<0||x+shape.w>gw||y+shape.h>gh) return true;
  const sd=shape.data;
  for(let sy=0;sy<shape.h;sy++){
    let si=sy*shape.w, gi=(y+sy)*gw+x;
    for(let sx=0;sx<shape.w;sx++){
      if(sd[si+sx] && grid[gi+sx]) return true;
    }
  }
  return false;
}
function mark(shape,x,y,grid,gw,gh,gap){
  // Small Chebyshev dilation at placement time; cheaper than storing expanded masks.
  const sd=shape.data, r=Math.max(0,gap|0);
  for(let sy=0;sy<shape.h;sy++){
    for(let sx=0;sx<shape.w;sx++){
      if(!sd[sy*shape.w+sx]) continue;
      const gx=x+sx, gy=y+sy;
      for(let yy=Math.max(0,gy-r);yy<=Math.min(gh-1,gy+r);yy++){
        const row=yy*gw;
        for(let xx=Math.max(0,gx-r);xx<=Math.min(gw-1,gx+r);xx++){
          grid[row+xx]=1;
        }
      }
    }
  }
}
function compact(shape,x,y,grid,gw,gh){
  if(collides(shape,x,y,grid,gw,gh)) return null;
  let changed=true, guard=0;
  while(changed && guard++<5){
    changed=false;
    while(x>0 && !collides(shape,x-1,y,grid,gw,gh)){x--;changed=true}
    while(y>0 && !collides(shape,x,y-1,grid,gw,gh)){y--;changed=true}
  }
  return {x,y};
}
function bboxCandidates(shape,placed,gw,gh,gap){
  const out=[{x:0,y:0}];
  for(const p of placed){
    out.push(
      {x:p.x+p.w+gap,y:p.y},
      {x:p.x,y:p.y+p.h+gap},
      {x:Math.max(0,p.x-shape.w-gap),y:p.y},
      {x:p.x,y:Math.max(0,p.y-shape.h-gap)}
    );
  }
  return out;
}
function frontierCandidates(shape,grid,gw,searchH,placed,gap,quality){
  const seen=new Set(), out=[];
  const push=(x,y)=>{
    x=Math.max(0,Math.min(gw-shape.w,x|0));
    y=Math.max(0,Math.min(searchH-shape.h,y|0));
    const k=x+'|'+y;
    if(!seen.has(k)){seen.add(k);out.push({x,y})}
  };
  for(const p of bboxCandidates(shape,placed,gw,searchH,gap)) push(p.x,p.y);

  // Adaptive frontier sampling. Mobile/large jobs use fewer candidates.
  const stride = quality==='fast' ? 2 : 1;
  const maxFrontier = quality==='fast' ? 550 : quality==='balanced' ? 1000 : 1600;
  let added=0;
  outer:
  for(let y=0;y<searchH;y+=stride){
    const row=y*gw;
    for(let x=0;x<gw;x+=stride){
      if(grid[row+x]) continue;
      const left=x>0 && grid[row+x-1];
      const up=y>0 && grid[(y-1)*gw+x];
      if(!left && !up) continue;
      push(x,y);
      push(x-shape.w+1,y);
      push(x,y-shape.h+1);
      push(x-shape.w+1,y-shape.h+1);
      added++;
      if(added>=maxFrontier) break outer;
    }
  }
  return out;
}
function bestSlot(shape,grid,gw,gh,placed,gap,quality){
  const usedBottom=placed.length ? Math.max(...placed.map(p=>p.y+p.h)) : 0;
  const searchH=Math.min(gh,Math.max(shape.h,usedBottom+shape.h+gap+2));
  let starts=frontierCandidates(shape,grid,gw,searchH,placed,gap,quality);
  if(!starts.length) starts=[{x:0,y:usedBottom+gap}];

  let best=null;
  const finals=new Set();
  for(const st of starts){
    if(cancelled) return null;
    if(collides(shape,st.x,st.y,grid,gw,gh)) continue;
    const c=compact(shape,st.x,st.y,grid,gw,gh);
    if(!c) continue;
    const key=c.x+'|'+c.y;
    if(finals.has(key)) continue;
    finals.add(key);
    const usedH=Math.max(c.y+shape.h,usedBottom);
    const score=[usedH,c.y,c.x,c.x+shape.w];
    if(!best || cmpScore(score,best.score)<0) best={...c,score};
  }
  return best;
}
function layout(items,shapeMap,gw,gh,gap,mode,allowRotate,quality){
  const sorted=[...items];
  if(mode==='maxSide'){
    sorted.sort((a,b)=>Math.max(b.baseW,b.baseH)-Math.max(a.baseW,a.baseH));
  }else{
    sorted.sort((a,b)=>(b.baseW*b.baseH)-(a.baseW*a.baseH));
  }

  const occupancy=new Uint8Array(gw*gh);
  const placed=[];
  let rotations=0,usedH=0,usedW=0,area=0;

  for(let i=0;i<sorted.length;i++){
    if(cancelled) return null;
    const item=sorted[i];
    const options=[{q:0,key:item.k0}];
    if(allowRotate && item.k1 && item.k1!==item.k0) options.push({q:1,key:item.k1});

    let best=null;
    for(const opt of options){
      const shape=shapeMap.get(opt.key);
      if(!shape||shape.w>gw||shape.h>gh) continue;
      const slot=bestSlot(shape,occupancy,gw,gh,placed,gap,quality);
      if(!slot) continue;
      const score=slot.score;
      if(!best || cmpScore(score,best.score)<0) best={...slot,shape,q:opt.q};
    }
    if(!best) return null;

    mark(best.shape,best.x,best.y,occupancy,gw,gh,gap);
    const p={
      id:item.id,
      x:best.x,y:best.y,
      w:best.shape.w,h:best.shape.h,
      rotated:best.q===1
    };
    placed.push(p);
    if(p.rotated) rotations++;
    usedH=Math.max(usedH,p.y+p.h);
    usedW=Math.max(usedW,p.x+p.w);
    area+=best.shape.occupied||0;
  }
  const waste=Math.max(0,usedW*usedH-area);
  return {placed,usedH,usedW,waste,rotations};
}
function better(a,b){
  if(!b) return true;
  if(a.usedH!==b.usedH) return a.usedH<b.usedH;
  if(a.waste!==b.waste) return a.waste<b.waste;
  if(a.rotations!==b.rotations) return a.rotations<b.rotations;
  return a.usedW<b.usedW;
}

self.onmessage=(e)=>{
  const msg=e.data||{};
  if(msg.type==='cancel'){cancelled=true;return}
  if(msg.type!=='run') return;
  cancelled=false;

  try{
    const {items,shapes,gw,gh,gap,allowRotate,quality='balanced'}=msg;
    const shapeMap=new Map();
    for(const s of shapes){
      shapeMap.set(s.key,{...s,data:new Uint8Array(s.data)});
    }

    // Only two pack orders. This is intentionally bounded.
    const modes=items.length>90?['area']:['area','maxSide'];
    let best=null;
    for(let i=0;i<modes.length;i++){
      if(cancelled) throw new Error('cancelled');
      postProgress(Math.round((i/modes.length)*90),`Organizando ${i+1}/${modes.length}`);
      const r=layout(items,shapeMap,gw,gh,gap,modes[i],allowRotate,quality);
      if(r && better(r,best)) best=r;
    }
    if(cancelled) throw new Error('cancelled');
    postProgress(100,'Listo');
    self.postMessage({type:'done',ok:!!best,result:best});
  }catch(err){
    self.postMessage({type:'done',ok:false,error:String(err&&err.message||err)});
  }
};
