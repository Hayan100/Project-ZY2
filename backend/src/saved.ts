import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail } from "./authorized.ts";
import { obj, uuid, type Session } from "./community.ts";
import { loadCourse } from "./learning.ts";
import type { registerEbooks } from "./ebooks.ts";
import type { registerInventory } from "./inventory.ts";

type Bookmark = {kind:"lesson"|"page"|"sheet";source:string;target:string;course?:string;lesson?:string;original_signature?:string};
export function registerSaved(app:FastifyInstance, session:Session, accessible:string,
  bookFor:ReturnType<typeof registerEbooks>, savedCommunity:ReturnType<typeof registerInventory>) {
  async function resolve(tx:PoolClient,user:string,item:Bookmark) {
    const {kind,source,target,course,lesson}=item;
    if(kind==="page") {
      const book=await bookFor(tx,user,source,{courseId:course??undefined,lessonId:lesson??undefined});
      const page=book.manuscript.pages.find(page=>page.id===target)??fail(404);
      const context=course ? "?courseId="+course+"&lessonId="+lesson : "";
      return {signature:createHash("sha256").update(JSON.stringify(page)).digest("hex"),title:page.title,href:"/api/v1/ebooks/"+source+"/pages/"+target+context};
    }
    const lessonId=kind==="lesson"?target:lesson!;
    const entry=(await loadCourse(tx,accessible,user,source,false,kind==="lesson"?lessonId:undefined)).available(lessonId);
    const path="/courses/"+source+"/lessons/"+lessonId;
    if(kind==="lesson") return {title:entry.title,href:"/api/v1"+path,signature:entry.resourceId};
    if(!entry.relatedResourceIds?.includes(target)) fail(404);
    const sheet=(await tx.query("SELECT title FROM academy_sheets WHERE id=$1",[target])).rows[0]??fail(404);
    return {title:String(sheet.title),href:"/api/v1/inventory"+path+"/sheets/"+target};
  }

  const path="/api/v1/me/saved";
  app.put<{Body:Bookmark & {saved:boolean}}>(path,{schema:{body:obj({
    kind:{enum:["lesson","page","sheet"]},source:uuid,target:uuid,course:uuid,lesson:uuid,saved:{type:"boolean"}
  },["kind","source","target","saved"])}}, req=>session(req,async(tx,actor)=>{
    const item=req.body, key=[actor.id,item.kind,item.source,item.target];
    if(!item.saved) {
      await tx.query("DELETE FROM study_bookmarks WHERE (student,kind,source,target)=($1,$2,$3,$4)",key);
      return {saved:false};
    }
    if(item.kind==="sheet" && (!item.lesson||item.course) || item.kind==="page" && !!item.course!==!!item.lesson ||
       item.kind==="lesson" && (item.lesson||item.course)) fail(422);
    const current=await resolve(tx,actor.id,item);
    await tx.query(`INSERT INTO study_bookmarks(student,kind,source,target,course,lesson,original_signature)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(student,kind,source,target) DO UPDATE SET
      course=excluded.course,lesson=excluded.lesson,original_signature=excluded.original_signature`,
      [...key,item.course,item.lesson,current.signature]);
    return {saved:true};
  }));
  app.get(path,req=>session(req,async(tx,actor)=>{
    const {rows}=await tx.query<Bookmark>("SELECT kind,source,target,course,lesson,original_signature FROM study_bookmarks WHERE student=$1 ORDER BY kind,source,target",[actor.id]);
    const items=[];
    for(const row of rows) {
      const key={kind:row.kind,source:row.source,target:row.target};
      try {
        const current=await resolve(tx,actor.id,row);
        const changed=!!row.original_signature && row.original_signature!==current.signature;
        items.push({...key,state:changed?"changed":"available",title:current.title,href:current.href});
      } catch(error) {
        if(![403,404].includes((error as {statusCode:number}).statusCode??0)) throw error;
        items.push({...key,state:"unavailable"});
      }
    }
    const visible=new Map((await savedCommunity(tx,actor.id)).map(post=>[post.id,post]));
    const saves=await tx.query("SELECT post FROM inventory_saves WHERE student=$1 ORDER BY post",[actor.id]);
    for(const {post} of saves.rows) {
      const resource=visible.get(post);
      items.push(resource?{kind:"community",target:post,state:"available",body:resource.body,href:"/api/v1/inventory/community/"+post}:
        {kind:"community",target:post,state:"unavailable"});
    }
    return {items};
  }));
}
