
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


  function makeBin(sheetWords,gh){
    return {
      occ:new Uint32Array(sheetWords*gh),
      placed:[],
      usedH:0,
      usedW:0,
      area:0,
      rotations:0
    };
  }

  function firstPlacementInBin(bin,ordered,ctx,sheetWords){
    const {gw,gh}=ctx;
    let best=null;

    for(const opt of ordered){
      const shape=opt.raw;
      if(shape.w>gw||shape.h>gh) continue;

      // Complete bottom-left scan at the active raster resolution.
      const maxY=Math.min(gh-shape.h,Math.max(0,bin.usedH+shape.h+2));
      outer:
      for(let y=0;y<=maxY;y++){
        for(let x=0;x<=gw-shape.w;x++){
          if(BB.collides(shape,x,y,bin.occ,sheetWords,gw,gh)) continue;
          best={opt,x,y};
          break outer;
        }
      }
      if(best) break;
    }
    return best;
  }

  function decodeMulti(chromosome,ctx){
    const {items,shapeMap,gw,gh}=ctx;
    const n=items.length;
    const order=Array.from({length:n},(_,i)=>i);
    order.sort((a,b)=>chromosome[a]-chromosome[b]);

    const sheetWords=Math.ceil((gw+31)/32)+1;
    const bins=[];
    const placed=[];
    let totalArea=0,totalRotations=0;

    for(let oi=0;oi<n;oi++){
      const idx=order[oi],item=items[idx];
      const opts=itemOptions(item,shapeMap);
      if(!opts.length) return null;

      const rg=chromosome[n+idx]??0;
      const pref=Math.min(opts.length-1,Math.floor(rg*opts.length));
      const ordered=[opts[pref],...opts.filter((_,i)=>i!==pref)];

      let chosen=null;
      let chosenBin=-1;

      // Always try existing sheets first: number of Gang Sheets is the primary objective.
      for(let bi=0;bi<bins.length;bi++){
        const pos=firstPlacementInBin(bins[bi],ordered,ctx,sheetWords);
        if(!pos) continue;

        const resultingH=Math.max(bins[bi].usedH,pos.y+pos.opt.raw.h);
        const score=resultingH*1e6 + pos.y*1e3 + pos.x;

        if(!chosen || score<chosen.score){
          chosen={...pos,score};
          chosenBin=bi;
        }
      }

      // No current sheet can accept it: open another 62 × max-height sheet.
      if(!chosen){
        const bin=makeBin(sheetWords,gh);
        bins.push(bin);
        chosenBin=bins.length-1;
        const pos=firstPlacementInBin(bin,ordered,ctx,sheetWords);
        if(!pos) return null;
        chosen={...pos,score:0};
      }

      const bin=bins[chosenBin];
      const {opt,x,y}=chosen;
      const raw=opt.raw;
      const off=opt.keepoutOffset||0;

      BB.markClipped(opt.keepout,x-off,y-off,bin.occ,sheetWords,gw,gh);

      const record={
        id:item.id,itemIndex:idx,
        sheetIndex:chosenBin,
        x,y,w:raw.w,h:raw.h,
        q:opt.q,rot:opt.q*90
      };

      bin.placed.push(record);
      placed.push(record);
      bin.usedH=Math.max(bin.usedH,y+raw.h);
      bin.usedW=Math.max(bin.usedW,x+raw.w);
      bin.area+=raw.occupied||0;
      if(opt.q!==0) bin.rotations++;

      totalArea+=raw.occupied||0;
      if(opt.q!==0) totalRotations++;
    }

    const sheetHeights=bins.map(b=>b.usedH);
    const totalUsedH=sheetHeights.reduce((a,b)=>a+b,0);
    const waste=bins.reduce((sum,b)=>sum+Math.max(0,b.usedW*b.usedH-b.area),0);

    return {
      placed,
      sheetCount:bins.length,
      sheetHeights,
      usedH:totalUsedH,
      maxUsedH:Math.max(0,...sheetHeights),
      usedW:Math.max(0,...bins.map(b=>b.usedW)),
      waste,
      area:totalArea,
      rotations:totalRotations
    };
  }

  function validateMulti(result,ctx){
    if(!result||result.placed.length!==ctx.items.length) return false;
    const {shapeMap,items,gw,gh}=ctx;
    const sheetWords=Math.ceil((gw+31)/32)+1;
    const occBySheet=[];

    for(const p of result.placed){
      if(!Number.isInteger(p.sheetIndex)||p.sheetIndex<0) return false;
      if(!occBySheet[p.sheetIndex]){
        occBySheet[p.sheetIndex]=new Uint32Array(sheetWords*gh);
      }

      const item=items[p.itemIndex];
      const key=item["k"+p.q];
      const entry=shapeMap.get(key);
      if(!entry) return false;
      const raw=entry.raw;

      if(p.x<0||p.y<0||p.x+raw.w>gw||p.y+raw.h>gh) return false;
      if(BB.collides(raw,p.x,p.y,occBySheet[p.sheetIndex],sheetWords,gw,gh)) return false;

      BB.markClipped(
        entry.keepout,
        p.x-(entry.keepoutOffset||0),
        p.y-(entry.keepoutOffset||0),
        occBySheet[p.sheetIndex],
        sheetWords,gw,gh
      );
    }

    return occBySheet.filter(Boolean).length===result.sheetCount;
  }

  function fitnessMulti(result){
    if(!result) return Number.POSITIVE_INFINITY;

    // First and overwhelmingly: fewer physical Gang Sheets.
    // Then: less total used linear material across those sheets.
    // Finally: compactness and fewer rotations.
    return result.sheetCount*1e15 +
           result.usedH*1e9 +
           result.waste*1e3 +
           result.rotations;
  }

  g.BixDecoder={buildShapeMap,decode,validate,fitness,decodeMulti,validateMulti,fitnessMulti};
})(self);
