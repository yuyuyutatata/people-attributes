// ===================== main.js（descriptor取得強化版） =====================
const video   = document.getElementById('video');
const overlay = document.getElementById('overlay');
const ctx     = overlay.getContext('2d');
const btnStart= document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const ckFront = document.getElementById('ckFront');
const statusEl= document.getElementById('status');
const tbody   = document.getElementById('tbody');
const logEl   = document.getElementById('log');

const SITE_SECRET   = 'CHANGE_ME_TO_RANDOM_32CHARS';
const STABLE_FRAMES = 8;
const COS_THRESHOLD = 0.98;
const MATCH_PIX     = 80;
const PURGE_MS      = 4000;
const MIN_BOX       = 80;   // 少し緩める
const MIN_SCORE     = 0.1;  // スコア閾値を下げる

// -------- Human初期化 --------
const human = new Human.Human({
  modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models',
  face: {
    detector: { rotation: true, maxDetected: 5 },
    mesh: false,
    iris: false,
    description: { enabled: true },
    descriptor:  { enabled: true },
  },
  body: { enabled: false },
  hand: { enabled: false },
  gesture: { enabled: false },
  filter: { enabled: true, equalization: true },
});

async function ensureModelsLoaded() {
  await human.load();
  await human.warmup();
  const valid = await human.validate();
  console.log("Human model validation:", valid);
}

// -------- 日付とユニーク管理 --------
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}
const uniqKey = () => `uniqHashes:${todayStr()}`;
let uniqSet = new Set(JSON.parse(localStorage.getItem(uniqKey()) || '[]'));
function saveUniqSet() {
  localStorage.setItem(uniqKey(), JSON.stringify([...uniqSet]));
}

// -------- 集計表 --------
const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
const minuteCounts = {}; for (const b of buckets) minuteCounts[b] = { male:0, female:0, unknown:0 };
function toBucket(age){
  if (!age) return 'unknown';
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
}
renderTable();

// -------- Utility関数 --------
function cosineSim(a,b){
  let dot=0,na=0,nb=0;
  for(let i=0;i<Math.min(a.length,b.length);i++){dot+=a[i]*b[i];na+=a[i]*a[i];nb+=b[i]*b[i];}
  return dot / (Math.sqrt(na)*Math.sqrt(nb)+1e-12);
}
function meanEmbedding(buf){
  const n=buf.length,d=buf[0].length;
  const out=new Array(d).fill(0);
  for(const v of buf){for(let i=0;i<d;i++)out[i]+=v[i];}
  for(let i=0;i<d;i++)out[i]/=n;return out;
}
async function hashEmbedding(emb){
  const rounded=emb.map(v=>Math.round(v*50)/50);
  const payload=JSON.stringify({r:rounded,d:todayStr(),s:SITE_SECRET});
  const buf=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload));
  const view=new DataView(buf);
  let out='';for(let i=0;i<16;i++)out+=view.getUint8(i).toString(16).padStart(2,'0');
  return out;
}

// -------- トラッキング管理 --------
const tracks = new Map();
let nextId = 1;
function assignTrack(face){
  const [x,y,w,h] = face.box;
  const cx=x+w/2, cy=y+h/2;
  let best=null,bestDist=Infinity;
  for(const [id,t] of tracks){
    const d=Math.hypot(t.cx-cx,t.cy-cy);
    if(d<bestDist){bestDist=d;best=id;}
  }
  if(best && bestDist<MATCH_PIX){
    const t=tracks.get(best);
    t.cx=cx;t.cy=cy;t.last=performance.now();
    return best;
  }
  const id=nextId++;
  tracks.set(id,{cx,cy,last:performance.now(),embBuf:[],counted:false,gender:'unknown',bucket:'unknown'});
  return id;
}
function purgeOldTracks(){
  const now=performance.now();
  for(const [id,t] of tracks){
    if(now-t.last>PURGE_MS) tracks.delete(id);
  }
}

// -------- カメラループ --------
let running=false, stream=null, rafId=null, lastTick=0;

async function startCamera(){
  await ensureModelsLoaded();
  const facing = ckFront.checked ? 'user' : 'environment';
  stream = await navigator.mediaDevices.getUserMedia({
    video:{facingMode:{ideal:facing},width:{ideal:640},height:{ideal:480}},
    audio:false
  });
  video.srcObject=stream; await video.play();
  overlay.width=video.videoWidth||640;
  overlay.height=video.videoHeight||480;
  running=true; btnStart.disabled=true; btnStop.disabled=false;
  statusEl.textContent='実行中';
  loop();
}
function stopCamera(){
  running=false;
  if(rafId) cancelAnimationFrame(rafId);
  if(stream){stream.getTracks().forEach(t=>t.stop());}
  btnStart.disabled=false; btnStop.disabled=true;
  statusEl.textContent='停止';
}

async function loop(ts){
  if(!running) return;
  if(ts && ts - lastTick < 100){rafId=requestAnimationFrame(loop);return;}
  lastTick=ts||performance.now();

  const result=await human.detect(video);
  ctx.clearRect(0,0,overlay.width,overlay.height);
  ctx.drawImage(video,0,0,overlay.width,overlay.height);

  const faces=result.face||[];
  for(const f of faces){
    const [x,y,w,h]=f.box;
    const q=f.faceScore??1;
    const emb = f.descriptor || f.embedding || f.descriptorRaw || null;
    const gender=(f.gender||'unknown').toLowerCase();
    const gscore=f.genderScore??0;
    const age = (typeof f.age==='number') ? Math.round(f.age) : null;
    const bucket=toBucket(age);
    const gkey=(gscore>0.6)?(gender.startsWith('f')?'female':'male'):'unknown';
    const id=assignTrack(f);
    const t=tracks.get(id);
    t.gender=gkey; t.bucket=bucket;

    if(w>=MIN_BOX && h>=MIN_BOX && q>=MIN_SCORE && emb){
      t.embBuf.push(emb);
    }

    if(!t.counted && t.embBuf.length>=STABLE_FRAMES){
      const recent=t.embBuf.slice(-STABLE_FRAMES);
      let stable=true;
      for(let i=1;i<recent.length;i++){
        if(cosineSim(recent[i-1],recent[i])<COS_THRESHOLD){stable=false;break;}
      }
      if(stable){
        const mean=meanEmbedding(recent);
        const hsh=await hashEmbedding(mean);
        if(!uniqSet.has(hsh)){
          uniqSet.add(hsh); saveUniqSet();
          minuteCounts[bucket][gkey]+=1;
        }
        t.counted=true;
      }
    }

    // 描画
    ctx.lineWidth=2;
    ctx.strokeStyle = t.counted ? '#00FF88' : '#3fa9f5';
    ctx.strokeRect(x,y,w,h);
    const label = `${bucket} • ${gkey}`+(age?` (${age})`:'');
    ctx.fillStyle='rgba(0,0,0,0.5)';
    const tw=ctx.measureText(label).width+10;
    ctx.fillRect(x,Math.max(0,y-20),tw,20);
    ctx.fillStyle='#fff';
    ctx.fillText(label,x+5,Math.max(12,y-6));
  }

  purgeOldTracks();
  renderTable();
  logEl.textContent = `faces: ${faces.length} | tracks: ${tracks.size}`;
  rafId=requestAnimationFrame(loop);
}

// -------- UI --------
btnStart.onclick=()=>startCamera();
btnStop.onclick =()=>stopCamera();
if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)) {
  statusEl.textContent='カメラ未対応ブラウザ';
} else {
  statusEl.textContent='「カメラ開始」を押してください（iPhoneはHTTPS必須）';
}
// ===================== /main.js =====================
