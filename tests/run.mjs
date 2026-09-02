import { installDom, loadPage, reporter, makeEl } from './harness.mjs';
const R = reporter();
let exitCode = 0;

/* ============ A. SITE: backgrounds + status rendering ============ */
{
  const { reg, rootStyle } = installDom();
  const S = loadPage('index.html', `globalThis.__X={resize:resizeSpace,anim:animateSpace,
    setMode:m=>{bgMode=m;initScene();}, render:renderServerStatus, load:loadData,
    setStatus:o=>Object.assign(statusData,o), open:openModal, ov:()=>modalOverlay}`);

  R.section('A. 3D backgrounds render');
  S.resize();
  const frames = (mode,n)=>{ S.setMode(mode); for(let i=0;i<n;i++) S.anim(16.7*(i+1)); };
  let threw = null;
  try { frames('voxel',20); } catch(e){ threw = e; }
  R.check('voxel tunnel renders 20 frames', !threw);
  threw = null;
  try { frames('grid',20); } catch(e){ threw = e; }
  R.check('wire terrain renders 20 frames', !threw);
  globalThis.document.documentElement.getAttribute = () => 'light';
  threw = null;
  try { frames('voxel',5); frames('grid',5); } catch(e){ threw = e; }
  R.check('both render in light theme', !threw);
  globalThis.window.innerWidth = 360; globalThis.window.innerHeight = 640;
  threw = null;
  try { S.resize(); frames('voxel',5); frames('grid',5); } catch(e){ threw = e; }
  R.check('both render on a 360px viewport', !threw);

  R.section('B. status presets drive the page');
  for (const st of ['online','offline','maintenance','whitelist','starting']) {
    S.setStatus({ status:st, message:'m', version:'1.21' }); S.render();
  }
  R.check('all 5 presets render', true);
  R.check('status colour applied to :root', !!rootStyle['--status-color']);

  R.section('C. connect button switch');
  S.setStatus({ showConnectBtn:false }); S.render();
  R.check('button hidden when disabled', reg['connectBtn'].style.display === 'none');
  S.open();
  R.check('modal cannot open while disabled', !reg['connectModal'].classList.contains('active'));
  S.setStatus({ showConnectBtn:true, connectBtnText:'ورود' }); S.render();
  R.check('button shown when enabled', reg['connectBtn'].style.display !== 'none');
  R.check('custom label applied', reg['connectBtnLabel'].textContent === 'ورود');
  S.open();
  R.check('modal opens when enabled', reg['connectModal'].classList.contains('active'));

  R.section('D. addresses stay out of the page');
  S.setStatus({ javaAddress:'a.example.com:1', bedrockAddress:'b.example.com',
                bedrockPort:'19132', version:'1.21.4', showVersion:true });
  S.render();
  const meta = reg['serverMeta'].innerHTML;
  R.check('version shown on page', meta.includes('1.21.4'));
  R.check('java address NOT on page', !meta.includes('a.example.com'));
  R.check('bedrock address NOT on page', !meta.includes('b.example.com'));
  R.check('no player counter anywhere', !/بازیکن/.test(meta));
  R.check('address present in modal', reg['javaAddr'].textContent === 'a.example.com:1');
  R.check('deep link uses the address', reg['bedrockDeepLink'].href.includes('a.example.com:1'));
  S.setStatus({ showVersion:false }); S.render();
  R.check('version can be hidden', reg['serverMeta'].style.display === 'none');
}

