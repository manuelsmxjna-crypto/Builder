"use strict";
importScripts("./bitboards.js","./decoder.js","./brkga.js");

function rngFactory(seed){
  let x=(seed|0)||123456789;
  return ()=>{
    x^=x<<13;x^=x>>>17;x^=x<<5;
    return (x>>>0)/4294967296;
  };
}

function randomChromosome(len,rng){
  const c=new Float64Array(len);
  for(let i=0;i<len;i++) c[i]=rng();
  return c;
}

function runRandomSearch(msg,shapeMap){
  const ctx={
    items:msg.items,
    shapeMap,
    gw:msg.gw,
    gh:msg.gh,
    gap:msg.gap||0
  };
  const n=msg.items.length;
  const geneLen=n*2;
  const iterations=Math.max(1,msg.iterations|0);
  const rng=rngFactory(msg.seed||12345);

  let best=null,bestFit=Infinity,valid=0,invalid=0;
  const started=performance.now();

  for(let i=0;i<iterations;i++){
    const c=randomChromosome(geneLen,rng);
    const result=BixDecoder.decode(c,ctx);
    if(!result || !BixDecoder.validate(result,ctx)){
      invalid++;
      continue;
    }
    valid++;
    const fit=BixDecoder.fitness(result);
    if(fit<bestFit){
      bestFit=fit;
      best=result;
      self.postMessage({
        type:"incumbent",
        solver:"random",
        result,
        bestFit,
        evaluations:i+1,
        valid,
        invalid
      });
    }
  }

  return {
    best,
    evaluations:iterations,
    valid,
    invalid,
    elapsedMs:performance.now()-started
  };
}

self.onmessage=e=>{
  const msg=e.data||{};
  if(msg.type!=="run") return;

  try{
    const shapeMap=BixDecoder.buildShapeMap(msg.shapes,msg.gap||0);

    if(msg.solver==="random"){
      const stats=runRandomSearch(msg,shapeMap);
      self.postMessage({
        type:"done",
        solver:"random",
        result:stats.best,
        evaluations:stats.evaluations,
        valid:stats.valid,
        invalid:stats.invalid,
        elapsedMs:stats.elapsedMs
      });
      return;
    }

    const payload={...msg,shapeMap};
    delete payload.shapes;

    const stats=BixBRKGA.evolve(payload,data=>{
      self.postMessage({...data,solver:"brkga"});
    });

    self.postMessage({
      type:"done",
      solver:"brkga",
      result:stats.best,
      evaluations:stats.evaluations,
      generation:stats.generation,
      elapsedMs:stats.elapsedMs,
      stopReason:stats.stopReason,
      beatExternal:stats.beatExternal
    });
  }catch(err){
    self.postMessage({
      type:"error",
      solver:msg.solver||"unknown",
      error:String(err&&err.stack||err)
    });
  }
};
