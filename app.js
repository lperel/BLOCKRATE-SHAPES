const SETTINGS = {
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
  geolocationHighAccuracy: true,
  reverseGeocodeEnabled: true
};

const SHAPES = ["circle","square","triangle","diamond","hexagon","star"];
const SYMBOLS = [
  "•", "••", "•••", "—", "——", "|||",
  "• —", "— •", "• |", "| •", "• •", "| |"
];

const state = {
  phase: "idle", // idle | paced | recovery | terminal_recovery | finished
  duration: SETTINGS.startDurationMs,
  blockDuration: null,
  current: null,
  previous: null,
  unresolvedStreak: 0,
  overloads: [],
  recoveries: [],
  recoveryCorrectCompleted: 0,
  liveData: [],
  history: JSON.parse(localStorage.getItem("blockrate_shape_match_history") || "[]"),
  oneBackCount: 0,
  onTimeCount: 0,
  totalTrials: 0,
  trialTimer: null,
  absoluteNoResponseTimer: null,
  lastBlockGap: null,
  qualifyingBlockPair: null,
  endReason: "",
  lastFiveAnswers: [],
  startMetadata: null,
  endMetadata: null,
  sessionId: null,
  deviceFingerprint: null,
  geo: { status:"not_requested", latitude:null, longitude:null, address:null, accuracyMeters:null, locationConfidence:"unknown", fixTimeMs:null, reverseGeocodeStatus:"not_requested", error:null }
};

let deferredPrompt = null;

const probeCircle = document.getElementById("probeCircle");
const upperEl = document.getElementById("upper");
const buttonsEl = document.getElementById("buttons");
const rateOut = document.getElementById("rateOut");
const blocksOut = document.getElementById("blocksOut");
const recoveryOut = document.getElementById("recoveryOut");
const gapOut = document.getElementById("gapOut");
const wrongOut = document.getElementById("wrongOut");
const statusLine = document.getElementById("statusLine");
const resultBox = document.getElementById("resultBox");
const phaseLabel = document.getElementById("phaseLabel");
const liveChart = document.getElementById("liveChart");
const lctx = liveChart.getContext("2d");
const installBtn = document.getElementById("installBtn");

function randInt(min,max){ return Math.floor(Math.random()*(max-min+1))+min; }
function clamp(v,lo,hi){ return Math.min(hi, Math.max(lo,v)); }
function median(arr){ if(!arr.length) return 0; const s=[...arr].sort((a,b)=>a-b); return s[Math.floor(s.length/2)]; }
function shuffle(arr){
  const a = [...arr];
  for(let i=a.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [a[i],a[j]]=[a[j],a[i]];
  }
  return a;
}
function pickDistinctSymbols(count){
  const shuffled = shuffle(SYMBOLS);
  return shuffled.slice(0, count);
}

