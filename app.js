const DEFAULTS = {
  startDurationMs: 800,
  speedupFactor: 0.94,
  resumeSlowerByMs: 300,
  consecutiveMissesForBlock: 2,
  recoveryCorrectTrials: 2,
  qualifyingBlockGapMs: 250,
  noResponseTimeoutMs: 4000,
  wrongWindowSize: 5,
  wrongThresholdStop: 3,
  maxTrialCount: 180,
  minDurationMs: 250,
  maxDurationMs: 2500,
  geolocationTimeoutMs: 10000,
  geolocationHighAccuracy: 1,
  reverseGeocodeEnabled: 1
};

const GROUPS = [
  {title:"Timing",description:"How fast the paced phase starts and tightens.",
   fields:[
    ["startDurationMs","Starting paced duration (ms)","Initial machine-paced display time."],
    ["speedupFactor","Speedup factor after non-block frame","Multiply duration by this after a successful paced frame. Smaller = faster tightening."],
    ["resumeSlowerByMs","Resume slower after block (ms)","How much slower the test resumes after a block."],
    ["minDurationMs","Minimum paced duration (ms)","Fastest allowed display time."],
    ["maxDurationMs","Maximum paced duration (ms)","Slowest allowed display time."],
    ["maxTrialCount","Maximum paced trial count","Hard stop so the test cannot run forever."]
   ]},
  {title:"Blocking and recovery",description:"How blocks are detected and how recovery works.",
   fields:[
    ["consecutiveMissesForBlock","Consecutive missed frames for a block","How many unresolved paced frames trigger blocking."],
    ["recoveryCorrectTrials","Correct self-paced recovery trials required","How many self-paced trials must be correct before returning to paced mode."],
    ["qualifyingBlockGapMs","Gap between consecutive blocks required to end (ms)","End once two consecutive block points are closer than this."]
   ]},
  {title:"Stopping rules",description:"Safety and validity rules that stop the run.",
   fields:[
    ["noResponseTimeoutMs","Time to end test if no response (ms)","End immediately if no response occurs for this long."],
    ["wrongWindowSize","Rolling window size for wrong-answer stop","Window used to check recent answer quality."],
    ["wrongThresholdStop","Stop if wrong answers exceed this count in window","Restart-required threshold for recent wrong answers."]
   ]},
  {title:"Location / metadata",description:"Context capture options.",
   fields:[
    ["geolocationTimeoutMs","Geolocation timeout (ms)","How long to wait for a location fix."],
    ["geolocationHighAccuracy","Use high-accuracy geolocation (1=yes, 0=no)","Use GPS-style accuracy where available."],
    ["reverseGeocodeEnabled","Street-address lookup (1=yes, 0=no)","Try to convert coordinates to a local street address."]
   ]}
];

const SHAPES = ["circle","square","triangle","diamond","hexagon","star"];
const SYMBOLS = ["•","••","•••","—","——","|||","• —","— •","• |","| •","• •","| |"];

let settings = loadSettings();
const state = {
  phase:"idle", duration:settings.startDurationMs, blockDuration:null, current:null, previous:null,
  unresolvedStreak:0, overloads:[], recoveries:[], recoveryCorrectCompleted:0, liveData:[],
  history:JSON.parse(localStorage.getItem("blockrate_shape_match_config_history")||"[]"),
  oneBackCount:0, onTimeCount:0, totalTrials:0, trialTimer:null, absoluteNoResponseTimer:null,
  lastBlockGap:null, qualifyingBlockPair:null, endReason:"", lastFiveAnswers:[]
};

let deferredPrompt = null;
const probeCircle = document.getElementById("probeCircle");
const upperEl = document.getElementById("upper");
const buttonsEl = document.getElementById("buttons");
const statusLine = document.getElementById("statusLine");
const resultBox = document.getElementById("resultBox");
const settingsRoot = document.getElementById("settingsRoot");
const installBtn = document.getElementById("installBtn");

