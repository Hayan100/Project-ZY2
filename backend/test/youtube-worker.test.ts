import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {Pool} from "pg";

test("a scheduled broadcast waits for the encoder, confirms live and closes the archive", {skip:!process.env.TEST_DATABASE_URL},async t=>{
  const db=new Pool({connectionString:process.env.TEST_DATABASE_URL});
  const schema="worker_"+randomUUID().replaceAll("-","");
  const uri=new URL(process.env.TEST_DATABASE_URL!);
  uri.searchParams.set("options","-c search_path="+schema);
  await db.query("CREATE SCHEMA "+schema);
  t.after(async()=>{await db.query("DROP SCHEMA "+schema+" CASCADE");await db.end()});
  await db.query(`CREATE TABLE ${schema}.classes(id uuid PRIMARY KEY,youtube_video_id text,youtube_state text,opens timestamptz,closes timestamptz)`);
  await db.query(`INSERT INTO ${schema}.classes VALUES ($1,'test1234567',null,now()-interval '1 minute',now()+interval '1 hour')`,[randomUUID()]);
  for(const [key,value] of Object.entries({MDCATEMY_YOUTUBE_CHANNEL_ID:"test-channel",YOUTUBE_WORKER_DATABASE_URL:uri.toString(),YOUTUBE_CLIENT_ID:"test",YOUTUBE_CLIENT_SECRET:"test",YOUTUBE_REFRESH_TOKEN:"test"})){
    const old=process.env[key];process.env[key]=value;t.after(()=>{if(old===undefined)delete process.env[key];else process.env[key]=old});
  }
  let encoder="inactive",life="ready",privacy="unlisted";
  const changes:string[]=[];
  t.mock.method(globalThis,"fetch",async(input:string,options:RequestInit)=>{
    const url=new URL(input);
    if(url.host==="oauth2.googleapis.com")return Response.json({access_token:"fixture"});
    switch(url.pathname.split("/").at(-1)){
      case "liveBroadcasts":return Response.json({items:[{snippet:{channelId:"test-channel"},status:{lifeCycleStatus:life,privacyStatus:privacy},contentDetails:{recordFromStart:true,boundStreamId:"test-stream"}}]});
      case "liveStreams":return Response.json({items:[{status:{streamStatus:encoder}}]});
      case "transition":life=url.searchParams.get("broadcastStatus")!;changes.push(life);return Response.json({});
      case "videos":
        if(options.method==="PUT"){privacy=JSON.parse(String(options.body)).status.privacyStatus;changes.push(privacy);return Response.json({})}
        return Response.json({items:[{snippet:{channelId:"test-channel"},status:{privacyStatus:privacy}}]});
      default:throw Error("Unexpected API call");
    }
  });
  const run=()=>import(new URL("../src/youtube-worker.ts?test="+randomUUID(),import.meta.url).href);
  const state=async()=>(await db.query("SELECT youtube_state FROM "+schema+".classes")).rows[0].youtube_state;
  await run();assert.deepEqual(changes,[]);
  encoder="active";await run();assert.equal(await state(),null);
  await run();assert.equal(await state(),"live");
  await db.query("UPDATE "+schema+".classes SET closes=now()");
  await run();await run();
  assert.deepEqual(changes,["live","complete","private"]);assert.equal(await state(),"private");
});
