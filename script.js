// /epiMRSA/script.js
// CSV(local) → ①時系列(選択UIあり) ②施設間比較(棒＋地図なしパイ) ③raw表示

let records = [];

// Chart instances
let timeCharts = [];
let barChart = null;
let pieCharts = {}; // key -> Chart

// 表示状態
let showDaily = true;
let showMA = true;
let selectedGroups = new Set(["ALL"]);  // ALLと施設名が入る
let selectedPots = new Set();           // CSV読み込み後に全POTで初期化。空ならPOT線なし

// 期間フィルタ（null=nullで全期間）
let selectedStartDate = null; // "YYYY-MM-DD" or null
let selectedEndDate = null;

// POT色
const POT_COLORS = {
  1: "#8FB3FF",
  2: "#5DD6C4",
  3: "#F7C56B",
  4: "#E989FF",
  5: "#FF8A7A"
};

// ===== Center text plugin for doughnut =====
const centerTextPlugin = {
  id: "centerText",
  afterDraw(chart, args, opts) {
    const { ctx, chartArea } = chart;
    if (!chartArea) return;
    const x = (chartArea.left + chartArea.right) / 2;
    const y = (chartArea.top + chartArea.bottom) / 2;
    ctx.save();
    ctx.font = `bold ${opts.fontSize || 14}px system-ui`;
    ctx.fillStyle = opts.color || "#111827";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(opts.text || "", x, y);
    ctx.restore();
  }
};
Chart.register(centerTextPlugin);

// ========== CSV読み込み ==========
document.getElementById("fileInput").addEventListener("change", handleCSV);

function handleCSV(e) {
  const files = Array.from(e.target.files);
  if (!files.length) return;

  // 1) まず records を空に（クリアして読み直す運用）
  records = [];

  let pending = files.length;

  files.forEach(file => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      const text = evt.target.result;
      const parsed = parseCSV(text).map(r => ({
        ...r,
        sourceFile: file.name   // 出自を記録
      }));
      // ★ 2) records に順次追加（重複は現時点で考えない）
      records = records.concat(parsed);

      pending--;
      if (pending === 0) {
        // ★ 3) 全ファイル読込み完了後に実行
        document.getElementById("loadStatus").textContent =
          `${files.length} ファイル読み込み・計 ${records.length} レコード`;

        showLoadedFileList(files);
        initSelectionsAfterLoad();
        updateAll();
      }
    };
    reader.readAsText(file);
  });
}