function loadSettings(){ const saved = JSON.parse(localStorage.getItem("blockrate_shape_match_settings") || "null"); return saved ? {...DEFAULTS, ...saved} : {...DEFAULTS}; }
function saveSettings(){ localStorage.setItem("blockrate_shape_match_settings", JSON.stringify(settings)); }
function renderSettings(){
  settingsRoot.innerHTML = "";
  for(const group of GROUPS){
    const section = document.createElement("div");
    section.className = "settings-section";
    section.innerHTML = `<div class="section-title">${group.title}</div><div class="section-desc">${group.description}</div>`;
    for(const [key,label,hint] of group.fields){
      const row = document.createElement("div");
      row.className = "row";
      row.innerHTML = `<label for="${key}">${label}<span class="hint">${hint}</span></label><input id="${key}" value="${settings[key]}">`;
      section.appendChild(row);
    }
    settingsRoot.appendChild(section);
  }
}
function readSettingsFromUI(){
  for(const group of GROUPS){
    for(const [key] of group.fields){
      const raw = document.getElementById(key).value.trim();
      settings[key] = Number(raw);
      if(Number.isNaN(settings[key])) settings[key] = DEFAULTS[key];
    }
  }
}
function resetSettings(){ settings = {...DEFAULTS}; renderSettings(); saveSettings(); }

