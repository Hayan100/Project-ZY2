import {randomBytes} from "node:crypto";
import type {PoolClient} from "pg";
import type {FastifyInstance,FastifyRequest} from "fastify";
import {fail,type sessionTransaction} from "./authorized.ts";

export type Viewer={name:string;email:string;phone:string|null};
export const escape=(s:string)=>s.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;");
export async function mediaViewer(tx:PoolClient,student:string):Promise<Viewer>{
  return (await tx.query('SELECT u.name,u.email,i.phone FROM "user" u LEFT JOIN classroom_identity i ON i.student=u.id WHERE u.id=$1',[student])).rows[0];
}
export const videoPolicy={minIntervalMs:180000,maxIntervalMs:300000,visibleMs:6000,position:"random"} as const;
export function pdfStamp(viewer:Viewer){
  if(!viewer.phone)fail(422);
  const label=[viewer.name,viewer.phone,viewer.email].join(" · ");
  const width=Math.max(380,Array.from(label).length*8+64);
  const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="100%" height="100%"><defs><pattern id="tile" width="${width}" height="120" patternUnits="userSpaceOnUse" patternTransform="rotate(-28)"><text x="8" y="60" font-family="sans-serif" font-size="14" fill="#465265" fill-opacity=".16" textLength="${width-64}" lengthAdjust="spacingAndGlyphs">${escape(label)}</text></pattern></defs><rect width="100%" height="100%" fill="url(#tile)"/></svg>`;
  return {label,svg};
}
export const markCss=`#mark{position:absolute;z-index:1;pointer-events:none;user-select:none;white-space:pre-line;overflow-wrap:anywhere;max-width:85%;max-height:88%;overflow:hidden;color:white;background:rgb(20 24 28 / 56%);border-radius:3px;padding:.25em .65em;font:500 clamp(10px,1.7vw,20px)/1.23 system-ui}#mark[hidden]{display:none}`;
export function markHtml(v:Viewer){return `<div id="mark" hidden aria-hidden="true">${[v.name,v.phone??"",v.email].map(escape).join("\n")}</div>`}
// Timers accumulate playing time so pausing does not reset the interval.
export const markScript=`
const mark=document.getElementById("mark");
const interval=()=>${videoPolicy.minIntervalMs}+Math.floor(Math.random()*${videoPolicy.maxIntervalMs-videoPolicy.minIntervalMs+1});
let remaining=interval(),deadline=0,showTimer,hideTimer,lastX=-1,lastY=-1;
function clearMark(){
  if(deadline)remaining=Math.max(0,deadline-performance.now());
  deadline=0;clearTimeout(showTimer);clearTimeout(hideTimer);mark.hidden=true;
}
function scheduleMark(){
  if(deadline)return;
  deadline=performance.now()+remaining;
  showTimer=setTimeout(()=>{
    mark.hidden=false;
    let x=Math.random(),y=Math.random();
    if(Math.abs(x-lastX)+Math.abs(y-lastY)<.3)x=(x+.5)%1;
    lastX=x;lastY=y;
    // Percent offsets and inverse translation keep all edges inside on resize.
    mark.style.left=(100*x)+"%";mark.style.top=(100*y)+"%";
    mark.style.transform="translate("+(-100*x)+"%,"+(-100*y)+"%)";
    hideTimer=setTimeout(()=>{mark.hidden=true},${videoPolicy.visibleMs});
    remaining=interval();deadline=0;scheduleMark();
  },remaining);
}`;
export const phoneForm='<form><label>Mobile number for your content watermark <input type="tel" required maxlength="16" placeholder="+923001234567"></label> <button>Save and continue</button></form>';
export const phoneSubmit=`document.querySelector("form").onsubmit=async e=>{e.preventDefault();try{const r=await fetch("/api/v1/me/watermark-phone",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone:document.querySelector("input").value.trim()})});if(r.ok){location.reload();return}}catch{}document.querySelector("output").textContent="Could not save the number. Check the country code and try again."}`;
type Session=ReturnType<typeof sessionTransaction>;
export function registerMediaIdentity(app:FastifyInstance,session:Session){
  app.put<{Body:{phone:string}}>("/api/v1/me/watermark-phone",{schema:{body:{type:"object",required:["phone"],additionalProperties:false,properties:{phone:{type:"string",pattern:"^\\+[1-9][0-9]{7,14}$"}}}}},req=>session(req,async(tx,a)=>{
    await tx.query("INSERT INTO classroom_identity VALUES ($1,$2) ON CONFLICT(student) DO UPDATE SET phone=excluded.phone",[a.id,req.body.phone]);
    return {saved:true};
  }));
}
export async function recordedPage(req:FastifyRequest,session:Session,asset:(tx:PoolClient,student:string)=>Promise<string>){
  const authorize=()=>session(req,async(tx,a)=>({assetId:await asset(tx,a.id),viewer:await mediaViewer(tx,a.id),actor:a}));
  const initial=await authorize();
  const nonce=randomBytes(18).toString("base64");
  const policy=`default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'; media-src https:; frame-ancestors 'self'; form-action 'none'; base-uri 'none'`;
  let body:string,script:string;
  if(!initial.viewer.phone){
    body=phoneForm;script=phoneSubmit;
  }else{
    const url=process.env.VIDEO_PLAYBACK_URL;
    if(!url)fail(503);
    const res=await fetch(url,{method:"POST",redirect:"error",signal:AbortSignal.timeout(8000),headers:{"Content-Type":"application/json",...(process.env.VIDEO_PLAYBACK_TOKEN?{Authorization:"Bearer "+process.env.VIDEO_PLAYBACK_TOKEN}:{})},body:JSON.stringify({assetId:initial.assetId,student:initial.actor.id})});
    if(!res.ok)fail(503);
    const ticket=await res.json();
    if(typeof ticket.url!=="string" || !URL.canParse(ticket.url) || new URL(ticket.url).protocol!=="https:")fail(503);
    const current=await authorize();
    if(current.actor.session!==initial.actor.session || current.assetId!==initial.assetId)fail(409);
    body=`<section><div class="screen"><video playsinline controls controlslist="nofullscreen nodownload noremoteplayback" disablepictureinpicture src="${escape(ticket.url)}"></video>${markHtml(current.viewer)}</div><button id="full">Full screen</button></section>`;
    script=markScript+`const v=document.querySelector("video"),room=document.querySelector("section"),full=document.getElementById("full");
    v.addEventListener("playing",scheduleMark);for(const e of ["waiting","pause","ended"])v.addEventListener(e,clearMark);
    full.onclick=async()=>{if(document.fullscreenElement)await document.exitFullscreen();else if(room.classList.contains("expanded"))room.classList.remove("expanded");else try{await room.requestFullscreen()}catch{room.classList.add("expanded")}update()};
    function update(){full.textContent=document.fullscreenElement||room.classList.contains("expanded")?"Exit full screen":"Full screen"}
    document.addEventListener("fullscreenchange",update);document.addEventListener("keydown",e=>{if(e.key==="Escape"){room.classList.remove("expanded");update()}});`;
  }
  return {policy,html:`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MDCATEMY video</title><style nonce="${nonce}">body{background:#102023;color:white;font:1rem system-ui;margin:1rem}section{max-width:70rem;margin:auto;background:black}.screen{position:relative;width:fit-content;max-width:100%;margin:auto}video{display:block;max-width:100%;max-height:calc(100dvh - 3rem)}section:fullscreen,.expanded{max-width:none;display:grid;align-content:center}.expanded{position:fixed;inset:0}button,input{font:inherit;padding:.4rem}${markCss}</style><main>${body}<output></output></main><script nonce="${nonce}">${script}</script></html>`};
}