/* ============ E. ADMIN: form + GitHub sync ============ */
{
  const { reg, store, gid } = installDom();

  // --- fake GitHub API ---
  const repo = {}; let calls = []; let n = 0;
  globalThis.fetch = async (url, opt={}) => {
    calls.push({ url, method: opt.method || 'GET' });
    if (!String((opt.headers||{})['Authorization']||'').includes('good'))
      return { ok:false, status:401, json:async()=>({message:'Bad credentials'}) };
    if (/\/repos\/[^/]+\/[^/]+$/.test(url)) return { ok:true, status:200, json:async()=>({permissions:{push:true}}) };
    const path = decodeURIComponent(url.match(/\/contents\/([^?]+)/)[1]);
    if ((opt.method||'GET')==='GET') {
      const f = repo[path];
      if (!f) return { ok:false, status:404, json:async()=>({message:'Not Found'}) };
      return { ok:true, status:200, json:async()=>({ sha:f.sha, content:Buffer.from(f.content,'utf8').toString('base64') }) };
    }
    const body = JSON.parse(opt.body);
    if (repo[path] && body.sha !== repo[path].sha) return { ok:false, status:409, json:async()=>({message:'conflict'}) };
    const sha = 'sha'+(++n);
    repo[path] = { content: Buffer.from(body.content,'base64').toString('utf8'), sha };
    return { ok:true, status:200, json:async()=>({ content:{ sha } }) };
  };

  const A = loadPage('admin.html', `globalThis.__X={fill:fillStatusForm,read:readStatusForm,
    select:selectStatus,save:saveStatus,preview:updateStatusPreview,bind:bindStatusInputs,
    tab:switchTab,cfg:o=>Object.assign(ghConfig,o),getCfg:()=>ghConfig,ready:ghReady,
    test:ghTestConnection,pull:ghPullAll,publish:publishAll,put:ghPutFile,
    setSha:(f,v)=>{ghShas[f]=v},b64:utf8ToBase64,unb64:base64ToUtf8,
    data:()=>appData,saveLocal,dl:downloadStatusFile}`);

  R.section('E. admin status form');
  A.bind(); A.fill();
  R.check('form fills with defaults', A.read().status === 'online');
  for (const k of ['online','offline','maintenance','whitelist','starting']) {
    A.select(k); if (A.read().status !== k) { R.check('preset '+k, false); }
  }
  R.check('all presets selectable', true);
  R.check('no player fields in payload', !Object.keys(A.read()).some(k=>/player/i.test(k)));
  gid('statusShowConnectBtn').checked = false; A.preview();
  R.check('button-off reflected in summary', reg['statusBtnSummary'].textContent.includes('مخفی'));
  R.check('preview hides the button', reg['previewConnectBtn'].style.display === 'none');
  gid('statusShowConnectBtn').checked = true;
  gid('statusVersion').value = '1.21.4'; A.preview();
  R.check('version appears in preview', reg['previewMeta'].innerHTML.includes('1.21.4'));
  R.check('addresses absent from preview meta', !reg['previewMeta'].innerHTML.includes('sv3.tgmc'));

  R.section('F. GitHub sync');
  R.check('utf8 base64 round-trip', A.unb64(A.b64('سیزن ۱ 🎮')) === 'سیزن ۱ 🎮');
  A.cfg({ token:'bad', owner:'AxiaSoft', repo:'Netheraxia', branch:'main', path:'data' });
  R.check('invalid token rejected', (await A.test(true)) === false);
  A.cfg({ token:'good-token' });
  R.check('valid token accepted', (await A.test(true)) === true);

  R.check('first publish succeeds', (await A.publish()) === true);
  R.check('all 4 JSON files created',
    ['status','teams','rules','images'].every(f => !!repo[`data/${f}.json`]));
  calls = []; await A.publish();
  R.check('no commit when nothing changed', calls.filter(c=>c.method==='PUT').length === 0);

  gid('statusHeadline').value = 'سرور در حال تعمیر'; A.select('maintenance');
  calls = []; await A.save();
  const puts = calls.filter(c=>c.method==='PUT');
  R.check('editing publishes exactly one file', puts.length === 1);
  R.check('and it is status.json', puts[0].url.includes('status.json'));
  const saved = JSON.parse(repo['data/status.json'].content);
  R.check('Persian text survives the round-trip', saved.headline === 'سرور در حال تعمیر');
  R.check('file ends with a newline', repo['data/status.json'].content.endsWith('\n'));

  A.setSha('status.json','stale'); repo['data/status.json'].sha = 'real';
  calls = []; await A.put('status.json','{"probe":true}\n','t');
  R.check('409 conflict is retried', calls.filter(c=>c.method==='PUT').length === 2);
  R.check('conflicting write lands', JSON.parse(repo['data/status.json'].content).probe === true);

  repo['data/status.json'] = { content: JSON.stringify({status:'offline',headline:'از مخزن'}), sha:'s9' };
  await A.pull(true);
  R.check('pull applies repo state', A.data().status.status === 'offline');
  R.check('defaults merged on pull', A.data().status.showConnectBtn === true);
  calls = []; await A.pull(true); await new Promise(r=>setTimeout(r,60));
  R.check('pull never triggers a push loop', calls.filter(c=>c.method==='PUT').length === 0);

  const rf = globalThis.fetch;
  globalThis.fetch = async()=>{ throw new Error('offline'); };
  R.check('offline test() returns false', (await A.test(true)) === false);
  R.check('offline publish fails gracefully', (await A.publish('status')) === false);
  globalThis.fetch = rf;

  A.cfg({ token:'' });
  calls = []; await A.publish('status');
  R.check('no network calls without a token', calls.length === 0);
  R.check('local save still works offline', (A.saveLocal(), !!store['nthx_status']));

  R.section('G. tabs');
  let threw = null;
  try { ['status','teams','rules','images'].forEach(t => A.tab(t, makeEl('b'))); } catch(e){ threw = e; }
  R.check('all tabs switch without error', !threw);
}

exitCode = R.done('ALL NETHERAXIA TESTS');
process.exit(exitCode);
