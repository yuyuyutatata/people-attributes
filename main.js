// ===================== main.js（置き換え用 完全版） =====================
// 依存: index.htmlで tfjs と human をCDN読み込み済みであること
//   <script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/@vladmandic/human/dist/human.js"></script>
// （端末間ユニークにする場合のみ）
//   <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>

const video   = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx     = overlay.getContext('2d');
const btnStart= document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnCsv  = document.getElementById('btnCsv');
const ckFront = document.getElementById('ckFront');
const statusEl= document.getElementById('status');
const tbody   = document.getElementById('tbody');
const logEl   = document.getElementById('log');

// ---------- 設定 ----------
const SITE_SECRET = 'CHANGE_ME_TO_RANDOM_32CHARS'; // 端末間で同じ値を入れる（公開しない）
const USE_SUPABASE = false;                         // 端末間ユニークにするなら true
const SUPABASE_URL  = 'https://xxxxxxxxxxxx.supabase.co';
const SUPABASE_ANON = 'eyJhbGciOi...';

let sb = null;
if (USE_SUPABASE && window.supabase) {
  sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON);
}

// ---------- Human 初期化（属性＋顔ベクトル） ----------
const human = new Human.Human({
  modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models',
  face: {
    detector:  { rotation: true, maxDetected: 5 },
    mesh: false, iris: false,
    description: { enabled: true }, // 年齢・性別
    descriptor:  { enabled: true }  // 顔ベクトル（ユニーク判定に使用）
  },
  body: { enabled: false },
  hand: { enabled: false },
  gesture: { enabled: false },
  filter: { enabled: true, equalization: true },
});

