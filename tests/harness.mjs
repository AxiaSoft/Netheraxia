// Shared minimal DOM harness for the Netheraxia static pages
import fs from 'fs';
import { TextEncoder, TextDecoder } from 'util';

export function makeEl(id, tag='div'){
  return { id, tagName:tag, textContent:'', innerHTML:'', value:'', checked:true, disabled:false,
    href:'', src:'', title:'', dataset:{},
    style:new Proxy({ setProperty(k,v){ this[k]=v; } },{get:(t,k)=>t[k]??'',set:(t,k,v)=>{t[k]=v;return true;}}),
    classList:{_s:new Set(),add(c){this._s.add(c)},remove(c){this._s.delete(c)},contains(c){return this._s.has(c)},toggle(){}},
    addEventListener(){}, appendChild(){}, removeChild(){}, remove(){}, click(){}, focus(){},
    getBoundingClientRect:()=>({left:0,top:0,width:100,height:40}),
    getAttribute:()=>null, setAttribute(){}, querySelectorAll:()=>[],
    getContext:()=>new Proxy({},{get:()=>()=>({addColorStop(){}})}),
    parentElement:{ getBoundingClientRect:()=>({left:0,top:0,width:400,height:50}) } };
}

export function installDom({ protocol='https:', width=1280, height=800 } = {}){
  const reg = {}; const store = {}; const rootStyle = {};
  const gid = id => reg[id] ??= makeEl(id);
  globalThis.window = { innerWidth:width, innerHeight:height, devicePixelRatio:1,
    addEventListener(){}, matchMedia:()=>({matches:false}),
    getSelection:()=>({removeAllRanges(){},addRange(){}}),
    showDirectoryPicker: async()=>{ throw Object.assign(new Error('x'),{name:'AbortError'}); } };
  globalThis.localStorage = { getItem:k=>store[k]??null, setItem:(k,v)=>{store[k]=String(v)}, removeItem:k=>{delete store[k]} };
  globalThis.location = { protocol };
  globalThis.document = {
    documentElement:{ getAttribute:()=>'dark', setAttribute(){}, style:{ setProperty:(k,v)=>{rootStyle[k]=v} } },
    getElementById:gid, querySelector:()=>makeEl('q'), querySelectorAll:()=>[makeEl('a'),makeEl('b')],
    addEventListener(){}, createElement:(t)=>makeEl('c',t), createRange:()=>({selectNode(){}}),
    body:{ appendChild(){}, removeChild(){} }, execCommand(){} };
  Object.defineProperty(globalThis,'navigator',{value:{clipboard:{writeText:async()=>{}}},configurable:true});
  globalThis.requestAnimationFrame = ()=>0;
  globalThis.TextEncoder = TextEncoder; globalThis.TextDecoder = TextDecoder;
  globalThis.btoa = s => Buffer.from(s,'binary').toString('base64');
  globalThis.atob = s => Buffer.from(s,'base64').toString('binary');
  // Keep the real URL constructor (fetch needs it); only add the blob helpers.
  if (!globalThis.URL.createObjectURL) {
    globalThis.URL.createObjectURL = () => 'blob:stub';
    globalThis.URL.revokeObjectURL = () => {};
  }
  globalThis.Blob = class { constructor(p){ this.p=p; } };
  globalThis.FileReader = class { readAsDataURL(){ this.onload&&this.onload(); } };
  globalThis.fetch = async () => ({ ok:false, status:404 });
  return { reg, store, gid, rootStyle };
}

export function loadPage(file, exportsSrc){
  const code = fs.readFileSync('/home/user/Netheraxia/'+file,'utf8').match(/<script>([\s\S]*)<\/script>/)[1];
  new Function(code + ';' + exportsSrc)();
  return globalThis.__X;
}

export function reporter(){
  let failed = false;
  return {
    check(name, cond){ console.log((cond?'  ✅ ':'  ❌ ')+name); if(!cond) failed = true; },
    section(t){ console.log('\n── '+t+' ──'); },
    done(label){ console.log(failed ? `\n❌ ${label} FAILED` : `\n🎉 ${label} PASSED`); return failed?1:0; }
  };
}
