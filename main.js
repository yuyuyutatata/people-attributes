// === 日次ユニーク集計 + 動いても1回だけ + IndexedDB 照合 ===
(async function boot() {
  // ---------------- DOM ----------------
  const overlay  = document.getElementById('overlay');
  const ctx      = overlay.getContext('2d');
  const btnStart = document.getElementById('btnStart');
  const btnStop  = document.getElementById('btnStop');
  const btnCsv   = document.getElementById('btnCsv');
  const ckFront  = document.getElementById('ckFront');
  const statusEl = document.getElementById('status');
  const tbody    = document.getElementById('tbody');

  btnStop.disabled = true;
  statusEl.textContent = '準備中…';

  // ---------------- Human 読み込み ----------------
  for (let i = 0; i < 200 && !window.Human; i++) await delay(100);
  if (!window.Human) {
    statusEl.textContent = 'Human が読み込めませんでした';
    btnStart.disabled = true; btnStop.disabled = true; return;
  }

  // 入力 video（非表示）
  const video = document.createElement('video');
  Object.assign(video.style, { display: 'none', width: '0', height: '0', position: 'absolute', opacity: '0' });
  document.body.appendChild(video);

  const human = new Human.Human({
    modelBasePath: './models',
    face: {
      detector: { rotation: true, maxDetected: 3 },
      mesh: false, iris: false,
      description: { enabled: true },
      descriptor:  { enabled: true },
    },
    body: { enabled: false }, hand: { enabled: false }, gesture: { enabled: false },
    filter: { enabled: true, equalization: true },
  });
  await human.load().catch(() => {});
  statusEl.textContent = 'モデル準備完了';

  // ---------------- 日付・保存（ローカル集計） ----------------
  const todayStr = () => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  };
  let currentDay = todayStr();

  const buckets = ['child', '10s', '20s', '30s', '40s', '50s', '60s+', 'unknown'];
  const blankCounts = () => {
    const o = {}; for (const b of buckets) o[b] = { male: 0, female: 0, unknown: 0 }; return o;
  };

  const kCounts = d => `counts:${d}`;
  const loadCounts = d => { try { const raw = localStorage.getItem(kCounts(d)); return raw ? JSON.parse(raw) : blankCounts(); } catch { return blankCounts(); } };
  const saveCounts = (d,obj) => localStorage.setItem(kCounts(d), JSON.stringify(obj));

  let dayCounts = loadCounts(currentDay);

  function renderTable() {
    tbody.innerHTML = buckets.map(b => {
      const c = dayCounts[b];
      return `<tr><td>${b}</td><td>${c.male}</td><td>${c.female}</td><td>${c.unknown}</td></tr>`;
    }).join('');
  }
  renderTable();

  // ---------------- IndexedDB（顔DB） ----------------
  // faces-db / vectors : { id, vec: number[], tsFirst, tsLast, seenCount, lastCountedDay, attrs? }
  const DB_NAME='faces-db', STORE='vectors', DB_VER=1;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const os = db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
          os.createIndex('tsLast', 'tsLast');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }
  async function dbGetAll() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readonly');
      const rq = tx.objectStore(STORE).getAll();
      rq.onsuccess = () => res(rq.result || []);
      rq.onerror   = () => rej(rq.error);
    });
  }
  async function dbGetById(id) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const rq = db.transaction(STORE, 'readonly').objectStore(STORE).get(id);
      rq.onsuccess = () => res(rq.result || null);
      rq.onerror   = () => rej(rq.error);
    });
  }
  async function dbPut(rec) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(rec);
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  }
  async function dbUpdate(id, patch) {
    const rec = await dbGetById(id);
    if (!rec) return;
    await dbPut(Object.assign(rec, patch));
  }
  async function dbDeleteByIds(ids) {
    if (!ids.length) return;
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite');
      const os = tx.objectStore(STORE);
      ids.forEach(id => os.delete(id));
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  }
  async function dbMaintenance() {
    const THIRTY = 30*24*60*60*1000, MAX_KEEP = 10000;
    const all = await dbGetAll(); const now = Date.now();
    const oldIds = all.filter(r => (r.tsLast||r.tsFirst||0) < now-THIRTY).map(r => r.id);
    await dbDeleteByIds(oldIds);
    const rest = (await dbGetAll()).sort((a,b)=>(a.tsLast||a.tsFirst)-(b.tsLast||b.tsFirst));
    if (rest.length > MAX_KEEP) await dbDeleteByIds(rest.slice(0, rest.length-MAX_KEEP).map(r => r.id));
  }
  await dbMaintenance();

  // 近傍検索（コサイン類似度）
  function cosSim(a, b) {
    let dot=0, na=0, nb=0, L=Math.min(a.length,b.length);
    for (let i=0;i<L;i++){ const x=a[i], y=b[i]; dot+=x*y; na+=x*x; nb+=y*y; }
    return (na&&nb) ? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0;
  }
  async function findNearestInDB(vec, SIM_TH=0.998) {
    const all = await dbGetAll();
    let best=null, bestSim=-1;
    for (const r of all) {
      if (!r.vec) continue;
      const s = cosSim(vec, new Float32Array(r.vec));
      if (s > bestSim) { bestSim=s; best=r; }
    }
    return (best && bestSim >= SIM_TH) ? { rec: best, sim: bestSim } : null;
  }

  // ---------------- 追尾・一致判定（厳しめ） ----------------
  const MIN_FACE_SCORE = 0.70;   // 顔スコア閾値（上げると厳しめ）
  const MIN_AREA_RATIO = 0.05;   // フレームに対する顔面積の最小比
  const STREAK_N       = 8;      // 連続フレーム数で確定
  const SIM_MIN        = 0.995;  // トラック更新に使う最小類似度
  const IOU_MIN        = 0.35;
  const DIST_MAX_RATIO = 0.15;

  const normalize = v => {
    const out = new Float32Array(v.length); let n=0;
    for (let i=0;i<v.length;i++){ const x=v[i]; n+=x*x; }
    const s = n ? 1/Math.sqrt(n) : 1;
    for (let i=0;i<v.length;i++) out[i] = v[i]*s;
    return out;
  };
  const iou = (b1,b2)=> {
    const [x1,y1,w1,h1]=b1,[x2,y2,w2,h2]=b2;
    const xa=Math.max(x1,x2), ya=Math.max(y1,y2);
    const xb=Math.min(x1+w1,x2+w2), yb=Math.min(y1+h1,y2+h2);
    const inter=Math.max(0,xb-xa)*Math.max(0,yb-ya);
    const uni=w1*h1+w2*h2-inter; return uni>0? inter/uni:0;
  };
  const centerDist = (b1,b2)=> {
    const c1x=b1[0]+b1[2]/2, c1y=b1[1]+b1[3]/2;
    const c2x=b2[0]+b2[2]/2, c2y=b2[1]+b2[3]/2;
    return Math.hypot(c1x-c2x, c1y-c2y);
  };

  async function faceEmbedding(face) {
    const emb = face.descriptor || face.embedding;
    if (!emb || !Array.isArray(emb)) return null;
    return normalize(new Float32Array(emb));
  }

  // メモリ内クラスタ（姿勢変化耐性）
  const people = [];                 // [{ vecs: Float32Array[] }]
  const MEMORY_SIM_TH = 0.998;
  const addPersonVec = vec => {
    for (const p of people) {
      for (const v of p.vecs) {
        if (cosSim(vec, v) >= MEMORY_SIM_TH) {
          p.vecs.push(vec); if (p.vecs.length > 3) p.vecs.shift(); return;
        }
      }
    }
    people.push({ vecs: [vec] });
  };

  // トラッカー
  let nextTrackId = 1;
  const tracks = new Map();  // id -> { id, box, vec, lastTs, streak, counted }
  const TRACK_MAX_AGE = 2000;

  function cleanupTracks(now) {
    for (const [id,t] of tracks) if (now - t.lastTs > TRACK_MAX_AGE) tracks.delete(id);
  }
  function assignDetectionsToTracks(dets) {
    const now = performance.now(); cleanupTracks(now);
    const unassigned = new Set(dets.map((_,i)=>i));
    const entries = [...tracks.values()];
    const diag = Math.hypot(overlay.width, overlay.height) || 1;

    const pairs = [];
    for (const t of entries) {
      for (let i=0;i<dets.length;i++) {
        const d = dets[i];
        const dist = centerDist(t.box, d.box)/diag;
        const ov   = iou(t.box, d.box);
        const sim  = t.vec && d.vec ? cosSim(t.vec, d.vec) : 0;
        const cost = 0.7*(1-sim) + 0.2*dist + 0.1*(1-ov);
        pairs.push({ tid: t.id, i, cost, sim, dist, ov });
      }
    }
    pairs.sort((a,b)=>a.cost-b.cost);

    const usedT=new Set(), usedD=new Set();
    for (const p of pairs) {
      if (usedT.has(p.tid) || usedD.has(p.i)) continue;
      if (p.sim >= SIM_MIN && p.ov >= IOU_MIN && p.dist <= DIST_MAX_RATIO) {
        const t = tracks.get(p.tid), d = dets[p.i];
        t.box = d.box; t.vec = d.vec;
        t.lastTs = now; t.streak = Math.min(t.streak+1, STREAK_N);
        usedT.add(p.tid); usedD.add(p.i); unassigned.delete(p.i);
      }
    }
    return [...unassigned];
  }
  function createTrack(det) {
    const now = performance.now();
    tracks.set(nextTrackId, { id: nextTrackId++, box: det.box, vec: det.vec, lastTs: now, streak: 1, counted: false });
  }

  // ---------------- カメラ制御 ----------------
  let running=false, stream=null, rafId=null, lastTick=0;

  async function startCamera() {
    const facing = ckFront.checked ? 'user' : 'environment';
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: facing }, width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false
    });
    video.srcObject = stream; await video.play();
    overlay.width  = video.videoWidth  || 640;
    overlay.height = video.videoHeight || 480;
    running = true; btnStart.disabled = true; btnStop.disabled = false;
    statusEl.textContent = '実行中（1日1回・DB照合・動いても1回だけ）';
    loop();
  }
  function stopCamera() {
    running = false; if (rafId) cancelAnimationFrame(rafId);
    if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
    btnStart.disabled = false; btnStop.disabled = true; statusEl.textContent = '停止';
  }

  async function loop(ts) {
    if (!running) return;

    // 日付跨ぎでリセット
    const dnow = todayStr();
    if (dnow !== currentDay) {
      currentDay = dnow;
      dayCounts  = loadCounts(currentDay);
      renderTable();
    }

    // 描画・検出レート制御（~10fps）
    if (ts && ts - lastTick < 100) { rafId = requestAnimationFrame(loop); return; }
    lastTick = ts || performance.now();

    const result = await human.detect(video);

    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.drawImage(video,0,0,overlay.width,overlay.height);

    // 低信頼フレーム除外
    const frameArea = overlay.width * overlay.height;
    const faces = (result.face || []).filter(f => {
      const [x,y,w,h] = f.box;
      const okScore = (typeof f.score !== 'number') ? true : f.score >= MIN_FACE_SCORE;
      const okArea  = (w*h)/frameArea >= MIN_AREA_RATIO;
      return okScore && okArea;
    });

    // 埋め込み
    const detections = [];
    for (const f of faces) {
      const vec = await faceEmbedding(f);
      if (!vec) continue;
      detections.push({
        box: f.box,
        vec,
        age: f.age ? Math.round(f.age) : null,
        gender: (f.gender||'unknown').toLowerCase()
      });
    }

    // トラック割当
    const unassignedIdx = assignDetectionsToTracks(detections);
    for (const idx of unassignedIdx) createTrack(detections[idx]);

    // 確定トラックだけ 1日1回カウント処理
    for (const t of [...tracks.values()]) {
      if (t.streak >= STREAK_N && !t.counted && t.vec) {
        // 1) DB 既知か？
        const nearest = await findNearestInDB(t.vec, 0.998);
        if (nearest) {
          // 既知：当日未カウントなら +1 して lastCountedDay を更新
          const last = nearest.rec.lastCountedDay || '';
          if (last !== currentDay) {
            const attr = estimateAttrFromDetections(t.vec, detections);
            dayCounts[attr.bucket][attr.gkey] += 1; saveCounts(currentDay, dayCounts); renderTable();
            await dbUpdate(nearest.rec.id, { tsLast: Date.now(), lastCountedDay: currentDay, seenCount: (nearest.rec.seenCount||0)+1 });
          } else {
            // 当日すでにカウント済み：最終観測だけ更新
            await dbUpdate(nearest.rec.id, { tsLast: Date.now(), seenCount: (nearest.rec.seenCount||0)+1 });
          }
          addPersonVec(t.vec);
        } else {
          // 未知：登録して当日カウント +1
          const attr = estimateAttrFromDetections(t.vec, detections);
          await dbPut({
            vec: Array.from(t.vec),
            tsFirst: Date.now(),
            tsLast : Date.now(),
            seenCount: 1,
            lastCountedDay: currentDay,
            attrs: attr
          });
          dayCounts[attr.bucket][attr.gkey] += 1; saveCounts(currentDay, dayCounts); renderTable();
          addPersonVec(t.vec);
        }
        t.counted = true; // このトラックは2度と数えない
      }
    }

    // 可視化
    ctx.font = '14px system-ui';
    for (const t of [...tracks.values()]) {
      const [x,y,w,h] = t.box;
      ctx.lineWidth = 2; ctx.strokeStyle = t.counted ? '#00FF88' : '#ffaa00';
      ctx.strokeRect(x,y,w,h);
      const tag = t.counted ? 'counted' : `tracking ${t.streak}/${STREAK_N}`;
      const tw = ctx.measureText(tag).width + 10;
      ctx.fillStyle='rgba(0,0,0,0.5)'; ctx.fillRect(x, Math.max(0,y-20), tw, 20);
      ctx.fillStyle='#fff'; ctx.fillText(tag, x+5, Math.max(12,y-6));
    }

    rafId = requestAnimationFrame(loop);
  }

  // ---------------- イベント ----------------
  btnStart.addEventListener('click', async () => {
    try { await startCamera(); } catch (e) { statusEl.textContent = 'カメラ開始失敗: ' + e.message; }
  });
  btnStop .addEventListener('click', stopCamera);
  btnCsv  .addEventListener('click', () => {
    const lines = ['bucket,male,female,unknown'];
    for (const b of buckets) { const c = dayCounts[b]; lines.push([b, c.male, c.female, c.unknown].join(',')); }
    const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: `daily_attributes_${currentDay}.csv` });
    a.click(); URL.revokeObjectURL(url);
  });

  // ---------------- 初期表示 ----------------
  if (!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices))
    statusEl.textContent = 'このブラウザはカメラ取得に未対応です';
  else
    statusEl.textContent = '「カメラ開始」を押してください（HTTPS必須）';

  // ---------------- Helpers ----------------
  function delay(ms){ return new Promise(r=>setTimeout(r,ms)); }

  function estimateAttrFromDetections(vec, dets){
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

  // ===== RESET（最終版・重複なし） =====

  // counts:＊ を全削除（uniq: は使っていないので触らない）
  function clearAllDailyStorage() {
    const del = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('counts:')) del.push(k);
    }
    del.forEach(k => localStorage.removeItem(k));
  }

  // faces-db（IndexedDB）を丸ごと削除
  function deleteFacesDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.deleteDatabase('faces-db');
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
      req.onblocked = () => reject(new Error('DB deletion blocked (close other tabs or reload)'));
    });
  }

  // すべて初期化（DB・ローカル集計・トラッカー）
  async function resetAll() {
    if (!confirm('DB（顔ベクトル）と集計を全て削除して初期化します。よろしいですか？')) return;
    if (!confirm('本当に実行しますか？この操作は元に戻せません。')) return;

    try {
      // 実行中ならいったん停止
      if (typeof running !== 'undefined' && running) {
        try { stopCamera(); } catch {}
      }

      // ローカル集計のキー削除
      clearAllDailyStorage();

      // IndexedDB 削除（他タブが掴んでいると失敗）
      try { await deleteFacesDB(); }
      catch (e) {
        alert('DBの削除がブロックされました。他のタブを閉じてから再実行してください。\n' + (e?.message || e));
      }

      // メモリ状態初期化（全員を新規扱いへ）
      if (typeof tracks !== 'undefined' && tracks.clear) tracks.clear();
      if (typeof people !== 'undefined' && Array.isArray(people)) people.length = 0;
      if (typeof nextTrackId !== 'undefined') nextTrackId = 1;

      // 今日の器を作り直して描画
      currentDay = todayStr();
      dayCounts  = blankCounts();
      saveCounts(currentDay, dayCounts);
      renderTable();

      statusEl.textContent = 'DB・集計を全リセットしました（全員が新規扱いになります）';
    } catch (err) {
      console.error(err);
      alert('全リセット中にエラーが発生しました：' + (err?.message || err));
    }
  }

  // ボタン割り当て
  document.getElementById('btnResetAll')?.addEventListener('click', resetAll);

})();
