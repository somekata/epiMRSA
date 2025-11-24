// /epiMRSA/script.js
// CSV(local) → ①時系列(選択UIあり) ②施設間比較 ③raw表示

let records = [];

// Chart instances
let timeCharts = [];
let barChart = null;
let pieCharts = {};

// 表示状態
let showDaily = true;
let showMA = true;
let selectedGroups = new Set(["ALL"]);  // ALLと施設名が入る
let selectedPots = new Set();           // CSV読み込み後に全POTで初期化

// POT色
const POT_COLORS = {
  1: "#8FB3FF",
  2: "#5DD6C4",
  3: "#F7C56B",
  4: "#E989FF",
  5: "#FF8A7A"
};

// ===== CSV読み込み =====
document.getElementById("fileInput").addEventListener("change", handleCSV);

function handleCSV(e) {
  const file = e.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = (evt) => {
    const text = evt.target.result;
    records = parseCSV(text);

    if (!records.length) {
      document.getElementById("loadStatus").textContent = "読み込み失敗：CSV形式を確認してください";
      return;
    }

    document.getElementById("loadStatus").textContent =
      `読み込み成功：${records.length} レコード`;

    // 初期選択：ALL＋全施設、全POT
    initSelectionsAfterLoad();

    updateAll();
  };
  reader.readAsText(file);
}

function parseCSV(txt) {
  const lines = txt.trim().split(/\r?\n/);
  if (lines.length < 2) return [];

  const header = lines[0].split(",").map(h => h.trim().toLowerCase());
  const iDate = header.indexOf("date");
  const iPot = header.indexOf("pot");
  const iFac = header.indexOf("facility");
  if (iDate === -1 || iPot === -1 || iFac === -1) return [];

  const out = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map(c => c.trim());
    if (cols.length < header.length) continue;

    const date = cols[iDate];
    const pot = Number(cols[iPot]);
    const facility = cols[iFac];
    if (!date || !facility || !pot) continue;

    out.push({ date, pot, facility });
  }
  return out;
}

// 読み込み後の初期選択セット
function initSelectionsAfterLoad(){
  const facilities = getFacilities();
  const pots = getPots();

  selectedGroups = new Set(["ALL", ...facilities]);
  selectedPots = new Set(pots);

  buildFacilityModalOptions();
  buildPotModalOptions();
  updateSelectionText();
}

// ===== 共通ユーティリティ =====
function getFacilities(){
  return Array.from(new Set(records.map(r => r.facility))).sort();
}
function getPots(){
  return Array.from(new Set(records.map(r => r.pot))).sort((a,b)=>a-b);
}

