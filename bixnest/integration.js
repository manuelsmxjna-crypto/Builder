(function(){
"use strict";

const VERSION="3.0.0-production";
const WORKER_URL="./bixnest/worker.js";
const BRIDGE=window.BixNestBridge;
const STRATEGY=window.BixNestStrategy;

if(!BRIDGE) throw new Error("BixNestBridge no está disponible.");
if(!STRATEGY) throw new Error("BixNestStrategy no está disponible.");

const state=BRIDGE.getState();
const toast=BRIDGE.toast;
const nestGapValue=BRIDGE.nestGapValue;
const MAX_SHEET_HEIGHT=BRIDGE.MAX_SHEET_HEIGHT;
const ensureRotationModel=BRIDGE.ensureRotationModel;
const getAdaptiveNestMask=BRIDGE.getAdaptiveNestMask;
const pushHistory=BRIDGE.pushHistory;
const recalcActiveSheetHeight=BRIDGE.recalcActiveSheetHeight;
const updateDiagnostics=BRIDGE.updateDiagnostics;
const renderAll=BRIDGE.renderAll;
const fitViewport=BRIDGE.fitViewport;

let running=false;

function q(s){ return document.querySelector(s); }
function paint(){ return new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))); }

function showBusy(show){
  const overlay=q("#autoNestProcessingOverlay");
  if(overlay) overlay.classList.toggle("show",!!show);

  const sub=overlay?.querySelector(".autonest-processing-sub");
  if(sub && show) sub.textContent="Optimizando espacio…";

  const btn=q("#autoNestTopBtn");
  if(btn){
    if(show){
      if(!btn.dataset.bixOriginalText) btn.dataset.bixOriginalText=btn.textContent;
      btn.textContent="⏳ Organizando…";
      btn.disabled=true;
    }else{
      btn.textContent=btn.dataset.bixOriginalText||"✦ Auto Organizar";
      delete btn.dataset.bixOriginalText;
      btn.disabled=false;
    }
  }
}

function better(a,b){
  if(!a) return false;
  if(!b) return true;
  if(a.usedH!==b.usedH) return a.usedH<b.usedH;
  if((a.waste||0)!==(b.waste||0)) return (a.waste||0)<(b.waste||0);
  if((a.rotations||0)!==(b.rotations||0)) return (a.rotations||0)<(b.rotations||0);
  return (a.usedW||0)<(b.usedW||0);
}

function runWorker(problem,opts,onMessage){
  return new Promise(resolve=>{
    let w;
    try{
      w=new Worker(WORKER_URL);
    }catch(e){
      resolve({type:"error",error:String(e?.message||e)});
      return;
    }

    let done=false;
    const finish=data=>{
      if(done) return;
      done=true;
      try{w.terminate()}catch{}
      resolve(data);
    };

    w.onmessage=e=>{
      const msg=e.data||{};
      onMessage?.(msg);
      if(msg.type==="done" || msg.type==="error") finish(msg);
    };
    w.onerror=e=>finish({type:"error",error:e.message||"Worker error"});

    w.postMessage({
      type:"run",
      solver:opts.solver,
      iterations:opts.iterations||0,
      items:problem.items,
      shapes:problem.shapes,
      gw:problem.gw,
      gh:problem.gh,
      gap:problem.gap,
      allowRotate:problem.allowRotate,
      seed:opts.seed||12345,
      budgetMs:opts.budgetMs||0,
      externalTargetUsedH:opts.externalTargetUsedH ?? null,
      minRuntimeMs:opts.minRuntimeMs ?? 1100,
      noBeatStopMs:opts.noBeatStopMs ?? 2000,
      stallMs:opts.stallMs ?? 1000,
      meaningfulImprovementCells:opts.meaningfulImprovementCells ?? 1
    });
  });
}

