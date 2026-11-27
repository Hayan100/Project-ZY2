import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type Academic} from "./authorized.ts";
import {label,obj,params,uuid,type Path,type Session} from "./community.ts";
import {courseLessons,loadCourse} from "./learning.ts";
import type {Outline} from "./curriculum.ts";

type Channels = (tx:PoolClient,user:string,id?:string,kind?:string)=>Promise<{id:string}[]>;
type SheetPath = {Params:{course:string;lesson:string;id:string}};

export function registerInventory(app:FastifyInstance,session:Session,academic:Academic,accessible:string,visible:Channels) {
  const root="/api/v1/inventory";
  app.post<{Body:{id:string;title:string;body:string}}>("/api/v1/staff/inventory/sheets",{schema:{
    body:obj({id:uuid,title:label(160),body:label(8000)})
  }},req=>academic(req,async(tx,author)=>{
    const {id,title,body}=req.body;
    const args=[id,title,body,author];
    await tx.query("INSERT INTO academy_sheets(id,title,body,author) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",args);
    return (await tx.query("SELECT id FROM academy_sheets WHERE (id,title,body,author)=($1,$2,$3,$4)",args)).rows[0]??fail(409);
  }));

  app.get<SheetPath>(root+"/courses/:course/lessons/:lesson/sheets/:id",{
    schema:{params:obj({course:uuid,lesson:uuid,id:uuid})}
  },req=>session(req,async(tx,actor)=>{
    const {course,lesson,id}=req.params;
    const source=await loadCourse(tx,accessible,actor.id,course);
    if (!source.available(lesson).relatedResourceIds?.includes(id)) fail(404);
    return (await tx.query("SELECT id,title,body FROM academy_sheets WHERE id=$1",[id])).rows[0]??fail(404);
  }));

  const publishedPosts=`FROM community_posts p JOIN published_resource_posts r ON r.id=p.id
    WHERE p.space=ANY($2::uuid[]) AND NOT EXISTS (SELECT FROM community_blocks b
      WHERE (b.actor,b.peer) IN (($1,p.author),(p.author,$1)))`;
  app.get<Path>(root+"/community/:id",{schema:{params}},req=>session(req,async(tx,actor)=>{
    const posts=await savedCommunity(tx,actor.id,req.params.id);
    return posts[0]??fail(404);
  }));
  app.put<Path & {Body:{saved:boolean}}>(root+"/community/:id",{schema:{params,body:obj({saved:{type:"boolean"}})}},
    req=>session(req,async(tx,actor)=>{
      const {id}=req.params;
      if(req.body.saved) {
        const space=(await tx.query("SELECT space FROM community_posts WHERE id=$1",[id])).rows[0]?.space;
        if(!space) fail(404);
        const channels=await visible(tx,actor.id,space,"resources");
        if (!(await tx.query(`SELECT p.id ${publishedPosts} AND p.id=$3`,[actor.id,channels.map(c=>c.id),id])).rowCount) fail(404);
        await tx.query("INSERT INTO inventory_saves(student,post) VALUES($1,$2) ON CONFLICT DO NOTHING",[actor.id,id]);
      } else await tx.query("DELETE FROM inventory_saves WHERE student=$1 AND post=$2",[actor.id,id]);
      return {id,saved:req.body.saved};
    }));

  app.get(root,req=>session(req,async(tx,actor)=>{
    const courses=await tx.query<{id:string;outline:Outline;now:Date}>(`SELECT c.id,r.outline,now() AS now ${accessible} ORDER BY c.id`,[actor.id]);
    const progress=await tx.query("SELECT course_id,lesson_id,lesson_type,resource_id,completed FROM lesson_progress WHERE user_id=$1",[actor.id]);
    const sources=new Map<string,{course:string;lesson:string}>();
    for(const course of courses.rows) {
      const state=courseLessons(course.outline,course.now,progress.rows.filter(p=>p.course_id===course.id));
      for(const lesson of state.lessons) {
        if(state.lockReason(lesson)) continue;
        for(const id of lesson.relatedResourceIds??[]) if(!sources.has(id)) sources.set(id,{course:course.id,lesson:lesson.id});
      }
    }
    const sheets=await tx.query("SELECT id,title FROM academy_sheets WHERE id=ANY($1::uuid[]) ORDER BY title,id",[[...sources.keys()]]);
    const academy=sheets.rows.map(sheet=>{
      const source=sources.get(sheet.id)!;
      return {...sheet,...source,href:root+"/courses/"+source.course+"/lessons/"+source.lesson+"/sheets/"+sheet.id};
    });
    const community=await savedCommunity(tx,actor.id);
    return {academy,community};
  }));
  async function savedCommunity(tx:PoolClient,user:string,id?:string) {
    let channels:{id:string}[];
    try {channels=await visible(tx,user,undefined,"resources");}
    catch(error) {
      if((error as {statusCode?:number}).statusCode!==403) throw error;
      channels=[];
    }
    return (await tx.query(`SELECT p.id,p.space,p.body ${publishedPosts}
      AND EXISTS(SELECT FROM inventory_saves WHERE student=$1 AND post=p.id)
      AND ($3::uuid IS NULL OR p.id=$3) ORDER BY p.created DESC,p.id`,
      [user,channels.map(c=>c.id),id])).rows;
  }
  return savedCommunity;
}
