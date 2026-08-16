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


function planAllSheets(analysis){
  const total=analysis.total;

  // Global multi-sheet packing is a harder problem than one sheet.
  // Huge duplicate jobs need a coarse grid and a deliberately bounded search
  // so "Organizar todas" stays practical instead of exploring forever.
  if(total>600){
    return {
      kind:analysis.kind,
      grid:1,
      randomIterations:analysis.kind==="repetitive"?8:5,
      randomWorkers:2,
      brkgaWorkers:analysis.kind==="repetitive"?1:0,
      brkgaBudgetMs:analysis.kind==="repetitive"?1400:0,
      populationSize:14,
      minRuntimeMs:500,
      noBeatStopMs:900,
      stallMs:550
    };
  }

  if(total>250){
    return {
      kind:analysis.kind,
      grid:1,
      randomIterations:analysis.kind==="repetitive"?20:12,
      randomWorkers:2,
      brkgaWorkers:analysis.kind==="repetitive"?1:0,
      brkgaBudgetMs:analysis.kind==="repetitive"?1800:0,
      populationSize:18,
      minRuntimeMs:650,
      noBeatStopMs:1100,
      stallMs:700
    };
  }

  if(total>100){
    return {
      kind:analysis.kind,
      grid:2,
      randomIterations:analysis.kind==="heterogeneous"?120:180,
      randomWorkers:3,
      brkgaWorkers:1,
      brkgaBudgetMs:analysis.kind==="repetitive"?2600:1600,
      populationSize:24,
      minRuntimeMs:800,
      noBeatStopMs:1300,
      stallMs:800
    };
  }

  const base=plan(analysis);
  return {
    ...base,
    // The multi-sheet fitness is expensive; cap the portfolio a little.
    randomIterations:Math.min(base.randomIterations,900),
    randomWorkers:Math.min(base.randomWorkers,4),
    brkgaWorkers:Math.min(base.brkgaWorkers,2),
    brkgaBudgetMs:Math.min(base.brkgaBudgetMs,3800),
    populationSize:analysis.total<=40?50:36
  };
}

g.BixNestStrategy={analyze,plan,planAllSheets,groupKeyForObject};
})(window);