import { createWebGL1Compat, type CompatStats } from './webgl1';
type LogFn = (message: string) => void;
type AnyRecord = Record<string, any>;

function installTextDecoderCompat(g: AnyRecord, log: LogFn) {
  const NativeTextDecoder = g.TextDecoder;
  if (typeof NativeTextDecoder !== 'function') return;
  try {
    new NativeTextDecoder('utf-16le');
    return;
  } catch {}

  class TextDecoderCompat {
    readonly encoding: string;
    readonly fatal = false;
    readonly ignoreBOM = false;
    private readonly native: any;
    private readonly utf16le: boolean;
    constructor(label = 'utf-8', options?: any) {
      const normalized = String(label || 'utf-8').toLowerCase().replace(/[_\s]/g, '-');
      this.utf16le = normalized === 'utf-16le' || normalized === 'utf16le' || normalized === 'utf-16';
      this.encoding = this.utf16le ? 'utf-16le' : 'utf-8';
      this.native = this.utf16le ? null : new NativeTextDecoder('utf-8', options);
    }
    decode(input?: any, options?: any) {
      if (!this.utf16le) return this.native.decode(input, options);
      if (input == null) return '';
      let bytes: Uint8Array;
      if (input instanceof ArrayBuffer) bytes = new Uint8Array(input);
      else if (ArrayBuffer.isView(input)) bytes = new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
      else bytes = new Uint8Array(input);
      let start = bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe ? 2 : 0;
      let out = '';
      const chars: number[] = [];
      for (let i = start; i + 1 < bytes.length; i += 2) {
        chars.push(bytes[i] | (bytes[i + 1] << 8));
        if (chars.length >= 4096) {
          out += String.fromCharCode(...chars);
          chars.length = 0;
        }
      }
      if (chars.length) out += String.fromCharCode(...chars);
      return out;
    }
  }
  g.TextDecoder = TextDecoderCompat;
  log('[dom] TextDecoder utf-16le compatibility installed');
}

class ElementShim extends EventTarget {
  [key:string]: any;
  readonly nodeType = 1;
  nodeName: string;
  tagName: string;
  className = '';
  id = '';
  style: AnyRecord = Object.create(null);
  parentNode: ElementShim | null = null;
  children: any[] = [];
  innerHTML = '';
  textContent = '';
  private attrs = new Map<string, string>();
  constructor(tagName='div') { super(); this.tagName = tagName.toUpperCase(); this.nodeName = this.tagName; }
  appendChild(child:any){ if (child && typeof child === 'object') child.parentNode=this; this.children.push(child); return child; }
  removeChild(child:any){ const i=this.children.indexOf(child); if(i>=0)this.children.splice(i,1); if(child&&typeof child==='object')child.parentNode=null; return child; }
  setAttribute(name:string,value:string|number){ const t=String(value); this.attrs.set(name,t); if(name==='id')this.id=t; if(name==='class')this.className=t; }
  getAttribute(name:string){ return this.attrs.get(name) ?? null; }
  getElementsByTagName(tagName:string){
    const wanted=String(tagName).toUpperCase();
    const found:any[]=[];
    const walk=(node:any)=>{for(const child of node.children??[]){if(child?.tagName&&(wanted==='*'||child.tagName===wanted))found.push(child);if(child?.children)walk(child);}};
    walk(this);
    return found;
  }
  focus(){} blur(){} click(){}
  remove(){ if(this.parentNode)this.parentNode.removeChild(this); }
  getBoundingClientRect(){ return {left:0,top:0,right:0,bottom:0,width:0,height:0,x:0,y:0}; }
}

class TextNodeShim extends EventTarget {
  readonly nodeType=3;
  readonly nodeName='#text';
  parentNode:ElementShim|null=null;
  constructor(public data:string){super();}
  get textContent(){return this.data;}
  set textContent(value:string){this.data=String(value);}
}

class MediaElementShim extends ElementShim {
  src=''; volume=1; currentTime=0; duration=0; paused=true; readyState=0; autoplay=false; loop=false;
  constructor(tagName:'video'|'audio'){super(tagName);}
  play(){this.paused=false;return Promise.resolve();}
  pause(){this.paused=true;}
  load(){}
  canPlayType(type:string){
    const value=String(type||'').toLowerCase();
    if(value.includes('audio/ogg')||value.includes('audio/vorbis'))return 'probably';
    if(value.includes('audio/mp4')||value.includes('audio/aac')||value.includes('audio/m4a'))return 'probably';
    if(value.includes('video/webm')||value.includes('video/mp4'))return 'maybe';
    return '';
  }
}

