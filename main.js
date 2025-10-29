// ===== main.js (確実加算・即時描画・デバッグ付き) =====
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

// 画面下に“今日のユニーク合計”表示を追加（index.html に要 <div id="total"></div>）
let totalEl = document.getElementById('total');
if (!totalEl) {
  totalEl = document.createElement('div');
  totalEl.id = 'total';
  totalEl.style.marginTop = '8px';
  totalEl.style.fontSize = '14px';
  document.body.appendChild(totalEl);
}

// ---- パラメータ ----
const SITE_SECRET      = 'CHANGE_ME_TO_RANDOM_32CHARS';
const MATCH_PIX        = 90;
const MIN_BOX          = 70;
const MIN_SCORE        = 0.05;
const COUNT_DELAY_MS   = 800;   // フォールバック加算の滞在時間
const STABLE_FRAMES    = 5;     // 埋め込み安定判定
const COS_THRESHOLD    = 0.975; // 類似度しきい値
const TARGET_FPS       = 12;    // 推論間引き

// ---- Human ----
const human = new Human.Human({
  modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models',
  face: {
    detector: { rotation: true, maxDetected: 5 },
    mesh: false, iris: false,
    description: { enabled: true },
    descriptor:  { enabled: true }
  },
  filter: { enabled: true, equalization: true },
  body: { enabled: false }, hand: { enabled: false }, gesture: { enabled: false },
});

// ---- 日付 & ユニーク管理 ----
function todayStr(){
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const uniqKey = () => `uniqHashes:${todayStr()}`;
let uniqSet = new Set(JSON.parse(localStorage.getItem(uniqKey()) || '[]'));
function saveUniq(){ localStorage.setItem(uniqKey(), JSON.stringify([...uniqSet])); }

// ---- テーブル（直近1分）----
const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
const minuteCounts = {}; resetMinute();
function toBucket(age){
  if (!(age > 0)) return 'unknown';
  if (age < 13) return 'child';
  if (age < 20) return '10s';
  if (age < 30) return '20s';
  if (age < 40) return '30s';
  if (age < 50) return '40s';
  if (age < 60) return '50s';
  return '60s+';
}
function renderTable(){
  tbody.innerHTML = buckets.map(b=>{
    const c = minuteCounts[b];
    return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
  }).join('');
  // 今日のユニーク合計
  totalEl.textContent = `今日のユニーク合計: ${uniqSet.size} 人`;
}
function resetMinute(){
  for (const b of buckets) minuteCounts[b] = { male:0, female:0, unknown:0 };
  renderTable();
}
setInterval(()=>{
  // 日またぎ検知（キーが変わると localStorage のキーも変わる）
  const k = uniqKey();
  if (!localStorage.getItem(k)) { uniqSet = new Set(); saveUniq(); }
  resetMinute();
}, 60*1000);

// ---- ユーティリティ ----
function cosineSim(a,b){
  let dot=0,na=0,nb=0; const n=Math.min(a.length,b.length);
  for (let i=0;i<n;i++){ const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
  return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-12);
}
function meanVec(arr){
  const n=arr.length, d=arr[0].length, out=new Array(d).fill(0);
  for (const v of arr){ for (let i=0;i<d;i++) out[i]+=v[i]; }
  for (let i=0;i<d;i++) out[i]/=n; return out;
}
async function hashEmbedding(emb){
  const rounded = emb.map(v => Math.round(v*50)/50); // 0.02刻み
  const payload = JSON.stringify({ r: rounded, d: todayStr(), s: SITE_SECRET, v:3 });
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const dv  = new DataView(buf); let out='';
  for (let i=0;i<16;i++) out += dv.getUint8(i).toString(16).padStart(2,'0');
  return out;
}

// ---- 簡易トラッカー ----
let nextId=1;
const tracks = new Map(); // id -> {cx,cy,firstSeen,lastSeen,counted,embBuf,gender,bucket,age}
function assignTrack(face){
  const [x,y,w,h]=face.box, cx=x+w/2, cy=y+h/2;
  let best=null, bestDist=Infinity;
  for (const [id,t] of tracks){
    const d=Math.hypot(t.cx-cx,t.cy-cy);
    if (d<bestDist){bestDist=d;best=id;}
  }
  if (best && bestDist<=MATCH_PIX){
    const t=tracks.get(best); t.cx=cx; t.cy=cy; t.lastSeen=performance.now(); return best;
  }
  const id=nextId++;
  tracks.set(id,{cx,cy,firstSeen:performance.now(),lastSeen:performance.now(),
    counted:false,embBuf:[],gender:'unknown',bucket:'unknown',age:null});
  return id;
}
function purgeOld(){
  const now=performance.now();
  for (const [id,t] of tracks){ if (now - t.lastSeen > 4000) tracks.delete(id); }
}

// ---- ループ ----
let running=false, stream=null, rafId=null, lastTick=0;
const frameGap = Math.max(1000/TARGET_FPS, 60);

async function startCamera(){
  await human.load(); await human.warmup(); // モデル確実ロード
  const facing = ckFront.checked ? 'user' : 'environment';
  stream = await navigator.mediaDevices.getUserMedia({
    video:{facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480}}, audio:false
  });
  video.srcObject=stream; await video.play();
  overlay.width = video.videoWidth  || 640;
  overlay.height= video.videoHeight || 480;
  running=true; btnStart.disabled=true; btnStop.disabled=false;
  statusEl.textContent='実行中（ユニーク集計）';
  loop();
}
function stopCamera(){
  running=false; if (rafId) cancelAnimationFrame(rafId);
  if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
}

