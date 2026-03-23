const DEFAULTS={adminPasscode:"4822",speedupFactor:0.80,resumeSlowerByMs:400,consecutiveMissesForBlock:2,recoveryCorrectTrials:2,qualifyingBlockGapMs:250,noResponseTimeoutMs:20000,wrongWindowSize:5,wrongThresholdStop:4,maxTrialCount:180,minDurationMs:45000,maxDurationMs:180000,initialUnusedCalibrationTrials:1,initialMeasuredCalibrationTrials:20,initialPacedPercent:0.70,calibrationStopErrors:5,calibrationStopSlowMs:20000,cpsBestMs:2000,cpsWorstMs:5000,deviceBenchmarkEnabled:0};
const ADMIN_FIELDS=[["speedupFactor","Speedup factor","number"],["resumeSlowerByMs","Resume slower after block (ms)","number"],["consecutiveMissesForBlock","Consecutive misses for block","number"],["recoveryCorrectTrials","Recovery correct trials","number"],["qualifyingBlockGapMs","Gap between consecutive blocks to end (ms)","number"],["noResponseTimeoutMs","Time to end test if no response (ms)","number"],["wrongWindowSize","Wrong-answer window size","number"],["wrongThresholdStop","Wrong answers threshold","number"],["maxTrialCount","Maximum paced trial count","number"],["minDurationMs","Minimum paced duration (ms)","number"],["maxDurationMs","Maximum paced duration (ms)","number"],["initialUnusedCalibrationTrials","Unused self-paced trials","number"],["initialMeasuredCalibrationTrials","Measured self-paced trials","number"],["initialPacedPercent","Initial paced % of calibration average","number"],["calibrationStopErrors","Calibration stop after errors >","number"],["calibrationStopSlowMs","Calibration stop if any RT exceeds (ms)","number"],["cpsBestMs","CPS best ms (score 100)","number"],["cpsWorstMs","CPS worst ms (score 0)","number"],["deviceBenchmarkEnabled","Run device benchmark before test (0/1)","number"],["adminPasscode","Admin passcode","password"]];
let settings=loadSettings();
const SHAPES=["square","triangle_down","diamond","pentagon","hexagon","triangle_up"];
const SAMN_PERELLI=[[7,"Full alert, wide awake"],[6,"Very lively, responsive, but not at peak"],[5,"Okay, about normal"],[4,"Less than sharp, let down"],[3,"Feeling dull, losing focus"],[2,"Very difficult to concentrate, groggy"],[1,"Unable to function, ready to drop"]];
const DOT_PATTERNS={1:[["dot",50,50]],2:[["dot",34,50],["dot",66,50]],3:[["dot",50,30],["dot",50,50],["dot",50,70]],4:[["dot",34,34],["dot",66,34],["dot",34,66],["dot",66,66]],5:[["dot",34,34],["dot",66,34],["dot",50,50],["dot",34,66],["dot",66,66]],6:[["dot",34,25],["dot",66,25],["dot",34,50],["dot",66,50],["dot",34,75],["dot",66,75]]};
const LINE_PATTERNS={1:[["v",50,50]],2:[["v",28,50],["v",72,50]],3:[["v",20,50],["v",50,50],["v",80,50]],4:[["v",28,30],["v",72,30],["v",28,70],["v",72,70]],5:[["v",28,28],["v",72,28],["v",50,50],["v",28,72],["v",72,72]],6:[["v",28,22],["v",72,22],["v",28,50],["v",72,50],["v",28,78],["v",72,78]]};
const state={phase:"idle",duration:null,blockDuration:null,current:null,previous:null,unresolvedStreak:0,overloads:[],recoveries:[],recoveryCorrectCompleted:0,history:JSON.parse(localStorage.getItem("blockrate_v25_corrected_consolidated_history")||"[]"),totalTrials:0,trialTimer:null,absoluteNoResponseTimer:null,lastFiveAnswers:[],samnPerelli:null,subjectId:null,calibrationTrialIndex:0,calibrationRTs:[],calibrationErrors:0,trialOpenedAt:null,geo:null,benchmark:null,lastResult:null};
const $=id=>document.getElementById(id),combinedGrid=$("combinedGrid"),rateOut=$("rateOut"),blocksOut=$("blocksOut"),recoveryOut=$("recoveryOut"),wrongOut=$("wrongOut"),fatigueOut=$("fatigueOut"),cpsOut=$("cpsOut"),statusLine=$("statusLine"),resultBox=$("resultBox"),phaseLabel=$("phaseLabel"),modeLabel=$("modeLabel"),infoPanel=$("infoPanel"),resultsCpsChart=$("resultsCpsChart"),resultsSpfChart=$("resultsSpfChart"),adminCpsChart=$("adminCpsChart"),adminSpfChart=$("adminSpfChart"); let deferredPrompt=null;
function loadSettings(){const s=JSON.parse(localStorage.getItem("blockrate_v25_corrected_consolidated_settings")||"null");return s?{...DEFAULTS,...s}:{...DEFAULTS}}
function saveSettings(){localStorage.setItem("blockrate_v25_corrected_consolidated_settings",JSON.stringify(settings))}
function computeCPS(avgMs){const best=Number(settings.cpsBestMs),worst=Number(settings.cpsWorstMs);const span=worst-best;if(!isFinite(best)||!isFinite(worst)||span<=0)return 0;return Math.max(0,Math.min(100,((worst-avgMs)/span)*100))}
function updateCPSDisplay(avg){cpsOut.textContent=avg!=null?computeCPS(avg).toFixed(0):"—"}
function setStatus(m){statusLine.textContent=m}
function clearTimer(){if(state.trialTimer)clearTimeout(state.trialTimer);state.trialTimer=null}
function clearNoResponseTimer(){if(state.absoluteNoResponseTimer)clearTimeout(state.absoluteNoResponseTimer);state.absoluteNoResponseTimer=null}
function armNoResponseTimer(){clearNoResponseTimer();state.absoluteNoResponseTimer=setTimeout(()=>{state.endReason=`No response for more than ${settings.noResponseTimeoutMs} ms`;finish()},settings.noResponseTimeoutMs)}
function noteAnyResponse(){armNoResponseTimer()}