// 日付正規化："2025-1-9"→"2025-01-09"
function normalizeDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  const dt = new Date(s);
  if (isNaN(dt)) return s;
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// 日付→件数集計（Dateソート）
function aggregateDaily(recList) {
  const counts = new Map();
  recList.forEach(r => {
    const key = normalizeDate(r.date);
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  const labels = Array.from(counts.keys())
    .sort((a, b) => new Date(a) - new Date(b));
  return labels.map(d => ({ date: d, count: counts.get(d) }));
}

// n日移動平均
function movingAverage(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const start = Math.max(0, i - n + 1);
    const slice = arr.slice(start, i + 1);
    out.push(slice.reduce((a, b) => a + b, 0) / slice.length);
  }
  return out;
}

// ===== 全体更新 =====
function updateAll(){
  drawTimeSeries();
  drawFacilityComparison();
  showTable();
}

// =======================================================
// ① 時系列：表示コントロールに従って再描画
// =======================================================
function drawTimeSeries() {
  const wrap = document.getElementById("timeChartsWrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!records.length) return;

  const facilities = getFacilities();
  const potsAll = getPots();

  // 選択されたPOTだけ使う
  const potList = potsAll.filter(p => selectedPots.has(p));
  if (potList.length === 0) potList.push(...potsAll); // 全解除防止の保険

  // 選択されたグループを並べる
  const groups = [];
  if (selectedGroups.has("ALL")) {
    groups.push({ key:"ALL", label:"全体", data: records });
  }
  facilities.forEach(f=>{
    if (selectedGroups.has(f)) {
      groups.push({ key:f, label:`施設 ${f}`, data: records.filter(r=>r.facility===f) });
    }
  });
  if (groups.length === 0) groups.push({ key:"ALL", label:"全体", data: records });

  // 既存Chart破棄
  timeCharts.forEach(ch => ch.destroy());
  timeCharts = [];

  groups.forEach(g=>{
    const card = document.createElement("div");
    card.className = "chart-card";
    card.innerHTML = `<h3>${g.label}</h3><canvas></canvas>`;
    wrap.appendChild(card);
    const canvas = card.querySelector("canvas");

    const dailyTotal = aggregateDaily(g.data);
    const labels = dailyTotal.map(d=>d.date);
    const totalCounts = dailyTotal.map(d=>d.count);
    const ma7 = movingAverage(totalCounts, 7);

    // POT別 date→count map
    const potDateCount = {};
    potList.forEach(p => potDateCount[p] = new Map());
    g.data.forEach(r=>{
      const d = normalizeDate(r.date);
      if (!selectedPots.has(r.pot)) return;
      potDateCount[r.pot].set(d, (potDateCount[r.pot].get(d)||0)+1);
    });
    const potSeries = potList.map(p=>({
      pot:p,
      data: labels.map(d=>potDateCount[p].get(d)||0)
    }));

    const datasets = [];

    // 元の総数日別
    if (showDaily){
      datasets.push({
        label:"日別件数（総数）",
        data: totalCounts,
        borderColor:"#1e3a8a",
        backgroundColor:"rgba(30,58,138,0.10)",
        borderWidth:2,
        tension:0,
        pointRadius:1
      });
    }

    // 元の7日平均
    if (showMA){
      datasets.push({
        label:"7日移動平均（総数）",
        data: ma7,
        borderColor:"#dc2626",
        backgroundColor:"rgba(220,38,38,0.08)",
        borderWidth:3,
        tension:0,
        pointRadius:0
      });
    }

    // POT別補助線
    potSeries.forEach((ps,i)=>{
      datasets.push({
        label:`POT${ps.pot}`,
        data: ps.data,
        borderColor: POT_COLORS[ps.pot] || `hsl(${i*60},70%,60%)`,
        borderWidth:1.5,
        tension:0,
        pointRadius:0,
        borderDash:[4,3]
      });
    });

    const chart = new Chart(canvas, {
      type:"line",
      data:{ labels, datasets },
      options:{
        responsive:true,
        plugins:{ legend:{ position:"bottom" } },
        scales:{
          x:{ ticks:{ maxRotation:0 } },
          y:{ beginAtZero:true }
        }
      }
    });

    timeCharts.push(chart);
  });
}

// =======================================================
// ② 施設間比較（積み上げ棒 + A/B/C円グラフ）
// =======================================================
function drawFacilityComparison() {
  if (!records.length) return;

  const facs = getFacilities();
  const potList = getPots();

  const facilityCounts = {};
  facs.forEach(f=>{
    facilityCounts[f]={};
    potList.forEach(p=>facilityCounts[f][p]=0);
  });
  records.forEach(r=>{
    facilityCounts[r.facility][r.pot]++;
  });

  const barData = {
    labels: facs,
    datasets: potList.map((p,i)=>({
      label:`POT${p}`,
      data:facs.map(f=>facilityCounts[f][p]),
      backgroundColor:POT_COLORS[p] || `hsl(${i*60},70%,60%)`
    }))
  };

  if (barChart) barChart.destroy();
  const barCtx = document.getElementById("facilityBar");
  if (!barCtx) return;
  barChart = new Chart(barCtx,{
    type:"bar",
    data:barData,
    options:{
      responsive:true,
      plugins:{ legend:{ position:"bottom" } },
      scales:{ x:{ stacked:true }, y:{ stacked:true, beginAtZero:true } }
    }
  });

  // Map pies (A/B/Cのみ)
  const pieIDs = {A:"pieA",B:"pieB",C:"pieC"};
  Object.keys(pieCharts).forEach(k=>pieCharts[k].destroy());
  pieCharts={};

  Object.keys(pieIDs).forEach(f=>{
    const canvas = document.getElementById(pieIDs[f]);
    if(!canvas || !facilityCounts[f]) return;
    pieCharts[f]=new Chart(canvas,{
      type:"doughnut",
      data:{
        labels:potList.map(p=>`POT${p}`),
        datasets:[{
          data:potList.map(p=>facilityCounts[f][p]),
          backgroundColor:potList.map((p,i)=>POT_COLORS[p]||`hsl(${i*60},70%,60%)`)
        }]
      },
      options:{ plugins:{legend:{display:false}}, cutout:"45%" }
    });
  });
}

// =======================================================
// ③ raw表示
// =======================================================
function showTable(){
  const div=document.getElementById("rawTable");
  if(!div) return;
  if(!records.length){ div.innerHTML=""; return; }

  let html=`<table><thead><tr><th>Date</th><th>POT</th><th>Facility</th></tr></thead><tbody>`;
  records.forEach(r=>{
    html+=`<tr><td>${normalizeDate(r.date)}</td><td>${r.pot}</td><td>${r.facility}</td></tr>`;
  });
  html+=`</tbody></table>`;
  div.innerHTML=html;
}

// =======================================================
// UI：日別/平均トグル
// =======================================================
const toggleDailyBtn = document.getElementById("toggleDaily");
const toggleMABtn = document.getElementById("toggleMA");

toggleDailyBtn.addEventListener("click", ()=>{
  showDaily = !showDaily;
  toggleDailyBtn.classList.toggle("active", showDaily);
  if(!showDaily && !showMA){ showMA=true; toggleMABtn.classList.add("active"); }
  drawTimeSeries();
});
toggleMABtn.addEventListener("click", ()=>{
  showMA = !showMA;
  toggleMABtn.classList.toggle("active", showMA);
  if(!showDaily && !showMA){ showDaily=true; toggleDailyBtn.classList.add("active"); }
  drawTimeSeries();
});

// =======================================================
// UI：施設モーダル
// =======================================================
const facilityModal = document.getElementById("facilityModal");
document.getElementById("facilitySelectBtn").addEventListener("click", ()=>{
  if(!records.length) return;
  openModal(facilityModal);
});

function buildFacilityModalOptions(){
  const box = document.getElementById("facilityOptions");
  box.innerHTML="";

  const facilities = getFacilities();
  const items = ["ALL", ...facilities];

  items.forEach(key=>{
    const label = key==="ALL" ? "全体(ALL)" : `施設 ${key}`;
    const id = `fac_${key}`;
    const checked = selectedGroups.has(key);

    const el = document.createElement("label");
    el.innerHTML = `<input type="checkbox" id="${id}" data-key="${key}" ${checked?"checked":""}> ${label}`;
    box.appendChild(el);
  });
}

document.getElementById("facilityAllOn").addEventListener("click", ()=>{
  document.querySelectorAll("#facilityOptions input").forEach(cb=>cb.checked=true);
});
document.getElementById("facilityAllOff").addEventListener("click", ()=>{
  document.querySelectorAll("#facilityOptions input").forEach(cb=>cb.checked=false);
});

document.getElementById("facilityApply").addEventListener("click", ()=>{
  const newSet = new Set();
  document.querySelectorAll("#facilityOptions input").forEach(cb=>{
    if(cb.checked) newSet.add(cb.dataset.key);
  });
  if(newSet.size===0) newSet.add("ALL"); // 全解除防止
  selectedGroups = newSet;
  closeModal(facilityModal);
  updateSelectionText();
  drawTimeSeries();
});

// =======================================================
// UI：POTモーダル
// =======================================================
const potModal = document.getElementById("potModal");
document.getElementById("potSelectBtn").addEventListener("click", ()=>{
  if(!records.length) return;
  openModal(potModal);
});

function buildPotModalOptions(){
  const box = document.getElementById("potOptions");
  box.innerHTML="";

  const potList = getPots();
  potList.forEach(p=>{
    const id = `pot_${p}`;
    const checked = selectedPots.has(p);
    const el = document.createElement("label");
    el.innerHTML = `<input type="checkbox" id="${id}" data-pot="${p}" ${checked?"checked":""}> POT${p}`;
    box.appendChild(el);
  });
}

document.getElementById("potAllOn").addEventListener("click", ()=>{
  document.querySelectorAll("#potOptions input").forEach(cb=>cb.checked=true);
});
document.getElementById("potAllOff").addEventListener("click", ()=>{
  document.querySelectorAll("#potOptions input").forEach(cb=>cb.checked=false);
});

document.getElementById("potApply").addEventListener("click", ()=>{
  const newSet = new Set();
  document.querySelectorAll("#potOptions input").forEach(cb=>{
    if(cb.checked) newSet.add(Number(cb.dataset.pot));
  });
  if(newSet.size===0) newSet.add(...getPots()); // 全解除防止
  selectedPots = newSet;
  closeModal(potModal);
  updateSelectionText();
  drawTimeSeries();
});

// =======================================================
// モーダル開閉共通
// =======================================================
function openModal(modal){
  modal.classList.remove("hidden");
}
function closeModal(modal){
  modal.classList.add("hidden");
}
document.querySelectorAll(".modal .close, .modal-bg").forEach(el=>{
  el.addEventListener("click", ()=>{
    closeModal(el.closest(".modal"));
  });
});

// =======================================================
// 選択状態の表示
// =======================================================
function updateSelectionText(){
  const facText = Array.from(selectedGroups)
    .map(k=>k==="ALL"?"全体":"施設"+k).join(", ");
  const potText = Array.from(selectedPots)
    .sort((a,b)=>a-b).map(p=>"POT"+p).join(", ");
  document.getElementById("currentSelection").textContent =
    `施設: ${facText} ／ POT: ${potText} ／ 表示: ${showDaily?"日別 ":""}${showMA?"7日平均":""}`;
}

// =======================================================
// タブ切替
// =======================================================
document.querySelectorAll(".tab-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab-btn").forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");
    const tab=btn.dataset.tab;
    document.querySelectorAll(".tab-content").forEach(sec=>sec.classList.remove("active"));
    document.getElementById(tab).classList.add("active");
  });
});