function nowMetadata(){
  const d = new Date();
  return {
    epochMs: d.getTime(),
    localDate: d.toLocaleDateString(),
    localTime: d.toLocaleTimeString(),
    localDateTime: d.toLocaleString(),
    gmtDateTime: d.toUTCString(),
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown"
  };
}
function makeSessionId(){
  if (crypto.randomUUID) return crypto.randomUUID();
  return "session-" + Date.now() + "-" + Math.random().toString(36).slice(2,10);
}
async function sha256(text){
  const enc = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2,"0")).join("");
}
async function makeDeviceFingerprint(){
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "";
  const parts = [
    navigator.userAgent || "",
    navigator.language || "",
    navigator.platform || "",
    String(screen.width || ""),
    String(screen.height || ""),
    String(screen.colorDepth || ""),
    tz
  ].join("|");
  return sha256(parts);
}
function classifyLocationConfidence(acc){
  if (acc == null) return "unknown";
  if (acc <= 10) return "high";
  if (acc <= 50) return "moderate";
  if (acc <= 200) return "low";
  return "very low";
}
async function reverseGeocode(lat, lon){
  const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lon)}`;
  const response = await fetch(url, {headers:{"Accept":"application/json"}});
  if(!response.ok) throw new Error("Reverse geocode failed");
  const data = await response.json();
  return data.display_name || "unknown";
}
function requestGeo(){
  if (!("geolocation" in navigator)){
    state.geo = { status:"unsupported", latitude:null, longitude:null, address:null, accuracyMeters:null, locationConfidence:"unknown", fixTimeMs:null, reverseGeocodeStatus:"not_requested", error:"Geolocation unsupported" };
    return;
  }
  state.geo.status = "pending";
  const start = performance.now();
  navigator.geolocation.getCurrentPosition(
    async pos => {
      state.geo.status = "granted";
      state.geo.latitude = pos.coords.latitude;
      state.geo.longitude = pos.coords.longitude;
      state.geo.accuracyMeters = pos.coords.accuracy;
      state.geo.locationConfidence = classifyLocationConfidence(pos.coords.accuracy);
      state.geo.fixTimeMs = Math.round(performance.now() - start);
      if (SETTINGS.reverseGeocodeEnabled){
        try{
          state.geo.address = await reverseGeocode(state.geo.latitude, state.geo.longitude);
          state.geo.reverseGeocodeStatus = "ok";
        }catch(err){
          state.geo.address = null;
          state.geo.reverseGeocodeStatus = "failed";
          state.geo.error = err && err.message ? err.message : "lookup failed";
        }
      } else {
        state.geo.reverseGeocodeStatus = "disabled";
      }
    },
    err => {
      state.geo.status = "denied_or_unavailable";
      state.geo.fixTimeMs = Math.round(performance.now() - start);
      state.geo.error = err && err.message ? err.message : "Location unavailable";
    },
    { enableHighAccuracy: SETTINGS.geolocationHighAccuracy, timeout: SETTINGS.geolocationTimeoutMs, maximumAge: 0 }
  );
}
function explainEnd(reason){
  if (!reason) return "Test ended.";
  if (reason.includes("More than")) return "Test ended due to excessive errors. Performance reliability was compromised and a restart is required.";
  if (reason.includes("No response")) return "Test ended due to sustained non-response. This suggests overload, disengagement, or inability to keep up.";
  if (reason.includes("consecutive blocks")) return "Test ended after two blocking points converged within 250 ms, indicating a stable threshold.";
  if (reason.includes("trial cap")) return "Test ended because the maximum trial limit was reached before a stable stopping condition.";
  return "Test ended.";
}
function geoText(){
  if (state.geo.status === "granted"){
    return `Latitude: ${state.geo.latitude != null ? state.geo.latitude.toFixed(6) : "—"}