class WorkerShim extends EventTarget {
  onmessage:any=null; onerror:any=null;
  constructor(public url:string){ super(); }
  postMessage(_data:any){ }
  terminate(){}
}

class CanvasShim extends ElementShim {
  private _width=300; private _height=150; private offscreen:OffscreenCanvas|null=null; private context2d:OffscreenCanvasRenderingContext2D|null=null; private context2dCompat:any=null; private dirtyRect:{x0:number;y0:number;x1:number;y1:number}|null=null;
  constructor(private webglProvider:()=>any){ super('canvas'); }
  get width(){return this._width;}
  set width(v:number){
    this._width=Math.max(1,Number(v)||1);
    // Browser canvas semantics: resizing keeps the same Canvas/2D context
    // object alive while resetting its backing store. RPG Maker MV obtains
    // the 2D context first, then assigns canvas.width/height. Replacing the
    // OffscreenCanvas here would leave MV drawing into a stale old surface.
    if(this.offscreen)this.offscreen.width=this._width;
    this.__mvmzMarkDirtyFull();
  }
  get height(){return this._height;}
  set height(v:number){
    this._height=Math.max(1,Number(v)||1);
    if(this.offscreen)this.offscreen.height=this._height;
    this.__mvmzMarkDirtyFull();
  }
  __mvmzMarkDirtyFull(){this.dirtyRect={x0:0,y0:0,x1:this._width,y1:this._height};}
  __mvmzMarkDirtyRect(x:any,y:any,width:any,height:any){
    let x0=Math.floor(Number(x)||0),y0=Math.floor(Number(y)||0),x1=Math.ceil((Number(x)||0)+(Number(width)||0)),y1=Math.ceil((Number(y)||0)+(Number(height)||0));
    if(x1<x0){const t=x0;x0=x1;x1=t;} if(y1<y0){const t=y0;y0=y1;y1=t;}
    x0=Math.max(0,Math.min(this._width,x0)); y0=Math.max(0,Math.min(this._height,y0)); x1=Math.max(0,Math.min(this._width,x1)); y1=Math.max(0,Math.min(this._height,y1));
    if(x1<=x0||y1<=y0)return;
    const d=this.dirtyRect;
    this.dirtyRect=d?{x0:Math.min(d.x0,x0),y0:Math.min(d.y0,y0),x1:Math.max(d.x1,x1),y1:Math.max(d.y1,y1)}:{x0,y0,x1,y1};
  }
  __mvmzPeekDirtyRect(){const d=this.dirtyRect;if(!d)return null;return {x:d.x0,y:d.y0,width:d.x1-d.x0,height:d.y1-d.y0};}
  __mvmzClearDirtyRect(){this.dirtyRect=null;}
  private isIdentityTransform(target:any){
    try{const t=target?.getTransform?.();if(!t)return true;return Number(t.a)===1&&Number(t.b)===0&&Number(t.c)===0&&Number(t.d)===1&&Number(t.e)===0&&Number(t.f)===0;}catch{return false;}
  }
  private markTextDirty(target:any,text:string,x:any,y:any,maxWidth:any,stroke:boolean){
    if(!this.isIdentityTransform(target)){this.__mvmzMarkDirtyFull();return;}
    try{
      const metrics=target.measureText(text);
      let width=Math.max(1,Number(metrics?.width)||1);
      const limit=Number(maxWidth);if(Number.isFinite(limit)&&limit>0)width=Math.min(width,limit);
      const align=String(target.textAlign||'start');let left=Number(x)||0;if(align==='center')left-=width/2;else if(align==='right'||align==='end')left-=width;
      const fontMatch=/(\d+(?:\.\d+)?)px/i.exec(String(target.font||''));const fontSize=fontMatch?Number(fontMatch[1]):26;
      const ascent=Math.max(fontSize*0.8,Number(metrics?.actualBoundingBoxAscent)||0);
      const descent=Math.max(fontSize*0.3,Number(metrics?.actualBoundingBoxDescent)||0);
      const pad=(stroke?Math.max(1,Number(target.lineWidth)||1)/2:0)+3;
      this.__mvmzMarkDirtyRect(left-pad,(Number(y)||0)-ascent-pad,width+pad*2,ascent+descent+pad*2);
    }catch{this.__mvmzMarkDirtyFull();}
  }
  private markDrawImageDirty(target:any,source:any,args:any[]){
    if(!this.isIdentityTransform(target)){this.__mvmzMarkDirtyFull();return;}
    try{
      let x=0,y=0,w=Number(source?.width||source?.videoWidth||0),h=Number(source?.height||source?.videoHeight||0);
      if(args.length===2){x=Number(args[0])||0;y=Number(args[1])||0;}
      else if(args.length===4){x=Number(args[0])||0;y=Number(args[1])||0;w=Number(args[2])||0;h=Number(args[3])||0;}
      else if(args.length>=8){x=Number(args[4])||0;y=Number(args[5])||0;w=Number(args[6])||0;h=Number(args[7])||0;}
      else{this.__mvmzMarkDirtyFull();return;}
      this.__mvmzMarkDirtyRect(x,y,w,h);
    }catch{this.__mvmzMarkDirtyFull();}
  }
  getNativeCanvas(){if(!this.offscreen)this.offscreen=new OffscreenCanvas(this._width,this._height);return this.offscreen;}
  private unwrapCanvasSource(value:any){return value instanceof CanvasShim?value.getNativeCanvas():value;}
  private get2d(){
    if(!this.context2d)this.context2d=this.getNativeCanvas().getContext('2d');
    if(!this.context2dCompat){
      const owner=this;
      this.context2dCompat=new Proxy(this.context2d as any,{
        get(target,property){
          if(property==='drawImage')return(source:any,...args:any[])=>{const native=owner.unwrapCanvasSource(source);const result=target.drawImage(native,...args);owner.markDrawImageDirty(target,native,args);return result;};
          if(property==='createPattern')return(source:any,repetition:any)=>target.createPattern(owner.unwrapCanvasSource(source),repetition);
          if(property==='fillText'||property==='strokeText'||property==='measureText')return(...args:any[])=>{
            const text=String(args[0]??'');
            const g:any=globalThis as any;
            const family=String(g.__mvmzCanvasHangulFallbackFamily||'');
            const hasHangul=/[\u1100-\u11ff\u3130-\u318f\ua960-\ua97f\uac00-\ud7af\ud7b0-\ud7ff]/.test(text);
            const fn=(target as any)[property];
            if(typeof fn!=='function')return undefined;
            const invoke=()=>{const result=fn.apply(target,args);if(property!=='measureText')owner.markTextDirty(target,text,args[1],args[2],args[3],property==='strokeText');return result;};
            if(!family||!hasHangul)return invoke();
            const previousFont=String((target as any).font||'');
            const match=/^(.*?\b\d+(?:\.\d+)?px)\s+/i.exec(previousFont);
            try{
              (target as any).font=(match?match[1]:'26px')+' '+family;
              try{g.__mvmzCanvasHangulFallbackLogger?.(String(property),text,previousFont);}catch{}
              return invoke();
            }finally{
              try{(target as any).font=previousFont;}catch{}
            }
          };
          if(property==='clearRect'||property==='fillRect'||property==='strokeRect')return(x:any,y:any,width:any,height:any)=>{const fn=(target as any)[property];const result=fn.call(target,x,y,width,height);if(owner.isIdentityTransform(target))owner.__mvmzMarkDirtyRect(x,y,width,height);else owner.__mvmzMarkDirtyFull();return result;};
          if(property==='putImageData')return(image:any,x:any,y:any,...args:any[])=>{const result=(target as any).putImageData(image,x,y,...args);owner.__mvmzMarkDirtyRect(x,y,Number(image?.width||0),Number(image?.height||0));return result;};
          if(property==='fill'||property==='stroke')return(...args:any[])=>{const result=(target as any)[property](...args);owner.__mvmzMarkDirtyFull();return result;};
          if(property==='getImageData')return(x:any,y:any,width:any,height:any)=>{
            const sx=Math.trunc(Number(x)||0),sy=Math.trunc(Number(y)||0);
            const sw=Math.max(1,Math.trunc(Number(width)||0)),sh=Math.max(1,Math.trunc(Number(height)||0));
            const cw=owner.width,ch=owner.height;
            if(sx>=0&&sy>=0&&sx+sw<=cw&&sy+sh<=ch)return target.getImageData(sx,sy,sw,sh);
            // Browser CanvasRenderingContext2D#getImageData returns transparent
            // black for the portion outside the canvas. nx.js currently throws
            // for those coordinates, which breaks MZ Bitmap.getAlphaPixel()
            // hit-tests used by plugins and title/map UI.
            const out=target.createImageData(sw,sh);
            const ix=Math.max(0,sx),iy=Math.max(0,sy);
            const ex=Math.min(cw,sx+sw),ey=Math.min(ch,sy+sh);
            const iw=Math.max(0,ex-ix),ih=Math.max(0,ey-iy);
            if(iw>0&&ih>0){
              const part=target.getImageData(ix,iy,iw,ih);
              for(let row=0;row<ih;row++){
                const srcStart=row*iw*4;
                const srcEnd=srcStart+iw*4;
                const dstStart=((iy-sy+row)*sw+(ix-sx))*4;
                out.data.set(part.data.subarray(srcStart,srcEnd),dstStart);
              }
            }
            return out;
          };
          const value=Reflect.get(target,property,target);
          return typeof value==='function'?value.bind(target):value;
        },
        set(target,property,value){return Reflect.set(target,property,value,target);}
      });
    }
    return this.context2dCompat;
  }
  getContext(kind:string,_options?:any){ if(kind==='2d')return this.get2d(); if(kind==='webgl'||kind==='experimental-webgl'||kind==='webgl2')return this.webglProvider(); return null; }
  toDataURL(type?:string,quality?:number){const native:any=this.getNativeCanvas();if(typeof native?.toDataURL==='function'){try{return native.toDataURL(type,quality);}catch{}}return '';}
  private getDisplayRect(){
    const fit=(globalThis as any).__mvmzViewportFit;
    const id=String(this.id||'').toLowerCase();
    if((id==='gamecanvas'||id==='uppercanvas')&&fit){
      return {left:Number(fit.x)||0,top:Number(fit.top)||0,width:Number(fit.width)||this._width,height:Number(fit.height)||this._height};
    }
    return {left:0,top:0,width:this._width,height:this._height};
  }
  get offsetWidth(){return this.getDisplayRect().width;}
  get offsetHeight(){return this.getDisplayRect().height;}
  get offsetTop(){return this.getDisplayRect().top;}
  get offsetLeft(){return this.getDisplayRect().left;}
  getBoundingClientRect(){const r=this.getDisplayRect();return {left:r.left,top:r.top,right:r.left+r.width,bottom:r.top+r.height,width:r.width,height:r.height,x:r.left,y:r.top};}
}

