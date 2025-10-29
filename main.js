// 依存: tfjs, human（CDN読み込み済み）

const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx = overlay.getContext('2d');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnCsv = document.getElementById('btnCsv');
const ckFront = document.getElementById('ckFront');
const statusEl = document.getElementById('status');
const tbody = document.getElementById('tbody');
const logEl = document.getElementById('log');

// Human設定（軽量＆リアルタイム寄り）
const human = new Human.Human({
  modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models',
  face: {
    detector: { rotation: true, maxDetected: 5 },
    mesh: false, iris: false,
    // ここを変更：属性とdescriptorの両方を有効化
    description: { enabled: true },   // 年齢・性別
    descriptor:  { enabled: true }    // 顔埋め込みベクトル
  },
  body: { enabled: false },
  hand: { enabled: false },
  gesture: { enabled: false },
  filter: { enabled: true, equalization: true },
});

// 店舗用シークレット（各端末で同じ値にする。任意の英数字でOK・公開しない）
// 例: 後で.env的に差し替えやすいように定数化
const SITE_SECRET = 'CHANGE_ME_TO_RANDOM_32CHARS';

// 今日の日付（端末のタイムゾーンでOK。必要ならJST固定に調整）
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

// 端末内ユニーク管理（localStorageに保存）
const uniqKey = () => `uniqHashes:${todayStr()}`;
function loadUniqSet() {
  try {
    const raw = localStorage.getItem(uniqKey());
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}
function saveUniqSet(set) {
  localStorage.setItem(uniqKey(), JSON.stringify([...set]));
}
let uniqSet = loadUniqSet();

// 日付が変わったら自動リセット
let currentDay = todayStr();
setInterval(() => {
  const t = todayStr();
  if (t !== currentDay) {
    currentDay = t;
    uniqSet = new Set();
    saveUniqSet(uniqSet);
    resetMinute();
  }
}, 60 * 1000);

async function hashFaceEmbedding(face) {
  // Human は face.descriptor または face.embedding を返す
  const emb = (face.descriptor || face.embedding);
  if (!emb || !Array.isArray(emb) || emb.length === 0) return null;

  // ノイズ低減：小数第2位で丸めて文字列化（端末差/フレーム差を吸収）
  const rounded = emb.map(v => Math.round(v * 100) / 100);
  const payload = JSON.stringify({
    r: rounded,
    d: todayStr(),         // 日替わりにする（翌日には別IDになる）
    s: SITE_SECRET         // 端末間で同じにするため共有シークレットを使う
  });

  const enc = new TextEncoder().encode(payload);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  // 先頭16バイトだけを使って短縮（十分衝突しにくい）
  const view = new DataView(buf);
  let out = '';
  for (let i = 0; i < 16; i++) out += view.getUint8(i).toString(16).padStart(2,'0');
  return out; // 32桁の短いハッシュ
}


// 集計：年齢層×性別
const buckets = ['child','10s','20s','30s','40s','50s','60s+']; // ざっくり
function toBucket(age) {
  if (age == null) return 'unknown';
  if (age < 13) return 'child';
  if (age < 20) return '10s';
  if (age < 30) return '20s';
  if (age < 40) return '30s';
  if (age < 50) return '40s';
  if (age < 60) return '50s';
  return '60s+';
}
const minuteCounts = {}; // { bucket: { male: n, female: n, unknown: n } }
function initCounts() {
  for (const b of [...buckets, 'unknown']) minuteCounts[b] = { male:0, female:0, unknown:0 };
}
initCounts();

let running = false;
let stream = null;
let rafId = null;
let lastTick = 0;

function renderTable() {
  const rows = [];
  for (const b of [...buckets, 'unknown']) {
    const c = minuteCounts[b];
    rows.push(`<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`);
  }
  tbody.innerHTML = rows.join('');
}

function resetMinute() {
  initCounts();
  renderTable();
}

async function startCamera() {
  const facing = ckFront.checked ? 'user' : 'environment';
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing } , width: {ideal: 640}, height: {ideal: 480} },
    audio: false
  });
  video.srcObject = stream;
  await video.play();

  overlay.width = video.videoWidth || 640;
  overlay.height = video.videoHeight || 480;

  running = true;
  btnStart.disabled = true;
  btnStop.disabled = false;
  statusEl.textContent = '実行中（オンデバイス推論・送信なし）';

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

async function loop(ts) {
  if (!running) return;

  // パフォーマンス節約：~10FPS程度に間引く
  if (ts && ts - lastTick < 100) {
    rafId = requestAnimationFrame(loop);
    return;
  }
  lastTick = ts || performance.now();

  await human.load(); // 初回のみ実質ロード
  const result = await human.detect(video);

  // 描画
  ctx.clearRect(0, 0, overlay.width, overlay.height);
  ctx.drawImage(video, 0, 0, overlay.width, overlay.height);

  // 顔ごとに処理
  const faces = result.face || [];
  for (const f of faces) {
  const box = f.box;
  const gender = f.gender || 'unknown';
  const genderScore = typeof f.genderScore === 'number' ? f.genderScore : 0;
  const age = typeof f.age === 'number' ? Math.round(f.age) : null;
  const bucket = toBucket(age);
  const gkey = (genderScore > 0.6)
    ? (gender.toLowerCase().startsWith('f') ? 'female' : 'male')
    : 'unknown';

  // ★ ユニーク判定：同じ人は「その日1回だけ」カウント
  const h = await hashFaceEmbedding(f);
  if (h && !uniqSet.has(h)) {
    uniqSet.add(h);
    saveUniqSet(uniqSet);
    minuteCounts[bucket][gkey] += 1;   // ← 初回だけカウント
  }

  // 表示はそのまま
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#00FF88';
  ctx.strokeRect(box[0], box[1], box[2], box[3]);
  const label = `${bucket} • ${gkey}` + (age ? ` (${age})` : '');
  ctx.fillStyle = 'rgba(0,0,0,0.5)';
  const tw = ctx.measureText(label).width + 10;
  ctx.fillRect(box[0], Math.max(0, box[1]-20), tw, 20);
  ctx.fillStyle = '#fff';
  ctx.fillText(label, box[0]+5, Math.max(12, box[1]-6));
}


  renderTable();
  logEl.textContent = `faces: ${faces.length}\nFPS approx: ${(1000 / (performance.now() - lastTick + 1)).toFixed(1)}`;

  rafId = requestAnimationFrame(loop);
}

// 1分ごとにカウントをクリア（「直近1分」集計として見る）
setInterval(resetMinute, 60 * 1000);

btnStart.addEventListener('click', async () => {
  try { await startCamera(); } 
  catch (e) { statusEl.textContent = 'カメラ開始に失敗: ' + e.message; }
});
btnStop.addEventListener('click', stopCamera);

btnCsv.addEventListener('click', () => {
  const lines = ['bucket,male,female,unknown'];
  for (const b of [...buckets, 'unknown']) {
    const c = minuteCounts[b];
    lines.push([b, c.male, c.female, c.unknown].join(','));
  }
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {href:url, download:`attributes_${Date.now()}.csv`});
  a.click(); URL.revokeObjectURL(url);
});

// ページ表示時の注意
if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)) {
  statusEl.textContent = 'このブラウザはカメラ取得に未対応です';
} else {
  statusEl.textContent = '「カメラ開始」を押してください（iPhoneはHTTPS必須）';
}
