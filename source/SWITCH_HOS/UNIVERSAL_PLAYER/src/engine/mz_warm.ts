import type { RuntimeContext } from '../types';

type WarmImage = { kind:string; name:string; priority:number; source:string; source_bytes?:number; folder?:string };
type WarmNamed = { name:string; priority:number; source:string };
type WarmMap = { images:WarmImage[]; effects:WarmNamed[]; se:WarmNamed[] };
type WarmManifest = {
  format:'MVMZWARM'; version:2; engine:'MZ'; generated_unix:number; generator:string;
  fingerprint:{ stat_fnv1a32:string; files:number; total_bytes:number };
  maps:Record<string,WarmMap>;
};

const enc = new TextEncoder();
function fnv1a32(data:Uint8Array|string){
  const bytes=typeof data==='string'?enc.encode(data):data; let h=0x811c9dc5;
  for(const b of bytes){h^=b;h=Math.imul(h,0x01000193)>>>0;}
  return h.toString(16).padStart(8,'0');
}
function readJson(ctx:RuntimeContext,path:string,fallback:any){
  try{return JSON.parse(ctx.fs.readText(path).replace(/^\uFEFF/,''));}catch{return fallback;}
}
function dataFiles(ctx:RuntimeContext){
  const root=`${ctx.fs.root}/data`; let names:string[]=[];
  try{names=(Switch.readDirSync(root)??[]).map(String);}catch{}
  const fixed=new Set(['System.json','Animations.json','CommonEvents.json','Tilesets.json','Troops.json','Enemies.json','Skills.json','MapInfos.json']);
  return names.filter(n=>fixed.has(n)||/^Map\d{3}\.json$/i.test(n)).sort((a,b)=>a.localeCompare(b));
}
function quickFingerprint(ctx:RuntimeContext){
  const names=dataFiles(ctx); let total=0; const parts:string[]=[];
  for(const name of names){
    try{const st=Switch.statSync(`${ctx.fs.root}/data/${name}`); if(!st)continue; total+=Number(st.size||0); parts.push(`${name}:${Number(st.size||0)}:${Number(st.mtime||0)}`);}catch{}
  }
  return {stat_fnv1a32:fnv1a32(parts.join('|')),files:parts.length,total_bytes:total};
}
function sameFingerprint(a:any,b:any){return !!a&&!!b&&String(a.stat_fnv1a32)===String(b.stat_fnv1a32)&&Number(a.files)===Number(b.files)&&Number(a.total_bytes)===Number(b.total_bytes);}

const imageFolders:Record<string,string>={
  animation:'img/animations', battleback1:'img/battlebacks1', battleback2:'img/battlebacks2',
  character:'img/characters', enemy:'img/enemies', face:'img/faces', parallax:'img/parallaxes',
  picture:'img/pictures', svactor:'img/sv_actors', svenemy:'img/sv_enemies', tileset:'img/tilesets'
};