function randInt(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function clamp(v,lo,hi){ return Math.min(hi, Math.max(lo,v)); }
function median(arr){ if(!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }
function shuffle(arr){ const a=[...arr]; for(let i=a.length-1;i>0;i--){ const j=Math.floor(Math.random()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }
function pickDistinctSymbols(count){ return shuffle(SYMBOLS).slice(0,count); }

function escapeHtml(s){ return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;"); }
function shapeSvg(shapeId, symbolText=""){
  const commonStroke='stroke="#111" stroke-width="2" fill="none"';
  const commonFill='fill="#fff"';
  const text = symbolText ? `<text x="50" y="56" text-anchor="middle" class="symbolTxt">${escapeHtml(symbolText)}</text>` : "";
  let shape="";
  if(shapeId==="circle") shape=`<circle cx="50" cy="50" r="32" ${commonStroke} ${commonFill}/>`;
  if(shapeId==="square") shape=`<rect x="18" y="18" width="64" height="64" ${commonStroke} ${commonFill}/>`;
  if(shapeId==="triangle") shape=`<polygon points="50,15 84,82 16,82" ${commonStroke} ${commonFill}/>`;
  if(shapeId==="diamond") shape=`<polygon points="50,12 86,50 50,88 14,50" ${commonStroke} ${commonFill}/>`;
  if(shapeId==="hexagon") shape=`<polygon points="30,18 70,18 88,50 70,82 30,82 12,50" ${commonStroke} ${commonFill}/>`;
  if(shapeId==="star") shape=`<polygon points="50,14 58,38 84,38 63,53 71,79 50,63 29,79 37,53 16,38 42,38" ${commonStroke} ${commonFill}/>`;
  return `<div class="shapeHolder"><svg class="shapeSvg" viewBox="0 0 100 100">${shape}${text}</svg></div>`;
}
function setStatus(msg){ statusLine.textContent = msg; }
function clearTimer(){ if(state.trialTimer) clearTimeout(state.trialTimer); state.trialTimer = null; }
function clearNoResponseTimer(){ if(state.absoluteNoResponseTimer) clearTimeout(state.absoluteNoResponseTimer); state.absoluteNoResponseTimer = null; }
function armNoResponseTimer(){ clearNoResponseTimer(); state.absoluteNoResponseTimer = setTimeout(()=>{ state.endReason = `No response for more than ${settings.noResponseTimeoutMs} ms`; finish(); }, settings.noResponseTimeoutMs); }
function noteAnyResponse(){ armNoResponseTimer(); }

function makeTrial(kind){
  const upperShapes = shuffle(SHAPES);
  const lowerShapes = shuffle(SHAPES);
  const correctUpperIndex = randInt(0,5);
  const correctShapeId = upperShapes[correctUpperIndex];
  const symbols = pickDistinctSymbols(6);
  const targetSymbol = symbols[0];
  const upperSymbols = [];
  for(let i=0;i<6;i++) upperSymbols.push(symbols[i === correctUpperIndex ? 0 : i]);
  return { id: crypto.randomUUID ? crypto.randomUUID() : String(Date.now()+Math.random()), kind, upperShapes, upperSymbols, lowerShapes, targetSymbol, correctShapeId, resolved:false };
}
function renderProbe(trial){ probeCircle.textContent = trial.targetSymbol; }
function renderUpper(trial){
  upperEl.innerHTML = "";
  for(let i=0;i<6;i++){
    const cell = document.createElement("div");
    cell.className = "cell";
    cell.dataset.shape = trial.upperShapes[i];
    cell.innerHTML = shapeSvg(trial.upperShapes[i], trial.upperSymbols[i]);
    upperEl.appendChild(cell);
  }
}
function renderButtons(trial){
  buttonsEl.innerHTML = "";
  for(let i=0;i<6;i++){
    const btn = document.createElement("div");
    btn.className = "btncell";
    btn.dataset.shape = trial.lowerShapes[i];
    btn.innerHTML = shapeSvg(trial.lowerShapes[i], "");
    btn.addEventListener("click", ()=>handleTap(i));
    buttonsEl.appendChild(btn);
  }
}
function trialMatches(trial, chosenShapeId){ return trial && chosenShapeId === trial.correctShapeId; }
function recordAnswer(isCorrect){
  state.lastFiveAnswers.push(isCorrect);
  if(state.lastFiveAnswers.length > settings.wrongWindowSize) state.lastFiveAnswers.shift();
  const wrongCount = state.lastFiveAnswers.filter(v=>v===false).length;
  if(state.lastFiveAnswers.length === settings.wrongWindowSize && wrongCount > settings.wrongThresholdStop){
    clearTimer(); clearNoResponseTimer();
    state.phase = "finished";
    state.endReason = `More than ${settings.wrongThresholdStop} wrong answers out of the last ${settings.wrongWindowSize} answers. Restart required.`;
    resultBox.textContent = "Test stopped. Please start over.";
    setStatus(state.endReason);
    return true;
  }
  return false;
}
function openTrial(kind){
  clearTimer();
  state.previous = state.current;
  state.current = makeTrial(kind);
  renderProbe(state.current);
  renderUpper(state.current);
  renderButtons(state.current);
  if(kind === "paced"){ setStatus(`Machine-paced · ${Math.round(state.duration)} ms`); state.trialTimer = setTimeout(onPacedFrameEnd, state.duration); }
  else if(kind === "recovery"){ setStatus(`Self-paced recovery ${state.recoveryCorrectCompleted + 1}/${settings.recoveryCorrectTrials}`); }
  else if(kind === "terminal_recovery"){ setStatus(`Final recovery ${state.recoveryCorrectCompleted + 1}/${settings.recoveryCorrectTrials}`); }
}
function maybeTriggerTerminalRule(){
  if(state.overloads.length < 2) return false;
  const n = state.overloads.length;
  const gap = Math.abs(state.overloads[n-1] - state.overloads[n-2]);
  state.lastBlockGap = gap;
  if(gap < settings.qualifyingBlockGapMs){
    state.qualifyingBlockPair = [state.overloads[n-2], state.overloads[n-1]];
    state.phase = "terminal_recovery";
    state.recoveryCorrectCompleted = 0;
    openTrial("terminal_recovery");
    return true;
  }
  return false;
}
function handleTap(index){
  if(!["paced","recovery","terminal_recovery"].includes(state.phase)) return;
  noteAnyResponse();
  const chosenShapeId = buttonsEl.children[index].dataset.shape;

  if(state.phase === "recovery" || state.phase === "terminal_recovery"){
    const ok = trialMatches(state.current, chosenShapeId);
    if(recordAnswer(ok)) return;
    if(ok){
      state.current.resolved = true;
      state.recoveryCorrectCompleted += 1;
      if(state.recoveryCorrectCompleted >= settings.recoveryCorrectTrials){
        if(state.phase === "terminal_recovery"){
          state.endReason = `Completed ${settings.recoveryCorrectTrials} final self-paced trials after consecutive blocks under ${settings.qualifyingBlockGapMs} ms apart`;
          finish(); return;
        }
        state.recoveries.push(state.blockDuration + settings.resumeSlowerByMs);
        state.phase = "paced";
        state.duration = clamp(state.blockDuration + settings.resumeSlowerByMs, settings.minDurationMs, settings.maxDurationMs);
        setTimeout(()=>openTrial("paced"), 180);
      } else {
        setTimeout(()=>openTrial(state.phase), 160);
      }
    } else {
      setTimeout(()=>openTrial(state.phase), 160);
    }
    return;
  }

  if(state.previous && state.previous.kind==="paced" && !state.previous.resolved && trialMatches(state.previous, chosenShapeId)){
    state.previous.resolved = true;
    state.oneBackCount += 1;
    if(recordAnswer(true)) return;
    return;
  }
  if(state.current && state.current.kind==="paced" && !state.current.resolved && trialMatches(state.current, chosenShapeId)){
    state.current.resolved = true;
    state.onTimeCount += 1;
    if(recordAnswer(true)) return;
    return;
  }
  recordAnswer(false);
}
function onPacedFrameEnd(){
  if(state.phase !== "paced") return;
  state.totalTrials += 1;
  const currentMissed = state.current && state.current.kind==="paced" && !state.current.resolved;
  if(currentMissed){ if(recordAnswer(false)) return; }
  state.unresolvedStreak = currentMissed ? state.unresolvedStreak + 1 : 0;
  if(state.unresolvedStreak >= settings.consecutiveMissesForBlock){
    state.blockDuration = state.duration;
    state.overloads.push(state.blockDuration);
    state.unresolvedStreak = 0;
    if(maybeTriggerTerminalRule()) return;
    state.phase = "recovery";
    state.recoveryCorrectCompleted = 0;
    openTrial("recovery");
    return;
  }
  state.duration = clamp(state.duration * settings.speedupFactor, settings.minDurationMs, settings.maxDurationMs);
  if(state.totalTrials >= settings.maxTrialCount){ state.endReason = "Reached trial cap"; finish(); }
  else openTrial("paced");
}
function finish(){
  clearTimer(); clearNoResponseTimer();
  state.phase = "finished";
  const overloadAvg = median(state.overloads) || state.duration;
  const recoveryAvg = median(state.recoveries) || (overloadAvg + settings.resumeSlowerByMs);
  let threshold = (overloadAvg + recoveryAvg) / 2;
  if(state.qualifyingBlockPair) threshold = (state.qualifyingBlockPair[0] + state.qualifyingBlockPair[1]) / 2;
  resultBox.textContent =
`This version lets you change the variables of the test.

Current settings:
${JSON.stringify(settings, null, 2)}

Latest threshold:
${threshold.toFixed(1)} ms

End reason:
${state.endReason || "Run complete"}`;
}
function exportResults(){
  const blob = new Blob([JSON.stringify({settings, history:state.history}, null, 2)], {type:"application/json"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "blockrate_shape_match_configurable_results.json";
  a.click();
}
function emailResults(){
  const body = encodeURIComponent(JSON.stringify({settings, lastThreshold: state.overloads.slice(-1)[0] || null}, null, 2));
  window.location.href = `mailto:?subject=BlockRate Shape Match Configurable&body=${body}`;
}
async function startTest(){
  readSettingsFromUI(); saveSettings();
  clearTimer(); clearNoResponseTimer();
  state.phase = "paced";
  state.duration = settings.startDurationMs;
  state.blockDuration = null;
  state.current = null;
  state.previous = null;
  state.unresolvedStreak = 0;
  state.overloads = [];
  state.recoveries = [];
  state.recoveryCorrectCompleted = 0;
  state.totalTrials = 0;
  state.lastBlockGap = null;
  state.qualifyingBlockPair = null;
  state.endReason = "";
  state.lastFiveAnswers = [];
  resultBox.textContent = "";
  noteAnyResponse();
  openTrial("paced");
}

document.getElementById("saveSettingsBtn").addEventListener("click", ()=>{ readSettingsFromUI(); saveSettings(); setStatus("Settings saved"); });
document.getElementById("resetSettingsBtn").addEventListener("click", ()=>{ resetSettings(); setStatus("Settings reset"); });
document.getElementById("exportSettingsBtn").addEventListener("click", ()=>{ readSettingsFromUI(); const blob = new Blob([JSON.stringify(settings, null, 2)], {type:"application/json"}); const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "blockrate_shape_match_settings.json"; a.click(); });
document.getElementById("importSettingsBtn").addEventListener("click", ()=>document.getElementById("importSettingsFile").click());
document.getElementById("importSettingsFile").addEventListener("change", async e=>{ const file=e.target.files[0]; if(!file) return; settings = {...DEFAULTS, ...JSON.parse(await file.text())}; renderSettings(); saveSettings(); setStatus("Settings imported"); });
document.getElementById("startBtn").addEventListener("click", startTest);
document.getElementById("exportBtn").addEventListener("click", exportResults);
document.getElementById("emailBtn").addEventListener("click", emailResults);

window.addEventListener("beforeinstallprompt", e=>{ e.preventDefault(); deferredPrompt=e; installBtn.disabled=false; });
installBtn.addEventListener("click", async ()=>{ if(!deferredPrompt) return; deferredPrompt.prompt(); await deferredPrompt.userChoice; deferredPrompt=null; });

if("serviceWorker" in navigator){ window.addEventListener("load", ()=>navigator.serviceWorker.register("./sw.js")); }

renderSettings();
probeCircle.textContent = "Ready";
