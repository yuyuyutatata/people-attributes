// ===================== main.js（確実カウント版：モデル不在は強制フォールバック） =====================
// 依存: tfjs, human を index.html で先に読み込み
//   <script src="https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js"></script>
//   <script src="https://cdn.jsdelivr.net/npm/@vladmandic/human@3.6.0/dist/human.js"></script>

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

let totalEl = document.getElementById('total');
if (!totalEl) {
  totalEl = document.createElement('div');
  totalEl.id = 'total';
  totalEl.style.marginTop = '8px';
  totalEl.style.fontSize = '14px';
  document.body.appendChild(totalEl);
}

// ------- パラメータ -------
const SITE_SECRET   = 'CHANGE_ME_TO_RANDOM_32CHARS';
const TARGET_FPS    = 12;
const STABLE_FRAMES = 5;
const COS_THRESHOLD = 0.975;
const COUNT_DELAY_MS = 400;   // 0.4秒でカウント（以前: 600〜800）
const MATCH_PIX     = 220;
const IOU_THRESH    = 0.10;
const PURGE_MS      = 4000;
const MIN_BOX       = 70;
const MIN_SCORE     = 0.05;

// ------- Human -------
const human = new Human.Human({
  modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.6.0/models',
  face: { detector:{rotation:true,maxDetected:5}, mesh:false, iris:false,
          description:{enabled:true}, descriptor:{enabled:true} },
  filter:{enabled:true,equalization:true},
  body:{enabled:false}, hand:{enabled:false}, gesture:{enabled:false},
});

let USE_FALLBACK_ONLY = false; // モデル未ロード時は true になり、強制フォールバック

async function ensureModelsLoaded() {
  const bases = [
    'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.6.0/models',
    'https://unpkg.com/@vladmandic/human@3.6.0/models',
    'https://fastly.jsdelivr.net/npm/@vladmandic/human@3.6.0/models',
  ];
  for (const base of bases) {
    try {
      human.config.modelBasePath = base;
      console.log('[Human] try modelBasePath:', base);
      await human.load();
      await human.warmup();
      const v = await human.validate();
      console.log('[Human] validate:', v);
      if (v.face) { console.log('✅ Face model ready'); USE_FALLBACK_ONLY = false; return; }
    } catch(e){ console.warn('load failed at', base, e); }
  }
  // どれもダメだった→フォールバックに切り替え（検出器だけでも動く前提）
  USE_FALLBACK_ONLY = true;
  console.warn('⚠️ Face models not fully ready. Fallback counting only.');
  human.config.face.description = { enabled: false };
  human.config.face.descriptor  = { enabled: false };
}

// ------- 日付 & ユニーク -------
function todayStr(){ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; }
const uniqKey = ()=>`uniqHashes:${todayStr()}`;
let uniqSet = new Set(JSON.parse(localStorage.getItem(uniqKey())||'[]'));
function saveUniq(){ localStorage.setItem(uniqKey(), JSON.stringify([...uniqSet])); }

// ------- 集計（直近1分） -------
const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
const minuteCounts = {}; initCounts();
function initCounts(){ for(const b of buckets) minuteCounts[b]={male:0,female:0,unknown:0}; }
function toBucket(age){
  if(!(age>0)) return 'unknown';
  if(age<13) return 'child'; if(age<20) return '10s'; if(age<30) return '20s';
  if(age<40) return '30s'; if(age<50) return '40s'; if(age<60) return '50s'; return '60s+';
}
function renderTable(){
  tbody.innerHTML = buckets.map(b=>`<tr><td>${b}</td><td>${minuteCounts[b].male}</td><td>${minuteCounts[b].female}</td><td>${minuteCounts[b].unknown}</td></tr>`).join('');
  totalEl.textContent = `今日のユニーク合計: ${uniqSet.size} 人`;
}
renderTable();
setInterval(()=>{ // 1分ごとに表リセット＆日またぎ検知
  if (!localStorage.getItem(uniqKey())) { uniqSet = new Set(); saveUniq(); }
  initCounts(); renderTable();
}, 60*1000);

