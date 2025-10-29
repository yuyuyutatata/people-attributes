// ===================== main.js（安定化ユニーク版） =====================
// 依存CDNは index.html 側で読み込み済み：tfjs, human
//   <script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/@vladmandic/human/dist/human.js"></script>

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

// ------- パラメータ（必要に応じて調整） -------
const SITE_SECRET   = 'CHANGE_ME_TO_RANDOM_32CHARS'; // 端末間で同値（公開しない）
const STABLE_FRAMES = 8;          // 何フレーム連続で安定したらユニーク確定にするか
const COS_THRESHOLD = 0.98;       // 連続埋め込みの類似度しきい値
const MATCH_PIX     = 80;         // トラック割り当ての許容距離（px）
const PURGE_MS      = 4000;       // この時間見失ったトラックは破棄
const MIN_BOX       = 90;         // 顔ボックスの最小幅/高さ（小さすぎる顔は無視）
const MIN_SCORE     = 0.2;        // 顔品質スコアの下限

// ------- Human 初期化（属性＋descriptor） -------
const human = new Human.Human({
  modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models',
  face: {
    detector:  { rotation: true, maxDetected: 5 },
    mesh: false, iris: false,
    description: { enabled: true }, // 年齢・性別
    descriptor:  { enabled: true }  // 顔ベクトル
  },
  body: { enabled: false },
  hand: { enabled: false },
  gesture: { enabled: false },
  filter: { enabled: true, equalization: true },
});

// ------- 日付・ユニーク管理（端末内） -------
function todayStr() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd= String(d.getDate()).padStart(2,'0');
  return `${y}-${m}-${dd}`;
}
const uniqKey = () => `uniqHashes:${todayStr()}`;
let uniqSet = loadUniqSet();
function loadUniqSet() {
  try { return new Set(JSON.parse(localStorage.getItem(uniqKey())||'[]')); }
  catch { return new Set(); }
}
function saveUniqSet(set) { localStorage.setItem(uniqKey(), JSON.stringify([...set])); }
let currentDay = todayStr();
setInterval(() => {
  const t = todayStr();
  if (t !== currentDay) { currentDay = t; uniqSet = new Set(); saveUniqSet(uniqSet); resetMinute(); }
}, 60*1000);

// ------- 集計（直近1分：日内初回のみ加算） -------
const buckets = ['child','10s','20s','30s','40s','50s','60s+'];
const minuteCounts = {};
function toBucket(age){
  if (age == null) return 'unknown';
  if (age < 13) return 'child';
  if (age < 20) return '10s';
  if (age < 30) return '20s';
  if (age < 40) return '30s';
  if (age < 50) return '40s';
  if (age < 60) return '50s';
  return '60s+';
}
function initCounts(){ for (const b of [...buckets,'unknown']) minuteCounts[b]={male:0,female:0,unknown:0}; }
function renderTable(){
  const rows = [];
  for (const b of [...buckets,'unknown']) {
    const c = minuteCounts[b];
    rows.push(`<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`);
  }
  tbody.innerHTML = rows.join('');
}
function resetMinute(){ initCounts(); renderTable(); }
initCounts(); renderTable();
setInterval(resetMinute, 60*1000);

// ------- ユーティリティ（埋め込み類似度・平均） -------
function cosineSim(a,b){
  let dot=0, na=0, nb=0;
  const n = Math.min(a.length, b.length);
  for (let i=0;i<n;i++){ const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
  return dot / (Math.sqrt(na)*Math.sqrt(nb) + 1e-12);
}
function meanEmbedding(buf){
  const n = buf.length, d = buf[0].length;
  const out = new Array(d).fill(0);
  for (const v of buf){ for (let i=0;i<d;i++) out[i]+=v[i]; }
  for (let i=0;i<d;i++) out[i]/=n;
  return out;
}

// ------- 匿名ハッシュ（平均埋め込み→丸め→SHA-256） -------
async function hashFromEmbedding(emb){
  // 丸め（0.02刻み）で端末/フレーム差をさらに吸収
  const rounded = emb.map(v => Math.round(v * 50) / 50);
  const payload = JSON.stringify({ r: rounded, d: todayStr(), s: SITE_SECRET, v:2 });
  const enc = new TextEncoder().encode(payload);
  const buf = await crypto.subtle.digest('SHA-256', enc);
  const view = new DataView(buf);
  let out=''; for (let i=0;i<16;i++) out += view.getUint8(i).toString(16).padStart(2,'0');
  return out; // 32桁
}

// ------- 簡易トラッキング（位置近接） -------
let nextTrackId = 1;
const tracks = new Map(); // id -> { cx, cy, lastSeen, counted, embBuf:[], genderKey, ageBucket }

function assignTrack(face){
  const [x,y,w,h] = face.box;
  const cx = x + w/2, cy = y + h/2;
  let bestId=null, bestDist=Infinity;
  for (const [id,t] of tracks){
    const d = Math.hypot(t.cx - cx, t.cy - cy);
    if (d < bestDist){ bestDist=d; bestId=id; }
  }
  if (bestDist <= MATCH_PIX){
    const t = tracks.get(bestId);
    t.cx = cx; t.cy = cy; t.lastSeen = performance.now();
    return bestId;
  } else {
    const id = nextTrackId++;
    tracks.set(id, { cx, cy, lastSeen: performance.now(), counted:false, embBuf:[], genderKey:'unknown', ageBucket:'unknown' });
    return id;
  }
}
function purgeOldTracks(){
  const now = performance.now();
  for (const [id,t] of tracks){
    if (now - t.lastSeen > PURGE_MS) tracks.delete(id);
  }
}

// ------- 実行ループ -------
let running=false, stream=null, rafId=null, lastTick=0;

async function startCamera(){
  await human.load(); // 先にロード
  const facing = ckFront.checked ? 'user' : 'environment';
  stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480} }, audio:false
  });
  video.srcObject = stream; await video.play();
  overlay.width = video.videoWidth || 640;
  overlay.height= video.videoHeight|| 480;

  running=true; btnStart.disabled=true; btnStop.disabled=false;
  statusEl.textContent='実行中（オンデバイス推論・送信なし）';
  loop();
}
function stopCamera(){
  running=false;
  if (rafId) cancelAnimationFrame(rafId);
  if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  btnStart.disabled=false; btnStop.disabled=true;
  statusEl.textContent='停止';
}