function compileManifest(ctx:RuntimeContext, fingerprint:any):WarmManifest{
  const started=Date.now();
  ctx.reportProgress?.('MZ 사전 컴파일 중',0,'맵 데이터 분석 시작');
  const animations=readJson(ctx,'data/Animations.json',[]);
  const commons=readJson(ctx,'data/CommonEvents.json',[]);
  const tilesets=readJson(ctx,'data/Tilesets.json',[]);
  const troops=readJson(ctx,'data/Troops.json',[]);
  const enemies=readJson(ctx,'data/Enemies.json',[]);
  const skills=readJson(ctx,'data/Skills.json',[]);
  const system=readJson(ctx,'data/System.json',{});
  const sideView=!!system?.optSideView;
  const maps:Record<string,WarmMap>={};
  const sourceByteCache=new Map<string,number>();
  const mapNames=dataFiles(ctx).filter(n=>/^Map\d{3}\.json$/i.test(n));

  const sourceBytes=(kind:string,name:string)=>{
    const folder=imageFolders[kind]; if(!folder||!name)return 0;
    const key=`${kind}|${name}`; const cached=sourceByteCache.get(key); if(cached!==undefined)return cached;
    for(const rel of [`${folder}/${name}.png`,`${folder}/${name}.png_`,`${folder}/${name}.rpgmvp`]){
      try{const st=Switch.statSync(ctx.fs.resolve(rel)); if(st){const size=Number(st.size||0);sourceByteCache.set(key,size);return size;}}catch{}
    }
    sourceByteCache.set(key,0); return 0;
  };

  for(let mi=0;mi<mapNames.length;mi++){
    const filename=mapNames[mi]; const m=/Map(\d{3})\.json$/i.exec(filename); if(!m)continue;
    const mapId=Number(m[1]); const map=readJson(ctx,`data/${filename}`,{});
    const images=new Map<string,WarmImage>(); const effects=new Map<string,WarmNamed>(); const ses=new Map<string,WarmNamed>();
    const addImage=(kind:string,name:any,priority=1,source='map')=>{const n=String(name||''); if(!n||!imageFolders[kind])return; const key=`${kind}|${n}`; const v={kind,name:n,priority,source,source_bytes:sourceBytes(kind,n)}; const old=images.get(key); if(!old||priority<old.priority)images.set(key,v);};
    const addNamed=(target:Map<string,WarmNamed>,name:any,priority=1,source='map')=>{const n=String(name||'');if(!n)return;const old=target.get(n);if(!old||priority<old.priority)target.set(n,{name:n,priority,source});};
    const addAnimation=(id:any,priority=1,source='anim')=>{const a=animations?.[Number(id||0)];if(!a)return; if(a.effectName)addNamed(effects,a.effectName,priority,source); for(const t of a.soundTimings||[])addNamed(ses,t?.se?.name,priority,source); if(a.animation1Name)addImage('animation',a.animation1Name,priority,source); if(a.animation2Name)addImage('animation',a.animation2Name,priority,source);};
    const addTileset=(id:any,priority=0,source='tileset')=>{const t=tilesets?.[Number(id||0)];for(const n of t?.tilesetNames||[])addImage('tileset',n,priority,source);};
    const addSkill=(id:any,priority=1,source='skill')=>{const sk=skills?.[Number(id||0)];if(!sk)return; const aid=Number(sk.animationId||0); if(aid>0)addAnimation(aid,priority,source);};
    const scanMove=(route:any,priority=1,source='route')=>{for(const c of route?.list||[])if(Number(c?.code||0)===41)addImage('character',c?.parameters?.[0],priority,source);};
    const scanList=(list:any[],priority=1,depth=0,seen=new Set<number>(),source='event')=>{
      if(!Array.isArray(list))return;
      for(const c of list){const code=Number(c?.code||0),p=c?.parameters||[];
        if(code===101)addImage('face',p[0],priority,source);
        else if(code===117&&depth<3){const id=Number(p[0]||0);if(id&&!seen.has(id)){seen.add(id);scanList(commons?.[id]?.list,priority+1,depth+1,seen,`common:${id}`);}}
        else if(code===205)scanMove(p[1],priority,source);
        else if(code===212||code===337)addAnimation(p[1],priority,source);
        else if(code===231)addImage('picture',p[1],priority,source);
        else if(code===250)addNamed(ses,p[0]?.name,priority,source);
        else if(code===282)addTileset(p[0],priority,source);
        else if(code===283){addImage('battleback1',p[0],priority,source);addImage('battleback2',p[1],priority,source);}
        else if(code===284)addImage('parallax',p[0],priority,source);
        else if(code===301&&Number(p[0]||0)===0)addTroop(p[1],priority,source);
        else if(code===322){addImage('character',p[1],priority,source);addImage('face',p[3],priority,source);addImage('svactor',p[5],priority,source);}
        else if(code===323)addImage('character',p[1],priority,source);
      }
    };
    const addTroop=(id:any,priority=1,source='troop')=>{const tr=troops?.[Number(id||0)];if(!tr)return; for(const mem of tr.members||[]){const en=enemies?.[Number(mem?.enemyId||0)];if(!en)continue;addImage(sideView?'svenemy':'enemy',en.battlerName,priority,source);for(const act of en.actions||[])addSkill(act?.skillId,priority,source);} for(const page of tr.pages||[])scanList(page?.list,priority+1,0,new Set(),source);};

    addTileset(map.tilesetId,0,'map_base');
    addImage('parallax',map.parallaxName,0,'map_base');
    if(map.specifyBattleback){addImage('battleback1',map.battleback1Name,0,'map_base');addImage('battleback2',map.battleback2Name,0,'map_base');}
    for(const encounter of map.encounterList||[])addTroop(encounter?.troopId,1,'encounter');
    for(const ev of map.events||[]){if(!ev)continue;for(let pi=0;pi<(ev.pages||[]).length;pi++){const page=ev.pages[pi],img=page?.image||{};addImage('character',img.characterName,0,`event:${ev.id}:page:${pi}`);scanList(page?.list,1,0,new Set(),`event:${ev.id}:page:${pi}`);}}
    const sort=(a:any,b:any)=>a.priority-b.priority||String(a.name||a.kind).localeCompare(String(b.name||b.kind));
    maps[String(mapId)]={images:[...images.values()].sort(sort),effects:[...effects.values()].sort(sort),se:[...ses.values()].sort(sort)};
    ctx.reportProgress?.('MZ 사전 컴파일 중',Math.round(((mi+1)/Math.max(1,mapNames.length))*100),`${mi+1}/${mapNames.length} maps`);
    if((mi+1)%25===0)ctx.log(`[mz-warm-compile] maps ${mi+1}/${mapNames.length}`);
  }
  const manifest:WarmManifest={format:'MVMZWARM',version:2,engine:'MZ',generated_unix:Math.floor(Date.now()/1000),generator:'switch-first-run-v1',fingerprint,maps};
  ctx.log(`[mz-warm-compile] complete | maps=${Object.keys(maps).length} elapsedMs=${Date.now()-started}`);
  ctx.reportProgress?.('MZ 사전 컴파일 완료',100,`${Object.keys(maps).length} maps`);
  return manifest;
}

