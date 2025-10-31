// === 来客属性カウンター：新規のみカウント（DB照合・再入場/日跨ぎでも加算しない） ===
(async function () {
  // ---------- Utils ----------
  const delay = (ms) => new Promise(r => setTimeout(r, ms));
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };

  // ---------- DOM ----------
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
  statusEl.textContent = 'モデル準備中…';

  // ---------- Human ----------
  for (let i=0; i<200 && !window.Human; i++) await delay(50);
  if (!window.Human) {
    statusEl.textContent = 'Human を読み込めませんでした';
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
    filter:{enabled:true, equalization:true}
  });
  await human.load().catch(()=>{});
  statusEl.textContent = 'モデル準備完了';

  // ---------- Daily counts (表示は当日; カウントは生涯一度) ----------
  let currentDay = todayStr();
  const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
  const blankCounts = () => { const o={}; for(const b of buckets) o[b]={male:0,female:0,unknown:0}; return o; };
  const kCounts = d => `counts:${d}`;
  const loadCounts = d => { try{ const raw=localStorage.getItem(kCounts(d)); return raw?JSON.parse(raw):blankCounts(); }catch{ return blankCounts(); } };
  const saveCounts = (d,obj) => localStorage.setItem(kCounts(d), JSON.stringify(obj));
  let dayCounts = loadCounts(currentDay);
  const renderTable = () => tbody.innerHTML = buckets.map(b => {
    const c = dayCounts[b];
    return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
  }).join('');
  renderTable();

  // ---------- IndexedDB (faces-db / vectors) ----------
  const DB_NAME='faces-db', STORE='vectors';

  async function openDBEnsure() {
    // 既存を開く（バージョン指定なし）
    const db = await new Promise((resolve,reject)=>{
      const req = indexedDB.open(DB_NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
      req.onupgradeneeded = () => {
        const dbu = req.result;
        if (!dbu.objectStoreNames.contains(STORE)) {
          const os = dbu.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
          os.createIndex('tsLast', 'tsLast');
        }
      };
    });
    if (db.objectStoreNames.contains(STORE)) return db;

    // ストアが無ければ version+1 で作成
    const newVersion = db.version + 1;
    db.close();
    return new Promise((resolve,reject)=>{
      const req2 = indexedDB.open(DB_NAME, newVersion);
      req2.onupgradeneeded = () => {
        const dbu = req2.result;
        if (!dbu.objectStoreNames.contains(STORE)) {
          const os = dbu.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
          os.createIndex('tsLast', 'tsLast');
        }
      };
      req2.onsuccess = () => resolve(req2.result);
      req2.onerror   = () => reject(req2.error);
    });
  }

  // ★ ここを全面修正：各操作は IDBRequest の onSuccess を待って“値”を返す
  async function dbGetAll() {
    const db = await openDBEnsure();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const os = tx.objectStore(STORE);
      const rq = os.getAll();
      rq.onsuccess = () => res(Array.isArray(rq.result) ? rq.result : []);
      rq.onerror   = () => rej(rq.error);
    });
  }
  async function dbGetById(id) {
    const db = await openDBEnsure();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const os = tx.objectStore(STORE);
      const rq = os.get(id);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror   = () => rej(rq.error);
    });
  }
  async function dbPut(rec) {
    const db = await openDBEnsure();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => res(true);
      tx.onerror    = () => rej(tx.error);
    });
  }
  async function dbUpdate(id, patch) {
    const cur = await dbGetById(id);
    if (!cur) return false;
    return dbPut(Object.assign(cur, patch));
  }

  // ---------- Embedding / similarity ----------
  const cosSim=(a,b)=>{let d=0,na=0,nb=0,L=Math.min(a.length,b.length);for(let i=0;i<L;i++){const x=a[i],y=b[i];d+=x*y;na+=x*x;nb+=y*y;}return(na&&nb)?d/(Math.sqrt(na)*Math.sqrt(nb)):0;};
  const normalize = (v)=>{let n=0;for(let i=0;i<v.length;i++) n+=v[i]*v[i]; const s=n?1/Math.sqrt(n):1; const out=new Float32Array(v.length); for(let i=0;i<v.length;i++) out[i]=v[i]*s; return out;};
  async function faceEmbedding(face){
    const emb = face.embedding || face.descriptor;
    if (!emb || !Array.isArray(emb) || emb.length===0) return null;
    return normalize(new Float32Array(emb));
  }
  async function findNearestInDB(vec, TH=0.998){
    try{
      const all = await dbGetAll();        // ← 常に “配列” が返るようになった
      let best=null, bestSim=-1;
      for(const r of all){
        if (!r.vec) continue;
        const s = cosSim(vec, new Float32Array(r.vec));
        if (s > bestSim){ bestSim=s; best=r; }
      }
      return (best && bestSim>=TH) ? { rec:best, sim:bestSim } : null;
    }catch(e){
      console.warn('DB lookup skipped:', e);
      return null;
    }
  }

  // ---------- Tracking ----------
  const MIN_FACE_SCORE=0.70, MIN_AREA_RATIO=0.05;
  const STREAK_N=4, SIM_MIN=0.98, IOU_MIN=0.20, DIST_MAX_RATIO=0.25;
  const iou=(b1,b2)=>{const[a,b,c,d]=b1,[e,f,g,h]=b2;const xa=Math.max(a,e),ya=Math.max(b,f);const xb=Math.min(a+c,e+g),yb=Math.min(b+d,f+h);const inter=Math.max(0,xb-xa)*Math.max(0,yb-ya);const uni=c*d+g*h-inter;return uni>0?inter/uni:0;};
  const centerDist=(b1,b2)=>{const c1=[b1[0]+b1[2]/2,b1[1]+b1[3]/2],c2=[b2[0]+b2[2]/2,b2[1]+b2[3]/2];return Math.hypot(c1[0]-c2[0],c1[1]-c2[1]);};

  const people=[]; const MEMORY_SIM_TH=0.998;
  const addPersonVec=(vec)=>{for(const p of people){for(const v of p.vecs){if(cosSim(vec,v)>=MEMORY_SIM_TH){p.vecs.push(vec);if(p.vecs.length>3)p.vecs.shift();return;}}}people.push({vecs:[vec]});};

  let nextTrackId=1; const tracks=new Map(); const TRACK_MAX_AGE=2000;
  function cleanupTracks(now){for(const [id,t] of tracks){if(now-t.lastTs>TRACK_MAX_AGE)tracks.delete(id);}}
  function assignDetectionsToTracks(dets){
    const now=performance.now(); cleanupTracks(now);
    const unassigned=new Set(dets.map((_,i)=>i));
    const entries=[...tracks.values()];
    const diag=Math.hypot(overlay.width,overlay.height)||1;

    if(entries.length===1 && dets.length===1){
      const t=entries[0], d=dets[0];
      t.box=d.box; t.vec=d.vec; t.lastTs=now; t.streak=Math.min(t.streak+1,STREAK_N);
      unassigned.delete(0); return [...unassigned];
    }

    const pairs=[];
    for(const t of entries){
      for(let i=0;i<dets.length;i++){
        const d=dets[i];
        const dist=centerDist(t.box,d.box)/diag, ov=iou(t.box,d.box), sim=(t.vec&&d.vec)?cosSim(t.vec,d.vec):0;
        const cost=0.7*(1-sim)+0.2*dist+0.1*(1-ov);
        pairs.push({tid:t.id,i,cost,sim,dist,ov});
      }
    }
    pairs.sort((a,b)=>a.cost-b.cost);

    const usedT=new Set(), usedD=new Set();
    for(const p of pairs){
      if(usedT.has(p.tid)||usedD.has(p.i))continue;
      const passSim=p.sim>=SIM_MIN, passIOU=p.ov>=IOU_MIN, passDist=p.dist<=DIST_MAX_RATIO;
      if((passSim&&passIOU)||(passSim&&passDist)||(passIOU&&passDist)){
        const t=tracks.get(p.tid), d=dets[p.i];
        t.box=d.box; t.vec=d.vec; t.lastTs=now; t.streak=Math.min(t.streak+1,STREAK_N);
        usedT.add(p.tid); usedD.add(p.i); unassigned.delete(p.i);
      }
    }
    return [...unassigned];
  }
  function createTrack(det){
    const now=performance.now();
    tracks.set(nextTrackId,{ id:nextTrackId++, box:det.box, vec:det.vec, lastTs:now, streak:1, counted:false });
  }

  // ---------- Count only on first-ever ----------
  function addDailyCount(attr){
    dayCounts[attr.bucket][attr.gkey] += 1;
    saveCounts(currentDay, dayCounts);
    renderTable();
  }
  function estimateAttrFromDetections(vec, dets){
    let best=null, bestSim=-1;
    for(const d of dets){ const s=cosSim(vec, d.vec); if(s>bestSim){bestSim=s; best=d;} }
    let bucket='unknown', gkey='unknown';
    if(best){
      const age=best.age;
      bucket=(age==null)?'unknown':age<13?'child':age<20?'10s':age<30?'20s':age<40?'30s':age<50?'40s':age<60?'50s':'60s+';
      const g=(best.gender||''); gkey=g.startsWith('f')?'female':(g.startsWith('m')?'male':'unknown');
    }
    return { bucket, gkey };
  }

  // ---------- Camera ----------
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
    if(dnow!==currentDay){ currentDay=dnow; dayCounts=loadCounts(currentDay); renderTable(); }

    if(ts && ts-lastTick<100){ rafId=requestAnimationFrame(loop); return; }
    lastTick = ts || performance.now();

    const result = await human.detect(video);

    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.drawImage(video,0,0,overlay.width,overlay.height);

    const frameArea=overlay.width*overlay.height;
    const faces=(result.face||[]).filter(f=>{
      const [x,y,w,h]=f.box;
      const okScore=(typeof f.score!=='number')?true:f.score>=MIN_FACE_SCORE;
      const okArea=(w*h)/frameArea>=MIN_AREA_RATIO;
      return okScore && okArea;
    });

    const detections=[];
    for(const f of faces){
      const vec=await faceEmbedding(f);
      if(!vec) continue;
      detections.push({ box:f.box, vec, age:f.age?Math.round(f.age):null, gender:(f.gender||'unknown').toLowerCase() });
    }

    const unassignedIdx=assignDetectionsToTracks(detections);
    for(const idx of unassignedIdx) createTrack(detections[idx]);

    // 確定トラックだけ判定
    for(const t of [...tracks.values()]){
      if(t.streak>=STREAK_N && !t.counted && t.vec){
        try{
          const attr=estimateAttrFromDetections(t.vec, detections);
          const nearest=await findNearestInDB(t.vec, 0.998);

          if(nearest){
            // 既知：絶対にカウントしない（記録更新のみ）
            await dbUpdate(nearest.rec.id, { tsLast: Date.now(), seenCount:(nearest.rec.seenCount||0)+1 });
            addPersonVec(t.vec);
          }else{
            // 新規：DB登録 → この瞬間だけ +1
            const now=Date.now();
            await dbPut({
              vec: Array.from(t.vec),
              tsFirst: now, tsLast: now,
              seenCount: 1,
              attrs: attr
            });
            addDailyCount(attr);
            addPersonVec(t.vec);
          }
        }catch(e){
          console.warn('count step skipped due to DB error:', e);
        }
        t.counted = true; // 同一トラックの二重加算防止
      }
    }

    // 可視化
    ctx.font='14px system-ui';
    for(const t of [...tracks.values()]){
      const [x,y,w,h]=t.box;
      ctx.lineWidth=2; ctx.strokeStyle=t.counted?'#00C985':'#FFA726';
      ctx.strokeRect(x,y,w,h);
      const tag=t.counted?'counted':'tracking';
      const tw=ctx.measureText(tag).width+10;
      ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(x,Math.max(0,y-20),tw,20);
      ctx.fillStyle='#fff'; ctx.fillText(tag,x+5,Math.max(12,y-6));
    }

    rafId=requestAnimationFrame(loop);
  }

  // ---------- Events ----------
  btnStart.addEventListener('click', async ()=>{
    try{ await startCamera(); }catch(e){ statusEl.textContent='開始失敗: '+e.message; }
  });
  btnStop .addEventListener('click', stopCamera);
  btnCsv  .addEventListener('click', ()=>{
    const lines=['bucket,male,female,unknown'];
    for(const b of buckets){ const c=dayCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
    const blob=new Blob([lines.join('\n')],{type:'text/csv'});
    const url=URL.createObjectURL(blob);
    const a=Object.assign(document.createElement('a'),{href:url,download:`daily_attributes_${currentDay}.csv`});
    a.click(); URL.revokeObjectURL(url);
  });

  // ---------- Reset All ----------
  function clearAllDailyStorage(){
    const del=[]; for(let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k && (k.startsWith('counts:')||k.startsWith('uniq:'))) del.push(k); }
    del.forEach(k=>localStorage.removeItem(k));
  }
  function deleteFacesDB(){
    return new Promise((resolve,reject)=>{
      const req=indexedDB.deleteDatabase(DB_NAME);
      req.onsuccess=()=>resolve('deleted');
      req.onerror  =()=>reject(req.error);
      req.onblocked=()=>reject(new Error('DB deletion blocked'));
    });
  }
  async function resetAll(){
    if(!confirm('DB（顔ベクトル）と集計を全て削除して初期化します。よろしいですか？')) return;
    if(running) stopCamera?.();
    clearAllDailyStorage();
    try{ await deleteFacesDB(); }catch(e){ alert('DB削除がブロックされました。別タブを閉じてリロードしてください。'); }
    tracks.clear?.(); people.length=0; nextTrackId=1;
    currentDay=todayStr(); dayCounts=blankCounts(); saveCounts(currentDay,dayCounts); renderTable();
    statusEl.textContent='全リセット完了';
  }
  btnResetAll?.addEventListener('click', resetAll);

  // ---------- Init message ----------
  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices))
    statusEl.textContent='このブラウザはカメラ未対応';
  else
    statusEl.textContent='「カメラ開始」を押してください（HTTPS必須）';
})();