class DocumentShim extends EventTarget {
  readonly body=new ElementShim('body'); readonly head=new ElementShim('head'); readonly documentElement=new ElementShim('html'); hidden=false; visibilityState='visible'; readyState='complete'; title='MVMZ Universal Player'; currentScript:any=null;
  constructor(private webglProvider:()=>any){ super(); this.documentElement.appendChild(this.head); this.documentElement.appendChild(this.body); }
  createElement(tagName:string){ const tag=String(tagName).toLowerCase(); if(tag==='canvas')return new CanvasShim(this.webglProvider); if(tag==='img'||tag==='image')return new Image(); if(tag==='video'||tag==='audio')return new MediaElementShim(tag); return new ElementShim(tag); }
  createTextNode(text:string){return new TextNodeShim(String(text));}
  createElementNS(_ns:string,tagName:string){return this.createElement(tagName);}
  getElementById(id:string){return this.getElementsByTagName('*').find((x:any)=>x.id===id)??null;}
  querySelector(selector:string){if(selector.startsWith('#'))return this.getElementById(selector.slice(1));return null;}
  getElementsByTagName(tagName:string){
    const wanted=String(tagName).toUpperCase();
    if(wanted==='HEAD')return [this.head];
    if(wanted==='BODY')return [this.body];
    if(wanted==='HTML')return [this.documentElement];
    const all:any[]=[];
    if(wanted==='*'||this.head.tagName===wanted)all.push(this.head);
    if(wanted==='*'||this.body.tagName===wanted)all.push(this.body);
    all.push(...this.documentElement.getElementsByTagName(tagName));
    return Array.from(new Set(all));
  }
}

export type DomCompat={document:DocumentShim;gl:any;glStats:CompatStats;createCanvas:(w:number,h:number)=>CanvasShim};
export function installDomCompat(rawGl:WebGL2RenderingContext,log:LogFn):DomCompat{
  const g=globalThis as AnyRecord; const {gl,stats}=createWebGL1Compat(rawGl,log); const provider=()=>gl; const document=new DocumentShim(provider); const events=new EventTarget();
  installTextDecoderCompat(g,log);
  g.window=g; g.self=g; g.global=g; g.document=document; g.innerWidth=screen.width; g.innerHei