function addCount(bucket, gender){
  const b = buckets.includes(bucket)?bucket:'unknown';
  const g = (gender==='male'||gender==='female')?gender:'unknown';
  minuteCounts[b][g]+=1;
  console.log(`[COUNT] +1 bucket=${b}, gender=${g}`);
  renderTable();
}

// ------- ユーティリティ -------
function cosineSim(a,b){ let dot=0,na=0,nb=0; const n=Math.min(a.length,b.length);
  for(let i=0;i<n;i++){const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y;}
  return dot/(Math.sqrt(na)*Math.sqrt(nb)+1e-12);
}
function meanVec(arr){ const n=arr.length,d=arr[0].length,out=new Array(d).fill(0);
  for(const v of arr){for(let i=0;i<d;i++) out[i]+=v[i];} for(let i=0;i<d;i++) out[i]/=n; return out; }
async function hashEmbedding(emb){
  const rounded=emb.map(v=>Math.round(v*50)/50);
  const payload=JSON.stringify({r:rounded,d:todayStr(),s:SITE_SECRET,v:3});
  const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
  const dv=new DataView(buf); let out=''; for(let i=0;i<16;i++) out+=dv.getUint8(i).toString(16).padStart(2,'0'); return out;
}
function iou(a,b){ const ax2=a.x+a.w, ay2=a.y+a.h, bx2=b.x+b.w, by2=b.y+b.h;
  const ix=Math.max(0, Math.min(ax2,bx2)-Math.max(a.x,b.x));
  const iy=Math.max(0, Math.min(ay2,by2)-Math.max(a.y,b.y));
  const inter=ix*iy, ua=a.w*a.h+b.w*b.h-inter; return ua>0? inter/ua : 0;
}

// ------- トラッカー（IoU + 距離） -------
let nextId=1;
const tracks=new Map(); // id -> {cx,cy,box,firstSeen,lastSeen,counted,embBuf,gender,bucket,age}
function assignTrack(face){
  const [x,y,w,h]=face.box; const cx=x+w/2, cy=y+h/2;
  let bestId=null, bestIoU=0, bestDist=Infinity;
  for(const [id,t] of tracks){
    const j=iou({x,y,w,h}, t.box); const d=Math.hypot(t.cx-cx,t.cy-cy);
    if (j>bestIoU+1e-6 || (Math.abs(j-bestIoU)<1e-6 && d<bestDist)){ bestIoU=j; bestDist=d; bestId=id; }
  }
  if (bestId!==null && (bestIoU>=IOU_THRESH || bestDist<=MATCH_PIX)) {
    const t=tracks.get(bestId); t.cx=cx; t.cy=cy; t.lastSeen=performance.now(); t.box={x,y,w,h}; return bestId;
  }
  const id=nextId++; tracks.set(id,{cx,cy,box:{x,y,w,h},firstSeen:performance.now(),lastSeen:performance.now(),
                                     counted:false,embBuf:[],gender:'unknown',bucket:'unknown',age:null});
  return id;
}
function purgeOld(){ const now=performance.now(); for(const [id,t] of tracks){ if(now-t.lastSeen>PURGE_MS) tracks.delete(id); } }

// ------- ループ -------
let running=false, stream=null, rafId=null, lastTick=0;
const frameGap=Math.max(1000/TARGET_FPS,60);

async function startCamera(){
  await ensureModelsLoaded();
  const facing=ckFront.checked?'user':'environment';
  stream=await navigator.mediaDevices.getUserMedia({ video:{facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480}}, audio:false });
  video.srcObject=stream; await video.play();
  overlay.width=video.videoWidth||640; overlay.height=video.videoHeight||480;
  running=true; btnStart.disabled=true; btnStop.disabled=false;
  statusEl.textContent= USE_FALLBACK_ONLY ? '実行中（フォールバック集計）' : '実行中（ユニーク集計）';
  loop();
}
function stopCamera(){
  running=false; if(rafId) cancelAnimationFrame(rafId);
  if(stream){stream.getTracks().forEach(t=>t.stop()); stream=null;}
  btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
}

