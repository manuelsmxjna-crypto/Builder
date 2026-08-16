
(function(g){
  "use strict";

  function rotateMask(mask,w,h,q){
    q=((q%4)+4)%4;
    if(!q) return {data:mask,w,h};
    let src=mask,sw=w,sh=h;
    for(let turn=0;turn<q;turn++){
      const dw=sh,dh=sw,out=new Uint8Array(dw*dh);
      for(let y=0;y<sh;y++){
        for(let x=0;x<sw;x++){
          const nx=sh-1-y,ny=x;
          out[ny*dw+nx]=src[y*sw+x];
        }
      }
      src=out;sw=dw;sh=dh;
    }
    return {data:src,w:sw,h:sh};
  }

  function toBits(mask,w,h){
    const words=Math.ceil(w/32);
    const rows=new Uint32Array(words*h);
    let occupied=0;
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        if(!mask[y*w+x]) continue;
        rows[y*words+(x>>>5)]|=(1<<(x&31))>>>0;
        occupied++;
      }
    }
    return {rows,w,h,words,occupied};
  }

  function dilate(mask,w,h,r){
    r=Math.max(0,r|0);
    if(!r) return {data:mask,w,h};
    const dw=w+r*2,dh=h+r*2;
    const out=new Uint8Array(dw*dh);
    // Two-pass square dilation. This is setup-time only, not per chromosome.
    const tmp=new Uint8Array(dw*dh);
    for(let y=0;y<h;y++){
      for(let x=0;x<w;x++){
        if(!mask[y*w+x]) continue;
        const yy=y+r;
        for(let xx=x;xx<=x+r*2;xx++) tmp[yy*dw+xx]=1;
      }
    }
    for(let y=0;y<dh;y++){
      const row=y*dw;
      for(let x=0;x<dw;x++){
        if(!tmp[row+x]) continue;
        for(let yy=Math.max(0,y-r);yy<=Math.min(dh-1,y+r);yy++) out[yy*dw+x]=1;
      }
    }
    return {data:out,w:dw,h:dh};
  }

  function collides(shape,x,y,occ,sheetWords,gw,gh){
    x|=0;y|=0;
    if(x<0||y<0||x+shape.w>gw||y+shape.h>gh) return true;
    const shift=x&31,wordOff=x>>>5;
    for(let sy=0;sy<shape.h;sy++){
      const srcBase=sy*shape.words;
      const dstBase=(y+sy)*sheetWords+wordOff;
      let carry=0;
      for(let wi=0;wi<shape.words;wi++){
        const word=shape.rows[srcBase+wi]>>>0;
        const lo=shift===0?word:((word<<shift)>>>0);
        const merged=(lo|carry)>>>0;
        if(merged && (occ[dstBase+wi]&merged)) return true;
        carry=shift===0?0:(word>>>(32-shift));
      }
      if(carry && (occ[dstBase+shape.words]&carry)) return true;
    }
    return false;
  }

  function mark(shape,x,y,occ,sheetWords){
    const shift=x&31,wordOff=x>>>5;
    for(let sy=0;sy<shape.h;sy++){
      const srcBase=sy*shape.words;
      const dstBase=(y+sy)*sheetWords+wordOff;
      let carry=0;
      for(let wi=0;wi<shape.words;wi++){
        const word=shape.rows[srcBase+wi]>>>0;
        const lo=shift===0?word:((word<<shift)>>>0);
        occ[dstBase+wi]|=(lo|carry)>>>0;
        carry=shift===0?0:(word>>>(32-shift));
      }
      if(carry) occ[dstBase+shape.words]|=carry>>>0;
    }
  }

  // Mark a "keep-out" mask with clipping at sheet edges.
  // Used for inter-piece separation without forcing a margin at sheet borders.
  function markClipped(maskBits,x,y,occ,sheetWords,gw,gh){
    // Fast path when entirely inside.
    if(x>=0&&y>=0&&x+maskBits.w<=gw&&y+maskBits.h<=gh){
      mark(maskBits,x,y,occ,sheetWords);
      return;
    }
    // Setup masks are low-res; edge clipping is uncommon and this path is safe.
    for(let sy=0;sy<maskBits.h;sy++){
      const gy=y+sy;
      if(gy<0||gy>=gh) continue;
      for(let sx=0;sx<maskBits.w;sx++){
        const gx=x+sx;
        if(gx<0||gx>=gw) continue;
        const word=maskBits.rows[sy*maskBits.words+(sx>>>5)]>>>0;
        if(((word>>>(sx&31))&1)===0) continue;
        occ[gy*sheetWords+(gx>>>5)]|=(1<<(gx&31))>>>0;
      }
    }
  }

  g.BixBitboards={rotateMask,toBits,dilate,collides,mark,markClipped};
})(self);
