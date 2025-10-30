// ----------------------------------------------------
// main.js : Humanによる年齢・性別属性推定＋ユニーク集計
// ----------------------------------------------------

const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnCsv = document.getElementById('btnCsv');
const ckFront = document.getElementById('ckFront');
const statusEl = document.getElementById('status');
const tbody = document.getElementById('tbody');
const logEl = document.getElementById('log');

// 非表示のvideoを生成（カメラ入力専用）
const video = document.createElement('video');
video.id = 'video';
video.playsInline = true;
video.muted = true;
document.body.appendChild(video);

// Human設定
const human = new Human.Human({
  modelBasePath: './models', // ローカルモデル利用
  face: {
    detector: { rotation: true, maxDetected: 5 },
    mesh: false, iris: false,
    description: { enabled: true },
    descriptor: { enabled: true }
  },
  body: { enabled: false },
  hand: { enabled: false },
  gesture: { enabled: false },
  filter: { enabled: true, equalization: true }
});

// ----------------------------------------------------
// 集計関連
// ----------------------------------------------------
const buckets = ['child', '10s', '20s', '30s', '40s', '50s', '60s+', 'unknown'];
const minuteCounts = {};
function initCounts() {
  for (const b of buckets) {
    minuteCounts[b] = { male: 0, female: 0, unknown: 0 };
  }
}
initCounts();

function renderTable() {
  tbody.innerHTML = buckets.map(b => {
    const c = minuteCounts[b];
    return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
  }).join('');
}
renderTable();

function resetMinute() {
  initCounts();
  renderTable();
}
setInterval(resetMinute, 60 * 1000);

function toBucket(age) {
  if (!age) return 'unknown';
  if (age < 13) return 'child';
  if (age < 20) return '10s';
  if (age < 30) return '20s';
  if (age < 40) return '30s';
  if (age < 50) return '40s';
  if (age < 60) return '50s';
  return '60s+';
}

// ----------------------------------------------------
// ユニーク判定
// ----------------------------------------------------
const SITE_SECRET = 'FIXED_SECRET_12345';
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function loadUniqSet() {
  try {
    const raw = localStorage.getItem(todayStr());
    return new Set(raw ? JSON.parse(raw) : []);
  } catch {
    return new Set();
  }
}
function saveUniqSet(set) {
  localStorage.setItem(todayStr(), JSON.stringify([...set]));
}
let uniqSet = loadUniqSet();

async function hashFaceEmbedding(face) {
  const emb = face.descriptor || face.embedding;
  if (!emb || !Array.isArray(emb)) return null;
  const rounded = emb.map(v => Math.round(v * 100) / 100);
  const payload = JSON.stringify({ r: rounded, d: todayStr(), s: SITE_SECRET });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const view = new DataView(buf);
  let out = '';
  for (let i = 0; i < 16; i++) out += view.getUint8(i).toString(16).padStart(2, '0');
  return out;
}

// ----------------------------------------------------
// カメラ制御
// ----------------------------------------------------
let running = false;
let stream = null;
let rafId = null;

async function startCamera() {
  const facing = ckFront.checked ? 'user' : 'environment';
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false
  });
  video.srcObject = stream;
  await video.play();

  overlay.width = video.videoWidth || 640;
  overlay.height = video.videoHeight || 480;

  running = true;
  btnStart.disabled = true;
  btnStop.disabled = false;
  statusEl.textContent = '実行中（ローカルモデル・ユニーク集計）';

  loop();
}

function stopCamera() {
  running = false;
  if (rafId) cancelAnimationFrame(rafId);
  if (stream) {
    stream.getTracks().forEach(t => t.stop());
    stream = null;
  }
  btnStart.disabled = false;
  btnStop.disabled = true;
  statusEl.textContent = '停止';
}

// ----------------------------------------------------
// メインループ
// ----------------------------------------------------
async function loop() {
  if (!running) return;

  await human.load();
  const result = await human.detect(video);

  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.drawImage(video, 0, 0, overlay.width, overlay.height);

  const faces = result.face || [];
  for (const f of faces) {
    const age = f.age ? Math.round(f.age) : null;
    const gender = f.gender || 'unknown';
    const gkey = gender.toLowerCase().startsWith('f') ? 'female' : 'male';
    const bucket = toBucket(age);

    const h = await hashFaceEmbedding(f);
    if (h && !uniqSet.has(h)) {
      uniqSet.add(h);
      saveUniqSet(uniqSet);
      minuteCounts[bucket][gkey] += 1;
    }

    const box = f.box;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#00FF88';
    ctx.strokeRect(box[0], box[1], box[2], box[3]);
    const label = `${bucket} • ${gkey}` + (age ? ` (${age})` : '');
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(box[0], Math.max(0, box[1] - 20), ctx.measureText(label).width + 10, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, box[0] + 5, Math.max(12, box[1] - 6));
  }

  renderTable();
  logEl.textContent = `faces: ${faces.length}\nユニーク人数: ${uniqSet.size}`;

  rafId = requestAnimationFrame(loop);
}

// ----------------------------------------------------
// ボタン制御
// ----------------------------------------------------
btnStart.addEventListener('click', async () => {
  try {
    await startCamera();
  } catch (e) {
    statusEl.textContent = 'カメラ開始に失敗: ' + e.message;
  }
});
btnStop.addEventListener('click', stopCamera);

btnCsv.addEventListener('click', () => {
  const lines = ['bucket,male,female,unknown'];
  for (const b of buckets) {
    const c = minuteCounts[b];
    lines.push([b, c.male, c.female, c.unknown].join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), { href: url, download: `attributes_${Date.now()}.csv` });
  a.click();
  URL.revokeObjectURL(url);
});

// ----------------------------------------------------
// 初期メッセージ
// ----------------------------------------------------
if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)) {
  statusEl.textContent = 'このブラウザはカメラ取得に未対応です';
} else {
  statusEl.textContent = '「カメラ開始」を押してください（HTTPS必須）';
}
