
(function(g){
  "use strict";
  const D=g.BixDecoder;

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

  function seededChromosomes(items,allowRotate){
    const n=items.length,out=[];
    const make=(orderFn,rotFn)=>{
      const c=new Float64Array(n*2);
      const ranked=Array.from({length:n},(_,i)=>i).sort((a,b)=>orderFn(items[a],items[b],a,b));
      ranked.forEach((idx,rank)=>c[idx]=(rank+.5)/n);
      for(let i=0;i<n;i++) c[n+i]=rotFn?rotFn(items[i],i):.01;
      out.push(c);
    };

    make((a,b)=>(b.baseW*b.baseH)-(a.baseW*a.baseH));
    make((a,b)=>Math.max(b.baseW,b.baseH)-Math.max(a.baseW,a.baseH));
    make((a,b)=>b.baseW-a.baseW||b.baseH-a.baseH);
    make((a,b)=>b.baseH-a.baseH||b.baseW-a.baseW);

    // Duplicate-aware seeds: keep identical assets consecutive and alternate
    // opposite rotations. This explicitly exposes the 0°/180° pattern to evolution.
    make((a,b)=>String(a.groupKey).localeCompare(String(b.groupKey)) || (a.instance||0)-(b.instance||0),
      (it,i)=>((it.instance||0)%2===0)?.01:.51);
    if(allowRotate){
      make((a,b)=>String(a.groupKey).localeCompare(String(b.groupKey)) || (a.instance||0)-(b.instance||0),
        (it,i)=>((it.instance||0)%2===0)?.26:.76);
    }
    return out;
  }

  function evolve(payload,emit){
    const {
      items,shapeMap,gw,gh,gap,
      seed=12345,
      budgetMs=5000,
      populationSize:popIn,
      allowRotate=true,

      // Adaptive stopping controls
      externalTargetUsedH=null,
      minRuntimeMs=1400,
      noBeatStopMs=2200,
      stallMs=1100,
      meaningfulImprovementCells=1
    }=payload;

    const n=items.length;
    const ctx={items,shapeMap,gw,gh,gap};
    const decodeFn=payload.multiSheet?D.decodeMulti:D.decode;
    const validateFn=payload.multiSheet?D.validateMulti:D.validate;
    const fitnessFn=payload.multiSheet?D.fitnessMulti:D.fitness;
    const rng=rngFactory(seed);
    const popSize=popIn || (n<=15?90:n<=40?70:n<=80?52:40);
    const eliteCount=Math.max(2,Math.floor(popSize*.20));
    const mutantCount=Math.max(2,Math.floor(popSize*.12));
    const bias=.72;
    const geneLen=n*2;
    const started=performance.now();
    const deadline=started+budgetMs;

    let evaluations=0,generation=0,best=null,bestFit=Infinity;
    let lastMeaningfulImprovementAt=started;
    let beatExternalAt=null;
    let stopReason="budget";

    const externalTarget=Number.isFinite(externalTargetUsedH)
      ? Number(externalTargetUsedH)
      : null;

    function noteImprovement(result){
      const now=performance.now();

      // A change of >= meaningfulImprovementCells counts as real progress.
      if(!best || (best.usedH-result.usedH)>=meaningfulImprovementCells){
        lastMeaningfulImprovementAt=now;
      }

      if(externalTarget!=null && result.usedH<externalTarget && beatExternalAt==null){
        beatExternalAt=now;
      }
    }

    function evalChrom(c){
      const result=decodeFn(c,ctx);
      evaluations++;
      if(!result || !validateFn(result,ctx)) return {c,result:null,fit:Infinity};

      const fit=fitnessFn(result);
      if(fit<bestFit){
        noteImprovement(result);
        bestFit=fit;
        best=result;
        emit({
          type:"incumbent",
          result,
          bestFit,
          evaluations,
          generation,
          elapsedMs:performance.now()-started,
          beatExternal:externalTarget!=null ? result.usedH<externalTarget : null
        });
      }
      return {c,result,fit};
    }

    let population=[];
    for(const c of seededChromosomes(items,allowRotate)) population.push(evalChrom(c));
    while(population.length<popSize && performance.now()<deadline){
      population.push(evalChrom(randomChromosome(geneLen,rng)));
    }
    population.sort((a,b)=>a.fit-b.fit);

    while(performance.now()<deadline){
      generation++;
      population.sort((a,b)=>a.fit-b.fit);
      const next=population.slice(0,eliteCount);

      for(let m=0;m<mutantCount && next.length<popSize && performance.now()<deadline;m++){
        next.push(evalChrom(randomChromosome(geneLen,rng)));
      }

      while(next.length<popSize && performance.now()<deadline){
        const elite=population[Math.floor(rng()*eliteCount)];
        const nonElite=population[
          eliteCount+Math.floor(rng()*Math.max(1,population.length-eliteCount))
        ] || population.at(-1);

        const child=new Float64Array(geneLen);
        for(let gidx=0;gidx<geneLen;gidx++){
          child[gidx]=rng()<bias?elite.c[gidx]:nonElite.c[gidx];
        }

        if(rng()<.28){
          const mutations=1+Math.floor(rng()*Math.min(4,n));
          for(let k=0;k<mutations;k++){
            child[Math.floor(rng()*geneLen)]=rng();
          }
        }
        next.push(evalChrom(child));
      }

      population=next;
      const now=performance.now();
      const elapsed=now-started;

      if(generation%3===0){
        emit({
          type:"progress",
          generation,
          evaluations,
          best,
          result:best,
          elapsedMs:elapsed
        });
      }

      // Do not stop during warm-up.
      if(elapsed<minRuntimeMs) continue;

      // If BRKGA has not even beaten Random after a reasonable chance, stop.
      if(externalTarget!=null && (!best || best.usedH>=externalTarget) && elapsed>=noBeatStopMs){
        stopReason="did-not-beat-random";
        break;
      }

      // Once it has a competitive solution, stop when progress stalls.
      if(now-lastMeaningfulImprovementAt>=stallMs){
        stopReason="stalled";
        break;
      }
    }

    return {
      best,
      evaluations,
      generation,
      elapsedMs:performance.now()-started,
      stopReason,
      beatExternal:externalTarget!=null && !!best && best.usedH<externalTarget
    };
  }

  g.BixBRKGA={evolve};
})(self);