function writeManifestAtomic(ctx:RuntimeContext, manifest:WarmManifest){
  const dir=`${ctx.fs.root}/.mvmz_warm`; const final=`${dir}/manifest.json`; const tmp=`${final}.tmp`; const bak=`${final}.bak`;
  try{Switch.mkdirSync(dir);}catch{}
  const remove=(p:string)=>{try{if(Switch.statSync(p))Switch.removeSync(p);}catch{}};
  remove(tmp); ctx.fs.writeTextAbsolute(tmp,JSON.stringify(manifest));
  let moved=false;
  try{remove(bak);if(Switch.statSync(final)){Switch.renameSync(final,bak);moved=true;}Switch.renameSync(tmp,final);remove(bak);}catch(e){remove(tmp);try{if(moved&&!Switch.statSync(final)&&Switch.statSync(bak))Switch.renameSync(bak,final);}catch{}throw e;}
  ctx.fs.invalidate();
}

function ensureManifest(ctx:RuntimeContext):WarmManifest|null{
  const fingerprint=quickFingerprint(ctx);
  try{
    if(ctx.fs.exists('.mvmz_warm/manifest.json')){const parsed=JSON.parse(ctx.fs.readText('.mvmz_warm/manifest.json')); if(parsed?.format==='MVMZWARM'&&Number(parsed.version)===2&&parsed.engine==='MZ'&&sameFingerprint(parsed.fingerprint,fingerprint)){ctx.log(`[mz-warm] auto manifest valid | maps=${Object.keys(parsed.maps||{}).length} fingerprint=${fingerprint.stat_fnv1a32}`);return parsed;}
      ctx.log('[mz-warm] manifest stale/unsupported -> auto rebuild');
    }else ctx.log('[mz-warm] first run -> auto compiling manifest');
    const built=compileManifest(ctx,fingerprint);writeManifestAtomic(ctx,built);ctx.log(`[mz-warm] auto manifest saved | path=.mvmz_warm/manifest.json bytes=${ctx.fs.readBuffer('.mvmz_warm/manifest.json').byteLength}`);return built;
  }catch(e){ctx.log(`[mz-warm] auto manifest FAILED | ${String((e as any)?.stack??e)}`);return null;}
}