function setTestingQuiet(isQuiet){
  if(infoPanel) infoPanel.style.display=isQuiet?"none":"grid";
  if(statusLine) statusLine.style.display=isQuiet?"none":"block";
  if(resultBox) resultBox.style.display=isQuiet?"none":"block";
}
async function captureGeoAndAddress(){
  const now=new Date();
  const base={local_time:now.toLocaleString(),gmt_time:now.toUTCString(),date_iso:now.toISOString()};
  if(!navigator.geolocation){state.geo={...base,status:"unavailable"};return;}
  const pos=await new Promise(resolve=>{
    navigator.geolocation.getCurrentPosition(resolve,()=>resolve(null),{enableHighAccuracy:true,timeout:7000,maximumAge:0});
  });
  if(!pos){state.geo={...base,status:"denied_or_failed"};return;}
  state.geo={...base,status:"ok",latitude:pos.coords.latitude,longitude:pos.coords.longitude,accuracy_m:pos.coords.accuracy};
  try{
    const url=`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(pos.coords.latitude)}&lon=${encodeURIComponent(pos.coords.longitude)}`;
    const r=await fetch(url,{headers:{"Accept":"application/json"}});
    const data=await r.json();
    state.geo.address=data.display_name||"";
  }catch(e){
    state.geo.address_error="reverse_geocode_failed";
  }
}
async function runDeviceBenchmark(){
  const enabled=Number(settings.deviceBenchmarkEnabled||0)===1;
  if(!enabled){state.benchmark=null;return;}
  const samples=[];
  let last=performance.now();
  await new Promise(resolve=>{
    let n=0;
    function step(ts){
      samples.push(ts-last); last=ts; n+=1;
      if(n<30) requestAnimationFrame(step); else resolve();
    }
    requestAnimationFrame(step);
  });
  const usable=samples.slice(1);
  const avg=usable.reduce((a,b)=>a+b,0)/Math.max(1,usable.length);
  const max=Math.max(...usable);
  const min=Math.min(...usable);
  state.benchmark={enabled:true,avgFrameMs:avg,minFrameMs:min,maxFrameMs:max,samples:usable.length};
}
function drawSimpleLineChart(canvas, values, label){
  if(!canvas) return;
  const ctx=canvas.getContext("2d");
  ctx.clearRect(0,0,canvas.width,canvas.height);
  ctx.fillStyle="#d7e7f8"; ctx.font="14px sans-serif"; ctx.fillText(label,10,18);
  ctx.strokeStyle="#7fd7ff"; ctx.lineWidth=2;
  if(!values.length){ctx.fillStyle="#d7e7f8"; ctx.fillText("No data yet",10,40); return;}
  const max=Math.max(...values), min=Math.min(...values);
  const span=(max-min)||1;
  ctx.beginPath();
  values.forEach((v,i)=>{
    const x=12+i*((canvas.width-24)/Math.max(1,values.length-1));
    const y=canvas.height-16-((v-min)/span)*(canvas.height-40);
    if(i===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
  });
  ctx.stroke();
}
function renderHistoryGraphs(){
  const hist=state.history||[];
  const cpsVals=hist.map(x=>x.cognitivePerformanceScore).filter(v=>v!=null);
  const spfVals=hist.map(x=>x.samnPerelli?x.samnPerelli.score:null).filter(v=>v!=null);
  drawSimpleLineChart(resultsCpsChart,cpsVals.slice(-20),"CPS history");
  drawSimpleLineChart(resultsSpfChart,spfVals.slice(-20),"S-PF history");
  drawSimpleLineChart(adminCpsChart,cpsVals.slice(-20),"CPS history");
  drawSimpleLineChart(adminSpfChart,spfVals.slice(-20),"S-PF history");
  const note=state.benchmark&&state.benchmark.enabled?`Device benchmark: avg frame ${state.benchmark.avgFrameMs.toFixed(2)} ms`:"Device benchmark off";
  const rn=$("resultsNote"), an=$("adminBenchmarkNote");
  if(rn) rn.textContent=note;
  if(an) an.textContent=note;
}

function subjectKey(id){return id==="0"?"Guest":id}
function shapeSvg(shapeId,pattern=null,size="normal"){const svgClass=size==="mini"?"miniShapeSvg":"shapeSvg";const holderClass=size==="mini"?"miniShapeHolder":"shapeHolder";let shape="";const c='class="shapeStroke"';if(shapeId==="square")shape=`<rect x="18" y="18" width="64" height="64" ${c}/>`;if(shapeId==="triangle_down")shape=`<polygon points="50,85 84,18 16,18" ${c}/>`;if(shapeId==="diamond")shape=`<polygon points="50,12 86,50 50,88 14,50" ${c}/>`;if(shapeId==="pentagon")shape=`<polygon points="50,10 85,36 72,84 28,84 15,36" ${c}/>`;if(shapeId==="hexagon")shape=`<polygon points="28,18 72,18 88,50 72,82 28,82 12,50" ${c}/>`;if(shapeId==="triangle_up")shape=`<polygon points="50,15 84,82 16,82" ${c}/>`;let marks="";if(pattern){for(const [k,x,y] of pattern){if(k==="dot")marks+=`<circle cx="${x}" cy="${y}" r="6.8" fill="var(--text)"/>`;if(k==="v")marks+=`<rect x="${x-5}" y="${y-12}" width="10" height="24" fill="var(--text)"/>`}}return `<div class="${holderClass}"><svg class="${svgClass}" viewBox="0 0 100 100">${shape}${marks}</svg></div>`}
function patternSvg(pattern,size="normal"){const svgClass=size==="mini"?"miniShapeSvg":"shapeSvg";const holderClass=size==="mini"?"miniShapeHolder":"shapeHolder";return `<div class="${holderClass}"><svg class="${svgClass}" viewBox="0 0 100 100">${pattern.map(([k,x,y])=>k==="dot"?`<circle cx="${x}" cy="${y}" r="6.8" fill="var(--text)"/>`:`<rect x="${x-5}" y="${y-12}" width="10" height="24" fill="var(--text)"/>`).join("")}</svg></div>`}
function renderRefresher(){const w=$("refresherMatchBox");w.innerHTML="";for(let i=1;i<=6;i++){const d=document.createElement("div");d.className="matchCard";d.innerHTML=`<div style="position:absolute;top:8px;left:10px;font-size:12px;color:var(--muted)">${i}</div><div class="matchInner"><div><div class="miniLabel">dots</div>${patternSvg(DOT_PATTERNS[i],"mini")}</div><div style="font-size:18px;color:var(--muted);text-align:center">→</div><div><div class="miniLabel">lines</div>${patternSvg(LINE_PATTERNS[i],"mini")}</div></div>`;w.appendChild(d)}}

function clearCurrentSession(){
  clearTimer();
  clearNoResponseTimer();
  state.phase="idle";
  state.duration=null;
  state.blockDuration=null;
  state.current=null;
  state.previous=null;
  state.unresolvedStreak=0;
  state.overloads=[];
  state.recoveries=[];
  state.recoveryCorrectCompleted=0;
  state.totalTrials=0;
  state.endReason="";
  state.lastFiveAnswers=[];
  state.calibrationTrialIndex=0;
  state.calibrationRTs=[];
  state.calibrationErrors=0;
  state.geo=null;
  state.benchmark=null;
  updateCPSDisplay(null);
  updateMetrics();
  combinedGrid.innerHTML="";
  setTestingQuiet(false);
}

function showResultsPage(text){
  const box = $("resultsPageBox");
  if(box) box.textContent = text;
  showOnly("resultsOverlay");
  renderHistoryGraphs();
}

function showOnly(overlayId){
  ["subjectOverlay","refresherOverlay","fatigueOverlay","resultsOverlay","adminOverlay"].forEach(id=>{
    const el=$(id);
    if(!el) return;
    if(id===overlayId) el.classList.remove("hidden");
    else el.classList.add("hidden");
  });
}
function goToStartPage(){
  clearCurrentSession();
  resultBox.textContent="V25 consolidated build active.";
  setStatus("Returned to start page");
  showOnly("subjectOverlay");
}
function startOverFlow(){
  clearCurrentSession();
  state.subjectId=null;
  state.samnPerelli=null;
  fatigueOut.textContent="—";
  $("subjectIdInput").value="";
  resultBox.textContent="Session cleared. Start over from subject ID.";setTestingQuiet(false);
  setStatus("Start over");
  showOnly("subjectOverlay");
}

function renderFatigueChecklist(){const f=$("fatigueList");f.innerHTML="";for(const [score,label] of SAMN_PERELLI){const b=document.createElement("button");b.className="fatigueItem";b.textContent=`${score}. ${label}`;b.onclick=()=>{state.samnPerelli={score,label};fatigueOut.textContent=String(score);$("fatigueOverlay").classList.add("hidden");resultBox.textContent=`Samn–Perelli fatigue rating selected: ${score} — ${label}`;setStatus("Fatigue rating recorded")};f.appendChild(b)}}
function renderAdmin(){const w=$("adminSettings");w.innerHTML="";for(const [k,l,t] of ADMIN_FIELDS){const r=document.createElement("div");r.className="row";r.innerHTML=`<label style="font-size:14px">${l}<div class="hint">${k}</div></label><input id="adm_${k}" type="${t}" value="${settings[k]}">`;w.appendChild(r)}renderHistoryGraphs()}
function readAdmin(){for(const [k,_,t] of ADMIN_FIELDS){const el=$("adm_"+k);settings[k]=t==="number"?Number(el.value):el.value}}
function randInt(min,max){return Math.floor(Math.random()*(max-min+1))+min}
function clamp(v,lo,hi){return Math.min(hi,Math.max(lo,v))}
function mean(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0}
function shuffle(arr){const a=[...arr];for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a}
function validateTrial(t){const m=t.upperItems.filter(x=>x.count===t.targetCount).length;if(m!==1)return false;const uc=t.upperShapes.filter(s=>s===t.correctShapeId).length,lc=t.lowerShapes.filter(s=>s===t.correctShapeId).length;if(uc!==1||lc!==1)return false;const idx=t.upperShapes.findIndex(s=>s===t.correctShapeId);return idx>=0&&t.upperItems[idx].count===t.targetCount}
function makeTrial(kind){for(let attempt=0;attempt<200;attempt++){const upperShapes=shuffle(SHAPES),lowerShapes=shuffle(SHAPES),family=Math.random()<0.5?"dotsToLines":"linesToDots",targetCount=randInt(1,6),correctUpperIndex=randInt(0,5),correctShapeId=upperShapes[correctUpperIndex],counts=shuffle([1,2,3,4,5,6]),upperItems=counts.map(c=>({count:c,pattern:family==="dotsToLines"?LINE_PATTERNS[c]:DOT_PATTERNS[c]}));const existingIndex=upperItems.findIndex(x=>x.count===targetCount);[upperItems[correctUpperIndex],upperItems[existingIndex]]=[upperItems[existingIndex],upperItems[correctUpperIndex]];const targetPattern=family==="dotsToLines"?DOT_PATTERNS[targetCount]:LINE_PATTERNS[targetCount];const t={kind,upperShapes,lowerShapes,targetPattern,upperItems,correctShapeId,targetCount,resolved:false};if(validateTrial(t))return t}throw new Error("Unable to generate valid trial")}
function renderCombinedGrid(trial){combinedGrid.innerHTML="";const slots=new Array(16).fill(null).map(()=>({type:"empty"})),positions=shuffle([...Array(16).keys()]),probePos=positions[0],upperPos=positions.slice(1,7),lowerPos=positions.slice(7,13);slots[probePos]={type:"probe",pattern:trial.targetPattern};for(let i=0;i<6;i++)slots[upperPos[i]]={type:"stimulus",shape:trial.upperShapes[i],pattern:trial.upperItems[i].pattern};for(let i=0;i<6;i++)slots[lowerPos[i]]={type:"answer",shape:trial.lowerShapes[i],index:i};slots.forEach(slot=>{const el=document.createElement("div");el.className="slot";if(slot.type==="probe"){el.classList.add("probe");el.innerHTML=`<div class="probeTag">TARGET</div>${patternSvg(slot.pattern)}`}else if(slot.type==="stimulus"){el.innerHTML=shapeSvg(slot.shape,slot.pattern)}else if(slot.type==="answer"){el.classList.add("answer");el.innerHTML=shapeSvg(slot.shape,null);el.onclick=()=>handleTap(slot.index)}combinedGrid.appendChild(el)})}
function updateMetrics(){rateOut.textContent=state.duration?`${(1000/state.duration).toFixed(2)} Hz`:"—";blocksOut.textContent=String(state.overloads.length);recoveryOut.textContent=String(state.recoveries.length);wrongOut.textContent=String(state.lastFiveAnswers.filter(v=>v===false).length+state.calibrationErrors);fatigueOut.textContent=state.samnPerelli?String(state.samnPerelli.score):"—"}
function openTrial(kind){clearTimer();state.previous=state.current;state.current=makeTrial(kind);state.trialOpenedAt=performance.now();renderCombinedGrid(state.current);updateMetrics();if(kind==="calibration"){const idx=state.calibrationTrialIndex+1,total=settings.initialUnusedCalibrationTrials+settings.initialMeasuredCalibrationTrials;phaseLabel.textContent=`Calibration ${idx}/${total}`;setStatus(idx<=settings.initialUnusedCalibrationTrials?"Unused self-paced trial — waiting for response":"Measured self-paced trial — waiting for response")}else if(kind==="paced"){phaseLabel.textContent=`Paced · ${Math.round(state.duration)} ms`;setStatus("Machine-paced");state.trialTimer=setTimeout(onPacedFrameEnd,state.duration)}else if(kind==="recovery"){phaseLabel.textContent=`Recovery ${state.recoveryCorrectCompleted+1}/${settings.recoveryCorrectTrials}`;setStatus("Self-paced recovery — waiting for response")}else if(kind==="terminal_recovery"){phaseLabel.textContent=`Final recovery ${state.recoveryCorrectCompleted+1}/${settings.recoveryCorrectTrials}`;setStatus("Self-paced final recovery — waiting for response")}}
function trialMatches(trial,index){return trial&&trial.lowerShapes[index]===trial.correctShapeId}
function failCalibrationAndRetest(reason){clearTimer();clearNoResponseTimer();state.phase="finished";state.endReason=reason+" Please retest.";resultBox.textContent=`Calibration failed.
${state.endReason}`;setStatus("Retest required")}
function finishCalibration(){const avg=mean(state.calibrationRTs),pacedStart=clamp(avg*settings.initialPacedPercent,settings.minDurationMs,settings.maxDurationMs);state.duration=pacedStart;state.phase="paced";setStatus(`Machine-paced start: ${pacedStart.toFixed(1)} ms`);openTrial("paced")}
function recordAnswer(ok){state.lastFiveAnswers.push(ok);if(state.lastFiveAnswers.length>settings.wrongWindowSize)state.lastFiveAnswers.shift();updateMetrics();const wc=state.lastFiveAnswers.filter(v=>v===false).length;if(state.lastFiveAnswers.length===settings.wrongWindowSize&&wc>settings.wrongThresholdStop){clearTimer();clearNoResponseTimer();state.phase="finished";state.endReason=`More than ${settings.wrongThresholdStop} wrong answers out of the last ${settings.wrongWindowSize} answers. Restart required.`;resultBox.textContent="Test stopped. Please start over.";setStatus(state.endReason);return true}return false}
function maybeTriggerTerminalRule(){if(state.overloads.length<2)return false;const n=state.overloads.length,gap=Math.abs(state.overloads[n-1]-state.overloads[n-2]);if(gap<settings.qualifyingBlockGapMs){state.phase="terminal_recovery";state.recoveryCorrectCompleted=0;openTrial("terminal_recovery");return true}return false}
function handleTap(index){if(!["calibration","paced","recovery","terminal_recovery"].includes(state.phase))return;noteAnyResponse();if(state.phase==="calibration"){const rt=performance.now()-state.trialOpenedAt,ok=trialMatches(state.current,index);if(!ok){state.calibrationErrors+=1;updateMetrics();if(state.calibrationErrors>settings.calibrationStopErrors){failCalibrationAndRetest(`More than ${settings.calibrationStopErrors} calibration errors.`);return}}else{if(rt>settings.calibrationStopSlowMs){failCalibrationAndRetest(`A calibration response exceeded ${settings.calibrationStopSlowMs} ms.`);return}if(state.calibrationTrialIndex>=settings.initialUnusedCalibrationTrials)state.calibrationRTs.push(rt)}state.calibrationTrialIndex+=1;if(state.calibrationTrialIndex>=settings.initialUnusedCalibrationTrials+settings.initialMeasuredCalibrationTrials)finishCalibration();else openTrial("calibration");return}
if(state.phase==="recovery"||state.phase==="terminal_recovery"){clearTimer();const ok=trialMatches(state.current,index);if(recordAnswer(ok))return;if(ok){state.current.resolved=true;state.recoveryCorrectCompleted+=1;if(state.recoveryCorrectCompleted>=settings.recoveryCorrectTrials){if(state.phase==="terminal_recovery"){state.endReason=`Completed ${settings.recoveryCorrectTrials} final self-paced trials`;finish();return}state.recoveries.push(state.blockDuration+settings.resumeSlowerByMs);state.phase="paced";state.duration=clamp(state.blockDuration+settings.resumeSlowerByMs,settings.minDurationMs,settings.maxDurationMs);setTimeout(()=>openTrial("paced"),180)}else setTimeout(()=>openTrial(state.phase),160)}else setTimeout(()=>openTrial(state.phase),160);return}
if(state.previous&&state.previous.kind==="paced"&&!state.previous.resolved&&trialMatches(state.previous,index)){state.previous.resolved=true;if(recordAnswer(true))return;return}
if(state.current&&state.current.kind==="paced"&&!state.current.resolved&&trialMatches(state.current,index)){state.current.resolved=true;if(recordAnswer(true))return;return}
recordAnswer(false)}
function onPacedFrameEnd(){if(state.phase!=="paced")return;state.totalTrials+=1;const currentMissed=state.current&&state.current.kind==="paced"&&!state.current.resolved;if(currentMissed){if(recordAnswer(false))return}state.unresolvedStreak=currentMissed?state.unresolvedStreak+1:0;if(state.unresolvedStreak>=settings.consecutiveMissesForBlock){state.blockDuration=state.duration;state.overloads.push(state.blockDuration);state.unresolvedStreak=0;updateCPSDisplay(avgLast2Blocks());if(maybeTriggerTerminalRule())return;state.phase="recovery";state.recoveryCorrectCompleted=0;openTrial("recovery");return}state.duration=clamp(state.duration*settings.speedupFactor,settings.minDurationMs,settings.maxDurationMs);if(state.totalTrials>=settings.maxTrialCount){state.endReason="Reached trial cap";finish()}else openTrial("paced")}
function avgLast2Blocks(){if(state.overloads.length<2)return state.overloads.length?state.overloads[state.overloads.length-1]:null;return (state.overloads[state.overloads.length-1]+state.overloads[state.overloads.length-2])/2}
function finish(){clearTimer();clearNoResponseTimer();state.phase="finished";const avg2=avgLast2Blocks(),cps=avg2!=null?computeCPS(avg2):null;const result={subjectId:subjectKey(state.subjectId||"0"),samnPerelli:state.samnPerelli,calibrationAverageMs:state.calibrationRTs.length?mean(state.calibrationRTs):null,blocks:[...state.overloads],averageLast2BlockingScoresMs:avg2,cognitivePerformanceScore:cps,endReason:state.endReason||"Run complete",time:new Date().toISOString()};state.history.push(result);localStorage.setItem("blockrate_v25_corrected_consolidated_history",JSON.stringify(state.history));updateCPSDisplay(avg2);const fatigueText=state.samnPerelli?`${state.samnPerelli.score} — ${state.samnPerelli.label}`:"not recorded";resultBox.textContent=`V25 consolidated build active.

Subject ID:
${result.subjectId}

Samn–Perelli:
${fatigueText}

Calibration average:
${result.calibrationAverageMs!=null?result.calibrationAverageMs.toFixed(1)+" ms":"—"}

Average of last 2 blocking scores:
${avg2!=null?avg2.toFixed(1)+" ms":"—"}

Cognitive Performance Score (CPS):
${cps!=null?cps.toFixed(1):"—"}

End reason:
${result.endReason}`}
function exportResults(){const blob=new Blob([JSON.stringify({settings,history:state.history},null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="blockrate_v25_corrected_consolidated_results.json";a.click()}
function emailResults(){const last=state.history[state.history.length-1]||{},body=encodeURIComponent(JSON.stringify(last,null,2));window.location.href=`mailto:?subject=BlockRate v25&body=${body}`}
async function startTest(){if(!state.subjectId){$("subjectOverlay").classList.remove("hidden");setStatus("Enter Subject ID first");return}if(!state.samnPerelli){$("fatigueOverlay").classList.remove("hidden");setStatus("Select Samn–Perelli fatigue rating first");return}clearTimer();clearNoResponseTimer();state.phase="calibration";state.duration=null;state.blockDuration=null;state.current=null;state.previous=null;state.unresolvedStreak=0;state.overloads=[];state.recoveries=[];state.recoveryCorrectCompleted=0;state.totalTrials=0;state.endReason="";state.lastFiveAnswers=[];state.calibrationTrialIndex=0;state.calibrationRTs=[];state.calibrationErrors=0;setTestingQuiet(true);await captureGeoAndAddress();await runDeviceBenchmark();noteAnyResponse();openTrial("calibration")}
$("subjectNextBtn").onclick=()=>{const raw=$("subjectIdInput").value.trim();if(raw==="0"){state.subjectId="0";$("subjectOverlay").classList.add("hidden");$("refresherOverlay").classList.remove("hidden");setStatus("Guest session");return}if(!/^[A-Za-z0-9]{6}$/.test(raw)){setStatus("ID must be 6 letters/numbers, or 0 for Guest");return}state.subjectId=raw.toUpperCase();$("subjectOverlay").classList.add("hidden");$("refresherOverlay").classList.remove("hidden");setStatus(`Subject ID set: ${state.subjectId}`)};
$("skipRefresherBtn").onclick=()=>{$("refresherOverlay").classList.add("hidden");$("fatigueOverlay").classList.remove("hidden");setStatus("Refresher skipped")};
$("continueRefresherBtn").onclick=()=>{$("refresherOverlay").classList.add("hidden");$("fatigueOverlay").classList.remove("hidden");setStatus("Refresher complete")};
$("adminOpenBtn").onclick=()=>{$("adminOverlay").classList.remove("hidden");$("adminGate").classList.remove("hidden");$("adminBody").classList.add("hidden");$("adminPass").value=""};
$("unlockBtn").onclick=()=>{if($("adminPass").value===settings.adminPasscode){$("adminGate").classList.add("hidden");$("adminBody").classList.remove("hidden");renderAdmin();setStatus("Admin unlocked")}else setStatus("Incorrect passcode")};
$("closeAdminBtn").onclick=()=>$("adminOverlay").classList.add("hidden");$("closeAdminBtn2").onclick=()=>$("adminOverlay").classList.add("hidden");
$("saveAdminBtn").onclick=()=>{readAdmin();saveSettings();renderAdmin();setStatus("Admin settings saved as the new default on this device")};
$("resetAdminBtn").onclick=()=>{resetAdmin();setStatus("Admin settings reset")};
$("exportAdminBtn").onclick=()=>{const blob=new Blob([JSON.stringify(settings,null,2)],{type:"application/json"}),a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download="blockrate_v25_corrected_consolidated_admin_export.json";a.click()};
$("startBtn").onclick=startTest;$("exportBtn").onclick=exportResults;$("emailBtn").onclick=emailResults;$("backToStartBtn").onclick=goToStartPage;$("startOverBtn").onclick=startOverFlow;$("refBackBtn").onclick=goToStartPage;$("refStartOverBtn").onclick=startOverFlow;$("fatigueBackBtn").onclick=goToStartPage;$("fatigueStartOverBtn").onclick=startOverFlow;$("adminBackBtn").onclick=goToStartPage;$("adminStartOverBtn").onclick=startOverFlow;$("resultsBackBtn").onclick=goToStartPage;$("resultsStartOverBtn").onclick=startOverFlow;$("resultsExportBtn").onclick=exportResults;$("resultsEmailBtn").onclick=emailResults;
window.addEventListener("beforeinstallprompt",e=>{e.preventDefault();deferredPrompt=e;$("installBtn").disabled=false});$("installBtn").onclick=async()=>{if(!deferredPrompt)return;deferredPrompt.prompt();await deferredPrompt.userChoice;deferredPrompt=null};
modeLabel.textContent="Subject mode";renderFatigueChecklist();renderRefresher();updateMetrics();renderHistoryGraphs();