Longitude: ${state.geo.longitude != null ? state.geo.longitude.toFixed(6) : "—"}
Address: ${state.geo.address || "unavailable (offline or lookup failed)"}
Accuracy: ${state.geo.accuracyMeters != null ? Math.round(state.geo.accuracyMeters) + " m" : "—"}
Confidence: ${state.geo.locationConfidence}
Fix time: ${state.geo.fixTimeMs != null ? state.geo.fixTimeMs + " ms" : "—"}
Reverse geocode: ${state.geo.reverseGeocodeStatus}`;
  }
  return `Location: ${state.geo.status}${state.geo.error ? " (" + state.geo.error + ")" : ""}`;
}

function shapeSvg(shapeId, symbolText=""){
  const commonStroke = 'stroke="#111" stroke-width="2" fill="none"';
  const commonFill = 'fill="#fff"';
  const text = symbolText ? `<text x="50" y="56" text-anchor="middle" class="symbolTxt">${escapeHtml(symbolText)}</text>` : "";
  let shape = "";
  if (shapeId === "circle") shape = `<circle cx="50" cy="50" r="32" ${commonStroke} ${commonFill}/>`;
  if (shapeId === "square") shape = `<rect x="18" y="18" width="64" height="64" ${commonStroke} ${commonFill}/>`;
  if (shapeId === "triangle") shape = `<polygon points="50,15 84,82 16,82" ${commonStroke} ${commonFill}/>`;
  if (shapeId === "diamond") shape = `<polygon points="50,12 86,50 50,88 14,50" ${commonStroke} ${commonFill}/>`;
  if (shapeId === "hexagon") shape = `<polygon points="30,18 70,18 88,50 70,82 30,82 12,50" ${commonStroke} ${commonFill}/>`;
  if (shapeId === "star") shape = `<polygon points="50,14 58,38 84,38 63,53 71,79 50,63 29,79 37,53 16,38 42,38" ${commonStroke} ${commonFill}/>`;
  return `<div class="shapeHolder"><svg class="shapeSvg" viewBox="0 0 100 100" aria-hidden="true">${shape}${text}</svg></div>`;
}
function escapeHtml(s){
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

function makeTrial(kind){
  const upperShapes = shuffle(SHAPES);
  const lowerShapes = shuffle(SHAPES);

  const correctUpperIndex = randInt(0,5);
  const correctShapeId = upperShapes[correctUpperIndex];

  const symbols = pickDistinctSymbols(6);
  const targetSymbol = symbols[0];

  const upperSymbols = [];
  for(let i=0;i<6;i++){
    upperSymbols.push(symbols[i === correctUpperIndex ? 0 : i]);
  }

  return {
    id: crypto.randomUUID(),
    kind,
    upperShapes,
    upperSymbols,
    lowerShapes,
    targetSymbol,
    correctShapeId,
    resolved: false
  };
}

function renderProbe(trial){
  probeCircle.textContent = trial.targetSymbol;
}
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
function drawLive(){
  lctx.clearRect(0,0,liveChart.width,liveChart.height);
  lctx.strokeStyle = "#111";
  lctx.lineWidth = 2;
  lctx.beginPath();
  state.liveData.forEach((v,i)=>{
    const x = (i / Math.max(1, state.liveData.length - 1)) * (liveChart.width - 10) + 5;
    const y = liveChart.height - Math.min(160, v / 8);
    if (i===0) lctx.moveTo(x,y); else lctx.lineTo(x,y);
  });
  lctx.stroke();
}
function updateMetrics(){
  rateOut.textContent = `${(1000/state.duration).toFixed(2)} Hz`;
  blocksOut.textContent = String(state.overloads.length);
  recoveryOut.textContent = String(state.recoveries.length);
  gapOut.textContent = state.lastBlockGap == null ? "—" : `${Math.round(state.lastBlockGap)} ms`;
  wrongOut.textContent = String(state.lastFiveAnswers.filter(v=>v===false).length);
}
function setStatus(msg){ statusLine.textContent = msg; }
function clearTimer(){ if (state.trialTimer) clearTimeout(state.trialTimer); state.trialTimer = null; }
function clearNoResponseTimer(){ if (state.absoluteNoResponseTimer) clearTimeout(state.absoluteNoResponseTimer); state.absoluteNoResponseTimer = null; }
function armNoResponseTimer(){
  clearNoResponseTimer();
  state.absoluteNoResponseTimer = setTimeout(()=>{
    state.endReason = `No response for more than ${SETTINGS.noResponseTimeoutMs} ms`;
    finish();
  }, SETTINGS.noResponseTimeoutMs);
}
function noteAnyResponse(){ armNoResponseTimer(); }

function recordAnswer(isCorrect){
  state.lastFiveAnswers.push(isCorrect);
  if (state.lastFiveAnswers.length > SETTINGS.wrongWindowSize) state.lastFiveAnswers.shift();
  updateMetrics();
  const wrongCount = state.lastFiveAnswers.filter(v=>v===false).length;
  if (state.lastFiveAnswers.length === SETTINGS.wrongWindowSize && wrongCount > SETTINGS.wrongThresholdStop){
    clearTimer(); clearNoResponseTimer();
    state.phase = "finished";
    state.endReason = `More than ${SETTINGS.wrongThresholdStop} wrong answers out of the last ${SETTINGS.wrongWindowSize} answers. Restart required.`;
    phaseLabel.textContent = "Restart";
    setStatus(state.endReason);
    resultBox.textContent = "Test stopped. Please start over.";
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
  updateMetrics();
  drawLive();

  if (kind === "paced"){
    phaseLabel.textContent = `Paced · ${Math.round(state.duration)} ms`;
    setStatus("Machine-paced");
    state.trialTimer = setTimeout(onPacedFrameEnd, state.duration);
  } else if (kind === "recovery"){
    phaseLabel.textContent = `Recovery ${state.recoveryCorrectCompleted + 1}/${SETTINGS.recoveryCorrectTrials}`;
    setStatus("Self-paced recovery (not scored)");
  } else if (kind === "terminal_recovery"){
    phaseLabel.textContent = `Final recovery ${state.recoveryCorrectCompleted + 1}/${SETTINGS.recoveryCorrectTrials}`;
    setStatus(`Consecutive block gap under ${SETTINGS.qualifyingBlockGapMs} ms`);
  }
}

function trialMatches(trial, chosenShapeId){
  return trial && chosenShapeId === trial.correctShapeId;
}

function maybeTriggerTerminalRule(){
  if (state.overloads.length < 2) return false;
  const n = state.overloads.length;
  const prevBlock = state.overloads[n-2];
  const currentBlock = state.overloads[n-1];
  const gap = Math.abs(currentBlock - prevBlock);
  state.lastBlockGap = gap;
  updateMetrics();

  if (gap < SETTINGS.qualifyingBlockGapMs){
    state.qualifyingBlockPair = [prevBlock, currentBlock];
    state.phase = "terminal_recovery";
    state.recoveryCorrectCompleted = 0;
    setStatus(`Consecutive block gap ${Math.round(gap)} ms < ${SETTINGS.qualifyingBlockGapMs} ms`);
    openTrial("terminal_recovery");
    return true;
  }
  setStatus(`Consecutive block gap ${Math.round(gap)} ms ≥ ${SETTINGS.qualifyingBlockGapMs} ms · continue`);
  return false;
}

function handleTap(index){
  if (!["paced","recovery","terminal_recovery"].includes(state.phase)) return;
  noteAnyResponse();

  const chosenShapeId = buttonsEl.children[index].dataset.shape;

  if (state.phase === "recovery" || state.phase === "terminal_recovery"){
    const ok = trialMatches(state.current, chosenShapeId);
    if (recordAnswer(ok)) return;
    if (ok){
      state.current.resolved = true;
      state.recoveryCorrectCompleted += 1;
      if (state.recoveryCorrectCompleted >= SETTINGS.recoveryCorrectTrials){
        if (state.phase === "terminal_recovery"){
          state.endReason = `Completed ${SETTINGS.recoveryCorrectTrials} final self-paced trials after consecutive blocks under ${SETTINGS.qualifyingBlockGapMs} ms apart`;
          finish();
          return;
        }
        state.recoveries.push(state.blockDuration + SETTINGS.resumeSlowerByMs);
        state.phase = "paced";
        state.duration = clamp(state.blockDuration + SETTINGS.resumeSlowerByMs, SETTINGS.minDurationMs, SETTINGS.maxDurationMs);
        setStatus("Recovery complete");
        setTimeout(()=>openTrial("paced"), 180);
      } else {
        setTimeout(()=>openTrial(state.phase), 160);
      }
    } else {
      setStatus("Recovery trial repeated");
      setTimeout(()=>openTrial(state.phase), 160);
    }
    return;
  }

  if (state.previous && state.previous.kind === "paced" && !state.previous.resolved && trialMatches(state.previous, chosenShapeId)){
    state.previous.resolved = true;
    state.oneBackCount += 1;
    if (recordAnswer(true)) return;
    return;
  }

  if (state.current && state.current.kind === "paced" && !state.current.resolved && trialMatches(state.current, chosenShapeId)){
    state.current.resolved = true;
    state.onTimeCount += 1;
    if (recordAnswer(true)) return;
    return;
  }

  recordAnswer(false);
}

function onPacedFrameEnd(){
  if (state.phase !== "paced") return;
  state.totalTrials += 1;

  const currentMissed = state.current && state.current.kind === "paced" && !state.current.resolved;
  if (currentMissed){
    if (recordAnswer(false)) return;
  }
  state.unresolvedStreak = currentMissed ? state.unresolvedStreak + 1 : 0;
  state.liveData.push(state.duration);

  if (state.unresolvedStreak >= SETTINGS.consecutiveMissesForBlock){
    state.blockDuration = state.duration;
    state.overloads.push(state.blockDuration);
    state.unresolvedStreak = 0;
    if (maybeTriggerTerminalRule()) return;
    state.phase = "recovery";
    state.recoveryCorrectCompleted = 0;
    setStatus(`Blocked at ${Math.round(state.blockDuration)} ms`);
    openTrial("recovery");
    return;
  }

  state.duration = clamp(state.duration * SETTINGS.speedupFactor, SETTINGS.minDurationMs, SETTINGS.maxDurationMs);

  if (state.liveData.length >= SETTINGS.maxTrialCount){
    state.endReason = "Reached trial cap";
    finish();
  } else {
    openTrial("paced");
  }
}

function classifyDeviation(pct){
  if (pct == null) return "Baseline building";
  if (pct < 10) return "Within baseline range";
  if (pct < 25) return "Mild slowdown";
  if (pct < 40) return "Moderate slowdown";
  return "Marked slowdown";
}

function finish(){
  clearTimer(); clearNoResponseTimer();
  state.phase = "finished";
  state.endMetadata = nowMetadata();

  const overloadAvg = median(state.overloads) || state.duration;
  const recoveryAvg = median(state.recoveries) || (overloadAvg + SETTINGS.resumeSlowerByMs);
  let threshold = (overloadAvg + recoveryAvg) / 2;
  if (state.qualifyingBlockPair) threshold = (state.qualifyingBlockPair[0] + state.qualifyingBlockPair[1]) / 2;

  const prior = state.history.slice(-5);
  const baseline = prior.length >= 3 ? median(prior.map(x => x.threshold)) : null;
  const deviation = baseline ? ((threshold - baseline) / baseline) * 100 : null;
  const lagRatio = (state.oneBackCount + state.onTimeCount) ? state.oneBackCount / (state.oneBackCount + state.onTimeCount) : 0;
  const explanation = explainEnd(state.endReason);

  const result = {
    sessionId: state.sessionId,
    deviceFingerprint: state.deviceFingerprint,
    time: Date.now(),
    taskVersion: "shape-match-v2",
    threshold,
    overloadAvg,
    recoveryAvg,
    hz: 1000 / threshold,
    blocks: state.overloads.length,
    lagRatio,
    onTimeCount: state.onTimeCount,
    oneBackCount: state.oneBackCount,
    baseline,
    deviation,
    qualifyingBlockPair: state.qualifyingBlockPair,
    lastBlockGap: state.lastBlockGap,
    endReason: state.endReason,
    endExplanation: explanation,
    lastFiveAnswers: state.lastFiveAnswers,
    startMetadata: state.startMetadata,
    endMetadata: state.endMetadata,
    geolocation: state.geo
  };

  state.history.push(result);
  localStorage.setItem("blockrate_shape_match_history", JSON.stringify(state.history));

  phaseLabel.textContent = "Finished";
  setStatus(state.endReason || "Run complete");
  resultBox.textContent =
`Threshold: ${threshold.toFixed(1)} ms
Rate: ${(1000/threshold).toFixed(2)} Hz
Overload avg: ${overloadAvg.toFixed(1)} ms
Recovery avg: ${recoveryAvg.toFixed(1)} ms
Blocks: ${state.overloads.length}
Qualifying block pair: ${state.qualifyingBlockPair ? state.qualifyingBlockPair.map(v => v.toFixed(1)+" ms").join(" / ") : "—"}
Last consecutive gap: ${state.lastBlockGap != null ? state.lastBlockGap.toFixed(1) + " ms" : "—"}
One-back ratio: ${(lagRatio*100).toFixed(1)}%
Baseline: ${baseline ? baseline.toFixed(1) + " ms" : "building"}
Deviation: ${deviation != null ? (deviation > 0 ? "+" : "") + deviation.toFixed(1) + "%" : "—"}

