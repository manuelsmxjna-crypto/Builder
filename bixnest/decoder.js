
(function(g){
  "use strict";
  const BB=g.BixBitboards;

  function buildShapeMap(shapes,gap){
    const map=new Map();
    for(const s of shapes){
      const raw={...s,rows:new Uint32Array(s.rows)};
      let keepout=raw;
      let keepoutOffset=0;
      if(gap>0 && s.mask){
        const expanded=BB.dilate(new Uint8Array(s.mask),s.w,s.h,gap);
        keepout={...BB.toBits(expanded.data,expanded.w,expanded.h),q:s.q,key:s.key};
        keepoutOffset=gap;
      }
      map.set(s.key,{raw,keepout,keepoutOffset});
    }
    return map;
  }

  function itemOptions(item,shapeMap){
    const out=[];
    for(let q=0;q<4;q++){
      const key=item["k"+q];
      if(!key) continue;
      const entry=shapeMap.get(key);
      if(entry) out.push({q,key,...entry});
    }
    return out;
  }

  function decode(chromosome,ctx){
    const {items,shapeMap,gw,gh}=ctx;
    const n=items.length;
    const order=Array.from({length:n},(_,i)=>i);
    order.sort((a,b)=>chromosome[a]-chromosome[b]);

    const sheetWords=Math.ceil((gw+31)/32)+1;
    const occ=new Uint32Array(sheetWords*gh);
    const placed=[];
    let usedH=0,usedW=0,area=0,rotations=0;

    for(let oi=0;oi<n;oi++){
      const idx=order[oi],item=items[idx];
      const opts=itemOptions(item,shapeMap);
      if(!opts.length) return null;

      const rg=chromosome[n+idx]??0;
      const pref=Math.min(opts.length-1,Math.floor(rg*opts.length));
      const ordered=[opts[pref],...opts.filter((_,i)=>i!==pref)];

      let best=null;

      // Complete bottom-left search at grid resolution.
      for(const opt of ordered){
        const shape=opt.raw;
        if(shape.w>gw||shape.h>gh) continue;

        const maxY=Math.min(gh-shape.h,Math.max(0,usedH+shape.h+2));
        outer:
        for(let y=0;y<=maxY;y++){
          for(let x=0;x<=gw-shape.w;x++){
            if(BB.collides(shape,x,y,occ,sheetWords,gw,gh)) continue;
            best={opt,x,y};
            break outer;
          }
        }
        if(best) break;
      }

      // Since strip height is open, if scan was curtailed by usedH, append below.
      if(!best){
        for(const opt of ordered){
          const shape=opt.raw;
          const y=placed.length?usedH+ctx.gap:0;
          if(shape.w<=gw && y+shape.h<=gh){
            best={opt,x:0,y};
            break;
          }
        }
      }
      if(!best) return null;

      const {opt,x,y}=best;
      const raw=opt.raw;
      const ko=opt.keepout;
      const off=opt.keepoutOffset||0;

      // Mark separation keep-out around the placed piece.
      BB.markClipped(ko,x-off,y-off,occ,sheetWords,gw,gh);

      placed.push({
        id:item.id,itemIndex:idx,x,y,w:raw.w,h:raw.h,q:opt.q,rot:opt.q*90
      });
      usedH=Math.max(usedH,y+raw.h);
      usedW=Math.max(usedW,x+raw.w);
      area+=raw.occupied||0;
      if(opt.q!==0) rotations++;
    }

    const waste=Math.max(0,usedW*usedH-area);
    return {placed,usedH,usedW,waste,area,rotations};
  }

  function validate(result,ctx){
    if(!result||result.placed.length!==ctx.items.length) return false;
    const {shapeMap,items,gw,gh}=ctx;
    const sheetWords=Math.ceil((gw+31)/32)+1;
    const occ=new Uint32Array(sheetWords*gh);

    for(const p of result.placed){
      const item=items[p.itemIndex];
      const key=item["k"+p.q];
      const entry=shapeMap.get(key);
      if(!entry) return false;
      const raw=entry.raw;
      if(p.x<0||p.y<0||p.x+raw.w>gw||p.y+raw.h>gh) return false;
      if(BB.collides(raw,p.x,p.y,occ,sheetWords,gw,gh)) return false;
      BB.markClipped(entry.keepout,p.x-(entry.keepoutOffset||0),p.y-(entry.keepoutOffset||0),occ,sheetWords,gw,gh);
    }
    return true;
  }

  function fitness(result){
    if(!result) return Number.POSITIVE_INFINITY;
    return result.usedH*1e9 + result.waste*1e3 + result.rotations;
  }

  g.BixDecoder={buildShapeMap,decode,validate,fitness};
})(self);
