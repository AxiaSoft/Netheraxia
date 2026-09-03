import { installDom, loadPage, loadScript, reporter, makeEl } from './harness.mjs';
import { readFileSync } from 'node:fs';
const R = reporter();
let exitCode = 0;

/* ============ A. SITE: backgrounds + status rendering ============ */
{
  const { reg, rootStyle } = installDom();
  const S = loadPage('index.html', `globalThis.__X={resize:resizeSpace,anim:animateSpace,
    setMode:m=>{bgMode=m;initScene();}, render:renderServerStatus, load:loadData,
    setStatus:o=>Object.assign(statusData,o), open:openModal, ov:()=>modalOverlay,
    refresh:refreshFromServer, imgs:()=>imagesData, sig:dataSignature,
    setImgs:o=>{imagesData=o;}}`);

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

/* ============ H. SITE: cache-busting + live refresh ============ */
{
  const { reg, store } = installDom();
  const served = {
    'images.json': { logo: 'data:image/png;base64,AAAA' },
    'teams.json' : { teams: [] },
    'rules.json' : { rules: [] },
    'status.json': { status:'online', headline:'اولیه', version:'1.21' },
    'texts.json' : { teamsLabel:'⚔️ تیم‌ها', teamsTitle:'تیم‌های تشکیل شده', teamsSubtitle:'',
                     rulesLabel:'📜 قوانین', rulesTitle:'قوانین رسمی سرور', rulesSubtitle:'' },
  };
  const seen = [];
  globalThis.fetch = async (url, opt={}) => {
    seen.push({ url, cache: opt.cache });
    const name = String(url).split('/').pop().split('?')[0];
    if (!served[name]) return { ok:false, status:404 };
    return { ok:true, status:200, json:async()=>JSON.parse(JSON.stringify(served[name])) };
  };

  const S = loadPage('index.html', `globalThis.__X={load:loadData,refresh:refreshFromServer,
    imgs:()=>imagesData, status:()=>statusData, render:renderServerStatus, sig:dataSignature,
    texts:()=>textsData, renderTexts:renderSectionTexts}`);

  R.section('H. cache-busting');
  await S.load();
  R.check('all five files requested', ['images','teams','rules','status','texts']
    .every(n => seen.some(s => s.url.includes(n + '.json'))));
  R.check('every request sends cache:no-store', seen.every(s => s.cache === 'no-store'));
  R.check('every request is cache-busted with ?v=', seen.every(s => /\?v=\d+/.test(s.url)));
  R.check('logo loaded from images.json', S.imgs().logo === 'data:image/png;base64,AAAA');

  R.section('I. live refresh picks up a new logo');
  served['images.json'] = { logo: 'data:image/png;base64,BBBB' };
  const changed = await S.refresh(false);
  R.check('refresh detects the change', changed === true);
  R.check('new logo applied', S.imgs().logo === 'data:image/png;base64,BBBB');
  R.check('img element updated', reg['heroLogo'].src === 'data:image/png;base64,BBBB');
  const again = await S.refresh(false);
  R.check('no redundant re-render when unchanged', again === false);

  served['status.json'] = { status:'offline', headline:'آفلاین شد', version:'1.21' };
  await S.refresh(false);
  R.check('status changes also picked up live', S.status().status === 'offline');

  R.section('J. stale localStorage must not override published data');
  store['nthx_status'] = JSON.stringify({ status:'maintenance', headline:'کهنه' });
  delete store['nthx_preview'];                 // a normal visitor
  await S.load();
  R.check('visitor ignores stale localStorage', S.status().headline === 'آفلاین شد');
  R.check('stale key is cleared', !store['nthx_status']);
  store['nthx_status'] = JSON.stringify({ headline:'پیش‌نمایش ادمین' });
  store['nthx_preview'] = '1';                  // the admin, mid-edit
  await S.load();
  R.check('admin still sees their own preview', S.status().headline === 'پیش‌نمایش ادمین');

  R.section('L. editable section texts');
  delete store['nthx_status']; delete store['nthx_preview'];
  await S.load();
  // The whole point of round 7: these two strings must never be baked in.
  const raw = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  R.check('teams subtitle not hardcoded in index.html', !raw.includes('حداکثر ۱۰ نفر در هر تیم'));
  R.check('rules subtitle not hardcoded in index.html', !raw.includes('مقررات سیزن ۱'));
  R.check('empty subtitle stays hidden', reg['teamsSubtitle'].style.display === 'none');
  R.check('empty rules subtitle stays hidden', reg['rulesSubtitle'].style.display === 'none');
  R.check('titles come from texts.json', reg['teamsTitle'].textContent === 'تیم‌های تشکیل شده');

  served['texts.json'] = { teamsLabel:'⚔️ گروه‌ها', teamsTitle:'لیست تیم‌ها',
    teamsSubtitle:'حداکثر ۸ نفر', rulesLabel:'📜 قواعد', rulesTitle:'قوانین',
    rulesSubtitle:'سیزن ۲' };
  const textsChanged = await S.refresh(false);
  R.check('text edits picked up live', textsChanged === true);
  R.check('new title rendered', reg['teamsTitle'].textContent === 'لیست تیم‌ها');
  R.check('subtitle reappears when set', reg['teamsSubtitle'].textContent === 'حداکثر ۸ نفر');
  R.check('subtitle becomes visible again', reg['teamsSubtitle'].style.display !== 'none');
  R.check('rules subtitle editable too', reg['rulesSubtitle'].textContent === 'سیزن ۲');

  served['texts.json'] = { teamsSubtitle:'' , teamsTitle:'لیست تیم‌ها' };
  await S.refresh(false);
  R.check('clearing a subtitle hides it again', reg['teamsSubtitle'].style.display === 'none');
  R.check('missing keys fall back to defaults', reg['rulesTitle'].textContent === 'قوانین رسمی سرور');

  const escaped = '<img src=x onerror=alert(1)>';
  served['texts.json'] = { teamsTitle: escaped };
  await S.refresh(false);
  R.check('text is inserted safely, not as HTML',
    reg['teamsTitle'].textContent === escaped && !reg['teamsTitle'].innerHTML);
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

  const A = loadPage('admin.html', `globalThis.__X={saveLogo,fill:fillStatusForm,read:readStatusForm,
    select:selectStatus,save:saveStatus,preview:updateStatusPreview,bind:bindStatusInputs,
    tab:switchTab,cfg:o=>Object.assign(ghConfig,o),getCfg:()=>ghConfig,ready:ghReady,
    test:ghTestConnection,pull:ghPullAll,publish:publishAll,put:ghPutFile,
    setSha:(f,v)=>{ghShas[f]=v},b64:utf8ToBase64,unb64:base64ToUtf8,
    data:()=>appData,saveLocal,dl:downloadStatusFile,getCfg:()=>ghConfig,
    saveTexts,fillTexts:fillTextsForm,readTexts:readTextsForm,bindTexts:bindTextsInputs,
    restoreDefaults:restoreDefaultTexts,defaults:()=>DEFAULT_TEXTS,
    vsb:validateSupabase}`);

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

  // Regression: GitHub reports permissions.push === false for fine-grained
  // tokens even when Contents:write is granted. That flag must never gate
  // publishing, otherwise nothing is ever committed.
  const savedFetch = globalThis.fetch;
  globalThis.fetch = async (url, opt={}) => {
    if (/\/repos\/[^/]+\/[^/]+$/.test(url))
      return { ok:true, status:200, json:async()=>({ permissions:{ push:false, pull:false } }) };
    return savedFetch(url, opt);
  };
  R.check('fine-grained token (push:false) still connects', (await A.test(true)) === true);
  globalThis.fetch = savedFetch;
  R.check('and can still publish', (await A.publish('status')) !== false);

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

  R.section('K. logo publishing');
  A.cfg({ token:'good-token' });        // an earlier test cleared it on purpose
  const uniqueLogo = 'data:image/png;base64,LOGO' + Date.now();
  gid('logoBase64').value = uniqueLogo;
  calls = [];
  await A.saveLogo();
  const logoPuts = calls.filter(c => c.method === 'PUT');
  R.check('saveLogo publishes to the repo', logoPuts.length === 1);
  R.check('it writes images.json', logoPuts[0] && logoPuts[0].url.includes('images.json'));
  R.check('logo content committed',
    JSON.parse(repo['data/images.json'].content).logo === uniqueLogo);
  calls = [];
  await A.saveLogo();
  R.check('unchanged logo makes no commit', calls.filter(c=>c.method==='PUT').length === 0);

  R.section('M. admin texts tab');
  A.cfg({ token:'good-token' });
  A.bindTexts(); A.fillTexts();
  R.check('form loads current texts', gid('txtTeamsTitle').value === 'تیم‌های تشکیل شده');
  R.check('subtitles default to empty', gid('txtTeamsSubtitle').value === '');
  gid('txtTeamsSubtitle').value = 'حداکثر ۸ نفر';
  gid('txtRulesTitle').value = 'قوانین سیزن ۲';
  calls = [];
  await A.saveTexts();
  const textPuts = calls.filter(c => c.method === 'PUT');
  R.check('saveTexts publishes to the repo', textPuts.length === 1);
  R.check('it writes texts.json', textPuts[0] && textPuts[0].url.includes('texts.json'));
  const committed = JSON.parse(repo['data/texts.json'].content);
  R.check('subtitle committed', committed.teamsSubtitle === 'حداکثر ۸ نفر');
  R.check('title committed', committed.rulesTitle === 'قوانین سیزن ۲');
  R.check('all six keys present',
    ['teamsLabel','teamsTitle','teamsSubtitle','rulesLabel','rulesTitle','rulesSubtitle']
      .every(k => k in committed));
  gid('txtTeamsSubtitle').value = '   ';
  await A.saveTexts();
  R.check('whitespace-only subtitle stored as empty',
    JSON.parse(repo['data/texts.json'].content).teamsSubtitle === '');
  A.restoreDefaults();
  R.check('restore defaults refills the form', gid('txtTeamsTitle').value === 'تیم‌های تشکیل شده');
  R.check('restored subtitles are empty', gid('txtTeamsSubtitle').value === '');


  R.section('P. Supabase key validation');
  const okUrl = 'https://abcdefgh.supabase.co';
  // Both key generations must be accepted: new projects get sb_publishable_,
  // older ones still have the eyJ... anon JWT.
  const anonJwt = 'eyJ' + Buffer.from('{"alg":"HS256"}').toString('base64') + '.' +
    Buffer.from('{"role":"anon"}').toString('base64') + '.sig';
  R.check('new publishable key accepted', A.vsb(okUrl, 'sb_publishable_abc123') === null);
  R.check('legacy anon JWT accepted', A.vsb(okUrl, anonJwt) === null);

  // Security: a secret key here would be handed to every visitor.
  R.check('sb_secret_ key is refused', /secret|مدیریتی/.test(A.vsb(okUrl, 'sb_secret_abc') || ''));
  const svcJwt = 'eyJ' + Buffer.from('{"alg":"HS256"}').toString('base64') + '.' +
    Buffer.from('{"role":"service_role"}').toString('base64') + '.sig';
  R.check('service_role JWT is refused', A.vsb(okUrl, svcJwt) !== null);

  R.check('missing values refused', A.vsb('', '') !== null);
  R.check('non-https url refused', A.vsb('http://abc.supabase.co', 'sb_publishable_x') !== null);
  R.check('dashboard url refused (common mistake)',
    A.vsb('https://supabase.com/dashboard/project/abcdefgh', 'sb_publishable_x') !== null);
  R.check('trailing slash tolerated', A.vsb(okUrl + '/', 'sb_publishable_x') === null);
  R.check('garbage key refused', A.vsb(okUrl, 'hello') !== null);

  R.section('G. tabs');
  let threw = null;
  try { ['status','teams','rules','texts','images'].forEach(t => A.tab(t, makeEl('b'))); } catch(e){ threw = e; }
  R.check('all tabs switch without error', !threw);
}


/* ============ N. ACCOUNTS: auth layer (js/nx-auth.js) ============ */
{
  const { store } = installDom();
  loadScript('js/nx-auth.js');
  const A = globalThis.NXAuth;

  R.section('N. auth layer');
  R.check('not configured out of the box', A.isConfigured() === false);
  await A.init().catch(()=>{});
  let rejected = null;
  await A.getConfig().catch(e => { rejected = e; });
  R.check('calls fail cleanly when unconfigured', !!rejected);

  A.saveConfig('https://demo.supabase.co/', 'anon-key-123');
  R.check('config saved and normalised', A.config().url === 'https://demo.supabase.co');
  R.check('config persisted to localStorage', !!store['nthx_supabase']);
  R.check('isConfigured flips on', A.isConfigured() === true);

  // Persian error translation — the whole point is that players see a
  // human sentence, never a raw Postgres exception.
  const cases = [
    ['... raise exception TEAM_FULL',        'این تیم پر است.'],
    ['ALREADY_IN_TEAM',                      'شما در حال حاضر عضو یک تیم هستید. اول از آن خارج شوید.'],
    ['MAX_TEAMS_REACHED',                    'ظرفیت تیم‌ها تکمیل است؛ تیم جدیدی نمی‌توان ساخت.'],
    ['USERNAME_TAKEN',                       'این نام ماینکرفت قبلاً ثبت شده است.'],
    ['OWNER_CANNOT_LEAVE',                   'شما کاپیتان تیم هستید؛ اول کاپیتانی را واگذار یا تیم را حذف کنید.'],
    ['Invalid login credentials',            'نام کاربری/ایمیل یا رمز عبور اشتباه است.'],
    ['REGISTRATION_CLOSED',                  'ثبت‌نام در حال حاضر بسته است.'],
    ['JOIN_CLOSED',                          'عضویت در تیم‌ها در حال حاضر بسته است.'],
  ];
  R.check('all DB errors translate to Persian',
    cases.every(([raw, fa]) => A.humanize(raw) === fa));
  R.check('unknown errors pass through', A.humanize('weird thing') === 'weird thing');

  // --- fake Supabase REST, routed by URL (never by timing) ---
  const seen = [];
  let routes = {};
  let nextResponse = { ok:true, status:200, body:'[]' };
  globalThis.fetch = async (url, opt={}) => {
    const u = String(url);
    seen.push({ url:u, method:opt.method||'GET',
                body: opt.body ? JSON.parse(opt.body) : null, headers: opt.headers||{} });
    for (const key in routes) if (u.includes(key)) return mk(routes[key]);
    return mk(nextResponse);
  };
  function mk(r){ return { ok:r.ok, status:r.status, text:async()=>r.body }; }

  // validation happens before any network call
  seen.length = 0;
  let err = null;
  await A.signUp({ username:'ab', email:'a@b.co', password:'123456' }).catch(e => err = e);
  R.check('short username rejected locally', !!err && seen.length === 0);
  err = null;
  await A.signUp({ username:'Steve!', email:'a@b.co', password:'123456' }).catch(e => err = e);
  R.check('invalid characters rejected', !!err && seen.length === 0);
  err = null;
  await A.signUp({ username:'Steve', email:'nope', password:'123456' }).catch(e => err = e);
  R.check('bad email rejected', !!err && seen.length === 0);
  err = null;
  await A.signUp({ username:'Steve', email:'a@b.co', password:'123' }).catch(e => err = e);
  R.check('short password rejected', !!err && seen.length === 0);

  // sign-up sends the minecraft name as user metadata
  seen.length = 0;
  routes = {
    'username_available': { ok:true, status:200, body:'true' },
    '/auth/v1/signup':    { ok:true, status:200, body: JSON.stringify({
        access_token:'tok', refresh_token:'ref', expires_in:3600,
        user:{ id:'u1', email:'steve@mc.com' } }) }
  };
  await A.signUp({ username:'Steve', email:'steve@mc.com', password:'secret123' }).catch(()=>{});
  R.check('username availability checked first',
    seen[0] && seen[0].url.includes('/rpc/username_available'));
  const su = seen.find(s => s.url.includes('/auth/v1/signup'));
  R.check('signup posts mc_username as metadata',
    !!su && su.body.data.mc_username === 'Steve');
  R.check('session stored after signup', A.isLoggedIn() === true);
  R.check('session persisted', !!store['nthx_session']);

  // requests carry the user's token, not the anon key
  seen.length = 0;
  routes = {};
  nextResponse = { ok:true, status:200, body:'[]' };
  await A.listTeams();
  R.check('authenticated request uses the session token',
    seen[0].headers.Authorization === 'Bearer tok');
  R.check('apikey header always present', seen[0].headers.apikey === 'anon-key-123');
  R.check('team list is cache-busted', seen[0].url.includes('/teams_public'));

  // login by minecraft name resolves to the account email first
  seen.length = 0;
  routes = {
    'email_for_login':      { ok:true, status:200, body:'"steve@mc.com"' },
    'grant_type=password':  { ok:true, status:200, body: JSON.stringify({
        access_token:'tok2', refresh_token:'ref2', expires_in:3600, user:{ id:'u1' } }) }
  };
  await A.signIn('Steve', 'secret123').catch(()=>{});
  R.check('minecraft name resolved via RPC', seen[0].url.includes('/rpc/email_for_login'));
  // Privacy: the server only reveals the email if the password checks out,
  // so the password must travel with the lookup.
  R.check('lookup sends the password so emails cannot be harvested',
    seen[0].body && seen[0].body.p_password === 'secret123');
  const tokenCall = seen.find(s => s.url.includes('grant_type=password'));
  R.check('login uses the resolved email', !!tokenCall && tokenCall.body.email === 'steve@mc.com');

  // email login skips the lookup
  seen.length = 0;
  await A.signIn('steve@mc.com', 'secret123').catch(()=>{});
  R.check('email login skips the name lookup',
    !seen.some(s => s.url.includes('email_for_login')));

  // create/join/leave hit the right endpoints
  seen.length = 0;
  routes = {};
  nextResponse = { ok:true, status:200, body: JSON.stringify([{ id:'t1', name:'Alpha' }]) };
  await A.createTeam({ name:'Alpha', description:'hi', emoji:'⚔️' }).catch(()=>{});
  R.check('createTeam posts to /teams', seen[0].url.includes('/teams'));
  R.check('creator is set as owner', seen[0].body.owner_id === 'u1');
  R.check('team name trimmed', seen[0].body.name === 'Alpha');

  err = null;
  await A.createTeam({ name:'A' }).catch(e => err = e);
  R.check('one-character team name rejected locally', !!err);

  seen.length = 0;
  await A.joinTeam('t1').catch(()=>{});
  R.check('joinTeam posts the current user', seen[0].body.user_id === 'u1');
  R.check('joiner is not a leader', seen[0].body.is_leader === false);

  seen.length = 0;
  await A.leaveTeam('t1').catch(()=>{});
  R.check('leaveTeam deletes only my own row',
    seen[0].method === 'DELETE' && seen[0].url.includes('user_id=eq.u1'));

  // server-side rejections surface in Persian
  nextResponse = { ok:false, status:400, body: JSON.stringify({ message:'TEAM_FULL' }) };
  err = null;
  await A.joinTeam('t1').catch(e => err = e);
  R.check('server rejection is translated', err && err.message === 'این تیم پر است.');
  R.check('raw error kept for debugging', err && /TEAM_FULL/.test(err.raw));

  // sign-out clears everything
  nextResponse = { ok:true, status:200, body:'' };
  await A.signOut();
  R.check('signOut clears the session', A.isLoggedIn() === false);
  R.check('signOut clears storage', !store['nthx_session']);
}

/* ============ O. SITE: team UI states ============ */
{
  const { reg, store } = installDom();
  globalThis.fetch = async () => ({ ok:false, status:404 });
  loadScript('js/nx-auth.js');
  globalThis.NXAuth.saveConfig('https://demo.supabase.co', 'k');

  const S = loadPage('index.html', `globalThis.__X={setLive:__setLive, renderTeams,
    stats:calcStats, esc:escapeHtml, toolbar:renderTeamsToolbar}`);

  R.section('O. team UI states');
  const cfg = { max_teams:10, max_members:10, team_creation_open:true, join_open:true };
  const teams = [
    { id:'t1', name:'Alpha', emoji:'⚔️', owner_id:'u1', owner_name:'Steve',
      members:[{ user_id:'u1', name:'Steve', is_leader:true }] },
    { id:'t2', name:'Beta', emoji:'🛡️', owner_id:'u2', owner_name:'Alex',
      members: Array.from({length:10}, (_,i)=>({ user_id:'x'+i, name:'P'+i, is_leader:i===0 })) },
  ];

  // logged out
  S.setLive(teams, cfg, null);
  S.renderTeams();
  const html = reg['teamsGrid'].innerHTML;
  R.check('live teams render instead of the static file', html.includes('Alpha') && html.includes('Beta'));
  R.check('logged-out visitors are prompted to sign in', html.includes('data-needlogin'));
  R.check('no join button while logged out', !html.includes('data-join='));
  R.check('full team shows 10/10', html.includes('۱۰/۱۰'));
  R.check('stats count live teams', S.stats().totalTeams === 2);
  R.check('stats count live members', S.stats().totalMembers === 11);

  // XSS: a team named like a script tag must never become markup
  S.setLive([{ id:'t9', name:'<img src=x onerror=alert(1)>', emoji:'🛡️', owner_id:'u9',
              members:[] }], cfg, null);
  S.renderTeams();
  R.check('team names are escaped',
    !reg['teamsGrid'].innerHTML.includes('<img src=x'));
  R.check('escaping keeps the visible text',
    reg['teamsGrid'].innerHTML.includes('&lt;img'));

  // toolbar reflects the caps
  S.setLive(teams, { ...cfg, max_teams:2 }, null);
  S.toolbar();
  R.check('counter shows the team cap', reg['teamsCounter'].textContent.includes('۲ از ۲'));
  R.check('member cap shown in Persian digits', reg['teamsCounter'].textContent.includes('۱۰ نفر'));

  S.setLive(teams, { ...cfg, team_creation_open:false }, null);
  S.toolbar();
  R.check('closed creation disables the button even before login',
    reg['createTeamBtn'].disabled === true &&
    reg['createTeamBtn'].textContent.includes('بسته'));

  S.setLive([], cfg, null);
  S.renderTeams();
  R.check('empty state invites the first team',
    reg['teamsGrid'].innerHTML.includes('اولین نفر باش'));

  // fallback: no database → the old static rendering still works
  S.setLive(null, null, null);
  S.renderTeams();
  R.check('falls back to teams.json when the DB is off',
    reg['teamsGrid'].innerHTML.includes('هیچ تیمی ثبت نشده'));
  R.check('toolbar hidden without a database', reg['teamsToolbar'].style.display === 'none');
}


/* ============ Q. SITE: the login button must actually work ============ */
{
  const { reg, gid } = installDom();
  const served = { 'images.json':{}, 'teams.json':{teams:[]}, 'rules.json':{rules:[]},
                   'status.json':{status:'online'}, 'texts.json':{} };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('supabase.co')) {
      if (u.includes('public_config')) return { ok:true, status:200, text:async()=>JSON.stringify(
        { max_teams:10, max_members:10, team_creation_open:true, join_open:true,
          registration_open:true, team_count:0, player_count:0, member_count:0 }) };
      return { ok:true, status:200, text:async()=>'[]' };
    }
    const n = u.split('/').pop().split('?')[0];
    return served[n] ? { ok:true, status:200, json:async()=>served[n] } : { ok:false, status:404 };
  };

  // config arrives exactly like js/nx-config.js delivers it in the browser.
  // (In a real page window === globalThis; the stub keeps them separate, so
  // set both to mirror the browser faithfully.)
  const supaCfg = { url:'https://demo.supabase.co', anonKey:'sb_publishable_test' };
  globalThis.window.NETHERAXIA_SUPABASE = supaCfg;
  globalThis.NETHERAXIA_SUPABASE = supaCfg;
  loadScript('js/nx-auth.js');

  const S = loadPage('index.html', `globalThis.__X={init:initAccounts, enabled:authEnabled,
    openOv:openOverlay, closeOv:closeOverlay, chip:renderAuthChip}`);

  R.section('Q. login button actually works');
  R.check('config from nx-config.js is picked up', S.enabled() === true);

  await S.init();
  R.check('the account button becomes visible', reg['authChip'].style.display !== 'none');
  R.check('it invites the user to sign in', reg['authChipLabel'].textContent.includes('ورود'));

  // Regression for the duplicate-function bug: openModal() already existed for
  // the connect modal, so redeclaring it made the login button a no-op.
  R.check('overlay opener takes an id', typeof S.openOv === 'function');
  S.openOv('authModal');
  R.check('opening authModal by id works', reg['authModal'].classList.contains('active'));
  R.check('it does not open the connect modal',
    !reg['connectModal'].classList.contains('active'));
  S.closeOv('authModal');
  R.check('closing by id works', !reg['authModal'].classList.contains('active'));

  // the click itself
  reg['authChip'].click();
  R.check('clicking the button opens the login modal',
    reg['authModal'].classList.contains('active'));

  // tab switching inside the modal
  gid('tabRegister').click();
  R.check('register tab shows the signup form', reg['registerForm'].style.display === 'block');
  R.check('and hides the login form', reg['loginForm'].style.display === 'none');
  gid('tabLogin').click();
  R.check('login tab switches back', reg['loginForm'].style.display === 'block');

  // the ✕ button: confirm the markup declares it and the handler closes by id
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  R.check('both modals ship a close button',
    (html.match(/data-close="(authModal|teamModal)"/g) || []).length === 2);
  R.check('close buttons are wired by data-close',
    /querySelectorAll\('\[data-close\]'\)[\s\S]{0,160}closeOverlay\(b\.dataset\.close\)/.test(html));
  S.openOv('authModal');
  S.closeOv('authModal');
  R.check('closing via the handler path works', !reg['authModal'].classList.contains('active'));

  // a failed login must surface a Persian message, not a silent dead end
  gid('loginId').value = 'Steve';
  gid('loginPass').value = 'wrong';
  globalThis.fetch = async () => ({ ok:false, status:400,
    text:async()=>JSON.stringify({ message:'Invalid login credentials' }) });
  gid('loginSubmit').click();
  await new Promise(r => setTimeout(r, 30));
  R.check('a wrong password shows a Persian error',
    /رمز عبور|اشتباه/.test(reg['authError'].textContent));
  R.check('the error box is made visible', reg['authError'].style.display === 'block');
}