async function buildProblem(plan){
  const count=state.objects?.length||0;
  const grid=plan.grid;
  const allowRotate=!!q("#allowRotate")?.checked;
  const gap=Math.max(0,Math.round(Math.max(0,nestGapValue())*grid));
  const margin=state.sheet.margin;
  const printableW=state.sheet.w-2*margin;
  const printableH=MAX_SHEET_HEIGHT-2*margin;
  const gw=Math.max(1,Math.floor(printableW*grid));
  const gh=Math.max(1,Math.floor(printableH*grid));

  const groupSeen=new Map();
  const items=[];
  const shapeDefs=new Map();

  for(let i=0;i<state.objects.length;i++){
    const o=state.objects[i];
    ensureRotationModel(o);

    const groupKey=STRATEGY.groupKeyForObject(o);
    const instance=groupSeen.get(groupKey)||0;
    groupSeen.set(groupKey,instance+1);

    const item={
      id:o.id,
      type:o.type,
      assetId:o.assetId||null,
      baseW:o.baseW,
      baseH:o.baseH,
      flipX:!!o.flipX,
      flipY:!!o.flipY,
      groupKey,
      instance
    };

    const qs=allowRotate?[0,1,2,3]:[0];
    for(const qtr of qs){
      const shape=await getAdaptiveNestMask(item,qtr,grid);
      item["k"+qtr]=shape.key;

      if(!shapeDefs.has(shape.key)){
        shapeDefs.set(shape.key,{
          key:shape.key,
          q:qtr,
          w:shape.w,
          h:shape.h,
          occupied:shape.occupied,
          mask:new Uint8Array(shape.data)
        });
      }
    }

    items.push(item);
    if(i%12===0) await new Promise(r=>setTimeout(r,0));
  }

  const shapes=[];
  for(const s of shapeDefs.values()){
    const words=Math.ceil(s.w/32);
    const rows=new Uint32Array(words*s.h);

    for(let y=0;y<s.h;y++){
      for(let x=0;x<s.w;x++){
        if(!s.mask[y*s.w+x]) continue;
        rows[y*words+(x>>>5)]|=(1<<(x&31))>>>0;
      }
    }

    shapes.push({...s,words,rows});
  }

  return {items,shapes,grid,gap,gw,gh,margin,allowRotate,count};
}

function applyResult(result,problem){
  const byId=new Map(result.placed.map(p=>[p.id,p]));

  pushHistory();

  for(const o of state.objects){
    const p=byId.get(o.id);
    if(!p) continue;

    ensureRotationModel(o);
    o.w=o.baseW;
    o.h=o.baseH;
    o.visualW=o.baseW;
    o.visualH=o.baseH;
    o.aspectRatio=o.baseW/o.baseH;

    const qtr=Number.isFinite(p.q)?p.q:Math.round((p.rot||0)/90);
    o.rot=((qtr*90)%360+360)%360;

    const left=problem.margin+p.x/problem.grid;
    const top=problem.margin+p.y/problem.grid;
    const pw=p.w/problem.grid;
    const ph=p.h/problem.grid;
    const cx=left+pw/2;
    const cy=top+ph/2;

    o.x=cx-o.w/2;
    o.y=cy-o.h/2;
  }

  recalcActiveSheetHeight();
  updateDiagnostics();
  renderAll();
  setTimeout(fitViewport,20);
}

async function runRandom(problem,plan){
  const count=Math.max(1,Math.min(plan.randomWorkers,navigator.hardwareConcurrency||4,6));
  const total=plan.randomIterations;
  const base=Math.floor(total/count);
  const rem=total%count;

  let best=null;
  let evaluations=0;
  let valid=0;
  let invalid=0;
  let elapsedMs=0;

  const jobs=Array.from({length:count},(_,i)=>{
    const iterations=base+(i<rem?1:0);
    return runWorker(problem,{
      solver:"random",
      iterations,
      seed:0x51A7000+i*7919+problem.count*131
    },msg=>{
      if(msg.type==="incumbent" && msg.result && better(msg.result,best)){
        best=msg.result;
      }
    });
  });

  const results=await Promise.all(jobs);
  for(const r of results){
    if(r?.result && better(r.result,best)) best=r.result;
    evaluations+=r?.evaluations||0;
    valid+=r?.valid||0;
    invalid+=r?.invalid||0;
    elapsedMs=Math.max(elapsedMs,r?.elapsedMs||0);
  }

  return {best,evaluations,valid,invalid,elapsedMs};
}

