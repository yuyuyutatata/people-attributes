// === 日次ユニーク集計 + 動いても1回だけ + IndexedDB 照合（DEBUG版） ===
(async function boot() {
  const DEBUG = true;
  const log = (...a) => DEBUG && console.log('[DBG]', ...a);
  const warn = (...a) => console.warn('[WARN]', ...a);
  const err  = (...a) => console.error('[ERR]', ...a);

  // -------- DOM --------
  const overlay  = document.getElementById('overlay');
  const ctx      = overlay.getContext('2d');
  const btnStart = document.getElementById('btnStart');
  const btnStop  = document.getElementById('btnStop');
  const btnCsv   = document.getElementById('btnCsv');
  const ckFront  = document.getElementById('ckFront');
  const statusEl = document.getElementById('status');
  const tbody    = document.getElementById('tbody');
  const btnResetAll = document.getElementById('btnResetAll');

  btnStop.disabled = true;
  statusEl.textContent = '準備中…';

  // -------- Human --------
  for (let i=0;i<200 && !window.Human;i++) await delay(100);
  if (!window.Human) {
    statusEl.textContent = 'Human 読み込み失敗';
    btnStart.disabled = true; btnStop.disabled = true; return;
  }

  const video = Object.assign(document.createElement('video'), { muted:true, playsInline:true });
  Object.assign(video.style, { display:'none', width:'0', height:'0', position:'absolute', opacity:'0' });
  document.body.appendChild(video);

  const human = new Human.Human({
    modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models',
    face: {
      detector:{ rotation:true, maxDetected:3 },
      embedding:{ enabled:true },
      descriptor:{ enabled:true },
      age:{ enabled:true }, gender:{ enabled:true },
      mesh:false, iris:false,
    },
    body:{enabled:false}, hand:{enabled:false}, gesture:{enabled:false},
    filter:{enabled:true, equalization:true},
  });
  await human.load().catch(()=>{});
  statusEl.textContent = 'モデル準備完了';

  // -------- 日付・集計 --------
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  let currentDay = todayStr();
  const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
  const blankCounts = ()=>{ const o={}; for(const b of buckets) o[b]={male:0,female:0,unknown:0}; return o; };
  const keyCounts = d => `counts:${d}`;
  const loadCounts = d => { try{ const raw=localStorage.getItem(keyCounts(d)); return raw?JSON.parse(raw):blankCounts(); }catch{ return blankCounts(); } };
  const saveCounts = (d,obj)=> localStorage.setItem(keyCounts(d), JSON.stringify(obj));
  let dayCounts = loadCounts(currentDay);
  const renderTable = ()=> tbody.innerHTML = buckets.map(b=> {
    const c = dayCounts[b]; return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
  }).join('');
  renderTable();

  // -------- IndexedDB（DEBUG強化）--------
  const DB_NAME='faces-db', STORE='vectors', TARGET_VER=4; // ←デバッグで1つ上げる
  function openDB() {
    return new Promise((resolve,reject)=>{
      const req = indexedDB.open(DB_NAME);
      req.onerror = ()=> reject(req.error);
      req.onsuccess = ()=>{
        const db = req.result;
        log('open success: name=', DB_NAME, 'ver=', db.version, 'stores=', [...db.objectStoreNames]);
        if (db.objectStoreNames.contains(STORE)) return resolve(db);
        const newVer = Math.max(db.version+1, TARGET_VER);
        log('upgrade to create store:', STORE, '→ version', newVer);
        db.close();
        const req2 = indexedDB.open(DB_NAME, newVer);
        req2.onupgradeneeded = ()=>{
          const db2 = req2.result;
          if (!db2.objectStoreNames.contains(STORE)) {
            const os = db2.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
            os.createIndex('tsLast','tsLast');
            log('created store:', STORE);
          }
        };
        req2.onerror = ()=> reject(req2.error);
        req2.onsuccess = ()=> { log('upgrade done ver=', req2.result.version); resolve(req2.result); };
      };
    });
  }
  async function dbGetAll(){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readonly');
      const rq = tx.objectStore(STORE).getAll();
      rq.onsuccess=()=>{ log('getAll count=', (rq.result||[]).length); res(rq.result||[]); };
      rq.onerror  =()=> rej(rq.error);
    });
  }
  async function dbGetById(id){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const rq = db.transaction(STORE,'readonly').objectStore(STORE).get(id);
      rq.onsuccess=()=> res(rq.result||null);
      rq.onerror  =()=> rej(rq.error);
    });
  }
  // put → 生成IDを返す（失敗時1回だけ再試行）
  async function dbPut(rec, _retry=false){
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readwrite');
      const rq = tx.objectStore(STORE).put(rec);
      let insertedId = null;
      rq.onsuccess = ()=> { insertedId = rq.result; };
      tx.oncomplete=()=>{ log('put complete id=', insertedId); res(insertedId); };
      tx.onerror   = async ()=>{
        err('put failed:', tx.error);
        if (!_retry) {
          warn('retry put once');
          try { const id2 = await dbPut(rec, true); res(id2); } catch(e){ rej(e); }
        } else rej(tx.error);
      };
    });
  }
  async function dbUpdate(id, patch){
    const rec = await dbGetById(id);
    if (!rec) { warn('update target missing id=', id); return null; }
    return dbPut(Object.assign(rec, patch));
  }
  async function dbDeleteByIds(ids){
    if (!ids.length) return;
    const db = await openDB();
    return new Promise((res,rej)=>{
      const tx = db.transaction(STORE,'readwrite');
      const os = tx.objectStore(STORE);
      ids.forEach(id => os.delete(id));
      tx.oncomplete=()=> res();
      tx.onerror   =()=> rej(tx.error);
    });
  }
  async function dbMaintenance(){
    try{
      const THIRTY=30*24*60*60*1000, MAX_KEEP=10000;
      const all = await dbGetAll(); const now = Date.now();
      const oldIds = all.filter(r=> (r.tsLast||r.tsFirst||0) < now-THIRTY).map(r=>r.id);
      if (oldIds.length) { log('delete old ids:', oldIds.length); await dbDeleteByIds(oldIds); }
      const rest = (await dbGetAll()).sort((a,b)=>(a.tsLast||a.tsFirst)-(b.tsLast||b.tsFirst));
      if (rest.length>MAX_KEEP) await dbDeleteByIds(rest.slice(0,rest.length-MAX_KEEP).map(r=>r.id));
    }catch(e){ warn('maintenance skipped', e?.message||e); }
  }
  await dbMaintenance();

  // -------- 類似度・埋め込み --------
  const cosSim=(a,b)=>{ let dot=0,na=0,nb=0,L=Math.min(a.length,b.length); for(let i=0;i<L;i++){const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y;} return (na&&nb)?dot/(Math.sqrt(na)*Math.sqrt(nb)):0; };
  function normalize(v){ const out=new Float32Array(v.length); let n=0; for(let i=0;i<v.length;i++){n+=v[i]*v[i];} const s=n?1/Math.sqrt(n):1; for(let i=0;i<v.length;i++) out[i]=v[i]*s; return out; }
  async function faceEmbedding(face){
    const emb = face.embedding || face.descriptor;
    if (!emb || !Array.isArray(emb) || emb.length===0) return null;
    return normalize(new Float32Array(emb));
  }
  async function findNearestInDB(vec, TH=0.998){
    const all = await dbGetAll();
    let best=null, bestSim=-1;
    for(const r of all){ if(!r.vec) continue; const s = cosSim(vec, new Float32Array(r.vec)); if (s>bestSim){ bestSim=s; best=r; } }
    log('nearest sim=', bestSim.toFixed(4), 'id=', best?.id);
    return (best && bestSim>=TH) ? {rec:best, sim:bestSim} : null;
  }

  // -------- トラッキング（緩和）--------
  const MIN_FACE_SCORE=0.70, MIN_AREA_RATIO=0.05;
  const STREAK_N=4, SIM_MIN=0.98, IOU_MIN=0.20, DIST_MAX_RATIO=0.25;
  const iou=(b1,b2)=>{const[a,b,c,d]=b1,[e,f,g,h]=b2;const xa=Math.max(a,e),ya=Math.max(b,f);const xb=Math.min(a+c,e+g),yb=Math.min(b+d,f+h);const inter=Math.max(0,xb-xa)*Math.max(0,yb-ya);const uni=c*d+g*h-inter;return uni>0?inter/uni:0;};
  const centerDist=(b1,b2)=>{const c1=[b1[0]+b1[2]/2,b1[1]+b1[3]/2],c2=[b2[0]+b2[2]/2,b2[1]+b2[3]/2];return Math.hypot(c1[0]-c2[0],c1[1]-c2[1]);};

  const people=[]; const MEMORY_SIM_TH=0.998;
  const addPersonVec = vec => {
    for(const p of people){ for(const v of p.vecs){ if (cosSim(vec,v)>=MEMORY_SIM_TH){ p.vecs.push(vec); if(p.vecs.length>3)p.vecs.shift(); return; } } }
    people.push({ vecs:[vec] });
  };

  let nextTrackId=1;
  const tracks=new Map(); const TRACK_MAX_AGE=2000;
  function cleanupTracks(now){ for(const [id,t] of tracks){ if (now - t.lastTs > TRACK_MAX_AGE) tracks.delete(id); } }
  function assignDetectionsToTracks(dets){
    const now=performance.now(); cleanupTracks(now);
    const unassigned=new Set(dets.map((_,i)=>i));
    const entries=[...tracks.values()];
    const diag=Math.hypot(overlay.width, overlay.height)||1;

    if (entries.length===1 && dets.length===1){
      const t=entries[0], d=dets[0];
      t.box=d.box; t.vec=d.vec; t.lastTs=now; t.streak=Math.min(t.streak+1, STREAK_N);
      unassigned.delete(0); return [...unassigned];
    }

    const pairs=[];
    for(const t of entries){
      for(let i=0;i<dets.length;i++){
        const d=dets[i];
        const dist=centerDist(t.box,d.box)/diag, ov=iou(t.box,d.box), sim=(t.vec && d.vec)?cosSim(t.vec,d.vec):0;
        const cost = 0.7*(1-sim)+0.2*dist+0.1*(1-ov);
        pairs.push({tid:t.id,i,cost,sim,dist,ov});
      }
    }
    pairs.sort((a,b)=>a.cost-b.cost);

    const usedT=new Set(), usedD=new Set();
    for(const p of pairs){
      if (usedT.has(p.tid) || usedD.has(p.i)) continue;
      const passSim=p.sim>=SIM_MIN, passIOU=p.ov>=IOU_MIN, passDist=p.dist<=DIST_MAX_RATIO;
      if ((passSim&&passIOU)||(passSim&&passDist)||(passIOU&&passDist)){
        const t=tracks.get(p.tid), d=dets[p.i];
        t.box=d.box; t.vec=d.vec; t.lastTs=now; t.streak=Math.min(t.streak+1, STREAK_N);
        usedT.add(p.tid); usedD.add(p.i); unassigned.delete(p.i);
      }
    }
    return [...unassigned];
  }
  function createTrack(det){
    const now=performance.now();
    tracks.set(nextTrackId,{ id:nextTrackId++, box:det.box, vec:det.vec, lastTs:now, streak:1, counted:false });
  }

  // -------- カメラ --------
  let running=false, stream=null, rafId=null, lastTick=0;

  async function startCamera(){
    const facing = ckFront.checked ? 'user' : 'environment';
    stream = await navigator.mediaDevices.getUserMedia({
      video:{ facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480} },
      audio:false
    });
    video.srcObject=stream; await video.play();
    overlay.width=video.videoWidth||640; overlay.height=video.videoHeight||480;
    running=true; btnStart.disabled=true; btnStop.disabled=false;
    statusEl.textContent='実行中（デバッグ版）';
    loop();
  }
  function stopCamera(){
    running=false; if (rafId) cancelAnimationFrame(rafId);
    if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
  }

  async function loop(ts){
    if (!running) return;

    const dnow=todayStr();
    if (dnow!==currentDay){ currentDay=dnow; dayCounts=loadCounts(currentDay); renderTable(); }

    if (ts && ts-lastTick<100){ rafId=requestAnimationFrame(loop); return; }
    lastTick = ts || performance.now();

    const result = await human.detect(video);

    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.drawImage(video,0,0,overlay.width,overlay.height);

    const frameArea=overlay.width*overlay.height;
    const faces=(result.face||[]).filter(f=>{
      const [x,y,w,h]=f.box;
      const okScore = (typeof f.score!=='number') ? true : f.score>=0.70;
      const okArea  = (w*h)/frameArea>=0.05;
      return okScore && okArea;
    });

    const detections=[];
    for(const f of faces){
      const vec = await faceEmbedding(f);
      if (!vec) continue;
      detections.push({ box:f.box, vec, age:f.age?Math.round(f.age):null, gender:(f.gender||'unknown').toLowerCase() });
    }

    const unassignedIdx = assignDetectionsToTracks(detections);
    for(const idx of unassignedIdx) createTrack(detections[idx]);

    for(const t of [...tracks.values()]){
      if (t.streak>=STREAK_N && !t.counted && t.vec){
        let wrote = false;
        const nearest = await findNearestInDB(t.vec, 0.998);
        if (nearest){
          log('UPDATE existing id=', nearest.rec.id);
          await dbUpdate(nearest.rec.id, { tsLast:Date.now(), lastCountedDay:currentDay, seenCount:(nearest.rec.seenCount||0)+1 });
          wrote = true;
        }else{
          const attr = estimateAttrFromDetections(t.vec, detections);
          const rec = { vec:Array.from(t.vec), tsFirst:Date.now(), tsLast:Date.now(), seenCount:1, lastCountedDay:currentDay, attrs:attr };
          const newId = await dbPut(rec).catch(e=>{ err('insert failed', e); return null; });
          if (newId!=null){ log('INSERT new id=', newId); wrote = true; }
          else { warn('INSERT returned null id'); }
        }

        // UIカウントはDB結果に関わらず実施（ここで進まないときはロジック切り分け）
        const attr2 = estimateAttrFromDetections(t.vec, detections);
        dayCounts[attr2.bucket][attr2.gkey] += 1; saveCounts(currentDay, dayCounts); renderTable();

        if (!wrote) {
          console.warn('%cDBに書き込めませんでした（この行が見えたらスクショください）','color:#d00;font-weight:bold');
        }
        addPersonVec(t.vec);
        t.counted = true;
      }
    }

    // 可視化
    ctx.font='14px system-ui';
    for(const t of [...tracks.values()]){
      const [x,y,w,h]=t.box;
      ctx.lineWidth=2; ctx.strokeStyle=t.counted?'#00FF88':'#ffaa00';
      ctx.strokeRect(x,y,w,h);
      const tag=t.counted?'counted':`tracking ${t.streak}/${STREAK_N}`;
      const tw=ctx.measureText(tag).width+10;
      ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(x,Math.max(0,y-20),tw,20);
      ctx.fillStyle='#fff'; ctx.fillText(tag,x+5,Math.max(12,y-6));
    }

    rafId = requestAnimationFrame(loop);
  }

  // -------- イベント --------
  btnStart.addEventListener('click', async ()=>{ try{ await startCamera(); }catch(e){ statusEl.textContent='開始失敗: '+e.message; }});
  btnStop .addEventListener('click', stopCamera);
  btnCsv  .addEventListener('click', ()=>{
    const lines=['bucket,male,female,unknown'];
    for(const b of buckets){ const c=dayCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
    const blob=new Blob([lines.join('\n')],{type:'text/csv'});
    const url=URL.createObjectURL(blob);
    const a=Object.assign(document.createElement('a'),{href:url,download:`daily_attributes_${currentDay}.csv`});
    a.click(); URL.revokeObjectURL(url);
  });

  // -------- 全リセット（据え置き）--------
  function clearAllDailyStorage(){
    const del=[]; for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k && (k.startsWith('counts:')||k.startsWith('uniq:'))) del.push(k); }
    del.forEach(k=>localStorage.removeItem(k));
  }
  function deleteFacesDB(){
    return new Promise((resolve,reject)=>{
      const req = indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess=()=>resolve('deleted');
      req.onerror  =()=>reject(req.error);
      req.onblocked=()=>reject(new Error('DB deletion blocked (close other tabs or reload)'));
    });
  }
  async function resetAll(){
    if(!confirm('DBと集計をすべて削除します。よろしいですか？')) return;
    if (running) stopCamera?.();
    clearAllDailyStorage();
    try{ await deleteFacesDB(); }catch(e){ alert('DB削除がブロックされました。タブを閉じて再試行：'+(e?.message||e)); }
    tracks.clear?.(); if(Array.isArray(people)) people.length=0; nextTrackId=1;
    currentDay=todayStr(); dayCounts=blankCounts(); saveCounts(currentDay,dayCounts); renderTable();
    statusEl.textContent='全リセット完了（デバッグ版）';
  }
  btnResetAll?.addEventListener('click', resetAll);

  // -------- 初期表示 --------
  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices))
    statusEl.textContent='このブラウザはカメラ未対応';
  else
    statusEl.textContent='「カメラ開始」を押してください（HTTPS必須）';

  // -------- Helpers --------
  function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function estimateAttrFromDetections(vec, dets){
    let best=null, bestSim=-1;
    for(const d of dets){ const s=cosSim(vec,d.vec); if(s>bestSim){ bestSim=s; best=d; } }
    let bucket='unknown', gkey='unknown';
    if (best){
      const age = best.age;
      bucket = (age==null)?'unknown'
        : age<13?'child'
        : age<20?'10s'
        : age<30?'20s'
        : age<40?'30s'
        : age<50?'40s'
        : age<60?'50s':'60s+';
      const g=(best.gender||'');
      gkey = g.startsWith('f')?'female':(g.startsWith('m')?'male':'unknown');
    }
    return { bucket, gkey };
  }
})();
