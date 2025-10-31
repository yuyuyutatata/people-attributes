// === 来客属性カウンター：新規のみカウント（CDN優先・DB永続） ===
(async function boot() {
  const canvas = document.getElementById('stage');
  const ctx = canvas.getContext('2d');
  const btnStart = document.getElementById('btnStart');
  const btnStop  = document.getElementById('btnStop');
  const btnCsv   = document.getElementById('btnCsv');
  const ckFront  = document.getElementById('ckFront');
  const statusEl = document.getElementById('status');
  const tbody    = document.getElementById('tbody');
  const btnResetAll = document.getElementById('btnResetAll');

  btnStop.disabled = true;
  const delay = (ms)=>new Promise(r=>setTimeout(r,ms));
  const todayStr = ()=>{ const d=new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };

  // ---------- Human 読み込み ----------
  statusEl.textContent = 'モデル準備中…';
  for (let i=0; i<200 && !window.Human; i++) await delay(50);
  if (!window.Human) { statusEl.textContent='Human を読み込めませんでした'; return; }

  const CDN_MODELS = 'https://cdn.jsdelivr.net/npm/@vladmandic/human/models';
  let modelBasePath = CDN_MODELS;
  try {
    const resp = await fetch('./models/face-detection.json', { method:'HEAD', cache:'no-store' }).catch(()=>null);
    if (resp && resp.ok) modelBasePath = './models'; // ← ここが修正点（ok のときだけローカル）
  } catch (_) {/* ignore */}

  const video = document.createElement('video');
  Object.assign(video.style, { position:'absolute', left:'-9999px', width:'1px', height:'1px' });
  document.body.appendChild(video);

  const makeHuman = (base)=>new Human.Human({
    backend:'webgl',
    modelBasePath: base,
    cacheSensitivity:0,
    filter:{enabled:true, equalization:true},
    face:{
      enabled:true,
      detector:{rotation:true, maxDetected:3},
      mesh:false, iris:false,
      description:{enabled:true},
      descriptor:{enabled:true}
    },
    body:{enabled:false}, hand:{enabled:false}, gesture:{enabled:false}
  });

  let human = makeHuman(modelBasePath);
  async function loadModelsWithFallback() {
    try {
      await human.load(); await human.warmup();
      statusEl.textContent = `モデル準備完了（${modelBasePath.includes('http')?'CDN':'ローカル'}）`;
    } catch (e) {
      // ローカル読み込み失敗 → CDNへ再試行
      if (modelBasePath !== CDN_MODELS) {
        modelBasePath = CDN_MODELS;
        human = makeHuman(modelBasePath);
        try {
          await human.load(); await human.warmup();
          statusEl.textContent = 'モデル準備完了（CDNにフォールバック）';
        } catch (e2) {
          statusEl.textContent = 'モデル読み込み失敗: ' + e2.message;
          throw e2;
        }
      } else {
        statusEl.textContent = 'モデル読み込み失敗: ' + e.message;
        throw e;
      }
    }
  }
  await loadModelsWithFallback();

  // ---------- 集計 ----------
  const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
  const blankCounts = ()=>{ const o={}; for(const b of buckets) o[b]={male:0,female:0,unknown:0}; return o; };
  const kCounts = (d)=>`counts:${d}`;
  function loadCounts(d){ try{ const raw=localStorage.getItem(kCounts(d)); return raw?JSON.parse(raw):blankCounts(); }catch{ return blankCounts(); } }
  function saveCounts(d,obj){ localStorage.setItem(kCounts(d), JSON.stringify(obj)); }
  let currentDay = todayStr();
  let dayCounts = loadCounts(currentDay);
  function renderTable(){ tbody.innerHTML=buckets.map(b=>{const c=dayCounts[b];return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`}).join(''); }
  renderTable();

  // 一度カウントした DB id は永遠に加算しない
  const KEY_COUNTED='countedEverIds';
  let countedEver = (()=>{ try{return new Set(JSON.parse(localStorage.getItem(KEY_COUNTED)||'[]'));}catch{return new Set();} })();
  const saveCounted=()=>localStorage.setItem(KEY_COUNTED, JSON.stringify([...countedEver]));

  // 当日顔ハッシュ（DB不調時の二重防止）
  const SITE_SECRET='FIXED_SECRET_12345';
  const kHashSeen=(d)=>`hashSeen:${d}`;
  let hashSeenToday = (()=>{
    try { return new Set(JSON.parse(localStorage.getItem(kHashSeen(currentDay))||'[]')); }
    catch { return new Set(); }
  })();
  const saveHashSeen=()=>localStorage.setItem(kHashSeen(currentDay), JSON.stringify([...hashSeenToday]));

  // ---------- IndexedDB ----------
  const DB_NAME='faces-db', STORE='vectors', DB_VER=3;
  function openDB(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded=()=>{
        const db=req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os=db.createObjectStore(STORE,{keyPath:'id',autoIncrement:true});
          os.createIndex('tsLast','tsLast');
        }
      };
      req.onsuccess=()=>resolve(req.result);
      req.onerror =()=>reject(req.error);
    });
  }
  async function dbAll(){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(STORE,'readonly');
      const rq=tx.objectStore(STORE).getAll();
      rq.onsuccess=()=>res(rq.result||[]);
      rq.onerror  =()=>rej(rq.error);
    });
  }
  async function dbAdd(rec){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(STORE,'readwrite');
      const rq=tx.objectStore(STORE).add(rec);
      rq.onsuccess=()=>res(rq.result);
      rq.onerror  =()=>rej(rq.error);
    });
  }
  async function dbUpdate(id,patch){
    const db=await openDB();
    return new Promise((res,rej)=>{
      const tx=db.transaction(STORE,'readwrite');
      const os=tx.objectStore(STORE);
      const get=os.get(id);
      get.onsuccess=()=>{ const obj=Object.assign(get.result||{},patch); os.put(obj); };
      tx.oncomplete=()=>res();
      tx.onerror   =()=>rej(tx.error);
    });
  }
  function cosSim(a,b){ let dot=0,na=0,nb=0,L=Math.min(a.length,b.length); for(let i=0;i<L;i++){const x=a[i],y=b[i];dot+=x*y;na+=x*x;nb+=y*y;} return (na&&nb)? dot/(Math.sqrt(na)*Math.sqrt(nb)):0; }
  async function findNearestInDB(vec, th){
    const all=await dbAll();
    let best=null, sBest=-1;
    for(const r of all){ if(!r.vec) continue; const s=cosSim(vec,new Float32Array(r.vec)); if(s>sBest){ sBest=s; best=r; } }
    return (best && sBest>=th) ? {rec:best, sim:sBest} : null;
  }

  // ---------- トラッキング ----------
  const MIN_FACE_SCORE=0.60, MIN_AREA_RATIO=0.03, STREAK_N=6;
  const SIM_MIN=0.995, IOU_MIN=0.35, DIST_MAX_RATIO=0.15;
  const tracks=new Map(); let nextTrackId=1; const TRACK_MAX_AGE=2000;
  const people=[]; const MEMORY_SIM_TH=0.998;
  function normalize(v){ const out=new Float32Array(v.length); let n=0; for(let i=0;i<v.length;i++){const x=v[i]; n+=x*x;} const s=n?1/Math.sqrt(n):1; for(let i=0;i<v.length;i++) out[i]=v[i]*s; return out; }
  function vecHash(vec, day){ let s=''; for(let i=0;i<vec.length;i++) s+=(Math.round(vec[i]/0.02)*0.02).toFixed(2)+','; return `${day}|${SITE_SECRET}|${s}`; }
  const iou=(b1,b2)=>{ const [x1,y1,w1,h1]=b1,[x2,y2,w2,h2]=b2; const xa=Math.max(x1,x2),ya=Math.max(y1,y2); const xb=Math.min(x1+w1,x2+w2),yb=Math.min(y1+h1,y2+h2); const inter=Math.max(0,xb-xa)*Math.max(0,yb-ya); const uni=w1*h1+w2*h2-inter; return uni>0? inter/uni:0; };
  const centerDist=(b1,b2)=>{ const c1x=b1[0]+b1[2]/2,c1y=b1[1]+b1[3]/2; const c2x=b2[0]+b2[2]/2,c2y=b2[1]+b2[3]/2; return Math.hypot(c1x-c2x,c1y-c2y); };
  function cleanupTracks(now){ for(const [id,t] of tracks) if(now - t.lastTs > TRACK_MAX_AGE) tracks.delete(id); }
  function addPersonVec(vec){ for(const p of people){ for(const v of p.vecs){ if(cosSim(vec,v)>=MEMORY_SIM_TH){ p.vecs.push(vec); if(p.vecs.length>3)p.vecs.shift(); return; } } } people.push({vecs:[vec]}); }
  function assignDetectionsToTracks(dets){
    const now=performance.now(); cleanupTracks(now);
    const unassigned=new Set(dets.map((_,i)=>i));
    const diag=Math.hypot(canvas.width,canvas.height)||1;
    const pairs=[];
    for(const t of [...tracks.values()]){
      for(let i=0;i<dets.length;i++){
        const d=dets[i];
        const dist=centerDist(t.box,d.box)/diag;
        const ov=iou(t.box,d.box);
        const sim=t.vec&&d.vec?cosSim(t.vec,d.vec):0;
        const cost=0.7*(1-sim)+0.2*dist+0.1*(1-ov);
        pairs.push({tid:t.id,i,cost,sim,dist,ov});
      }
    }
    pairs.sort((a,b)=>a.cost-b.cost);
    const usedT=new Set(), usedD=new Set();
    for(const p of pairs){
      if(usedT.has(p.tid)||usedD.has(p.i)) continue;
      if(p.sim>=SIM_MIN && p.ov>=IOU_MIN && p.dist<=DIST_MAX_RATIO){
        const t=tracks.get(p.tid), d=dets[p.i];
        t.box=d.box; t.vec=d.vec; t.face=d.face;
        t.lastTs=now; t.streak=Math.min(t.streak+1,STREAK_N);
        usedT.add(p.tid); usedD.add(p.i); unassigned.delete(p.i);
      }
    }
    return [...unassigned];
  }
  function createTrack(det){ const now=performance.now(); tracks.set(nextTrackId,{id:nextTrackId++,box:det.box,vec:det.vec,face:det.face,lastTs:now,streak:1,counted:false}); }

  // ---------- カメラ ----------
  let running=false, stream=null, rafId=null, lastTick=0, dbHealthy=true;
  async function startCamera(){
    const facing = ckFront.checked ? 'user' : 'environment';
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480} },
      audio:false
    });
    video.srcObject = stream; await video.play();
    canvas.width  = video.videoWidth  || 640;
    canvas.height = video.videoHeight || 480;
    running=true; btnStart.disabled=true; btnStop.disabled=false;
    statusEl.textContent='実行中（新規のみカウント）';
    loop();
  }
  function stopCamera(){
    running=false; if(rafId) cancelAnimationFrame(rafId);
    if(stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
  }

  async function loop(ts){
    if(!running) return;
    const dnow=todayStr();
    if(dnow!==currentDay){ currentDay=dnow; dayCounts=loadCounts(currentDay); hashSeenToday=new Set(JSON.parse(localStorage.getItem(kHashSeen(currentDay))||'[]')); renderTable(); }
    if(ts && ts-lastTick<100){ rafId=requestAnimationFrame(loop); return; }
    lastTick=ts||performance.now();

    const result = await human.detect(video);
    ctx.clearRect(0,0,canvas.width,canvas.height);
    ctx.drawImage(video,0,0,canvas.width,canvas.height);

    const frameArea=canvas.width*canvas.height;
    const faces=(result.face||[]).filter(f=>{
      const [x,y,w,h]=f.box;
      const okScore = typeof f.score==='number' ? f.score>=MIN_FACE_SCORE : true;
      const okArea  = (w*h)/frameArea >= MIN_AREA_RATIO;
      return okScore && okArea && Array.isArray(f.descriptor);
    });

    const detections=[];
    for(const f of faces){
      const vec=normalize(new Float32Array(f.descriptor));
      detections.push({box:f.box, vec, face:f});
    }

    const unassigned=assignDetectionsToTracks(detections);
    for(const idx of unassigned) createTrack(detections[idx]);

    for(const t of [...tracks.values()]){
      if(t.streak<STREAK_N || t.counted || !t.vec) continue;

      const todayHash = vecHash(t.vec, currentDay);
      if (hashSeenToday.has(todayHash)) { t.counted=true; continue; }

      try{
        if(!dbHealthy){ t.counted=true; continue; }
        const nearest = await findNearestInDB(t.vec, 0.998);
        if(nearest){
          await dbUpdate(nearest.rec.id, { tsLast:Date.now(), seenCount:(nearest.rec.seenCount||0)+1 });
          hashSeenToday.add(todayHash); localStorage.setItem(kHashSeen(currentDay), JSON.stringify([...hashSeenToday]));
        } else {
          const loose = await findNearestInDB(t.vec, 0.97);
          if(loose){
            await dbUpdate(loose.rec.id, { tsLast:Date.now(), seenCount:(loose.rec.seenCount||0)+1 });
            hashSeenToday.add(todayHash); localStorage.setItem(kHashSeen(currentDay), JSON.stringify([...hashSeenToday]));
          } else {
            // 完全新規：登録→一度だけ加算（以後は ID で永久ブロック）
            const attr = estimateAttr(t.face);
            const now  = Date.now();
            const newId = await dbAdd({ vec:Array.from(t.vec), tsFirst:now, tsLast:now, seenCount:1, attrs:attr });
            if(!countedEver.has(newId)){
              countedEver.add(newId); saveCounted();
              dayCounts[attr.bucket][attr.gkey]+=1; saveCounts(currentDay,dayCounts); renderTable();
            }
            hashSeenToday.add(todayHash); localStorage.setItem(kHashSeen(currentDay), JSON.stringify([...hashSeenToday]));
          }
        }
      } catch(e){
        console.warn('DB error:', e);
        dbHealthy=false; statusEl.textContent='DB不調: カウント停止中（再読込で復帰）';
      }
      t.counted=true;
    }

    ctx.font='13px system-ui';
    for(const t of [...tracks.values()]){
      const [x,y,w,h]=t.box;
      ctx.lineWidth=2; ctx.strokeStyle=t.counted?'#00C48C':'#FFA400';
      ctx.strokeRect(x,y,w,h);
      const tag=t.counted?'counted':`tracking ${t.streak}/${STREAK_N}`;
      const tw=ctx.measureText(tag).width+8;
      ctx.fillStyle='rgba(0,0,0,.55)'; ctx.fillRect(x,Math.max(0,y-18),tw,18);
      ctx.fillStyle='#fff'; ctx.fillText(tag,x+4,Math.max(12,y-4));
    }

    rafId=requestAnimationFrame(loop);
  }

  function estimateAttr(face){
    const age = face.age ? Math.round(face.age) : null;
    const bucket = (age==null)?'unknown'
      : age<13?'child'
      : age<20?'10s'
      : age<30?'20s'
      : age<40?'30s'
      : age<50?'40s'
      : age<60?'50s':'60s+';
    const g=(face.gender||'').toLowerCase();
    const gkey = g.startsWith('f')?'female':(g.startsWith('m')?'male':'unknown');
    return { bucket, gkey };
  }

  // ---------- CSV / リセット ----------
  btnStart.addEventListener('click', async ()=>{ try{ await startCamera(); }catch(e){ statusEl.textContent='カメラ開始失敗: '+e.message; }});
  btnStop .addEventListener('click', stopCamera);
  btnCsv  .addEventListener('click', ()=>{
    const lines=['bucket,male,female,unknown'];
    for(const b of buckets){ const c=dayCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
    const blob=new Blob([lines.join('\n')],{type:'text/csv'}); const url=URL.createObjectURL(blob);
    const a=Object.assign(document.createElement('a'),{href:url,download:`daily_attributes_${currentDay}.csv`}); a.click(); URL.revokeObjectURL(url);
  });

  function clearAllDailyStorage(){
    const del=[]; for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i);
      if(k && (k.startsWith('counts:')||k.startsWith('hashSeen:')||k===KEY_COUNTED)) del.push(k);
    } del.forEach(k=>localStorage.removeItem(k));
  }
  function deleteFacesDB(){ return new Promise((resolve,reject)=>{ const rq=indexedDB.deleteDatabase(DB_NAME); rq.onsuccess=()=>resolve(); rq.onerror=()=>reject(rq.error); rq.onblocked=()=>reject(new Error('DB deletion blocked')); }); }
  async function resetAll(){
    if(!confirm('DBと集計・既視記録を全削除します。よろしいですか？')) return;
    if(running) stopCamera();
    clearAllDailyStorage();
    try{ await deleteFacesDB(); }catch(e){ alert('DB削除がブロックされました。他タブを閉じて再実行してください。\n'+(e?.message||e)); }
    tracks.clear(); people.length=0; nextTrackId=1;
    currentDay=todayStr(); dayCounts=blankCounts(); saveCounts(currentDay,dayCounts); renderTable();
    countedEver=new Set(); saveCounted();
    hashSeenToday=new Set(); saveHashSeen();
    statusEl.textContent='全リセット完了。必要なら「カメラ開始」を押してください。';
  }
  btnResetAll.addEventListener('click', resetAll);

  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices))
    statusEl.textContent='このブラウザはカメラ取得に未対応です';
  else
    statusEl.textContent='「カメラ開始」を押してください（HTTPS必須）';
})();