async function runBRKGA(problem,plan,randomBest){
  const count=Math.max(1,Math.min(plan.brkgaWorkers,navigator.hardwareConcurrency||4,4));

  let best=null;
  let evaluations=0;
  let elapsedMs=0;
  let generation=0;
  const stopReasons=[];

  const jobs=Array.from({length:count},(_,i)=>
    runWorker(problem,{
      solver:"brkga",
      seed:0xB17B000+i*104729+problem.count*131,
      budgetMs:plan.brkgaBudgetMs,
      externalTargetUsedH:randomBest?.usedH ?? null,
      minRuntimeMs:plan.minRuntimeMs,
      noBeatStopMs:plan.noBeatStopMs,
      stallMs:plan.stallMs,
      meaningfulImprovementCells:1
    },msg=>{
      if(msg.type==="incumbent" && msg.result && better(msg.result,best)){
        best=msg.result;
      }
    })
  );

  const results=await Promise.all(jobs);
  for(const r of results){
    if(r?.result && better(r.result,best)) best=r.result;
    evaluations+=r?.evaluations||0;
    elapsedMs=Math.max(elapsedMs,r?.elapsedMs||0);
    generation=Math.max(generation,r?.generation||0);
    if(r?.stopReason) stopReasons.push(r.stopReason);
  }

  return {
    best,evaluations,elapsedMs,generation,
    stopReasons:[...new Set(stopReasons)]
  };
}

async function autoOrganize(){
  if(running) return toast("Ya se está organizando…");
  if(!state.objects?.length) return toast("No hay diseños para organizar.");

  running=true;
  showBusy(true);
  await paint();

  const t0=performance.now();

  try{
    // Make sure manual changes are reflected before classification.
    for(const o of state.objects) ensureRotationModel(o);

    const analysis=STRATEGY.analyze(state.objects);
    const plan=STRATEGY.plan(analysis);
    const problem=await buildProblem(plan);

    toast("Buscando una buena distribución…");
    const random=await runRandom(problem,plan);

    if(!random.best){
      throw new Error("No se pudo construir una distribución válida.");
    }

    toast("Optimizando espacio…");
    const brkga=await runBRKGA(problem,plan,random.best);

    let winner=random.best;
    let winnerName="Random";

    if(brkga.best && better(brkga.best,winner)){
      winner=brkga.best;
      winnerName="BRKGA";
    }

    applyResult(winner,problem);

    const bestCm=winner.usedH/problem.grid;
    const randomCm=random.best.usedH/problem.grid;
    const brkgaCm=brkga.best ? brkga.best.usedH/problem.grid : null;
    const elapsedMs=performance.now()-t0;

    // Customer sees only the useful result, not algorithm jargon.
    toast(`Auto Organizar listo · ${bestCm.toFixed(1)} cm`);

    console.info("[BixNest v3]",{
      version:VERSION,
      strategy:plan.kind,
      pieces:analysis.total,
      unique:analysis.unique,
      repetitionRatio:+analysis.repetitionRatio.toFixed(3),
      dominantRatio:+analysis.dominantRatio.toFixed(3),
      grid:problem.grid,
      randomCm:+randomCm.toFixed(2),
      randomEvaluations:random.evaluations,
      randomInvalid:random.invalid,
      brkgaCm:brkgaCm==null?null:+brkgaCm.toFixed(2),
      brkgaEvaluations:brkga.evaluations,
      brkgaStopReasons:brkga.stopReasons,
      winner:winnerName,
      bestCm:+bestCm.toFixed(2),
      elapsedMs:+elapsedMs.toFixed(0)
    });
  }catch(e){
    console.error("[BixNest v3]",e);
    toast(`Auto Organizar: ${String(e?.message||e).slice(0,150)}`);
  }finally{
    running=false;
    showBusy(false);
  }
}

function install(){
  const btn=q("#autoNestTopBtn");
  if(!btn) return;

  // Override any previous legacy handler after the main Builder has loaded.
  btn.onclick=autoOrganize;
  btn.title="Auto Organizar";
  console.info(`[BixNest] ${VERSION} instalado`);
}

if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",()=>setTimeout(install,0));
}else{
  setTimeout(install,0);
}
})();