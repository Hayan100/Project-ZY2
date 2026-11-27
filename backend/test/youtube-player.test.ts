import test from "node:test";
import assert from "node:assert/strict";
import {runInNewContext} from "node:vm";
import {youtubeClassPage} from "../src/youtube-class.ts";

test("class wrapper times the personal mark, fullscreens its container and removes it on session loss",async()=>{
  const page=youtubeClassPage("<Lecture>",{name:"A < B",email:"a@school.test",phone:"+923001234567"},"https://class.test","abcde123456","abc123");
  assert.ok(page.html.includes("A &lt; B") && page.html.includes("&lt;Lecture&gt;"));
  assert.ok(!page.html.includes("allowfullscreen"));
  const mark={dataset:{pos:""},hidden:true};
  let expanded=false,destroyed=false,access=true;
  const room={requestFullscreen(){expanded=true},classList:{contains:()=>false},remove(){}};
  const full={onclick:async()=>{}};
  const sound={onclick:()=>{},textContent:"Mute"};
  const nodes:Record<string,unknown>={mark,room,full,curtain:{},play:{},sound,status:{}};
  const timers=new Map<number,()=>void>();
  const window={onYouTubeIframeAPIReady:()=>{}};
  let stateChange=(e:{data:number})=>{};
  class Player{
    constructor(_id:string,options:{events:{onStateChange:typeof stateChange}}){stateChange=options.events.onStateChange}
    isMuted(){return false}
    mute(){}
    destroy(){destroyed=true}
  }
  const script=page.html.match(/<script nonce="[^"]+">([\s\S]+?)<\/script>/)![1];
  runInNewContext(script,{window,YT:{Player,PlayerState:{PLAYING:1,BUFFERING:3}},document:{
    getElementById:(id:string)=>nodes[id],addEventListener(){},createElement:()=>({}),head:{append(){}}
  },fetch:async()=>({ok:access}),AbortSignal,setTimeout:(callback:()=>void,ms:number)=>{timers.set(ms,callback);return ms},
  clearTimeout:(id:number)=>timers.delete(id)});
  window.onYouTubeIframeAPIReady();
  sound.onclick();
  assert.equal(sound.textContent,"Unmute");
  stateChange({data:1});
  assert.equal(mark.hidden,false);
  const first=mark.dataset.pos;
  timers.get(6000)!();
  assert.equal(mark.hidden,true);
  timers.get(45000)!();
  assert.equal(mark.hidden,false);
  assert.notEqual(mark.dataset.pos,first);
  await full.onclick();
  assert.equal(expanded,true);
  access=false;
  await new Promise(resolve=>setImmediate(resolve));
  await timers.get(30000)!();
  assert.equal(destroyed,true);
});
