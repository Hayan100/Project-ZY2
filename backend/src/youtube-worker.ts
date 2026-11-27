import {Pool} from "pg";

function setting(name:string) {
  const value=process.env[name];
  if(!value) throw new Error("Missing "+name);
  return value;
}
const channel=setting("MDCATEMY_YOUTUBE_CHANNEL_ID");
const connectionString=setting("YOUTUBE_WORKER_DATABASE_URL");
const credentials=new URLSearchParams({grant_type:"refresh_token",refresh_token:setting("YOUTUBE_REFRESH_TOKEN"),
  client_id:setting("YOUTUBE_CLIENT_ID"),client_secret:setting("YOUTUBE_CLIENT_SECRET")});
const db=new Pool({connectionString,max:1});
async function sync() {
  const pending=await db.query(`SELECT id FROM classes WHERE youtube_video_id IS NOT NULL AND opens<=now()
    AND youtube_state IS DISTINCT FROM 'private' AND (youtube_state IS NULL OR closes<=now()) ORDER BY closes`);
  if(!pending.rowCount)return;
  const tokenResponse=await fetch("https://oauth2.googleapis.com/token",{method:"POST",body:credentials,redirect:"error",signal:AbortSignal.timeout(10000)});
  if(!tokenResponse.ok) throw new Error("YouTube OAuth refresh failed");
  const {access_token:token}=await tokenResponse.json();
  if(typeof token!=="string" || !token) throw new Error("Missing YouTube access token");
  async function api(path:string,query:Record<string,string>,method="GET",body?:object) {
    const response=await fetch("https://www.googleapis.com/youtube/v3/"+path+"?"+new URLSearchParams(query),{
      method,redirect:"error",signal:AbortSignal.timeout(10000),
      headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body:body?JSON.stringify(body):undefined});
    if(!response.ok) throw new Error(path+" returned "+response.status);
    return response.json();
  }
  for(const {id} of pending.rows) {
    const tx=await db.connect();
    try{
      await tx.query("BEGIN");
      const {rows:[room]}=await tx.query(`SELECT youtube_video_id AS video,closes<=clock_timestamp() AS closed
        FROM classes WHERE id=$1 AND opens<=now() AND youtube_state IS DISTINCT FROM 'private'
        AND (youtube_state IS NULL OR closes<=now()) FOR UPDATE SKIP LOCKED`,[id]);
      if(room){
        const query={id:room.video,part:"snippet,status,contentDetails"};
        const {items:[event]}=await api("liveBroadcasts",query);
        if(event?.snippet?.channelId!==channel)throw new Error("Broadcast unavailable on configured MDCATEMY channel");
        const lifecycle=event.status.lifeCycleStatus;
        if(room.closed){
          if(["live","testing"].includes(lifecycle))await api("liveBroadcasts/transition",{id:room.video,part:"status",broadcastStatus:"complete"},"POST");
          if(["liveStarting","testStarting"].includes(lifecycle))throw new Error("Transition pending");
          const {items:[video]}=await api("videos",{id:room.video,part:"status,snippet"});
          if(video?.snippet?.channelId!==channel)throw new Error("Archive unavailable on configured channel");
          if(video.status.privacyStatus!=="private"){
            const status:Record<string,unknown>={privacyStatus:"private"};
            for(const key of ["embeddable","license","publicStatsViewable","selfDeclaredMadeForKids","containsSyntheticMedia"])
              if(video.status[key]!==undefined)status[key]=video.status[key];
            await api("videos",{part:"status"},"PUT",{id:room.video,status});
          }
          await tx.query("UPDATE classes SET youtube_state='private' WHERE id=$1",[id]);
        }else{
          if(event.status.privacyStatus!=="unlisted" || event.contentDetails.enableAutoStart || !event.contentDetails.recordFromStart)
            throw new Error("Schedule an unlisted recording with auto-start disabled");
          if(lifecycle==="testing" || lifecycle==="ready"){
            const streamId=event.contentDetails.boundStreamId;
            if(streamId){
              const {items:[stream]}=await api("liveStreams",{id:streamId,part:"status"});
              if(stream?.status?.streamStatus==="active"){
                const {rows:[window]}=await tx.query("SELECT closes>clock_timestamp() AS open FROM classes WHERE id=$1",[id]);
                if(window.open)await api("liveBroadcasts/transition",{id:room.video,part:"status",broadcastStatus:"live"},"POST");
              }
            }
          }else if(lifecycle==="live")await tx.query("UPDATE classes SET youtube_state='live' WHERE id=$1",[id]);
          // Poll again to confirm a requested transition before releasing playback.
        }
      }
      await tx.query("COMMIT");
    }catch(error){
      await tx.query("ROLLBACK");process.exitCode=1;
      console.error(JSON.stringify({event:"youtube_class_retry",classId:id,message:error instanceof Error?error.message:"unknown error"}));
    }finally{tx.release()}
  }
}
try{await sync()}finally{await db.end()}
