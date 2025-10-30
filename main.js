// === ユニーク人数カウント：同一人物は日内で厳密に1回のみ ===
(async function boot() {
  const overlay = document.getElementById('overlay');
  const ctx = overlay.getContext('2d');
  const btnStart = document.getElementById('btnStart');
  const btnStop  = document.getElementById('btnStop');
  const btnCsv   = document.getElementById('btnCsv');
  const ckFront  = document.getElementById('ckFront');
  const statusEl = document.getElementById('status');
  const tbody    = document.getElementById('tbody');
  const logEl    = document.getElementById('log');

  btnStop.disabled = true;
  statusEl.textContent = '準備中…';

  for (let i=0;i<200 && !window.Human;i++) await new Promise(r=>setTimeout(r,100));
  if (!window.Human) { statusEl.textContent='Humanが読み込めませんでした'; btnStart.disabled=true; btnStop.disabled=true; return; }

  // 入力 video（非表示）
  const video = document.createElement('video');
  Object.assign(video.style,{display:'none',visibility:'hidden',width:'0px',height:'0px',position:'absolute',opacity:'0'});
  document.body.appendChild(video);

  const human = new Human.Human({
    modelBasePath: './models',
    face: {
      detector: { rotation:true, maxDetected:5 },
      mesh:false, iris:false,
      description:{ enabled:true },
      descriptor:{ enabled:true },
    },
    body:{enabled:false}, hand:{enabled:false}, gesture:{enabled:false},
    filter:{enabled:true, equalization:true},
  });

  // ===== 集計 =====
  const buckets = ['child','10s','20s','30s','40s','50s','60s+','unknown'];
  const minuteCounts = {};
  function initCounts(){ for(const b of buckets) minuteCounts[b]={male:0,female:0,unknown:0}; }
  function renderTable(){
    tbody.innerHTML = buckets.map(b=>`<tr><td>${b}</td><td>${minuteCounts[b].male}</td><td>${minuteCounts[b].female}</td><td>${minuteCounts[b].unknown}</td></tr>`).join('');
  }
  initCounts(); renderTable();
  setInterval(()=>{ initCounts(); renderTable(); }, 60*1000);

  // ===== ユニーク判定 =====
  const SITE_SECRET='FIXED_SECRET_12345';
  const todayStr = ()=>{const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;};
  function loadUniqSet(){ try{ const raw=localStorage.getItem(todayStr()); return new Set(raw?JSON.parse(raw):[]);}catch{return new Set();}}
  function saveUniqSet(s){ localStorage.setItem(todayStr(), JSON.stringify([...s])); }
  let uniqSet = loadUniqSet(); // 「その日すでに数えたID」の集合

  // ベクトル類似 & 位置
  function cosSim(a,b){ let dot=0,na=0,nb=0,L=Math.min(a.length,b.length); for(let i=0;i<L;i++){let x=a[i],y=b[i];dot+=x*y;na+=x*x;nb+=y*y} return (na&&nb)? dot/(Math.sqrt(na)*Math.sqrt(nb)) : 0; }
  function iou(b1,b2){ const [x1,y1,w1,h1]=b1,[x2,y2,w2,h2]=b2; const xa=Math.max(x1,x2),ya=Math.max(y1,y2),xb=Math.min(x1+w1,x2+w2),yb=Math.min(y1+h1,y2+h2); const inter=Math.max(0,xb-xa)*Math.max(0,yb-ya); const uni=w1*h1+w2*h2-inter; return uni>0? inter/uni:0; }

  // 直近の“観測記録”
  const recent=[]; // {vec:Float32Array, box:[x,y,w,h], t:number, hash:string|null, counted:boolean}
  const trackState=new Map(); // key -> {streak,lastTs,lastBox,lastVec,lastHash,countedForever:boolean}

  const RECENT_WINDOW_MS=60*1000, SIM_TH=0.985, IOU_TH=0.35, STREAK_N=3;

  function prune(now){
    for(let i=recent.length-1;i>=0;i--) if(now-recent[i].t>RECENT_WINDOW_MS) recent.splice(i,1);
    for(const [k,st] of trackState) if(now-st.lastTs>RECENT_WINDOW_MS) trackState.delete(k);
  }
  function gridKey(box){ const [x,y,w,h]=box; return [Math.round((x+w/2)/40),Math.round((y+h/2)/40),Math.round(w/40),Math.round(h/40)].join(':'); }
  function findDup(vec,box,now){
    let best=null,simBest=0;
    for(const r of recent){ if(now-r.t>RECENT_WINDOW_MS) continue; const s=cosSim(vec,r.vec||vec); if(s>=SIM_TH && iou(box,r.box)>=IOU_TH && s>simBest){best=r;simBest=s;} }
    return best;
  }
  async function hashFaceEmbedding(face){
    const emb = face.descriptor || face.embedding;
    if(!emb || !Array.isArray(emb)) return {vec:null,hash:null};
    const vec=new Float32Array(emb);
    const q = Array.from(vec, v=>Math.round(v/0.05)*0.05);
    const payload=JSON.stringify({r:q,d:todayStr(),s:SITE_SECRET});
    const buf=await crypto.subtle.digest('SHA-256', new TextEncoder().encode(payload));
    const v=new Uint8Array(buf); const hash=Array.from(v.slice(0,16),b=>b.toString(16).padStart(2,'0')).join('');
    return {vec,hash};
  }

  // ===== カメラ =====
  let running=false, stream=null, rafId=null, lastTick=0;

  async function startCamera(){
    const facing=ckFront.checked?'user':'environment';
    stream=await navigator.mediaDevices.getUserMedia({ video:{facingMode:{ideal:facing},width:{ideal:640},height:{ideal:480}}, audio:false });
    video.srcObject=stream; await video.play();
    overlay.width=video.videoWidth||640; overlay.height=video.videoHeight||480;
    running=true; btnStart.disabled=true; btnStop.disabled=false; statusEl.textContent='実行中（ユニーク一回のみ）';
    loop();
  }
  function stopCamera(){ running=false; if(rafId)cancelAnimationFrame(rafId); if(stream){stream.getTracks().forEach(t=>t.stop()); stream=null;} btnStart.disabled=false; btnStop.disabled=true; statusEl.textContent='停止'; }

  async function loop(ts){
    if(!running) return;
    if(ts && ts-lastTick<100){ rafId=requestAnimationFrame(loop); return; }
    lastTick = ts || performance.now();

    await human.load();
    const result = await human.detect(video);

    ctx.clearRect(0,0,overlay.width,overlay.height);
    ctx.drawImage(video,0,0,overlay.width,overlay.height);

    const faces=result.face||[]; const now=performance.now(); prune(now);

    for(const f of faces){
      const [x,y,w,h]=f.box;
      const age = f.age ? Math.round(f.age) : null;
      const bucket = age==null? 'unknown' : (age<13?'child':age<20?'10s':age<30?'20s':age<40?'30s':age<50?'40s':age<60?'50s':'60s+');
      const g = (f.gender||'unknown').toLowerCase(); const gkey = g.startsWith('f')?'female':(g.startsWith('m')?'male':'unknown');

      const {vec,hash} = await hashFaceEmbedding(f);
      if(!vec){ draw(); continue; }

      // 位置グリッドで短期追尾
      const key=gridKey(f.box);
      const st=trackState.get(key)||{streak:0,lastTs:0,lastBox:f.box,lastVec:vec,lastHash:hash,countedForever:false};

      // 類似 or 位置連続でストリーク更新
      const dup=findDup(vec,f.box,now);
      const stable = !!dup || iou(st.lastBox,f.box)>=IOU_TH;
      st.streak = stable ? Math.min(st.streak+1, STREAK_N) : 1;
      st.lastTs = now; st.lastBox=f.box; st.lastVec=vec; st.lastHash=hash;

      // ★★ ここが肝：日内1回だけカウント ★★
      // ・すでに countedForever 済みなら何もしない
      // ・hash があり uniqSet に未登録なら「初回確定」として加算＋登録
      // ・hash が既に登録済みなら、このトラックも countedForever=true にして以後は加算しない
      if (!st.countedForever && st.streak>=STREAK_N) {
        if (hash) {
          if (!uniqSet.has(hash)) {
            uniqSet.add(hash); saveUniqSet(uniqSet);
            minuteCounts[bucket][gkey] += 1;   // ← “生涯”この1回のみ
          }
          st.countedForever = true; // 以後このトラックは再加算しない
        } else {
          // ハッシュが取れない時は“絶対に加算しない”に変更（誤カウント防止）
          // st.countedForever は付けない（次フレームでハッシュが取れたらその時に1回だけ加算）
        }
      }

      // recentログ（可視判定や追従に使う）
      recent.push({vec, box:f.box, t:now, hash:hash||null, counted: st.countedForever });

      trackState.set(key, st);

      function draw(){
        ctx.lineWidth=2; ctx.strokeStyle='#00FF88'; ctx.strokeRect(x,y,w,h);
        const tag=`${bucket} • ${gkey}`+(age?` (${age})`:'');
        ctx.fillStyle='rgba(0,0,0,0.5)'; const tw=ctx.measureText(tag).width+10;
        ctx.fillRect(x,Math.max(0,y-20),tw,20); ctx.fillStyle='#fff'; ctx.fillText(tag,x+5,Math.max(12,y-6));
      }
      draw();
    }

    renderTable();
    logEl && (logEl.textContent = `faces: ${faces.length}\n今日のユニーク合計: ${uniqSet.size}`);
    rafId=requestAnimationFrame(loop);
  }

  btnStart.addEventListener('click', async ()=>{ try{ await startCamera(); }catch(e){ statusEl.textContent='カメラ開始失敗: '+e.message; }});
  btnStop.addEventListener('click', stopCamera);
  btnCsv.addEventListener('click', ()=>{
    const lines=['bucket,male,female,unknown']; for(const b of buckets){ const c=minuteCounts[b]; lines.push([b,c.male,c.female,c.unknown].join(',')); }
    const blob=new Blob([lines.join('\n')],{type:'text/csv'}); const url=URL.createObjectURL(blob);
    const a=Object.assign(document.createElement('a'),{href:url,download:`attributes_${Date.now()}.csv`}); a.click(); URL.revokeObjectURL(url);
  });

  if(!('mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices)) statusEl.textContent='このブラウザはカメラ取得に未対応です';
  else statusEl.textContent='「カメラ開始」を押してください（HTTPS必須）';
})();