// ---------- 日付・ユニーク管理 ----------
function todayStr() {
  const d = new Date(); // 必要ならJST固定に調整可
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const day = String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${day}`;
}

const uniqKey = () => `uniqHashes:${todayStr()}`;
let uniqSet = loadUniqSet();

function loadUniqSet() {
  try {
    const raw = localStorage.getItem(uniqKey());
    return new Set(raw ? JSON.parse(raw) : []);
  } catch { return new Set(); }
}
function saveUniqSet(set) {
  localStorage.setItem(uniqKey(), JSON.stringify([...set]));
}

// 日付が変わったらリセット
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

// 顔ベクトル→匿名ハッシュ（日替わり）
// ・小数丸めでフレーム差/端末差を吸収
// ・日付＋シークレットを混ぜ、日をまたぐと別ID扱い
async function hashFaceEmbedding(face) {
  const emb = (face.descriptor || face.embedding);
  if (!emb || !Array.isArray(emb) || emb.length === 0) return null;

  // サイズ/品質が低い顔は除外（誤判定抑制）
  const [x,y,w,h] = face.box;
  if (w < 80 || h < 80) return null;                // 小さすぎる
  if (face.faceScore && face.faceScore < 0.2) return null; // 品質低

  const rounded = emb.map(v => Math.round(v * 100) / 100);  // 小数2桁
  const payload = JSON.stringify({
    r: rounded,
    d: todayStr(),
    s: SITE_SECRET,
    v: 1 // バージョン
  });

  const enc = new TextEncoder().encode(payload);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  let out = '';
  const view = new DataView(buf);
  for (let i = 0; i < 16; i++) out += view.getUint8(i).toString(16).padStart(2,'0'); // 32桁
  return out;
}

// 端末間ユニーク（Supabase）: その日そのハッシュが未登録なら登録
async function checkAndInsertRemoteUnique(hash) {
  if (!sb) return null; // 端末内のみ
  try {
    const { error } = await sb.from('daily_uniques').insert({ day: todayStr(), hash }).select();
    if (error) {
      // 既存 or エラー
      const msg = String(error.message).toLowerCase();
      if (msg.includes('duplicate') || msg.includes('unique') || msg.includes('primary')) return false;
      return null; // 通信等の失敗 → 端末内判定にフォールバック
    }
    return true; // 新規として登録できた
  } catch {
    return null;
  }
}

// ---------- 集計（表は「直近1分のユニーク初回のみ」増加） ----------
const buckets = ['child','10s','20s','30s','40s','50s','60s+'];
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
const minuteCounts = {}; // { bucket: { male, female, unknown } }
function initCounts() {
  for (const b of [...buckets, 'unknown']) minuteCounts[b] = { male:0, female:0, unknown:0 };
}
initCounts();

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
setInterval(resetMinute, 60 * 1000);

// ---------- 実行ループ ----------
let running = false;
let stream  = null;
let rafId   = null;
let lastTick= 0;

async function startCamera() {
  // モデルはここで一度だけロード
  await human.load();

  const facing = ckFront.checked ? 'user' : 'environment';
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false
  });
  video.srcObject = stream;
  await video.play();

  overlay.width  = video.videoWidth  || 640;
  overlay.height = video.videoHeight || 480;

  running = true;
  btnStart.disabled = true;
  btnStop.disabled  = false;
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
  btnStop.disabled  = true;
  statusEl.textContent = '停止';
}

async function loop(ts) {
  if (!running) return;

  // ~10FPSに間引き
  if (ts && ts - lastTick < 100) { rafId = requestAnimationFrame(loop); return; }
  lastTick = ts || performance.now();

  const result = await human.detect(video);

  // 描画
  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.drawImage(video, 0, 0, overlay.width, overlay.height);

  const faces = result.face || [];
  for (const f of faces) {
    // 年齢・性別の読み出し
    const gender = (f.gender || 'unknown').toLowerCase();
    const score  = typeof f.genderScore === 'number' ? f.genderScore : 0;
    const age    = typeof f.age === 'number' ? Math.round(f.age) : null;
    const bucket = toBucket(age);
    const gkey   = (score > 0.6) ? (gender.startsWith('f') ? 'female' : 'male') : 'unknown';

    // ---- ユニーク判定（端末内 + 端末間オプション） ----
    const h = await hashFaceEmbedding(f);
    if (h) {
      let shouldCount = false;

      if (!uniqSet.has(h)) {
        // 端末内では初回
        if (sb) {
          const remote = await checkAndInsertRemoteUnique(h);
          if (remote === true) {
            // 端末間でも初回
            shouldCount = true;
          } else if (remote === false) {
            // 既に別端末でカウント済み → 加算しない
            shouldCount = false;
          } else {
            // 通信不調 → 端末内初回として加算（運用に応じてfalseでもOK）
            shouldCount = true;
          }
        } else {
          // 端末内ユニークのみ
          shouldCount = true;
        }
        uniqSet.add(h);
        saveUniqSet(uniqSet);
      }

      if (shouldCount) {
        minuteCounts[bucket][gkey] += 1; // ← “その人の当日初回”だけ増える
      }
    }

    // 枠とラベル
    const [x,y,w,hBox] = f.box;
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#00FF88';
    ctx.strokeRect(x, y, w, hBox);
    const label = `${bucket} • ${gkey}` + (age ? ` (${age})` : '');
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    const tw = ctx.measureText(label).width + 10;
    ctx.fillRect(x, Math.max(0, y-20), tw, 20);
    ctx.fillStyle = '#fff';
    ctx.fillText(label, x+5, Math.max(12, y-6));
  }

  renderTable();
  const fps = (1000 / (performance.now() - lastTick + 1)).toFixed(1);
  logEl.textContent = `faces: ${faces.length}\nFPS approx: ${fps}`;

  rafId = requestAnimationFrame(loop);
}

// ---------- UI ----------
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
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href:url, download:`attributes_${todayStr()}.csv` });
  a.click(); URL.revokeObjectURL(url);
});

// ページ表示時の注意
if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)) {
  statusEl.textContent = 'このブラウザはカメラ取得に未対応です';
} else {
  statusEl.textContent = '「カメラ開始」を押してください（iPhoneはHTTPS必須）';
}
// ===================== /main.js =====================
