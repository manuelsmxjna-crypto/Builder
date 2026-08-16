(function(g){
"use strict";

function clamp(v,min,max){ return Math.max(min,Math.min(max,v)); }

function groupKeyForObject(o){
  const w=+(o.baseW||o.w||1);
  const h=+(o.baseH||o.h||1);
  return [
    o.type||"image",
    o.assetId||o.id||"shape",
    w.toFixed(3),
    h.toFixed(3),
    o.flipX?1:0,
    o.flipY?1:0
  ].join("|");
}

function analyze(objects){
  const list=Array.isArray(objects)?objects:[];
  const total=list.length;
  const groups=new Map();

  for(const o of list){
    const key=groupKeyForObject(o);
    groups.set(key,(groups.get(key)||0)+1);
  }

  const counts=[...groups.values()].sort((a,b)=>b-a);
  const unique=groups.size;
  const largest=counts[0]||0;
  const repeatedPieces=counts.filter(n=>n>1).reduce((s,n)=>s+n,0);
  const repetitionRatio=total ? 1-(unique/total) : 0;
  const dominantRatio=total ? largest/total : 0;
  const repeatedPieceRatio=total ? repeatedPieces/total : 0;

  let kind="mixed";

  // Repetitive: one/few designs dominate or most pieces belong to duplicate groups.
  if(
    total>=4 && (
      dominantRatio>=0.45 ||
      repetitionRatio>=0.55 ||
      repeatedPieceRatio>=0.72
    )
  ){
    kind="repetitive";
  }
  // Heterogeneous: mostly unique with no dominant duplicate family.
  else if(
    repetitionRatio<=0.20 &&
    dominantRatio<=0.22 &&
    repeatedPieceRatio<=0.35
  ){
    kind="heterogeneous";
  }

  return {
    total,unique,largest,repeatedPieces,
    repetitionRatio,
    dominantRatio,
    repeatedPieceRatio,
    kind
  };
}

function chooseGrid(total){
  if(total<=30) return 4;
  if(total<=80) return 3;
  return 2;
}

function plan(analysis){
  const total=analysis.total;
  const grid=chooseGrid(total);

  // Defaults tuned from the user's real A/B tests:
  // - mixed/heterogeneous often favored Random
  // - repetitive sets more often benefited from BRKGA
  if(analysis.kind==="heterogeneous"){
    return {
      kind:"heterogeneous",
      grid,
      randomIterations: total<=40 ? 1800 : 2600,
      randomWorkers:4,
      brkgaWorkers:1,
      brkgaBudgetMs: total<=40 ? 1600 : 2000,
      minRuntimeMs:850,
      noBeatStopMs:1200,
      stallMs:650
    };
  }

  if(analysis.kind==="repetitive"){
    return {
      kind:"repetitive",
      grid,
      randomIterations: total<=40 ? 1200 : 1700,
      randomWorkers:3,
      brkgaWorkers:2,
      brkgaBudgetMs: total<=20 ? 4200 : total<=80 ? 5200 : 6500,
      minRuntimeMs:1200,
      noBeatStopMs: total<=40 ? 2400 : 3000,
      stallMs: total<=40 ? 1200 : 1500
    };
  }

  return {
    kind:"mixed",
    grid,
    randomIterations: total<=40 ? 1600 : 2200,
    randomWorkers:4,
    brkgaWorkers:2,
    brkgaBudgetMs: total<=40 ? 3200 : 4200,
    minRuntimeMs:1100,
    noBeatStopMs: total<=40 ? 1900 : 2400,
    stallMs: total<=40 ? 950 : 1200
  };
}

g.BixNestStrategy={analyze,plan,groupKeyForObject};
})(window);