export function installMZManifestWarm(ctx:RuntimeContext){
  const g:any=globalThis as any; const mapProto=g.Game_Map?.prototype; const sceneMapProto=g.Scene_Map?.prototype;
  if(!mapProto||!sceneMapProto||!g.ImageManager){ctx.log('[mz-warm] skipped | core unavailable');return;}
  const manifest=ensureManifest(ctx); if(!manifest)return;
  const GATE_MAX_IMAGES=28, BACKGROUND_MAX=48, GATE_TIMEOUT=4500, GATE_MAX_EFFECTS=14, GATE_MAX_SE=20;
  let gate:any=null; let background:any[]=[]; let backgroundTimer:any=null;
  const methods:Record<string,string>={animation:'loadAnimation',battleback1:'loadBattleback1',battleback2:'loadBattleback2',character:'loadCharacter',enemy:'loadEnemy',face:'loadFace',parallax:'loadParallax',picture:'loadPicture',svactor:'loadSvActor',svenemy:'loadSvEnemy',tileset:'loadTileset'};
  const reverseFolders=new Map(Object.entries(imageFolders).map(([kind,folder])=>[`${folder}/`.toLowerCase(),kind]));
  let manifestDirty=0; let manifestFlushTimer:any=null; let learningSuppressed=0;
  const flushManifestSoon=()=>{if(manifestFlushTimer!==null||manifestDirty<=0)return;manifestFlushTimer=setTimeout(()=>{manifestFlushTimer=null;if(manifestDirty<=0)return;try{writeManifestAtomic(ctx,manifest);ctx.log(`[mz-warm-learn] manifest updated | additions=${manifestDirty}`);manifestDirty=0;}catch(e){ctx.log(`[mz-warm-learn] manifest update FAILED | ${String(e)}`);}},1200);};
  const mapEntryForLearn=()=>{const id=Number(g.$gameMap?.mapId?.()||0);if(id<=0)return null;return manifest.maps[String(id)]||(manifest.maps[String(id)]={images:[],effects:[],se:[]});};
  const learnImage=(folder:any,name:any)=>{if(learningSuppressed)return;const n=String(name||'');const f=String(folder||'').replace(/\\/g,'/');if(!n||!f)return;const entry=mapEntryForLearn();if(!entry)return;const normalized=f.endsWith('/')?f:`${f}/`;const kind=reverseFolders.get(normalized.toLowerCase())||'raw';if(entry.images.some((x:any)=>x.name===n&&((kind!=='raw'&&x.kind===kind)||(kind==='raw'&&x.kind==='raw'&&x.folder===normalized))))return;if(entry.images.length>=160)return;entry.images.push({kind,name:n,folder:kind==='raw'?normalized:undefined,priority:2,source:'learned'} as any);manifestDirty++;flushManifestSoon();};
  const learnNamed=(which:'effects'|'se',name:any)=>{if(learningSuppressed)return;const n=String(name||'');if(!n)return;const entry=mapEntryForLearn();if(!entry)return;const list=entry[which] as WarmNamed[];if(list.some(x=>x.name===n)||list.length>=160)return;list.push({name:n,priority:2,source:'learned'});manifestDirty++;flushManifestSoon();};
  const configureLimiter=(n:number)=>{try{const lim=g.Graphics?._app?.renderer?.plugins?.prepare?.limiter;if(lim&&typeof lim.maxItemsPerFrame==='number')lim.maxItemsPerFrame=n;if(g.PIXI?.settings)g.PIXI.settings.UPLOADS_PER_FRAME=n;}catch{}};
  const logical=(a:any)=>`${a.kind==='raw'?String(a.folder||'').replace(/\\/g,'/').replace(/\/$/,''):imageFolders[a.kind]||''}/${a.name}.png`;
  const exists=(a:any)=>{const p=logical(a);if(!p)return false;for(const c of [p,`${p}_`,p.replace(/\.png$/i,'.rpgmvp')])if(ctx.fs.exists(c))return true;ctx.log(`[mz-warm] skip missing | ${a.kind}:${a.name}`);return false;};
  const load=(a:any)=>{try{learningSuppressed++;if(a.kind==='raw')return g.ImageManager?.loadBitmap?.(a.folder,a.name);const fn=g.ImageManager?.[methods[a.kind]];return typeof fn==='function'?fn.call(g.ImageManager,a.name):null;}catch(e){ctx.log(`[mz-warm] load FAILED | ${a.kind}:${a.name} | ${String(e)}`);return null;}finally{learningSuppressed=Math.max(0,learningSuppressed-1);}};
  const memoryOk=()=>{try{const m=Switch.memoryUsage();const t=Number(m.nativeHeapTotal||0),u=Number(m.nativeHeapUsed||0);return t<=0||u/t<0.70;}catch{return true;}};
  const prepare=(bitmap:any,key:string,done?:()=>void)=>{let finished=false;const finish=()=>{if(finished)return;finished=true;done?.();};try{const bt=bitmap?.baseTexture||bitmap?._baseTexture;const prep=g.Graphics?._app?.renderer?.plugins?.prepare;if(!bt||!prep?.upload){finish();return;}prep.upload(bt,finish);}catch{finish();}};
  const watch=(state:any,a:any,bmp:any)=>{if(!bmp)return;state.pending++;let done=false;const finish=()=>{if(done)return;done=true;state.pending=Math.max(0,state.pending-1);state.gpu++;};const go=()=>prepare(bmp,`${a.kind}:${a.name}`,finish);try{if(bmp.isReady?.())go();else bmp.addLoadListener?.(go);}catch{finish();}};
  const startBackground=()=>{if(backgroundTimer!==null||!background.length)return;backgroundTimer=setTimeout(()=>{backgroundTimer=null;if(!background.length)return;if(!memoryOk()){startBackground();return;}const item=background.shift();if(item?.type==='image'){const b=load(item.value);if(b){const go=()=>prepare(b,`${item.value.kind}:${item.value.name}`);if(b.isReady?.())go();else b.addLoadListener?.(go);}}else if(item?.type==='effect'){try{g.EffectManager?.load?.(item.value.name);}catch{}}else if(item?.type==='se'){try{g.__mvmzMZPrewarmSe?.(item.value.name);}catch{}}if(background.length)backgroundTimer=setTimeout(()=>{backgroundTimer=null;startBackground();},45);},45);};
  try{
    const originalLoadBitmap=g.ImageManager.loadBitmap;
    if(typeof originalLoadBitmap==='function'&&!originalLoadBitmap.__mvmzWarmLearn){
      const wrapped=function(this:any,folder:any,filename:any){const result=originalLoadBitmap.apply(this,arguments as any);try{learnImage(folder,filename);}catch{}return result;};
      wrapped.__mvmzWarmLearn=true;g.ImageManager.loadBitmap=wrapped;
    }
    const originalEffectLoad=g.EffectManager?.load;
    if(typeof originalEffectLoad==='function'&&!originalEffectLoad.__mvmzWarmLearn){
      const wrapped=function(this:any,name:any){const result=originalEffectLoad.apply(this,arguments as any);try{learnNamed('effects',name);}catch{}return result;};
      wrapped.__mvmzWarmLearn=true;g.EffectManager.load=wrapped;
    }
    const originalPlaySe=g.AudioManager?.playSe;
    if(typeof originalPlaySe==='function'&&!originalPlaySe.__mvmzWarmLearn){
      const wrapped=function(this:any,se:any){const result=originalPlaySe.apply(this,arguments as any);try{learnNamed('se',se?.name);}catch{}return result;};
      wrapped.__mvmzWarmLearn=true;g.AudioManager.playSe=wrapped;
    }
    ctx.log('[mz-warm-learn] runtime asset learning installed | image/effect/se');
  }catch(e){ctx.log(`[mz-warm-learn] install FAILED | ${String(e)}`);}
  const runtimeImages=()=>{const out:WarmImage[]=[];const add=(kind:string,name:any,source:string)=>{const n=String(name||'');if(n)out.push({kind,name:n,priority:0,source});};try{add('character',g.$gamePlayer?.characterName?.(),'player');for(const f of g.$gamePlayer?.followers?.()?.visibleFollowers?.()||[])add('character',f?.characterName?.(),'follower');for(const e of g.$gameMap?.events?.()||[])add('character',e?.characterName?.(),`event:${e?.eventId?.()||0}`);}catch{}return out;};
  const partyAnimations=()=>{const effects=new Map<string,WarmNamed>(),se=new Map<string,WarmNamed>();const addAnim=(id:any)=>{const a=g.$dataAnimations?.[Number(id||0)];if(!a)return;if(a.effectName)effects.set(a.effectName,{name:a.effectName,priority:0,source:'party'});for(const t of a.soundTimings||[]){const n=String(t?.se?.name||'');if(n)se.set(n,{name:n,priority:0,source:'party'});}};try{for(const actor of g.$gameParty?.battleMembers?.()||[]){addAnim(actor.attackAnimationId1?.());addAnim(actor.attackAnimationId2?.());for(const sk of actor.skills?.()||[]){const id=Number(sk?.animationId||0);if(id>0)addAnim(id);else if(id<0){addAnim(actor.attackAnimationId1?.());addAnim(actor.attackAnimationId2?.());}}}}catch{}return {effects:[...effects.values()],se:[...se.values()]};};
  const begin=(mapId:number)=>{if(backgroundTimer!==null){clearTimeout(backgroundTimer);backgroundTimer=null;}background=[];const entry=manifest.maps?.[String(mapId)]||{images:[],effects:[],se:[]};const imageMap=new Map<string,WarmImage>();for(const a of [...(entry.images||[]),...runtimeImages()]){const key=`${a.kind}|${a.folder||''}|${a.name}`;const old=imageMap.get(key);if(!old||Number(a.priority)<Number(old.priority))imageMap.set(key,a);}const images=[...imageMap.values()].sort((a,b)=>Number(a.priority)-Number(b.priority)).filter(exists);const party=partyAnimations();const effectMap=new Map<string,WarmNamed>();for(const a of [...(entry.effects||[]),...party.effects]){const old=effectMap.get(a.name);if(!old||a.priority<old.priority)effectMap.set(a.name,a);}const seMap=new Map<string,WarmNamed>();for(const a of [...(entry.se||[]),...party.se]){const old=seMap.get(a.name);if(!old||a.priority<old.priority)seMap.set(a.name,a);}const selected=images.slice(0,GATE_MAX_IMAGES),overflow=images.slice(GATE_MAX_IMAGES,GATE_MAX_IMAGES+BACKGROUND_MAX);const effects=[...effectMap.values()].sort((a,b)=>a.priority-b.priority);const ses=[...seMap.values()].sort((a,b)=>a.priority-b.priority);gate={mapId,pending:0,gpu:0,count:selected.length,started:Date.now(),deadline:Date.now()+GATE_TIMEOUT,released:false};configureLimiter(2);for(const a of selected)watch(gate,a,load(a));for(const e of effects.slice(0,GATE_MAX_EFFECTS))try{g.EffectManager?.load?.(e.name);}catch{}for(const se of ses.slice(0,GATE_MAX_SE))try{g.__mvmzMZPrewarmSe?.(se.name);}catch{}background=[...overflow.map(value=>({type:'image',value})),...effects.slice(GATE_MAX_EFFECTS).map(value=>({type:'effect',value})),...ses.slice(GATE_MAX_SE).map(value=>({type:'se',value}))];ctx.log(`[mz-warm] gate start | map=${mapId} images=${selected.length}/${images.length} effects=${Math.min(effects.length,GATE_MAX_EFFECTS)}/${effects.length} se=${Math.min(ses.length,GATE_MAX_SE)}/${ses.length} background=${background.length}`);};
  const originalSetup=mapProto.setup;mapProto.setup=function(mapId:number){const result=originalSetup.apply(this,arguments as any);begin(Number(mapId||0));return result;};
  const originalReady=sceneMapProto.isReady;sceneMapProto.isReady=function(){const ready=originalReady.apply(this,arguments as any);if(!ready)return false;const st=gate;if(!st||st.mapId!==Number(g.$gameMap?.mapId?.()||0)||st.released)return ready;if(st.pending<=0&&g.EffectManager?.isReady?.()!==false){st.released=true;configureLimiter(1);ctx.log(`[mz-warm] gate release | map=${st.mapId} reason=ready gpu=${st.gpu}/${st.count} elapsedMs=${Date.now()-st.started}`);startBackground();return true;}if(Date.now()>=st.deadline){st.released=true;configureLimiter(1);ctx.log(`[mz-warm] gate timeout | map=${st.mapId} pending=${st.pending} gpu=${st.gpu}/${st.count} elapsedMs=${Date.now()-st.started}`);startBackground();return true;}return false;};
  configureLimiter(1);ctx.log(`[mz-warm] manifest gate installed | autoCompile=true maps=${Object.keys(manifest.maps||{}).length} maxImages=${GATE_MAX_IMAGES} timeoutMs=${GATE_TIMEOUT}`);
}