END REASON:
${state.endReason || "Run complete"}

INTERPRETATION:
${explanation}

SESSION ID:
${state.sessionId || "—"}

DEVICE FINGERPRINT:
${state.deviceFingerprint || "—"}

LOCAL DATE:
${state.endMetadata.localDate}

LOCAL TIME:
${state.endMetadata.localTime}

LOCAL DATE/TIME:
${state.endMetadata.localDateTime}

GMT DATE/TIME:
${state.endMetadata.gmtDateTime}

TIME ZONE:
${state.endMetadata.timeZone}

GEOLOCATION:
${geoText()}`;
}

function exportData(){
  const blob = new Blob([JSON.stringify(state.history, null, 2)], { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "blockrate_shape_match_results.json";
  a.click();
}
function emailResults(){
  const latest = state.history[state.history.length - 1];
  if (!latest) return;
  const body = encodeURIComponent(JSON.stringify(latest, null, 2));
  window.location.href = `mailto:?subject=BlockRate Shape Match Result&body=${body}`;
}

async function startTest(){
  clearTimer(); clearNoResponseTimer();
  state.phase = "paced";
  state.duration = SETTINGS.startDurationMs;
  state.blockDuration = null;
  state.current = null;
  state.previous = null;
  state.unresolvedStreak = 0;
  state.overloads = [];
  state.recoveries = [];
  state.recoveryCorrectCompleted = 0;
  state.liveData = [];
  state.oneBackCount = 0;
  state.onTimeCount = 0;
  state.totalTrials = 0;
  state.lastBlockGap = null;
  state.qualifyingBlockPair = null;
  state.endReason = "";
  state.lastFiveAnswers = [];
  state.startMetadata = nowMetadata();
  state.endMetadata = null;
  state.sessionId = makeSessionId();
  state.deviceFingerprint = await makeDeviceFingerprint();
  state.geo = { status:"pending", latitude:null, longitude:null, address:null, accuracyMeters:null, locationConfidence:"unknown", fixTimeMs:null, reverseGeocodeStatus:"not_requested", error:null };
  resultBox.textContent = "";
  requestGeo();
  noteAnyResponse();
  openTrial("paced");
}

document.getElementById("startBtn").addEventListener("click", startTest);
document.getElementById("exportBtn").addEventListener("click", exportData);
document.getElementById("emailBtn").addEventListener("click", emailResults);

window.addEventListener("beforeinstallprompt", e => {
  e.preventDefault();
  deferredPrompt = e;
  installBtn.disabled = false;
});
installBtn.addEventListener("click", async ()=>{
  if (!deferredPrompt) return;
  deferredPrompt.prompt();
  await deferredPrompt.userChoice;
  deferredPrompt = null;
});

if ("serviceWorker" in navigator){
  window.addEventListener("load", ()=>navigator.serviceWorker.register("./sw.js"));
}

renderProbe({targetSymbol:"Ready"});
probeCircle.textContent = "Ready";
updateMetrics();