async function loop(ts){
  if(!running) return;
  if(ts && ts-lastTick<frameGap){ rafId=requestAnimationFrame(loop); return; }
  lastTick=ts||performance.now();

  const res=await human.detect(video);

  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.drawImage(video,0,0,overlay.width,overlay.height);

  const faces=res.face||[];
  for(const f of faces){
    const [x,y,w,h]=f.box;
    const id=assignTrack(f);
    const t=tracks.get(id);

    // 属性（モデルが生きていれば使う）
    const gender=(f.gender||'unknown').toLowerCase();
    const gscore=f.genderScore??0;
    t.gender = (!USE_FALLBACK_ONLY && gscore>0.6) ? (gender.startsWith('f')?'female':'male') : 'unknown';
    t.age    = (!USE_FALLBACK_ONLY && typeof f.age==='number') ? Math.round(f.age) : null;
    t.bucket = toBucket(t.age);

    // 1) モデルが使える場合はハッシュでユニーク加算
    if (!USE_FALLBACK_ONLY) {
      const q = (f.score ?? f.faceScore ?? 1);       // Humanのスコア名差異に対応
      const emb = f.descriptor || f.embedding || f.descriptorRaw || null;
      if (!t.counted && emb && w>=MIN_BOX && h>=MIN_BOX && q>=MIN_SCORE){
        t.embBuf.push(emb);
        const recent=t.embBuf.slice(-STABLE_FRAMES);
        if (recent.length>=STABLE_FRAMES){
          let ok=true; for(let i=1;i<recent.length;i++){ if(cosineSim(recent[i-1],recent[i])<COS_THRESHOLD){ ok=false; break; } }
          if (ok){
            const mean=meanVec(recent); const hsh=await hashEmbedding(mean);
            if(!uniqSet.has(hsh)){ uniqSet.add(hsh); saveUniq(); addCount(t.bucket, t.gender); }
            else { console.log('[SKIP] already seen hash today'); }
            t.counted=true;
          }
        }
      }
    }

    // 2) フォールバック：モデル未ロード/不安定時は「必ず」1回カウント
if (!t.counted) {
  // 初回フレームで armedAt をセット
  if (!t.armedAt) t.armedAt = t.firstSeen;

  const dwell = performance.now() - t.armedAt;

  // ★ 顔が映って 0.4 秒経過したら、unknown として必ず +1
  if (USE_FALLBACK_ONLY && dwell >= COUNT_DELAY_MS) {
    addCount(t.bucket, t.gender); // ほぼ 'unknown','unknown' になる
    t.counted = true;
    console.log(`[FB] counted after ${Math.round(dwell)}ms`);
  }

  // ★ モデルは生きているが埋め込みが得られないときも救済
  if (!USE_FALLBACK_ONLY && dwell >= (COUNT_DELAY_MS + 200)) {
    addCount(t.bucket, t.gender);
    t.counted = true;
    console.log(`[FB2] counted without embedding after ${Math.round(dwell)}ms`);
  }
}


    // 枠・ラベル
    ctx.lineWidth=2;
    ctx.strokeStyle = t.counted ? '#00FF88' : '#3fa9f5';
    ctx.strokeRect(x,y,w,h);
    const label = `${t.bucket} • ${t.gender}` + (t.age?` (${t.age})`:'');
    ctx.fillStyle='rgba(0,0,0,0.5)';
    const tw=ctx.measureText(label).width+10;
    ctx.fillRect(x,Math.max(0,y-20),tw,20);
    ctx.fillStyle='#fff'; ctx.fillText(label,x+5,Math.max(12,y-6));
  }

  purgeOld();
  renderTable(); // 保険
  const fps=(1000/(performance.now()-lastTick+1)).toFixed(1);
  logEl.textContent=`faces: ${faces.length} | tracks: ${tracks.size} | FPS approx: ${fps}`;

  rafId=requestAnimationFrame(loop);
}

// ------- UI -------
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

if(!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)){
  statusEl.textContent='このブラウザはカメラに未対応です';
} else {
  statusEl.textContent='「カメラ開始」を押してください（iPhoneはHTTPS必須）';
}
// ===================== /main.js =====================