function addCount(bucket, gkey) {
  // バケット/性別が不正なら unknown に寄せる
  const b = buckets.includes(bucket) ? bucket : 'unknown';
  const g = (gkey==='male' || gkey==='female') ? gkey : 'unknown';
  minuteCounts[b][g] += 1;
  console.log(`[COUNT] +1  bucket=${b}, gender=${g}`);
  renderTable(); // ★ 即時描画
}

async function loop(ts){
  if (!running) return;
  if (ts && ts - lastTick < frameGap){ rafId=requestAnimationFrame(loop); return; }
  lastTick = ts || performance.now();

  const res = await human.detect(video);
  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.drawImage(video,0,0,overlay.width,overlay.height);

  const faces = res.face || [];
  for (const f of faces){
    const [x,y,w,h]=f.box;
    const q = f.faceScore ?? 1;
    const id=assignTrack(f);
    const t = tracks.get(id);

    // 属性（オーバレイ用 & 集計キー）
    const gender=(f.gender||'unknown').toLowerCase();
    const gscore=f.genderScore ?? 0;
    t.gender = (gscore>0.6) ? (gender.startsWith('f')?'female':'male') : 'unknown';
    t.age    = typeof f.age==='number' ? Math.round(f.age) : null;
    t.bucket = toBucket(t.age);

    // 1) ハッシュ（取れれば）で日内ユニーク加算
    const emb = f.descriptor || f.embedding || f.descriptorRaw || null;
    if (!t.counted && emb && w>=MIN_BOX && h>=MIN_BOX && q>=MIN_SCORE){
      t.embBuf.push(emb);
      const recent = t.embBuf.slice(-STABLE_FRAMES);
      if (recent.length >= STABLE_FRAMES){
        let ok=true; for (let i=1;i<recent.length;i++){ if (cosineSim(recent[i-1],recent[i]) < COS_THRESHOLD){ ok=false; break; } }
        if (ok){
          const mean = meanVec(recent);
          const hsh  = await hashEmbedding(mean);
          if (!uniqSet.has(hsh)){
            uniqSet.add(hsh); saveUniq();
            addCount(t.bucket, t.gender);  // ★ ここで即時加算
          } else {
            console.log('[SKIP] already seen hash today');
          }
          t.counted = true;
        }
      }
    }

    // 2) ハッシュ取れない/安定しない場合のフォールバック（滞在で1回）
    if (!t.counted){
      const dwell = performance.now() - t.firstSeen;
      if (dwell >= COUNT_DELAY_MS && w>=MIN_BOX && h>=MIN_BOX && q>=MIN_SCORE){
        addCount(t.bucket, t.gender);     // ★ ここで即時加算
        t.counted = true;
      }
    }

    // 枠とラベル
    ctx.lineWidth=2;
    ctx.strokeStyle = t.counted ? '#00FF88' : '#3fa9f5';
    ctx.strokeRect(x,y,w,h);
    const label = `${t.bucket} • ${t.gender}` + (t.age?` (${t.age})`:'');
    ctx.fillStyle='rgba(0,0,0,0.5)';
    const tw = ctx.measureText(label).width + 10;
    ctx.fillRect(x, Math.max(0,y-20), tw, 20);
    ctx.fillStyle='#fff'; ctx.fillText(label, x+5, Math.max(12, y-6));
  }

  purgeOld();
  // 周期描画（保険）
  renderTable();
  const fps = (1000 / (performance.now() - lastTick + 1)).toFixed(1);
  logEl.textContent = `faces: ${faces.length} | tracks: ${tracks.size} | FPS approx: ${fps}`;

  rafId = requestAnimationFrame(loop);
}

// ---- UI ----
btnStart.onclick = ()=>startCamera().catch(e=>statusEl.textContent='開始失敗: '+e.message);
btnStop .onclick = stopCamera;
btnCsv  .onclick = ()=>{
  const lines=['bucket,male,female,unknown'];
  for (const b of buckets){ const c=minuteCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
  const blob = new Blob([lines.join('\n')], {type:'text/csv'});
  const url  = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement('a'), {href:url, download:`attributes_${todayStr()}.csv`});
  a.click(); URL.revokeObjectURL(url);
};

if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)){
  statusEl.textContent='このブラウザはカメラに未対応です';
} else {
  statusEl.textContent='「カメラ開始」を押してください（iPhoneはHTTPS必須）';
}
// ===== end =====