async function loop(ts){
  if (!running) return;
  if (ts && ts - lastTick < 100){ rafId=requestAnimationFrame(loop); return; }
  lastTick = ts || performance.now();

  const result = await human.detect(video);

  // 画面描画
  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.drawImage(video,0,0,overlay.width,overlay.height);

  const faces = result.face || [];
  for (const f of faces){
    const [x,y,w,h] = f.box;
    const q = f.faceScore ?? 1;

    // 小さすぎる/品質低は無視（ハッシュがブレやすい）
    if (w < MIN_BOX || h < MIN_BOX || q < MIN_SCORE) {
      // 描画だけしてスキップ
      drawBox(f, 'weak');
      continue;
    }

    const id = assignTrack(f);
    const tr = tracks.get(id);

    // 属性
    const gender = (f.gender || 'unknown').toLowerCase();
    const gscore = typeof f.genderScore === 'number' ? f.genderScore : 0;
    tr.genderKey = (gscore > 0.6) ? (gender.startsWith('f') ? 'female' : 'male') : 'unknown';
    const age  = typeof f.age === 'number' ? Math.round(f.age) : null;
    tr.ageBucket = toBucket(age);

    // 埋め込みをバッファに蓄積（正規化）
    const emb = (f.descriptor || f.embedding);
    if (Array.isArray(emb) && emb.length > 0) tr.embBuf.push(emb);

    // まだカウントしていないトラックだけ、安定化チェック
    if (!tr.counted && tr.embBuf.length >= STABLE_FRAMES){
      // 直近 STABLE_FRAMES で安定しているか？
      const recent = tr.embBuf.slice(-STABLE_FRAMES);
      let ok = true;
      for (let i=1;i<recent.length;i++){
        const sim = cosineSim(recent[i-1], recent[i]);
        if (sim < COS_THRESHOLD){ ok=false; break; }
      }
      if (ok){
        const meanEmb = meanEmbedding(recent);
        const hsh = await hashFromEmbedding(meanEmb);
        if (hsh && !uniqSet.has(hsh)){
          // 当日ユニークとして確定：1回だけ加算
          minuteCounts[tr.ageBucket][tr.genderKey] += 1;
          uniqSet.add(hsh); saveUniqSet(uniqSet);
          tr.counted = true;
        } else {
          // 既に同一人物として登録済み → 加算しない
          tr.counted = true;
        }
      }
    }

    // 枠とラベル
    drawBox(f, tr.counted ? 'counted' : 'tracking', tr.ageBucket, tr.genderKey, age);
  }

  purgeOldTracks();
  renderTable();
  const fps = (1000 / (performance.now() - lastTick + 1)).toFixed(1);
  logEl.textContent = `faces: ${faces.length}\nFPS approx: ${fps}`;

  rafId = requestAnimationFrame(loop);
}

function drawBox(f, mode='tracking', bucket='unknown', gkey='unknown', age=null){
  const [x,y,w,h] = f.box;
  ctx.lineWidth = 2;
  ctx.strokeStyle = (mode==='counted') ? '#00FF88' : (mode==='weak' ? '#FFA500' : '#3fa9f5');
  ctx.strokeRect(x,y,w,h);
  const label = (mode==='counted'?'✔ ':'') + `${bucket} • ${gkey}` + (age?` (${age})`:'');
  ctx.fillStyle='rgba(0,0,0,0.5)';
  const tw = ctx.measureText(label).width + 10;
  ctx.fillRect(x, Math.max(0,y-20), tw, 20);
  ctx.fillStyle='#fff';
  ctx.fillText(label, x+5, Math.max(12, y-6));
}

// ------- UI -------
btnStart.addEventListener('click', async ()=>{ try{ await startCamera(); } catch(e){ statusEl.textContent='カメラ開始に失敗: '+e.message; }});
btnStop .addEventListener('click', stopCamera);
btnCsv  .addEventListener('click', () => {
  const lines = ['bucket,male,female,unknown'];
  for (const b of [...buckets,'unknown']) {
    const c = minuteCounts[b];
    lines.push([b,c.male,c.female,c.unknown].join(','));
  }
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url  = URL.createObjectURL(blob);
  const a    = Object.assign(document.createElement('a'), { href:url, download:`attributes_${todayStr()}.csv` });
  a.click(); URL.revokeObjectURL(url);
});

if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)) {
  statusEl.textContent = 'このブラウザはカメラ取得に未対応です';
} else {
  statusEl.textContent = '「カメラ開始」を押してください（iPhoneはHTTPS必須）';
}
// ===================== /main.js =====================
