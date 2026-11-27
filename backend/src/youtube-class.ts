import {randomBytes} from "node:crypto";

import {type Viewer,escape,markCss,markHtml,markScript} from "./media-watermark.ts";

export function youtubeClassPage(title:string, viewer:Viewer, origin:string, videoId:string|null, sessionTag:string) {
  const nonce=randomBytes(18).toString("base64");
  const policy=`default-src 'none'; frame-src https://www.youtube-nocookie.com; connect-src 'self'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}' https://www.youtube.com; base-uri 'none'; frame-ancestors 'self'; form-action 'none'`;
  const stage = videoId && viewer.phone ? `<section id="room" aria-label="Class player">
  <div class="screen"><iframe id="yt" tabindex="-1" title="Live class video" referrerpolicy="strict-origin-when-cross-origin"
    allow="autoplay; encrypted-media" src="https://www.youtube-nocookie.com/embed/${escape(videoId)}?enablejsapi=1&amp;origin=${encodeURIComponent(origin)}&amp;controls=0&amp;disablekb=1&amp;fs=0&amp;playsinline=1&amp;rel=0"></iframe>
    <div id="curtain">MDCATEMY</div>
    ${markHtml(viewer)}
  </div><div class="controls"><button id="play" disabled>Play</button><button id="sound" disabled>Mute</button>
    <button id="full">Full screen</button></div></section>
    <p>Your name, email and phone appear periodically on the video.</p>` :
    !viewer.phone ? `<form id="profile"><label>Your mobile number, including country code
      <input required name="phone" type="tel" autocomplete="tel" placeholder="+923001234567" maxlength="16"></label>
      <p>Your name, email and this number will appear periodically on your class video.</p>
      <button>Save and continue</button></form>` : `<p id="waiting">Waiting for the teacher to go live. <a href="">Refresh class</a></p>`;
  const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)} · MDCATEMY</title><style nonce="${nonce}">
*{box-sizing:border-box}body{margin:0;background:#102023;color:#faf7ee;font:1rem/1.5 system-ui,sans-serif}
main{max-width:70rem;margin:auto;padding:clamp(12px,3vw,40px)}h1{font-size:clamp(1.3rem,3vw,2rem)}button,input{font:inherit;padding:.45rem .8rem}
button{cursor:pointer}a{color:inherit}#room{background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center}
.screen{position:relative;width:100%;aspect-ratio:16/9;overflow:hidden}iframe,#curtain{position:absolute;inset:0;width:100%;height:100%;border:0}
iframe{pointer-events:none}#curtain{display:grid;place-items:center;background:#132327;font-weight:650}
${markCss}
.controls{display:flex;gap:.4rem;width:100%;padding:.35rem}.controls button{color:white;background:#23383a;border:0;border-radius:4px}#full{margin-left:auto}
#room:fullscreen,.expanded{width:100%;height:100%;background:black}.expanded{position:fixed;inset:0;z-index:1}
#room:fullscreen .screen,.expanded .screen{width:min(100%,calc((100dvh - 4rem)*16/9))}
[hidden],#curtain[hidden]{display:none}
</style></head><body><main><header>MDCATEMY</header><h1>${escape(title)}</h1>${stage}<p id="status" role="status"></p></main>
<script nonce="${nonce}">
const el=id=>document.getElementById(id), statusLine=el("status");
document.addEventListener("keydown",e=>{
  const k=e.key.toLowerCase();
  if(k==="f12" || e.ctrlKey && (k==="u" || k==="i" || e.shiftKey && k==="j") || e.metaKey && e.altKey && ["i","j","u"].includes(k)) e.preventDefault();
});
document.addEventListener("contextmenu",e=>e.preventDefault());
el("profile")?.addEventListener("submit",async e=>{
  e.preventDefault();
  try{
    const response=await fetch("watermark-phone",{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({phone:e.target.elements.phone.value.trim()})});
    if(response.ok){location.reload();return}
    statusLine.textContent=response.status===400?"Enter the full mobile number with + and the country code.":"Could not save the number. Refresh to check class access.";
  }catch{statusLine.textContent="Connection lost. Try again."}
});
const room=el("room");
if(el("waiting"))setTimeout(()=>location.reload(),30000);
if(room){
  let player,playing=false,ended=false;
  ${markScript}
  const cover=el("curtain"),full=el("full");
  function end(message){
    ended=true;clearMark();player?.destroy();room.remove();statusLine.textContent=message;
  }
  window.onYouTubeIframeAPIReady=()=>{
    if(ended)return;
    player=new YT.Player("yt",{events:{
      onReady(){el("play").disabled=false;el("sound").disabled=false},
      onStateChange(e){
        if(e.data===YT.PlayerState.BUFFERING)return;
        const wasPlaying=playing;
        playing=e.data===YT.PlayerState.PLAYING;
        cover.hidden=playing;el("play").textContent=playing?"Pause":"Play";
        if(playing && !wasPlaying){scheduleMark()}else if(!playing){clearMark()}
      },
      onError(){end("Video unavailable. Refresh to reconnect or contact your teacher.")}
    }});
  };
  el("play").onclick=()=>playing?player.pauseVideo():player.playVideo();
  el("sound").onclick=()=>{
    const muted=player.isMuted();
    if(muted)player.unMute();else player.mute();
    el("sound").textContent=muted?"Mute":"Unmute";
  };
  function syncFull(){full.textContent=document.fullscreenElement===room || room.classList.contains("expanded")?"Exit full screen":"Full screen"}
  document.addEventListener("fullscreenchange",syncFull);
  document.addEventListener("keydown",e=>{if(e.key==="Escape"){room.classList.remove("expanded");syncFull()}});
  full.onclick=async()=>{
    if(document.fullscreenElement===room)await document.exitFullscreen();
    else if(room.classList.contains("expanded"))room.classList.remove("expanded");
    else {try{await room.requestFullscreen()}catch{room.classList.add("expanded")}}
    syncFull();
  };
  async function checkSession(){
    if(ended)return;
    try{
      const r=await fetch("presence",{method:"POST",headers:{"X-Class-Session":"${sessionTag}"},cache:"no-store",signal:AbortSignal.timeout(8000)});
      if(r.ok){setTimeout(checkSession,30000);return}
    }catch{}
    if(!ended)end("Class access could not be confirmed. Reload to reconnect.");
  }
  checkSession();
  const api=document.createElement("script");api.src="https://www.youtube.com/iframe_api";
  api.onerror=()=>end("The player could not load. Refresh to reconnect.");document.head.append(api);
}
</script></body></html>`;
  return {policy,html};
}
