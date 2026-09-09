(function(){
"use strict";

const VERSION="3.1.0-multi-sheet";
const WORKER_URL="./bixnest/worker.js";
const BRIDGE=window.BixNestBridge;
const STRATEGY=window.BixNestStrategy;

if(!BRIDGE) throw new Error("BixNestBridge no está disponible.");
if(!STRATEGY) throw new Error("BixNestStrategy no está disponible.");

const state=BRIDGE.getState();
const toast=BRIDGE.toast;
const nestGapValue=BRIDGE.nestGapValue;
const MIN_SHEET_HEIGHT=BRIDGE.MIN_SHEET_HEIGHT||30;
const MAX_SHEET_HEIGHT=BRIDGE.MAX_SHEET_HEIGHT;
const SHEET_WIDTH=BRIDGE.FIXED_SHEET_WIDTH_CM||62;
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

function allObjects(){
  return (state.sheets||[]).flatMap(s=>s.objects||[]);
}

function showBusy(show,label="Optimizando espacio…"){
  const overlay=q("#autoNestProcessingOverlay");
  if(overlay) overlay.classList.toggle("show",!!show);

  const sub=overlay?.querySelector(".autonest-processing-sub");
  if(sub && show) sub.textContent=label;

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

  const am=Number.isFinite(a.sheetCount)?a.sheetCount:1;
  const bm=Number.isFinite(b.sheetCount)?b.sheetCount:1;
  if(am!==bm) return am<bm;

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
      multiSheet:!!opts.multiSheet,
      populationSize:opts.populationSize||undefined,
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

async function buildProblem(plan,objects,maxHeight=MAX_SHEET_HEIGHT,options={}){
  const list=Array.isArray(objects)?objects:[];
  const count=list.length;
  const grid=plan.grid;
  const allowRotate=options.allowRotate ?? !!q("#allowRotate")?.checked;
  const gapCm=options.gapCm ?? nestGapValue();
  const gap=Math.max(0,Math.round(Math.max(0,gapCm)*grid));
  const margin=0;
  const printableW=SHEET_WIDTH;
  const printableH=maxHeight;
  const gw=Math.max(1,Math.floor(printableW*grid));
  const gh=Math.max(1,Math.floor(printableH*grid));

  const groupSeen=new Map();
  const items=[];
  const shapeDefs=new Map();

  for(let i=0;i<list.length;i++){
    const o=list[i];
    if(!options.rectangular) ensureRotationModel(o);

    const groupKey=STRATEGY.groupKeyForObject(o);
    const instance=groupSeen.get(groupKey)||0;
    groupSeen.set(groupKey,instance+1);

    const item={
      id:o.id,
      type:o.type,
      assetId:o.assetId||null,
      baseW:o.baseW||o.w,
      baseH:o.baseH||o.h,
      flipX:!!o.flipX,
      flipY:!!o.flipY,
      groupKey,
      instance
    };

    const qs=allowRotate?[0,1,2,3]:[0];
    for(const qtr of qs){
      let shape;
      if(options.rectangular){
        const rotated=qtr%2===1;
        const w=Math.max(1,Math.ceil((rotated?item.baseH:item.baseW)*grid));
        const h=Math.max(1,Math.ceil((rotated?item.baseW:item.baseH)*grid));
        const key=`rect:${w}x${h}`;
        shape={key,q:qtr,w,h,occupied:w*h,data:new Uint8Array(w*h).fill(1)};
      }else{
        shape=await getAdaptiveNestMask(item,qtr,grid);
      }
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

    if(i%20===0){
      if(count>100){
        toast(`Preparando diseños… ${Math.min(i+1,count)}/${count}`);
      }
      await new Promise(r=>setTimeout(r,0));
    }
  }

  const shapes=[];
  for(const def of shapeDefs.values()){
    const words=Math.ceil(def.w/32);
    const rows=new Uint32Array(words*def.h);

    for(let y=0;y<def.h;y++){
      for(let x=0;x<def.w;x++){
        if(!def.mask[y*def.w+x]) continue;
        rows[y*words+(x>>>5)]|=(1<<(x&31))>>>0;
      }
    }

    shapes.push({...def,words,rows});
  }

  return {items,shapes,grid,gap,gw,gh,margin,allowRotate,count};
}

function positionObjectFromPlacement(o,p,problem){
  ensureRotationModel(o);

  o.w=o.baseW||o.w;
  o.h=o.baseH||o.h;
  o.visualW=o.w;
  o.visualH=o.h;
  o.aspectRatio=o.w/Math.max(.0001,o.h);

  const qtr=Number.isFinite(p.q)?p.q:Math.round((p.rot||0)/90);
  o.rot=((qtr*90)%360+360)%360;

  const left=p.x/problem.grid;
  const top=p.y/problem.grid;
  const pw=p.w/problem.grid;
  const ph=p.h/problem.grid;
  const cx=left+pw/2;
  const cy=top+ph/2;

  o.x=cx-o.w/2;
  o.y=cy-o.h/2;
}

function applyCurrentResult(result,problem,{skipHistory=false}={}){
  const byId=new Map(result.placed.map(p=>[p.id,p]));

  if(!skipHistory) pushHistory();

  for(const o of state.objects){
    const p=byId.get(o.id);
    if(p) positionObjectFromPlacement(o,p,problem);
  }

  recalcActiveSheetHeight();
  updateDiagnostics();
  renderAll();
  setTimeout(fitViewport,20);
}

function applyAllSheetsResult(result,problem,sourceObjects){
  const byId=new Map(sourceObjects.map(o=>[o.id,o]));
  const placedById=new Map(result.placed.map(p=>[p.id,p]));

  pushHistory();

  const newSheets=Array.from({length:result.sheetCount},(_,i)=>({
    id:`gs${i+1}`,
    name:`Gang Sheet ${i+1}`,
    sheet:{w:SHEET_WIDTH,h:MIN_SHEET_HEIGHT,margin:0},
    objects:[]
  }));

  for(const p of result.placed){
    const o=byId.get(p.id);
    if(!o) continue;

    positionObjectFromPlacement(o,p,problem);
    newSheets[p.sheetIndex].objects.push(o);
  }

  // Height becomes the actual used material on every resulting sheet,
  // never more than the production maximum.
  for(let i=0;i<newSheets.length;i++){
    const hCells=result.sheetHeights?.[i]||0;
    const hCm=Math.max(MIN_SHEET_HEIGHT,Math.ceil((hCells/problem.grid)*10)/10);
    newSheets[i].sheet.h=Math.min(MAX_SHEET_HEIGHT,hCm);
  }

  state.sheets=newSheets;
  state.activeSheetIndex=0;
  state.nextSheetId=newSheets.length+1;
  state.selectedId=null;
  state.selectedIds=[];

  updateDiagnostics();
  renderAll();
  setTimeout(fitViewport,20);
}

async function runRandom(problem,plan,{multiSheet=false}={}){
  const count=Math.max(1,Math.min(plan.randomWorkers||1,navigator.hardwareConcurrency||4,6));
  const total=Math.max(1,plan.randomIterations||1);
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
      multiSheet,
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

async function runBRKGA(problem,plan,randomBest,{multiSheet=false}={}){
  if(!plan.brkgaWorkers || !plan.brkgaBudgetMs){
    return {best:null,evaluations:0,elapsedMs:0,generation:0,stopReasons:["skipped"]};
  }

  const count=Math.max(1,Math.min(plan.brkgaWorkers,navigator.hardwareConcurrency||4,4));

  let best=null;
  let evaluations=0;
  let elapsedMs=0;
  let generation=0;
  const stopReasons=[];

  const jobs=Array.from({length:count},(_,i)=>
    runWorker(problem,{
      solver:"brkga",
      multiSheet,
      populationSize:plan.populationSize,
      seed:0xB17B000+i*104729+problem.count*131,
      budgetMs:plan.brkgaBudgetMs,

      // For multi-sheet search we intentionally do not use the old "beat Random by
      // usedH" early stop because the primary metric is sheet count, not only height.
      externalTargetUsedH:multiSheet?null:(randomBest?.usedH ?? null),
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

async function optimize(objects,{multiSheet=false,problemOptions={},quiet=false}={}){
  if(!problemOptions.rectangular){
    for(const o of objects) ensureRotationModel(o);
  }

  const analysis=STRATEGY.analyze(objects);
  const plan=multiSheet
    ? STRATEGY.planAllSheets(analysis)
    : STRATEGY.plan(analysis);

  const problem=await buildProblem(plan,objects,MAX_SHEET_HEIGHT,problemOptions);

  if(!quiet) toast(multiSheet
      ? `Organizando ${objects.length} diseños entre todas las hojas…`
      : "Buscando una buena distribución…"
    );

  const random=await runRandom(problem,plan,{multiSheet});
  if(!random.best){
    throw new Error("No se pudo construir una distribución válida.");
  }

  let brkga={best:null,evaluations:0,elapsedMs:0,stopReasons:["skipped"]};

  if(plan.brkgaWorkers && plan.brkgaBudgetMs){
    if(!quiet) toast("Optimizando espacio…");
    brkga=await runBRKGA(problem,plan,random.best,{multiSheet});
  }

  let winner=random.best;
  let winnerName="Random";
  if(brkga.best && better(brkga.best,winner)){
    winner=brkga.best;
    winnerName="BRKGA";
  }

  return {analysis,plan,problem,random,brkga,winner,winnerName};
}

async function autoOrganizeCurrent({skipHistory=false,quiet=false}={}){
  const objects=state.objects||[];
  if(!objects.length) return toast("No hay diseños para organizar.");

  const t0=performance.now();
  const result=await optimize(objects,{multiSheet:false,quiet});
  applyCurrentResult(result.winner,result.problem,{skipHistory});

  const bestCm=result.winner.usedH/result.problem.grid;
  if(!quiet) toast(`Auto Organizar listo · ${bestCm.toFixed(1)} cm`);

  console.info("[BixNest v3.1 current]",{
    version:VERSION,
    strategy:result.plan.kind,
    pieces:objects.length,
    winner:result.winnerName,
    bestCm:+bestCm.toFixed(2),
    elapsedMs:+(performance.now()-t0).toFixed(0)
  });
}

async function organizeCurrent(options={}){
  if(running) return false;
  const objects=state.objects||[];
  if(!objects.length) return false;
  running=true;
  if(options.showBusy!==false) showBusy(true,"Optimizando espacio…");
  await paint();
  try{
    await autoOrganizeCurrent(options);
    return true;
  }catch(e){
    console.error("[BixNest v3.1 programmatic]",e);
    if(!options.quiet) toast(`Auto Organizar: ${String(e?.message||e).slice(0,160)}`);
    return false;
  }finally{
    running=false;
    if(options.showBusy!==false) showBusy(false);
  }
}

async function quoteRectangles(rows,{gapCm=0,allowRotate=true}={}){
  const objects=[];
  for(const row of rows||[]){
    const qty=Math.max(1,Math.round(Number(row.qty)||1));
    const w=Math.max(.1,Number(row.w)||.1);
    const h=Math.max(.1,Number(row.h)||.1);
    if(Math.min(w,h)>SHEET_WIDTH || Math.max(w,h)>MAX_SHEET_HEIGHT){
      throw new Error(`${row.name||"Medida"}: ${w.toFixed(1)} × ${h.toFixed(1)} cm no cabe en una hoja de ${SHEET_WIDTH} cm.`);
    }
    for(let copy=1;copy<=qty;copy++) objects.push({
      id:`quote:${row.id}:${copy}`,
      type:"rect",assetId:row.id,baseW:w,baseH:h,w,h,
      name:row.name,color:row.color,copy
    });
  }
  if(!objects.length) throw new Error("Agrega al menos una medida.");
  const result=await optimize(objects,{
    multiSheet:true,quiet:true,
    problemOptions:{rectangular:true,gapCm,allowRotate}
  });
  const byId=new Map(objects.map(o=>[o.id,o]));
  const sheets=Array.from({length:result.winner.sheetCount},(_,sheetIndex)=>({
    placed:[],height:(result.winner.sheetHeights?.[sheetIndex]||0)/result.problem.grid
  }));
  for(const p of result.winner.placed){
    const source=byId.get(p.id);
    sheets[p.sheetIndex].placed.push({
      ...source,
      x:p.x/result.problem.grid,y:p.y/result.problem.grid,
      w:p.w/result.problem.grid,h:p.h/result.problem.grid,
      rotated:(p.q%2)===1
    });
  }
  return {
    sheets,
    totalCm:sheets.reduce((sum,s)=>sum+Math.ceil(s.height-1e-9),0),
    engine:VERSION
  };
}

async function autoOrganizeAll(){
  const objects=allObjects();
  if(!objects.length) return toast("No hay diseños para organizar.");

  const oldSheetCount=state.sheets.length;
  const t0=performance.now();

  const result=await optimize(objects,{multiSheet:true});
  applyAllSheetsResult(result.winner,result.problem,objects);

  const newSheetCount=result.winner.sheetCount;
  const totalCm=(result.winner.usedH/result.problem.grid);

  const reduced=newSheetCount<oldSheetCount
    ? ` · ${oldSheetCount} → ${newSheetCount} hojas`
    : ` · ${newSheetCount} hoja${newSheetCount===1?"":"s"}`;

  toast(`Todas las hojas organizadas${reduced}`);

  console.info("[BixNest v3.1 all sheets]",{
    version:VERSION,
    strategy:result.plan.kind,
    pieces:objects.length,
    oldSheetCount,
    newSheetCount,
    totalLinearCm:+totalCm.toFixed(2),
    winner:result.winnerName,
    randomSheets:result.random.best?.sheetCount,
    brkgaSheets:result.brkga.best?.sheetCount??null,
    elapsedMs:+(performance.now()-t0).toFixed(0)
  });
}

function ensureScopeModal(){
  let modal=document.getElementById("bixnestScopeModal");
  if(modal) return modal;

  modal=document.createElement("div");
  modal.id="bixnestScopeModal";
  modal.style.cssText=[
    "position:fixed","inset:0","z-index:2147482500",
    "background:rgba(15,23,42,.48)",
    "display:none","align-items:center","justify-content:center",
    "padding:18px"
  ].join(";");

  modal.innerHTML=`
    <div style="width:min(460px,94vw);background:#fff;border-radius:16px;box-shadow:0 24px 80px rgba(0,0,0,.28);padding:18px;color:#0f172a;font:13px/1.45 system-ui">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:12px">
        <div>
          <b style="font-size:17px">Auto Organizar</b>
          <div style="color:#64748b;margin-top:2px">¿Qué quieres optimizar?</div>
        </div>
        <button type="button" data-close style="border:0;background:transparent;font-size:23px;cursor:pointer;color:#64748b">×</button>
      </div>

      <button type="button" data-scope="current" style="width:100%;text-align:left;border:1px solid #dbe2ea;background:#fff;border-radius:12px;padding:13px 14px;cursor:pointer;margin-bottom:9px">
        <b style="display:block;font-size:14px">Hoja actual</b>
        <span style="display:block;color:#64748b;margin-top:3px">Optimiza únicamente la Gang Sheet que estás viendo.</span>
      </button>

      <button type="button" data-scope="all" style="width:100%;text-align:left;border:1px solid #93c5fd;background:#eff6ff;border-radius:12px;padding:13px 14px;cursor:pointer">
        <b style="display:block;font-size:14px;color:#1d4ed8">Todas las hojas</b>
        <span data-all-description style="display:block;color:#475569;margin-top:3px">Junta todos los diseños, los reorganiza y reduce el número de Gang Sheets si es posible.</span>
      </button>

      <div style="margin-top:11px;color:#64748b;font-size:11px">
        “Todas las hojas” puede mover diseños de una Gang Sheet a otra.
      </div>
    </div>
  `;

  document.body.appendChild(modal);
  return modal;
}

function chooseScope(){
  if((state.sheets?.length||0)<=1) return Promise.resolve("current");

  const modal=ensureScopeModal();
  const total=allObjects().length;
  const active=(state.objects||[]).length;
  const desc=modal.querySelector("[data-all-description]");
  if(desc){
    desc.textContent=`Reorganiza ${total} diseños de ${state.sheets.length} hojas y reduce la cantidad de Gang Sheets si es posible.`;
  }

  modal.style.display="flex";

  return new Promise(resolve=>{
    const finish=value=>{
      modal.style.display="none";
      modal.querySelectorAll("button").forEach(b=>b.onclick=null);
      resolve(value);
    };

    modal.querySelector("[data-close]").onclick=()=>finish(null);
    modal.onclick=e=>{ if(e.target===modal) finish(null); };
    modal.querySelector('[data-scope="current"]').onclick=()=>finish("current");
    modal.querySelector('[data-scope="all"]').onclick=()=>finish("all");
  });
}

async function autoOrganize(){
  if(running) return toast("Ya se está organizando…");

  const total=allObjects().length;
  if(!total) return toast("No hay diseños para organizar.");

  const scope=await chooseScope();
  if(!scope) return;

  running=true;
  showBusy(true,scope==="all"?"Reorganizando todas las Gang Sheets…":"Optimizando espacio…");
  await paint();

  try{
    if(scope==="all") await autoOrganizeAll();
    else await autoOrganizeCurrent();
  }catch(e){
    console.error("[BixNest v3.1]",e);
    toast(`Auto Organizar: ${String(e?.message||e).slice(0,160)}`);
  }finally{
    running=false;
    showBusy(false);
  }
}

function install(){
  const btn=q("#autoNestTopBtn");
  if(!btn) return;

  btn.onclick=autoOrganize;
  btn.title="Auto Organizar";
  console.info(`[BixNest] ${VERSION} instalado`);
}

window.BixNestAPI={organizeCurrent,quoteRectangles,version:VERSION};

if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",()=>setTimeout(install,0));
}else{
  setTimeout(install,0);
}
})();
