// ===================== main.js 完全版 =====================

// ---- 画面からvideoを排除し、検出用の非表示videoを1個だけ持つ ----
(function ensureSingleHiddenVideo() {
  // 既存videoがあればすべて削除（描画はcanvasのみ）
  document.querySelectorAll('video').forEach(v => v.remove());
  // 非表示videoを生成（DOMには追加しない＝絶対表示されない）
  const v = document.createElement('video');
  v.id = 'video';
  v.playsInline = true;
  v.muted = true;
  window.__HIDDEN_VIDEO__ = v; // 以降これを使う
})();

// ---- DOM参照（videoは隠しインスタンスを使う） ----
const video   = window.__HIDDEN_VIDEO__;
const overlay = document.getElementById('overlay');
const ctx     = overlay.getContext('2d');
const btnStart= document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const btnCsv  = document.getElementById('btnCsv');
const ckFront = document.getElementById('ckFront');
const statusEl= document.getElementById('status');
const tbody   = document.getElementById('tbody');
const logEl   = document.getElementById('log');
const totalEl = document.getElementById('total');

// ---- 設定（必要に応じて調整） ----
const SITE_SECRET    = 'CHANGE_ME_TO_RANDOM_32CHARS'; // 全端末共通の任意文字列
const TARGET_FPS     = 12;
const STABLE_FRAMES  = 5;
const COS_THRESHOLD  = 0.975;
const COUNT_DELAY_MS = 500;
const MATCH_PIX      = 240;
const IOU_THRESH     = 0.10;
const PURGE_MS       = 4000;
const MIN_BOX        = 60;
const MIN_SCORE      = 0.05;
const GENDER_MIN     = 0.30;

// ---- Human（ローカルmodels固定） ----
const human = new Human.Human({
  modelBasePath: './models',
  face: {
    detector: { rotation: true, maxDetected: 5 },
    mesh: false, iris: false,
    description: { enabled: true },  // age / gender
    descriptor:  { enabled: true },  // embedding
  },
  filter: { enabled: true, equalization: true },
  body: { enabled: false }, hand: { enabled: false }, gesture: { enabled: false },
});

async function ensureModelsLoaded() {
  human.config.modelBasePath = './models';
  console.log('[Human] loading from ./models');
  await human.load();
  await human.warmup();
  const v = await human.validate();
  console.log('[Human] validate:', v);
  console.log('✅ Face model ready (local models).');
}

// ---- 日付 & ユニーク管理 ----
function todayStr(){
  const d=new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const uniqKey = ()=>`uniqHashes:${todayStr()}`;
let uniqSet = new Set(JSON.parse(localStorage.getItem(uniqKey()) || '[]'));
function saveUniq(){ localStorage.setItem(uniqKey(), JSON.stringify([...uniqSet])); }

// ---- 集計（直近1分） ----
const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
const minuteCounts = {}; initCounts(); renderTable();
function initCounts(){ for(const b of buckets) minuteCounts[b]={male:0,female:0,unknown:0}; }
function toBucket(age){
  if(!(age>0)) return 'unknown';
  if(age<13) return 'child'; if(age<20) return '10s'; if(age<30) return '20s';
  if(age<40) return '30s'; if(age<50) return '40s'; if(age<60) return '50s'; return '60s+';
}
function renderTable(){
  tbody.innerHTML = buckets.map(b=>{
    const c=minuteCounts[b];
    return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
  }).join('');
  totalEl.textContent = `今日のユニーク合計: ${uniqSet.size} 人`;
}
function resetMinute(){ initCounts(); renderTable(); }
setInterval(()=>{ resetMinute(); }, 60*1000);

// ---- ベクトルユーティリティ ----
function cosineSim(a,b){ let dot=0,na=0,nb=0; const n=Math.min(a.length,b.length);
  for(let i=0;i<n;i++){ const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
  return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-12);
}
function meanVec(arr){ const n=arr.length,d=arr[0].length,out=new Array(d).fill(0);
  for(const v of arr){ for(let i=0;i<d;i++) out[i]+=v[i]; } for(let i=0;i<d;i++) out[i]/=n; return out; }
async function hashEmbedding(emb){
  const rounded=emb.map(v=>Math.round(v*50)/50);
  const payload=JSON.stringify({ r:rounded, d:todayStr(), s:SITE_SECRET, v:3 });
  const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const dv=new DataView(buf); let out=''; for(let i=0;i<16;i++) out+=dv.getUint8(i).toString(16).padStart(2,'0'); return out;
}

// ---- トラッキング ----
let nextId=1;
const tracks=new Map(); // id -> {cx,cy,box,firstSeen,lastSeen,counted,embBuf,gender,bucket,age,armedAt}
function iou(a,b){ const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
  const ix=Math.max(0, Math.min(ax2,bx2)-Math.max(a.x,b.x));
  const iy=Math.max(0, Math.min(ay2,by2)-Math.max(a.y,b.y));
  const inter=ix*iy, ua=a.w*a.h+b.w*b.h-inter; return ua>0? inter/ua : 0;
}
function assignTrack(face){
  const [x,y,w,h]=face.box; const cx=x+w/2, cy=y+h/2;
  let bestId=null, bestIoU=0, bestDist=Infinity;
  for(const [id,t] of tracks){
    const j=iou({x,y,w,h}, t.box); const d=Math.hypot(t.cx-cx,t.cy-cy);
    if (j>bestIoU+1e-6 || (Math.abs(j-bestIoU)<1e-6 && d<bestDist)){ bestIoU=j; bestDist=d; bestId=id; }
  }
  if (bestId!==null && (bestIoU>=IOU_THRESH || bestDist<=MATCH_PIX)){
    const t=tracks.get(bestId); t.cx=cx; t.cy=cy; t.lastSeen=performance.now(); t.box={x,y,w,h}; return bestId;
  }
  const id=nextId++; tracks.set(id,{
    cx, cy, box:{x,y,w,h}, firstSeen:performance.now(), lastSeen:performance.now(),
    counted:false, embBuf:[], gender:'unknown', bucket:'unknown', age:null, armedAt:null
  });
  return id;
}
function purgeOld(){ const now=performance.now(); for(const [id,t] of tracks){ if(now-t.lastSeen>PURGE_MS) tracks.delete(id); } }

// ---- メインループ ----
let running=false, stream=null, rafId=null, lastTick=0;
const frameGap=Math.max(1000/TARGET_FPS, 60);

async function startCamera(){
  console.log('videos=', document.querySelectorAll('video').length, 'canvas=', document.querySelectorAll('canvas').length);
  await ensureModelsLoaded();
  const facing=ckFront.checked?'user':'environment';
  stream=await navigator.mediaDevices.getUserMedia({
    video:{ facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480} }, audio:false
  });
  video.srcObject=stream; await video.play();

  // canvasサイズを入力に合わせる
  const settings = stream.getVideoTracks()[0].getSettings?.() || {};
  overlay.width  = settings.width  || 640;
  overlay.height = settings.height || 480;

  running=true; btnStart.disabled=true; btnStop.disabled=false;
  statusEl.textContent='実行中（ローカルモデル・ユニーク集計）';
  loop();
}
function stopCamera(){
  running=false; if(rafId) cancelAnimationFrame(rafId);
  if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
  btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
}