/* ============ R. SITE: styling must use variables this theme defines ====== */
{
  // The account CSS originally used --glass/--primary/--secondary, which this
  // theme never defines, so the button rendered invisible.
  const css = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  const scope = t => css.slice(css.indexOf(t), css.indexOf('}', css.indexOf(t)));
  const defined = new Set();
  [':root {', '[data-theme="dark"]', '[data-theme="light"]'].forEach(sel => {
    [...scope(sel).matchAll(/--([a-z0-9-]+)\s*:/g)].forEach(m => defined.add(m[1]));
  });

  const accounts = css.slice(css.indexOf('/* ==================== Accounts & teams'),
                             css.indexOf('</style>', css.indexOf('/* ==================== Accounts & teams')));
  const used = new Set([...accounts.matchAll(/var\(--([a-z0-9-]+)/g)].map(m => m[1]));
  const missing = [...used].filter(v => !defined.has(v));

  R.section('R. account styles use real theme variables');
  R.check('no undefined CSS variables in the account UI (' + missing.join(', ') + ')',
    missing.length === 0);
  R.check('the account button sits in the navbar',
    /<button class="auth-chip"[\s\S]{0,400}?<\/div>/.test(
      css.slice(css.indexOf('bg-switch" id="bgSwitch"'))));
}

exitCode = R.done('ALL NETHERAXIA TESTS');
process.exit(exitCode);
