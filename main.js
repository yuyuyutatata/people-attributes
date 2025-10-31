// === 新規のみカウント + 安定ID照合（EMAセンロイド & マージン） + IndexedDB ===
(async function boot() {
  // ------------ DOM ------------
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

  // ------------ Human ------------
  for (let i = 0; i < 200 && !window.Human; i++) await delay(100);
  if (!window.Human) { statusEl.textContent = 'Human 読み込み失敗'; btnStart.disabled = true; btnStop.disabled = true; return; }

  const video = Object.assign(document.createElement('video'), { muted: true, playsInline: true });
  Object.assign(video.style, { display:'none', width:'0', height:'0', position:'absolute', opacity:'0' });
  document.body.appendChild(video);

  const human = new Human.Human({
    modelBasePath: 'https://cdn.jsdelivr.net/npm/@vladmandic/human@3.3.6/models',
    face: {
      detector:  { rotation: true, maxDetected: 1 },       // 1人前提で安定化
      embedding: { enabled: true },
      descriptor:{ enabled: true },
      age:       { enabled: true },
      gender:    { enabled: true },
      mesh:false, iris:false,
    },
    body:{enabled:false}, hand:{enabled:false}, gesture:{enabled:false},
    filter:{enabled:true, equalization:true},
  });
  await human.load().catch(()=>{});
  statusEl.textContent = 'モデル準備完了';

  // ------------ 日付・集計（新規のみ）------------
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  let currentDay = todayStr();
  const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
  const blankCounts = () => { const o={}; for (const b of buckets) o[b] = {male:0,female:0,unknown:0}; return o; };
  const kCounts = d => `counts:${d}`;
  const loadCounts = d => { try{ const raw = localStorage.getItem(kCounts(d)); return raw ? JSON.parse(raw) : blankCounts(); } catch { return blankCounts(); } };
  const saveCounts = (d,obj) => localStorage.setItem(kCounts(d), JSON.stringify(obj));
  let dayCounts = loadCounts(currentDay);
  const renderTable = () => {
    tbody.innerHTML = buckets.map(b => {
      const c = dayCounts[b];
      return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
    }).join('');
  };
  renderTable();

  // ------------ IndexedDB（faces-db / vectors）------------
  // レコード構造：
  // { id, vecAvg:number[], n:number, tsFirst, tsLast, seenCount, hasCountedOnce:boolean, attrs? }
  const DB_NAME='faces-db', STORE='vectors', TARGET_VER=5;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => {
        const db = req.result;
        if (db.objectStoreNames.contains(STORE)) return resolve(db);
        const newVer = Math.max(db.version + 1, TARGET_VER);
        db.close();
        const up = indexedDB.open(DB_NAME, newVer);
        up.onupgradeneeded = () => {
          const db2 = up.result;
          if (!db2.objectStoreNames.contains(STORE)) {
            const os = db2.createObjectStore(STORE, { keyPath:'id', autoIncrement:true });
            os.createIndex('tsLast', 'tsLast');
          }
        };
        up.onsuccess = () => resolve(up.result);
        up.onerror   = () => reject(up.error);
      };
    });
  }
  async function dbAll() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror   = () => rej(rq.error);
    });
  }
  async function dbGet(id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const rq = db.transaction(STORE,'readonly').objectStore(STORE).get(id);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror   = () => rej(rq.error);
    });
  }
  async function dbPut(rec) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const rq = tx.objectStore(STORE).put(rec);
      let insertedId = null;
      rq.onsuccess = () => { insertedId = rq.result; };
      tx.oncomplete = () => res(insertedId);
      tx.onerror    = () => rej(tx.error);
    });
  }
  async function dbUpdate(id, patch) {
    const rec = await dbGet(id);
    if (!rec) return null;
    return dbPut(Object.assign(rec, patch));
  }

  // ------------ ベクトル関数 ------------
  const cosSim = (a,b)=>{ let dot=0,na=0,nb=0,L=Math.min(a.length,b.length); for(let i=0;i<L;i++){const x=a[i],y=b[i]; dot+=x*y; na+=x*x; nb+=y*y;} return (na&&nb)? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0; };
  const normalize = v => { const out=new Float32Array(v.length); let s=0; for(let i=0;i<v.length;i++) s+=v[i]*v[i]; s = s ? 1/Math.sqrt(s) : 1; for(let i=0;i<v.length;i++) out[i]=v[i]*s; return out; };
  async function faceVec(face) {
    const emb = face.embedding || face.descriptor;
    if (!emb || !Array.isArray(emb) || emb.length===0) return null;
    return normalize(new Float32Array(emb));
  }

  // 代表ベクトル（EMA）へ更新
  function emaUpdate(oldAvg, newVec, n, alpha=0.1) {
    // nが小さいうちは平均、十分溜まったらEMA
    const out = new Float32Array(oldAvg.length);
    const w = n < 5 ? 1/(n+1) : alpha;
    for (let i=0;i<out.length;i++) out[i] = (1-w)*oldAvg[i] + w*newVec[i];
    // L2正規化
    return normalize(out);
  }

  // 最近傍検索：1位と2位の差（マージン）もチェック
  async function findNearestByCentroid(vec) {
    const all = await dbAll();
    let best=null, second=null;
    for (const r of all) {
      const base = r.vecAvg || r.vec || r.embedding; // 後方互換
      if (!base) continue;
      const s = cosSim(vec, new Float32Array(base));
      if (!best || s > best.sim) { second = best; best = { rec:r, sim:s }; }
      else if (!second || s > second.sim) { second = { rec:r, sim:s }; }
    }
    return { best, second };
  }

  // 判定しきい値（ブレ吸収のため少し緩め + マージン併用）
  const TH_STRICT = 0.995;   // すごく近いと即マッチ
  const TH_SOFT   = 0.987;   // ここを下げすぎると誤マージ増
  const MARGIN    = 0.010;   // 1位と2位の差

  // ------------ トラッキング ------------
  const MIN_SCORE = 0.70, MIN_AREA_RATIO = 0.05;
  const STREAK_N = 5;               // 連続確信フレーム
  const tracks = new Map();
  let nextTrackId = 1;
  const TRACK_MAX_AGE = 1800;

  function cleanupTracks(now){ for (const [id,t] of tracks) if (now - t.lastTs > TRACK_MAX_AGE) tracks.delete(id); }

  function assignDets(dets) {
    const now = performance.now(); cleanupTracks(now);
    const unassigned = new Set(dets.map((_,i)=>i));
    // 単純1対1（本用途は十分）
    if (tracks.size === 1 && dets.length === 1) {
      const t=[...tracks.values()][0], d=dets[0];
      t.box=d.box; t.vec=d.vec; t.lastTs=now; t.streak=Math.min(t.streak+1, STREAK_N);
      unassigned.delete(0);
      return [...unassigned];
    }
    // 新規化
    return [...unassigned];
  }

  function createTrack(det){
    const now=performance.now();
    tracks.set(nextTrackId, { id:nextTrackId++, box:det.box, vec:det.vec, streak:1, lastTs:now, counted:false });
  }

  // ------------ カメラ ------------
  let running=false, stream=null, rafId=null, lastTick=0;

  async function startCamera(){
    const facing = ckFront.checked ? 'user' : 'environment';
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode:{ideal:facing}, width:{ideal:640}, height:{ideal:480} },
      audio: false
    });
    video.srcObject = stream; await video.play();
    overlay.width = video.videoWidth || 640; overlay.height = video.videoHeight || 480;
    running = true; btnStart.disabled = true; btnStop.disabled = false;
    statusEl.textContent = '実行中（新規のみカウント）';
    loop();
  }
  function stopCamera(){
    running=false; if (rafId) cancelAnimationFrame(rafId);
    if (stream){ stream.getTracks().forEach(t=>t.stop()); stream=null; }
    btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止';
  }

  async function loop(ts){
    if (!running) return;

    const dnow = todayStr();
    if (dnow !== currentDay) { currentDay = dnow; dayCounts = loadCounts(currentDay); renderTable(); }

    if (ts && ts - lastTick < 100) { rafId = requestAnimationFrame(loop); return; }
    lastTick = ts || performance.now();

    const result = await human.detect(video);

    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.drawImage(video,0,0,overlay.width,overlay.height);

    const frameArea = overlay.width * overlay.height;
    const faces = (result.face || []).filter(f => {
      const [x,y,w,h] = f.box;
      const okScore = (typeof f.score !== 'number') ? true : f.score >= MIN_SCORE;
      const okArea  = (w*h)/frameArea >= MIN_AREA_RATIO;
      return okScore && okArea;
    });

    const dets = [];
    for (const f of faces) {
      const vec = await faceVec(f);
      if (!vec) continue;
      dets.push({ box:f.box, vec, age: f.age?Math.round(f.age):null, gender:(f.gender||'unknown').toLowerCase() });
    }

    const unassigned = assignDets(dets);
    for (const i of unassigned) createTrack(dets[i]);

    // 確定したトラックのみ処理
    for (const t of [...tracks.values()]) {
      if (t.vec && t.streak >= STREAK_N && !t.counted) {
        // 1) 代表ベクトル（vecAvg）でデータベース照合
        const { best, second } = await findNearestByCentroid(t.vec);
        let matchedId = null, matchedRec = null, matchedSim = -1;

        if (best) {
          const passStrict = best.sim >= TH_STRICT;
          const passSoft   = best.sim >= TH_SOFT && (!second || (best.sim - (second.sim||0)) >= MARGIN);
          if (passStrict || passSoft) {
            matchedId  = best.rec.id;
            matchedRec = best.rec;
            matchedSim = best.sim;
          }
        }

        if (matchedId != null) {
          // 既知：代表ベクトルをEMA更新、ただし“新規のみカウント”なので集計は増やさない
          const base = matchedRec.vecAvg || matchedRec.vec;
          const oldAvg = new Float32Array(base);
          const newAvg = emaUpdate(oldAvg, t.vec, matchedRec.n || 1);
          await dbUpdate(matchedId, {
            vecAvg: Array.from(newAvg),
            n: (matchedRec.n||1) + 1,
            tsLast: Date.now(),
            seenCount: (matchedRec.seenCount||0) + 1
          });
        } else {
          // 2) 未知：新規登録 → このタイミングだけ集計 +1
          const attr = estimateAttrFromDets(t.vec, dets);
          const rec = {
            vecAvg: Array.from(t.vec),   // 初期は観測ベクトルをそのまま代表に
            n: 1,
            tsFirst: Date.now(),
            tsLast : Date.now(),
            seenCount: 1,
            hasCountedOnce: true,       // “新規のみ”フラグ
            attrs: attr
          };
          const newId = await dbPut(rec);
          // 集計（新規のみ）
          dayCounts[attr.bucket][attr.gkey] += 1; saveCounts(currentDay, dayCounts); renderTable();
        }

        t.counted = true; // このトラックは以後カウントしない
      }
    }

    // 可視化
    ctx.font = '14px system-ui';
    for (const t of [...tracks.values()]) {
      const [x,y,w,h] = t.box;
      ctx.lineWidth = 2; ctx.strokeStyle = t.counted ? '#00C853' : '#FFA000';
      ctx.strokeRect(x,y,w,h);
      const tag = t.counted ? 'counted' : `tracking ${t.streak}/${STREAK_N}`;
      const tw = ctx.measureText(tag).width + 10;
      ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(x, Math.max(0,y-20), tw, 20);
      ctx.fillStyle='#fff'; ctx.fillText(tag, x+5, Math.max(12,y-6));
    }

    rafId = requestAnimationFrame(loop);
  }

  // ------------ イベント ------------
  btnStart.addEventListener('click', async ()=>{ try{ await startCamera(); }catch(e){ statusEl.textContent = '開始失敗: ' + e.message; }});
  btnStop .addEventListener('click', stopCamera);
  btnCsv  .addEventListener('click', () => {
    const lines = ['bucket,male,female,unknown'];
    for (const b of buckets) { const c = dayCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
    const blob = new Blob([lines.join('\n')], { type:'text/csv' });
    const url  = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href:url, download:`daily_attributes_${currentDay}.csv` });
    a.click(); URL.revokeObjectURL(url);
  });

  // ------------ 全リセット ------------
  function clearDaily() {
    const del=[]; for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if (k && (k.startsWith('counts:')||k.startsWith('uniq:'))) del.push(k); }
    del.forEach(k=>localStorage.removeItem(k));
  }
  function deleteDB() {
    return new Promise((resolve,reject)=>{
      const rq = indexedDB.deleteDatabase(DB_NAME);
      rq.onsuccess=()=>resolve('deleted'); rq.onerror=()=>reject(rq.error);
      rq.onblocked=()=>reject(new Error('DB deletion blocked'));
    });
  }
  btnResetAll?.addEventListener('click', async ()=>{
    if (!confirm('DBと集計を初期化します。よろしいですか？')) return;
    if (running) stopCamera();
    clearDaily();
    try{ await deleteDB(); }catch(e){ alert('DB削除がブロックされました。タブを閉じて再試行してください。'); }
    tracks.clear(); nextTrackId=1;
    currentDay = todayStr(); dayCounts = blankCounts(); saveCounts(currentDay, dayCounts); renderTable();
    statusEl.textContent = '全リセット完了';
  });

  // ------------ 初期表示 ------------
  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices))
    statusEl.textContent = 'このブラウザはカメラ未対応';
  else
    statusEl.textContent = '「カメラ開始」を押してください（HTTPS必須）';

  // ------------ Helpers ------------
  function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }
  function estimateAttrFromDets(vec, dets){
    // そのフレームでもっとも近い観測から属性を採用
    let best=null, bestSim=-1;
    for (const d of dets){ const s = cosSim(vec, d.vec); if (s > bestSim){ bestSim=s; best=d; } }
    let bucket='unknown', gkey='unknown';
    if (best){
      const age = best.age;
      bucket = (age==null) ? 'unknown'
            : age<13 ? 'child'
            : age<20 ? '10s'
            : age<30 ? '20s'
            : age<40 ? '30s'
            : age<50 ? '40s'
            : age<60 ? '50s' : '60s+';
      const g = best.gender||'';
      gkey = g.startsWith('f') ? 'female' : (g.startsWith('m') ? 'male' : 'unknown');
    }
    return { bucket, gkey };
  }
})();