function showLoadedFileList(files) {
  const div = document.getElementById("fileList");
  if (!div) return;
  div.innerHTML = "<strong>読み込みファイル:</strong><br>" +
    files.map(f => `・${f.name}`).join("<br>");
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
  selectedPots = new Set(pots); // 初期は全POT表示

  selectedStartDate = null;
  selectedEndDate = null;

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
function filterRecordsByDate(recList){
  if(!selectedStartDate && !selectedEndDate) return recList;

  return recList.filter(r=>{
    const d = normalizeDate(r.date);
    if(selectedStartDate && d < selectedStartDate) return false;
    if(selectedEndDate && d > selectedEndDate) return false;
    return true;
  });
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
  drawFacilityPieGrid();
  showTable();
}

// =======================================================
// ① 時系列
//   - selectedPots が空なら POT補助線を出さない（総数のみ）
// =======================================================
function drawTimeSeries() {
  const wrap = document.getElementById("timeChartsWrap");
  if (!wrap) return;
  wrap.innerHTML = "";
  if (!records.length) return;
  const filteredRecords = filterRecordsByDate(records);

  const facilities = getFacilities();
  const potsAll = getPots();

  // 選択されたPOTだけ（空ならPOT線なし）
  const potList = selectedPots.size
    ? potsAll.filter(p => selectedPots.has(p))
    : [];

  // 選択されたグループを並べる
  const groups = [];
    if (selectedGroups.has("ALL")) {
    groups.push({ key:"ALL", label:"全体", data: filteredRecords });
    }
  facilities.forEach(f=>{
    if (selectedGroups.has(f)) {
      groups.push({
        key:f,
        label:`施設 ${f}`,
        data: filteredRecords.filter(r=>r.facility===f)
      });
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

    const datasets = [];

    // 総数日別
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

    // 総数7日平均
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

    // POT線（選択POTがある時だけ）
    if (potList.length > 0){
      const potDateCount = {};
      potList.forEach(p => potDateCount[p] = new Map());

      g.data.forEach(r=>{
        if (!selectedPots.has(r.pot)) return;
        const d = normalizeDate(r.date);
        potDateCount[r.pot].set(d, (potDateCount[r.pot].get(d)||0)+1);
      });

      potList.forEach((p,i)=>{
        const series = labels.map(d=>potDateCount[p].get(d)||0);
        datasets.push({
          label:`POT${p}`,
          data: series,
          borderColor: POT_COLORS[p] || `hsl(${i*60},70%,60%)`,
          borderWidth:1.5,
          tension:0,
          pointRadius:0,
          borderDash:[4,3]
        });
      });
    }

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
// ② 施設間比較：積み上げ棒（ALL + 各施設）
// =======================================================
function drawFacilityComparison() {
  if (!records.length) return;

  const facs = getFacilities();
  const potList = getPots();

  const facilityCounts = {};
  facs.forEach(f=>{
    facilityCounts[f] = {};
    potList.forEach(p=>facilityCounts[f][p] = 0);
  });
  records.forEach(r=>{
    facilityCounts[r.facility][r.pot]++;
  });

  // ALLを作る
  const allCounts = {};
  potList.forEach(p=>{
    allCounts[p] = facs.reduce((sum,f)=>sum + facilityCounts[f][p],0);
  });

  const labels = ["ALL", ...facs];

  const barData = {
    labels,
    datasets: potList.map((p,i)=>({
      label:`POT${p}`,
      data: labels.map(l=>{
        if(l==="ALL") return allCounts[p];
        return facilityCounts[l][p];
      }),
      backgroundColor: POT_COLORS[p] || `hsl(${i*60},70%,60%)`
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
      scales:{
        x:{ stacked:true },
        y:{ stacked:true, beginAtZero:true }
      }
    }
  });
}

// =======================================================
// ③ 施設間比較：地図なしパイ（グリッド）
//   - 施設ごと＋ALL
//   - 円の大きさは総数に比例（scale）
//   - 中央に施設名
// =======================================================
function drawFacilityPieGrid(){
  const grid = document.getElementById("facilityPieGrid");
  if(!grid) return;
  grid.innerHTML = "";
  if(!records.length) return;

  // 既存pie破棄
  Object.values(pieCharts).forEach(ch=>ch.destroy());
  pieCharts = {};

  const facs = getFacilities();
  const potList = getPots();

  // counts作成
  const facilityCounts = {};
  facs.forEach(f=>{
    facilityCounts[f] = {};
    potList.forEach(p=>facilityCounts[f][p] = 0);
  });
  records.forEach(r=>{
    facilityCounts[r.facility][r.pot]++;
  });

  const allCounts = {};
  potList.forEach(p=>{
    allCounts[p] = facs.reduce((sum,f)=>sum + facilityCounts[f][p],0);
  });

  const groups = ["ALL", ...facs];

  // 総数（サイズ計算用）
  const totals = groups.map(g=>{
    const obj = (g==="ALL") ? allCounts : facilityCounts[g];
    return potList.reduce((s,p)=>s+obj[p],0);
  });
  const maxTotal = Math.max(...totals, 1);

  groups.forEach((g, idx)=>{
    const obj = (g==="ALL") ? allCounts : facilityCounts[g];
    const dataArr = potList.map(p=>obj[p]);

    const total = totals[idx];
    const scale = 0.6 + 0.8*(total/maxTotal); // 0.6〜1.4くらい

    const card = document.createElement("div");
    card.className = "pie-card";
    card.innerHTML = `<canvas class="pie-canvas"></canvas>`;
    grid.appendChild(card);

    const canvas = card.querySelector("canvas");
    canvas.style.transform = `scale(${scale.toFixed(2)})`;

    const chart = new Chart(canvas, {
      type: "doughnut",
      data: {
        labels: potList.map(p=>`POT${p}`),
        datasets: [{
          data: dataArr,
          backgroundColor: potList.map(p=>POT_COLORS[p] || "#94a3b8"),
          borderWidth: 1
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { enabled: true },
          centerText: {
            text: (g==="ALL") ? "ALL" : g,
            fontSize: 16,
            color: "#0f172a"
          }
        },
        cutout: "62%"
      }
    });

    pieCharts[g] = chart;

    // 施設名＋総数を下にうっすら
    const label = document.createElement("div");
    label.style.marginTop = "6px";
    label.style.fontSize = "0.85rem";
    label.style.color = "#475569";
    label.textContent = `${(g==="ALL")?"全体":("施設 "+g)}（n=${total}）`;
    card.appendChild(label);
  });
}

// =======================================================
// ④ raw表示
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
  if(!showDaily && !showMA){
    showMA=true;
    toggleMABtn.classList.add("active");
  }
  updateSelectionText();
  drawTimeSeries();
});
toggleMABtn.addEventListener("click", ()=>{
  showMA = !showMA;
  toggleMABtn.classList.toggle("active", showMA);
  if(!showDaily && !showMA){
    showDaily=true;
    toggleDailyBtn.classList.add("active");
  }
  updateSelectionText();
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
    const checked = selectedGroups.has(key);

    const el = document.createElement("label");
    el.innerHTML =
      `<input type="checkbox" data-key="${key}" ${checked?"checked":""}> ${label}`;
    box.appendChild(el);
  });
}

document.getElementById("facilityAllOn").addEventListener("click", ()=>{
  document.querySelectorAll("#facilityOptions input")
    .forEach(cb=>cb.checked=true);
});
document.getElementById("facilityAllOff").addEventListener("click", ()=>{
  document.querySelectorAll("#facilityOptions input")
    .forEach(cb=>cb.checked=false);
});

document.getElementById("facilityApply").addEventListener("click", ()=>{
  const newSet = new Set();
  document.querySelectorAll("#facilityOptions input").forEach(cb=>{
    if(cb.checked) newSet.add(cb.dataset.key);
  });
  if(newSet.size===0) newSet.add("ALL"); // 全解除防止（施設は最低1つ）
  selectedGroups = newSet;
  closeModal(facilityModal);
  updateSelectionText();
  drawTimeSeries();
});

// =======================================================
// UI：POTモーダル
//   - 全解除OK → POT線なし（総数のみ）
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
    const checked = selectedPots.has(p);
    const el = document.createElement("label");
    el.innerHTML =
      `<input type="checkbox" data-pot="${p}" ${checked?"checked":""}> POT${p}`;
    box.appendChild(el);
  });
}

document.getElementById("potAllOn").addEventListener("click", ()=>{
  document.querySelectorAll("#potOptions input")
    .forEach(cb=>cb.checked=true);
});
document.getElementById("potAllOff").addEventListener("click", ()=>{
  document.querySelectorAll("#potOptions input")
    .forEach(cb=>cb.checked=false);
});

document.getElementById("potApply").addEventListener("click", ()=>{
  const newSet = new Set();
  document.querySelectorAll("#potOptions input").forEach(cb=>{
    if(cb.checked) newSet.add(Number(cb.dataset.pot));
  });
  // newSetが空なら「POT線なし」として空のまま採用
  selectedPots = newSet;

  closeModal(potModal);
  updateSelectionText();
  drawTimeSeries();
});

// =======================================================
// UI：期間モーダル
// =======================================================
const periodModal = document.getElementById("periodModal");
const periodBtn = document.getElementById("periodSelectBtn");
const periodStartInput = document.getElementById("periodStart");
const periodEndInput = document.getElementById("periodEnd");

if(periodBtn && periodModal){
  periodBtn.addEventListener("click", ()=>{
    if(!records.length) return;

    // 現在値をモーダルに反映
    periodStartInput.value = selectedStartDate || "";
    periodEndInput.value = selectedEndDate || "";

    openModal(periodModal);
  });
}

document.getElementById("periodReset").addEventListener("click", ()=>{
  selectedStartDate = null;
  selectedEndDate = null;
  periodStartInput.value = "";
  periodEndInput.value = "";
  closeModal(periodModal);
  updateSelectionText();
  drawTimeSeries();
});

document.getElementById("periodApply").addEventListener("click", ()=>{
  const s = periodStartInput.value || null;
  const e = periodEndInput.value || null;

  // start > end の場合は入れ替え
  if(s && e && s > e){
    selectedStartDate = e;
    selectedEndDate = s;
  } else {
    selectedStartDate = s;
    selectedEndDate = e;
  }

  closeModal(periodModal);
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

  const potText = selectedPots.size
    ? Array.from(selectedPots).sort((a,b)=>a-b).map(p=>"POT"+p).join(", ")
    : "なし（総数のみ）";

const periodText =
  (!selectedStartDate && !selectedEndDate)
    ? "全期間"
    : `${selectedStartDate || "…"} 〜 ${selectedEndDate || "…"}`;

document.getElementById("currentSelection").textContent =
  `施設: ${facText} ／ POT: ${potText} ／ 期間: ${periodText} ／ 表示: ${showDaily?"日別 ":""}${showMA?"7日平均":""}`;

}

// =======================================================
// タブ切替
// =======================================================
document.querySelectorAll(".tab-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    document.querySelectorAll(".tab-btn")
      .forEach(b=>b.classList.remove("active"));
    btn.classList.add("active");

    const tab=btn.dataset.tab;
    document.querySelectorAll(".tab-content")
      .forEach(sec=>sec.classList.remove("active"));
    document.getElementById(tab).classList.add("active");
  });
});