async function loop(ts){
  if(!running) return;
  if(ts && ts-lastTick<frameGap){ rafId=requestAnimationFrame(loop); return; }
  lastTick = ts || performance.now();

  const res = await human.detect(video);

  // 描画
  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.drawImage(video,0,0,overlay.width,overlay.height);

  const faces=res.face||[];
  for(const f of faces){
    const [x,y,w,h]=f.box;
    const q = (f.score ?? f.faceScore ?? 1);
    const id=assignTrack(f);
    const t=tracks.get(id);

    // 属性
    const gname = (f.gender||'unknown').toLowerCase();
    const gscore= f.genderScore ?? 0;
    t.gender = (gscore > GENDER_MIN) ? (gname.startsWith('f') ? 'female' : 'male') : 'unknown';
    t.age    = (typeof f.age==='number') ? Math.round(f.age) : null;
    t.bucket = toBucket(t.age);

    // 1) 安定埋め込みでユニーク加算
    const emb = f.descriptor || f.embedding || f.descriptorRaw || null;
    if (!t.counted && emb && w>=MIN_BOX && h>=MIN_BOX && q>=MIN_SCORE){
      t.embBuf.push(emb);
      const recent=t.embBuf.slice(-STABLE_FRAMES);
      if (recent.length>=STABLE_FRAMES){
        let ok=true; for(let i=1;i<recent.length;i++){ if(cosineSim(recent[i-1],recent[i])<COS_THRESHOLD){ ok=false; break; } }
        if (ok){
          const mean=meanVec(recent); const hsh=await hashEmbedding(mean);
          if (!uniqSet.has(hsh)){ uniqSet.add(hsh); saveUniq(); addCount(t.bucket, t.gender); }
          t.counted=true;
        }
      }
    }

    // 2) フォールバック（滞在時間）
    if (!t.counted){
      if (!t.armedAt) t.armedAt = t.firstSeen;
      const dwell = performance.now() - t.armedAt;
      if (dwell >= COUNT_DELAY_MS && w>=MIN_BOX && h>=MIN_BOX && q>=MIN_SCORE){
        addCount(t.bucket, t.gender);
        t.counted = true;
        console.log(`[FB] counted after ${Math.round(dwell)}ms`);
      }
    }

    // 可視化
    ctx.lineWidth=2;
    ctx.strokeStyle = t.counted ? '#00FF88' : '#3fa9f5';
    ctx.strokeRect(x,y,w,h);
    const label = `${t.bucket} • ${t.gender}` + (t.age?` (${t.age})`:'');
    ctx.fillStyle='rgba(0,0,0,0.5)';
    const tw=ctx.measureText(label).width+10;
    ctx.fillRect(x, Math.max(0,y-20), tw, 20);
    ctx.fillStyle='#fff'; ctx.fillText(label, x+5, Math.max(12,y-6));
  }

  purgeOld();
  renderTable();
  const fps=(1000/(performance.now()-lastTick+1)).toFixed(1);
  logEl.textContent = `faces: ${faces.length} | tracks: ${tracks.size} | FPS approx: ${fps}`;

  rafId=requestAnimationFrame(loop);
}

// ---- 集計加算 & UI ----
function addCount(bucket, gender){
  const b = buckets.includes(bucket)?bucket:'unknown';
  const g = (gender==='male'||gender==='female')?gender:'unknown';
  minuteCounts[b][g]+=1;
  renderTable();
}

btnStart.onclick = ()=>startCamera().catch(e=>statusEl.textContent='開始失敗: '+e.message);
btnStop .onclick = stopCamera;
btnCsv  .onclick = ()=>{
  const lines=['bucket,male,female,unknown'];
  for(const b of buckets){ const c=minuteCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
  const blob=new Blob([lines.join('\n')],{type:'text/csv'});
  const url=URL.createObjectURL(blob);
  const a=Object.assign(document.createElement('a'),{href:url,download:`attributes_${todayStr()}.csv`});
  a.click(); URL.revokeObjectURL(url);
};

// 対応ブラウザチェック
if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)){
  statusEl.textContent='このブラウザはカメラに未対応です';
} else {
  statusEl.textContent='「カメラ開始」を押してください（iPhoneはHTTPS必須）';
}
// ===================== /main.js =====================
