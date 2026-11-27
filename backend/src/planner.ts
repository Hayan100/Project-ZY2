import { familyStrip } from "./family.ts";
import { welcomeChecklist } from "./welcome.ts";
import { lastReadPage, libraryBooks } from "./ebooks.ts";
import { createHash, randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type Academic, type sessionTransaction } from "./authorized.ts";
import { continueLesson, loadCourse } from "./learning.ts";
import {classEligibility} from "./classrooms.ts";
import {testEligibility} from "./formal-tests.ts";

const zone="Asia/Karachi", dayMs=86400000, minute=60000;
const localDate=(date:Date)=>new Intl.DateTimeFormat("en-CA",{timeZone:zone,year:"numeric",month:"2-digit",day:"2-digit"}).format(date);
const midnight=(day:string)=>new Date(day+"T00:00:00+05:00").getTime();
const uuid={type:"string",format:"uuid"};
const day={type:"string",format:"date"};
const instant={type:"string",format:"date-time",pattern:"(Z|[+-][0-9]{2}:[0-9]{2})$"};
const duration={type:"integer",minimum:1,maximum:1440};
const title={type:"string",maxLength:200,pattern:"\\S"};
const version={type:"integer",minimum:1,maximum:2147483646};
const hash={type:"string",pattern:"^[a-f0-9]{64}$"};
const object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const idParams=object({id:uuid});
const digest=(value:unknown)=>createHash("sha256").update(JSON.stringify(value)).digest("hex");
type Session=ReturnType<typeof sessionTransaction>;
type Slot={starts_at:Date;minutes:number};
type Task=Slot & {id:string;student_id:string;created_by:string;title:string;version:number;fixed:boolean;deadline:Date|null;
  completed_at:Date|null;course_id:string|null;lesson_id:string|null};
type TaskBody={id:string;title:string;startsAt:string;minutes:number;deadline?:string;courseId?:string;lessonId?:string;fixed?:boolean};
const taskProps={id:uuid,title,startsAt:instant,minutes:duration,deadline:instant,courseId:uuid,lessonId:uuid};
const taskRequired=["id","title","startsAt","minutes"];
const dependencies={courseId:["lessonId"],lessonId:["courseId"]};
const eventJoin="FROM current_planner_events e WHERE EXISTS (SELECT FROM active_planner_batches b WHERE b.batch_id=e.batch_id AND b.user_id=$1 AND b.starts_at<=e.starts_at AND e.starts_at<b.ends_at)";
const end=(s:Slot)=>s.starts_at.getTime()+s.minutes*minute;
const overlaps=(s:Slot,t:Slot)=>s.starts_at.getTime()<end(t) && t.starts_at.getTime()<end(s);
function range(date:string,view:string) {
  let start=midnight(date), finish=start+dayMs;
  if(view==="week") {start-=((new Date(date).getUTCDay()+6)%7)*dayMs;finish=start+7*dayMs;}
  if(view==="month") {
    start=midnight(date.slice(0,7)+"-01");
    const next=new Date(Date.UTC(Number(date.slice(0,4)),Number(date.slice(5,7)),1));
    finish=midnight(next.toISOString().slice(0,10));
  }
  return {start:new Date(start),finish:new Date(finish)};
}
async function studentLock(tx:PoolClient,user:string) {
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,11))",[user]);
  const batches=await tx.query("SELECT DISTINCT batch_id FROM active_planner_batches WHERE user_id=$1 ORDER BY batch_id",[user]);
  for(const b of batches.rows) await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,12))",[b.batch_id]);
}
async function mentors(tx:PoolClient,student:string,actor:string,id:string,kind:string,old:Date|null,next:Date|null) {
  await tx.query(`INSERT INTO planner_notices(recipient,actor,item_id,kind,old_start,new_start)
    SELECT mentor_id,$2,$3,$4,$5,$6 FROM active_mentors WHERE student_id=$1`,[student,actor,id,kind,old,next]);
}
async function notice(tx:PoolClient,to:string,actor:string,id:string,kind:string,old:Date|null,next:Date|null) {
  await tx.query("INSERT INTO planner_notices(recipient,actor,item_id,kind,old_start,new_start) VALUES($1,$2,$3,$4,$5,$6)",[to,actor,id,kind,old,next]);
}
async function mentorCheck(tx:PoolClient,student:string,mentor:string) {
  if(!(await tx.query("SELECT FROM active_mentors WHERE student_id=$1 AND mentor_id=$2",[student,mentor])).rowCount) fail(403);
}
async function schedule(tx:PoolClient,user:string) {
  const tasks=(await tx.query<Task>("SELECT * FROM planner_tasks WHERE student_id=$1 ORDER BY starts_at,id",[user])).rows;
  const events=(await tx.query("SELECT e.id,e.revision,e.title,e.kind,e.starts_at,e.minutes,e.batch_id "+eventJoin+" ORDER BY e.starts_at,e.id",[user])).rows;
  return {tasks,events};
}
type Schedule=Awaited<ReturnType<typeof schedule>>;
async function curriculum(tx:PoolClient,user:string,accessible:string) {
  const result=await tx.query("SELECT c.id "+accessible+" ORDER BY c.id",[user]);
  const courses=new Map<string,Awaited<ReturnType<typeof loadCourse>>>();
  for(const {id} of result.rows) courses.set(id,await loadCourse(tx,accessible,user,id));
  return courses;
}
type Courses=Awaited<ReturnType<typeof curriculum>>;
function summary(tasks:Pick<Task,"minutes"|"completed_at">[]) {
  return {total:tasks.length,completed:tasks.filter(t=>t.completed_at).length,plannedMinutes:tasks.reduce((n,t)=>n+t.minutes,0),
    completedMinutes:tasks.reduce((n,t)=>n+(t.completed_at?t.minutes:0),0)};
}
function taskView(t:Task,courses:Courses) {
  const course=t.course_id?courses.get(t.course_id):undefined;
  const lesson=course?.lessons.find(l=>l.id===t.lesson_id);
  const available=!!lesson && !course!.lockReason(lesson);
  return {id:t.id,version:t.version,title:t.course_id && !available?"Study task":t.title,startsAt:t.starts_at,minutes:t.minutes,
    deadline:t.deadline,fixed:t.fixed,completedAt:t.completed_at,source:t.student_id===t.created_by?"personal":"mentor",
    lessonUrl:available?`/api/v1/courses/${t.course_id}/lessons/${t.lesson_id}`:null};
}
function planner(plan:Schedule,courses:Courses,date:string,view:string,now:Date) {
  const {start,finish}=range(date,view);
  const inside=(t:Slot)=>t.starts_at<finish && end(t)>start.getTime();
  const tasks=plan.tasks.filter(inside);
  return {date,view,timeZone:zone,start,end:finish,tasks:tasks.map(t=>taskView(t,courses)),events:plan.events.filter(inside),
    overdue:plan.tasks.filter(t=>!t.completed_at && end(t)<now.getTime()).map(t=>taskView(t,courses)),progress:summary(tasks)};
}
type Profile={mode:"initial"|"catch_up";startDate:string;targetDate:string;targetExam:string;preparation:"starting"|"revising";
  weekdays:number[];startMinute:number;minutesPerDay:number};
const profile=object({mode:{enum:["initial","catch_up"]},startDate:day,targetDate:day,targetExam:title,preparation:{enum:["starting","revising"]},
  weekdays:{type:"array",items:{type:"integer",minimum:1,maximum:7},uniqueItems:true,minItems:1,maxItems:7},
  startMinute:{type:"integer",minimum:0,maximum:1439},minutesPerDay:duration});
type Candidate={taskId:string|null;version:number;courseId:string|null;lessonId:string|null;title:string;minutes:number;deadline:Date;mentor:boolean};
function propose(plan:Schedule,courses:Courses,p:Profile,now:Date) {
  const start=midnight(p.startDate),limit=midnight(p.targetDate)+dayMs;
  if(start<midnight(localDate(now)) || limit<=start || limit-start>366*dayMs || p.startMinute+p.minutesPerDay>1440) fail(400);
  const busy:Slot[]=[...plan.events,...plan.tasks].filter(s=>end(s)>now.getTime()).sort((a,b)=>+a.starts_at-+b.starts_at);
  const candidates:Candidate[]=[];
  const linked=new Set(plan.tasks.map(t=>t.course_id+"/"+t.lesson_id));
  if(p.mode==="catch_up") {
    for(const t of plan.tasks.filter(t=>!t.fixed && !t.completed_at && end(t)<now.getTime())) {
      if(t.course_id && !taskView(t,courses).lessonUrl) continue;
      candidates.push({taskId:t.id,version:t.version,courseId:t.course_id,lessonId:t.lesson_id,title:t.title,minutes:t.minutes,
        deadline:new Date(Math.min(limit,t.deadline?.getTime() ?? limit)),mentor:t.student_id!==t.created_by});
    }
    candidates.sort((a,b)=>Number(b.mentor)-Number(a.mentor) || +a.deadline-+b.deadline);
  } else {
    for(const [courseId,course] of courses) for(const lesson of course.lessons) {
      if(course.outline.exam && course.outline.exam.toLowerCase()!==p.targetExam.trim().toLowerCase()) continue;
      if(course.lockReason(lesson) || course.progress.get(lesson.id)?.completed || linked.has(courseId+"/"+lesson.id) || !lesson.estimatedMinutes) continue;
      candidates.push({taskId:null,version:course.revision,courseId,lessonId:lesson.id,title:lesson.title,
        minutes:lesson.estimatedMinutes,deadline:new Date(limit),mentor:false});
    }
    if(p.preparation==="revising") candidates.sort((a,b)=>{
      const practice=(c:Candidate)=>["mcq_quiz","flashcard_review"].includes(courses.get(c.courseId!)!.lessons.find(l=>l.id===c.lessonId)!.type);
      return Number(practice(b))-Number(practice(a));
    });
  }
  const moves=[],unscheduled=[];
  for(const item of candidates) {
    let placed=false;
    for(let d=start;d<limit && d<+item.deadline;d+=dayMs) {
      const weekday=new Date(d+12*3600000).getUTCDay() || 7;
      if(!p.weekdays.includes(weekday)) continue;
      const window=d+p.startMinute*minute;
      let time=Math.max(window,Math.ceil(now.getTime()/(15*minute))*15*minute);
      for(const slot of busy) {
        if(end(slot)<=time) continue;
        if(+slot.starts_at>=time+item.minutes*minute) break;
        time=end(slot);
      }
      if(time+item.minutes*minute>Math.min(window+p.minutesPerDay*minute,+item.deadline)) continue;
      const slot={starts_at:new Date(time),minutes:item.minutes};
      moves.push({...item,startsAt:slot.starts_at.toISOString()});
      busy.push(slot);busy.sort((a,b)=>+a.starts_at-+b.starts_at);
      placed=true;break;
    }
    if(!placed) unscheduled.push(item);
  }
  return {moves,unscheduled};
}

export function registerPlanner(app:FastifyInstance,session:Session,academic:Academic,accessible:string,
  revisionSummary:(tx:PoolClient,user:string)=>Promise<{dueCount:number;newCount:number}>) {
  const base="/api/v1/me/planner";
  async function createTask(tx:PoolClient,user:string,actor:string,b:TaskBody,preview=false,token?:string) {
    await studentLock(tx,user);
    if(b.courseId) {
      // Mentors can plan a published lesson for the purchased batch's first week before access starts.
      const future=user!==actor && (await tx.query(`SELECT FROM courses c JOIN course_revisions r ON (c.id,c.published_revision)=(r.course_id,r.revision)
        JOIN enrollments e ON e.product_key=c.product_key CROSS JOIN LATERAL jsonb_array_elements(r.outline->'chapters') ch
        CROSS JOIN LATERAL jsonb_array_elements(ch->'lessons') l WHERE c.id=$1 AND e.user_id=$2 AND l->>'id'=$3
        AND e.revoked_at IS NULL AND e.starts_at>now() AND e.starts_at<=$4 AND $4<e.ends_at
        AND coalesce((l->>'releaseAt')::timestamptz,'-infinity')<=$4`,[b.courseId,user,b.lessonId,b.startsAt])).rowCount;
      if(!future) (await loadCourse(tx,accessible,user,b.courseId,true,b.lessonId)).available(b.lessonId!);
    }
    const slot={starts_at:new Date(b.startsAt),minutes:b.minutes};
    if(b.deadline && end(slot)>Date.parse(b.deadline)) fail(422);
    const plan=await schedule(tx,user);
    const conflicts=[...plan.tasks.filter(t=>!t.completed_at),...plan.events].filter(t=>overlaps(t,slot)).map(t=>t.id);
    const stamp=digest([user,actor,b.id,b.title,b.startsAt,b.minutes,b.deadline,b.courseId,b.lessonId,b.fixed,conflicts]);
    if(preview) return {task:b,conflicts,token:stamp};
    if(token!==undefined && token!==stamp) fail(409);
    if(conflicts.length) fail(409);
    await tx.query(`INSERT INTO planner_tasks(id,student_id,created_by,title,starts_at,minutes,deadline,fixed,course_id,lesson_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,[b.id,user,actor,b.title,b.startsAt,b.minutes,b.deadline,b.fixed ?? false,b.courseId,b.lessonId]);
    if(user!==actor) await notice(tx,user,actor,b.id,"mentor_task_published",null,slot.starts_at);
    return {id:b.id,version:1};
  }
  app.post<{Body:TaskBody}>(base+"/tasks",{schema:{body:{...object(taskProps,taskRequired),dependencies}}},req=>
    session(req,(tx,actor)=>createTask(tx,actor.id,actor.id,req.body)));
  const mentorPath="/api/v1/mentor/students/:studentId/planner/tasks";
  for(const action of ["preview","publish"] as const) {
    app.post<{Params:{studentId:string};Body:TaskBody & {token?:string}}>(mentorPath+"/"+action,{schema:{
      params:object({studentId:title}),body:{...object({...taskProps,fixed:{type:"boolean"},token:hash},action==="publish"?[...taskRequired,"token"]:taskRequired),dependencies}
    }},req=>session(req,async(tx,actor)=>{
      await mentorCheck(tx,req.params.studentId,actor.id);
      return createTask(tx,req.params.studentId,actor.id,req.body,action==="preview",req.body.token);
    }));
  }
  app.patch<{Params:{id:string};Body:{version:number;startsAt?:string;completed?:boolean}}>(base+"/tasks/:id",{
    schema:{params:idParams,body:{...object({version,startsAt:instant,completed:{type:"boolean"}},["version"]),minProperties:2}}
  },req=>session(req,async(tx,actor)=>{
    await studentLock(tx,actor.id);
    const plan=await schedule(tx,actor.id);
    const task=plan.tasks.find(t=>t.id===req.params.id) ?? fail(404);
    if(task.version!==req.body.version) fail(409);
    const next=req.body.startsAt?new Date(req.body.startsAt):task.starts_at;
    if(+next!==+task.starts_at) {
      if(task.fixed || task.completed_at) fail(409);
      const slot={starts_at:next,minutes:task.minutes};
      if(task.deadline && end(slot)>+task.deadline) fail(422);
      if([...plan.events,...plan.tasks.filter(t=>t.id!==task.id && !t.completed_at)].some(s=>overlaps(s,slot))) fail(409);
      await mentors(tx,actor.id,actor.id,task.id,"student_rescheduled",task.starts_at,next);
    }
    const result=await tx.query(`UPDATE planner_tasks SET starts_at=$2,completed_at=CASE WHEN $3::boolean IS NULL THEN completed_at
      WHEN $3 THEN coalesce(completed_at,now()) ELSE NULL END,version=version+1 WHERE id=$1 RETURNING id,version`,[task.id,next,req.body.completed]);
    return result.rows[0];
  }));
  app.patch<{Params:{studentId:string;id:string};Body:{version:number;startsAt:string}}>(mentorPath+"/:id",{
    schema:{params:object({studentId:title,id:uuid}),body:object({version,startsAt:instant})}
  },req=>session(req,async(tx,actor)=>{
    const student=req.params.studentId;
    await mentorCheck(tx,student,actor.id);
    await studentLock(tx,student);
    const plan=await schedule(tx,student);
    const task=plan.tasks.find(t=>t.id===req.params.id && t.created_by===actor.id) ?? fail(404);
    if(task.version!==req.body.version || task.completed_at) fail(409);
    const slot={starts_at:new Date(req.body.startsAt),minutes:task.minutes};
    if(task.deadline && end(slot)>+task.deadline) fail(422);
    if([...plan.events,...plan.tasks.filter(t=>t.id!==task.id && !t.completed_at)].some(s=>overlaps(s,slot))) fail(409);
    await tx.query("UPDATE planner_tasks SET starts_at=$2,version=version+1 WHERE id=$1",[task.id,slot.starts_at]);
    await notice(tx,student,actor.id,task.id,"mentor_rescheduled",task.starts_at,slot.starts_at);
    return {id:task.id,version:task.version+1};
  }));
  app.get<{Params:{id:string}}>(base+"/events/:id",{schema:{params:idParams}},req=>session(req,async(tx,actor)=>
    (await tx.query("SELECT e.id,e.kind,e.title,e.starts_at,e.minutes,e.revision,e.batch_id "+eventJoin+" AND e.id=$2",
      [actor.id,req.params.id])).rows[0] ?? fail(404)));
  app.post<{Params:{id:string};Body:{startsAt:string}}>(base+"/fixed/:id/change-request",{schema:{params:idParams,body:object({startsAt:instant})}},
    req=>session(req,async(tx,actor)=>{
      const plan=await schedule(tx,actor.id), next=new Date(req.body.startsAt);
      const task=plan.tasks.find(t=>t.id===req.params.id && t.fixed);
      if(task) await notice(tx,task.created_by,actor.id,task.id,"fixed_change_requested",task.starts_at,next);
      else {
        const event=plan.events.find(e=>e.id===req.params.id) ?? fail(404);
        const author=(await tx.query("SELECT published_by FROM current_planner_events WHERE id=$1",[event.id])).rows[0];
        await notice(tx,author.published_by,actor.id,event.id,"fixed_change_requested",event.starts_at,next);
      }
      return {requested:true};
    }));
  app.get("/api/v1/me/planner-notices",req=>session(req,async(tx,actor)=>({notices:(await tx.query(
    "SELECT item_id,actor,kind,old_start,new_start,created_at FROM planner_notices WHERE recipient=$1 ORDER BY created_at DESC,id DESC LIMIT 100",[actor.id])).rows})));
  type Calendar={batchId:string;kind:string;title:string;startsAt:string;minutes:number;revision:number;token?:string};
  const eventFields={batchId:uuid,kind:{enum:["class","chapter_test","mock","revision"]},title,startsAt:instant,minutes:duration,revision:{...version,minimum:0}};
  for(const action of ["preview","publish"] as const) {
    app.post<{Params:{id:string};Body:Calendar}>("/api/v1/staff/planner/events/:id/"+action,{schema:{params:idParams,
      body:action==="preview"?object(eventFields):object({...eventFields,token:hash})}},req=>academic(req,async(tx,actor)=>{
      const b=req.body,id=req.params.id;
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,12))",[b.batchId]);
      if(!(await tx.query("SELECT FROM admission_batches WHERE id=$1",[b.batchId])).rowCount) fail(404);
      const previous=(await tx.query("SELECT * FROM current_planner_events WHERE id=$1",[id])).rows[0];
      if((previous?.revision ?? 0)!==b.revision || (previous && previous.batch_id!==b.batchId)) fail(409);
      const recipients=(await tx.query("SELECT DISTINCT user_id FROM active_planner_batches WHERE batch_id=$1 AND (($2>=starts_at AND $2<ends_at) OR ($3>=starts_at AND $3<ends_at)) ORDER BY user_id",[b.batchId,b.startsAt,previous?.starts_at])).rows.map(r=>r.user_id);
      const times=[b.startsAt,new Date(Date.parse(b.startsAt)+b.minutes*minute)];
      const collisions=(await tx.query(`SELECT id FROM current_planner_events WHERE batch_id=$3 AND id<>$4
        AND starts_at<$2 AND starts_at+minutes*interval '1 minute'>$1 ORDER BY id`,[...times,b.batchId,id])).rows.map(r=>r.id);
      const affected=(await tx.query(`SELECT id,version FROM planner_tasks WHERE student_id=ANY($3::text[]) AND completed_at IS NULL
        AND starts_at<$2 AND starts_at+minutes*interval '1 minute'>$1 ORDER BY id`,[...times,recipients])).rows;
      const stamp=digest([id,b.batchId,b.kind,b.title,b.startsAt,b.minutes,b.revision,recipients,collisions,affected]);
      if(action==="preview") return {token:stamp,batchId:b.batchId,students:recipients.length,overlappingEvents:collisions,conflictingTasks:affected.length};
      if(stamp!==b.token) fail(409);
      await tx.query(`INSERT INTO planner_events(id,revision,batch_id,kind,title,starts_at,minutes,published_by)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,[id,b.revision+1,b.batchId,b.kind,b.title,b.startsAt,b.minutes,actor]);
      await tx.query(`INSERT INTO planner_notices(recipient,actor,item_id,kind,old_start,new_start)
        SELECT recipient,$2,$3,'calendar_published',$4,$5 FROM (SELECT unnest($1::text[]) AS recipient UNION
        SELECT mentor_id FROM active_mentors WHERE student_id=ANY($1::text[])) audience`,
        [recipients,actor,id,previous?.starts_at,b.startsAt]);
      return {id,revision:b.revision+1};
    }));
  }
  for(const action of ["preview","accept"] as const) {
    app.post<{Body:{profile:Profile;token?:string}}>(base+"/suggestions/"+action,{schema:{
      body:action==="preview"?object({profile}):object({profile,token:hash})}},req=>session(req,async(tx,actor)=>{
      await studentLock(tx,actor.id);
      const {profile:p,token}=req.body;
      if(token && (await tx.query("SELECT FROM accepted_plans WHERE student_id=$1 AND token=$2",[actor.id,token])).rowCount) return {accepted:true,token};
      const plan=await schedule(tx,actor.id), courses=await curriculum(tx,actor.id,accessible);
      const result=propose(plan,courses,p,new Date());
      const stamp=digest([actor.id,p.mode,p.startDate,p.targetDate,p.targetExam,p.preparation,[...p.weekdays].sort(),p.startMinute,p.minutesPerDay,result]);
      if(action==="preview") return {...result,token:stamp};
      if(stamp!==token) fail(409);
      for(const m of result.moves) {
        if(m.taskId) {
          const old=plan.tasks.find(t=>t.id===m.taskId)!;
          await tx.query("UPDATE planner_tasks SET starts_at=$2,version=version+1 WHERE id=$1",[m.taskId,m.startsAt]);
          await mentors(tx,actor.id,actor.id,m.taskId,"student_rescheduled",old.starts_at,new Date(m.startsAt));
        } else {
          await tx.query(`INSERT INTO planner_tasks(id,student_id,created_by,title,starts_at,minutes,deadline,fixed,course_id,lesson_id)
            VALUES($1,$2,$2,$3,$4,$5,$6,false,$7,$8)`,[randomUUID(),actor.id,m.title,m.startsAt,m.minutes,m.deadline,m.courseId,m.lessonId]);
        }
      }
      await tx.query("INSERT INTO accepted_plans(student_id,token,profile) VALUES($1,$2,$3)",[actor.id,stamp,p]);
      return {accepted:true,token};
    }));
  }
  const views={enum:["today","week","month","progress"]};
  app.get("/api/v1/me/exports/planner",(req,reply)=>session(req,async(tx,actor)=>{
    const {tasks,events}=await schedule(tx,actor.id);
    const courses=await curriculum(tx,actor.id,accessible);
    reply.header("Content-Disposition",'attachment; filename="Project-ZY2-planner.json"');
    return {timeZone:zone,tasks:tasks.map(t=>taskView(t,courses)),events};
  }));
  type Period={date?:string;view?:"today"|"week"|"month"|"progress";download?:boolean};
  app.get<{Querystring:Period}>(base,{schema:{querystring:object({date:day,view:views,download:{type:"boolean"}},[])}},(req,reply)=>
    session(req,async(tx,actor)=>{
      const now=new Date(), date=req.query.date ?? localDate(now);
      if(req.query.download) reply.header("Content-Disposition",'attachment; filename="Project-ZY2-planner.json"');
      const actions={addTask:base+"/tasks",catchUpPreview:base+"/suggestions/preview"};
      if(req.query.view==="progress") {
        const {start,finish}=range(date,"week");
        const {rows:tasks}=await tx.query<Pick<Task,"starts_at"|"minutes"|"completed_at">>(`SELECT starts_at,minutes,completed_at FROM planner_tasks
          WHERE student_id=$1 AND starts_at >= $2 AND starts_at < $3`,[actor.id,start,finish]);
        const days=Array.from({length:7},(_,i)=>{
          const dayStart=start.getTime()+i*dayMs;
          return {date:localDate(new Date(dayStart)),...summary(tasks.filter(task=>
            task.starts_at.getTime()>=dayStart && task.starts_at.getTime()<dayStart+dayMs))};
        });
        return {date,view:"progress",timeZone:zone,start,end:finish,progress:summary(tasks),days,actions};
      }
      const plan=await schedule(tx,actor.id);
      return {...planner(plan,await curriculum(tx,actor.id,accessible),date,req.query.view ?? "today",now),actions};
    }));
  app.get("/api/v1/me/camp",req=>session(req,async(tx,actor)=>{
    const now=new Date(), user=actor.id, plan=await schedule(tx,user),courses=await curriculum(tx,user,accessible);
    const today=planner(plan,courses,localDate(now),"today",now);
    const upcoming=plan.events.filter(e=>end(e)>+now && e.kind!=="revision").slice(0,5);
    const {rows:sessions}=await tx.query(`SELECT *, opens<=now() AS "windowOpen" FROM (
      SELECT 'class' AS kind,c.id,c.title,c.opens,c.closes FROM classes c
      WHERE c.closes>now() AND ${classEligibility}
      UNION ALL
      SELECT 'test',t.id,t.quiz->>'title',(t.rules->>'opens')::timestamptz,(t.rules->>'rankedClose')::timestamptz
      FROM formal_registrations r JOIN formal_tests t ON t.id=r.event
      WHERE r.student=$1 AND (t.rules->>'rankedClose')::timestamptz>now() AND ${testEligibility}
    ) scheduled ORDER BY opens,kind,id LIMIT 5`,[user]);
    const scheduledSessions=sessions.map(row=>{
      const action=row.kind==="test"?{method:"GET",url:`/api/v1/tests/${row.id}/lobby`}:
        row.windowOpen?{method:"POST",url:`/api/v1/classes/${row.id}/join`}:null;
      return {...row,action};
    });
    const nextTask=plan.tasks.find(t=>!t.completed_at && end(t)>=+now);
    const quickStarts=Array.from(courses,([courseId,course])=>{
      const l=continueLesson(course);
      return l?{courseId,lessonId:l.id,title:l.title,url:`/api/v1/courses/${courseId}/lessons/${l.id}`,last:course.progress.get(l.id)?.updated_at.getTime() ?? 0}:null;
    }).filter(s=>s!==null).sort((a,b)=>b.last-a.last);
    const books=await libraryBooks(tx,user);
    const allowed=new Map(books.map(b=>[b.id,{url:"/api/v1/ebooks/"+b.id}]));
    for(const [courseId,course] of courses) for(const l of course.lessons) if(!course.lockReason(l)) {
      for(const id of [...(l.type==="html_article" && l.resourceId?[l.resourceId]:[]),...(l.relatedResourceIds ?? [])])
        if(!allowed.has(id)) allowed.set(id,{url:`/api/v1/ebooks/${id}?courseId=${courseId}&lessonId=${l.id}`});
    }
    const reading=await lastReadPage(tx,user,[...allowed.keys()]);
    const rev=await revisionSummary(tx,user);
    const onboarding=await welcomeChecklist(tx,user);
    return {familyPresence:await familyStrip(tx,user),onboarding,scheduledSessions,planner:{...today,tasks:today.tasks.slice(0,5),events:today.events.slice(0,5),overdue:today.overdue.slice(0,5),
      overdueCount:today.overdue.length,nextTask:nextTask?taskView(nextTask,courses):null,url:base},upcomingEvents:upcoming.map(e=>({...e,url:base+"/events/"+e.id})),
      continueLesson:quickStarts[0]?{courseId:quickStarts[0].courseId,lessonId:quickStarts[0].lessonId,title:quickStarts[0].title,url:quickStarts[0].url}:null,
      continueReading:reading?{...reading,url:allowed.get(reading.bookId)!.url}:null,
      revision:{due:rev.dueCount,new:rev.newCount,url:"/api/v1/me/revision"}};
  }));
  app.get<{Querystring:{from?:string;to?:string;download?:boolean}}>("/api/v1/me/progress",{
    schema:{querystring:object({from:day,to:day,download:{type:"boolean"}},[])}},(req,reply)=>session(req,async(tx,actor)=>{
      const {from,to,download}=req.query;
      if(from && to && from>to) fail(400);
      const start=from?new Date(midnight(from)):null,finish=to?new Date(midnight(to)+dayMs):null;
      const args=[actor.id,start,finish];
      const results=(await tx.query(`SELECT id,quiz_id AS "quizId",revision,submitted_at AS "submittedAt",correct,incorrect,omitted,total
        FROM lesson_quiz_results WHERE student_id=$1 AND submitted_at>=coalesce($2,'-infinity'::timestamptz)
        AND submitted_at<coalesce($3,'infinity'::timestamptz) ORDER BY submitted_at,id`,args)).rows;
      const usage=(await tx.query(`SELECT count(DISTINCT question_id) FILTER(WHERE option_id IS NOT NULL)::int AS "uniqueAnswered",count(*) FILTER(WHERE correct)::int AS correct,
        count(*) FILTER(WHERE NOT correct)::int AS incorrect,count(*) FILTER(WHERE option_id IS NULL)::int AS omitted
        FROM individual_question_history WHERE student_id=$1 AND recorded_at>=coalesce($2,'-infinity'::timestamptz)
        AND recorded_at<coalesce($3,'infinity'::timestamptz)`,args)).rows[0];
      const revision=(await tx.query(`SELECT to_char(reviewed_at AT TIME ZONE 'Asia/Karachi','YYYY-MM-DD') AS day,rating,count(*)::int AS reviews
        FROM student_reviews WHERE student_id=$1 AND reviewed_at>=coalesce($2,'-infinity'::timestamptz) AND reviewed_at<coalesce($3,'infinity'::timestamptz)
        GROUP BY 1,2 ORDER BY 1,2`,args)).rows;
      const courses=await curriculum(tx,actor.id,accessible);
      const courseCoverage=Array.from(courses,([courseId,c])=>({courseId,title:c.outline.title,total:c.lessons.length,
        completed:c.lessons.filter(l=>c.progress.get(l.id)?.completed).length}));
      const quizIds=new Set<string>();
      for(const c of courses.values()) for(const l of c.lessons) if(!c.lockReason(l)) {
        if(l.type==="mcq_quiz" && l.resourceId) quizIds.add(l.resourceId);
        for(const id of l.relatedResourceIds ?? []) quizIds.add(id);
      }
      const coverage=(await tx.query(`WITH current_quizzes AS (
          SELECT DISTINCT ON(quiz_id) quiz FROM quiz_revisions WHERE published_at IS NOT NULL AND quiz_id=ANY($2::uuid[])
          ORDER BY quiz_id,revision DESC
        ), eligible AS (SELECT DISTINCT (q->>'id')::uuid AS id FROM current_quizzes CROSS JOIN LATERAL jsonb_array_elements(quiz->'questions') q),
        used AS (SELECT DISTINCT question_id FROM individual_question_history WHERE student_id=$1 AND option_id IS NOT NULL)
        SELECT count(*)::int AS eligible,count(u.question_id)::int AS used FROM eligible e LEFT JOIN used u ON u.question_id=e.id`,
        [actor.id,[...quizIds]])).rows[0];
      const activity=(await tx.query(`SELECT count(*)::int AS "visitedPages",count(*) FILTER(WHERE studied)::int AS "studiedPages"
        FROM ebook_reading WHERE user_id=$1`,[actor.id])).rows[0];
      const study=(await schedule(tx,actor.id)).tasks.filter(t=>(!start || t.starts_at>=start) && (!finish || t.starts_at<finish));
      if(download) reply.header("Content-Disposition",'attachment; filename="Project-ZY2-progress.json"');
      return {from:from ?? null,to:to ?? null,timeZone:zone,quiz:{...usage,accuracy:usage.correct+usage.incorrect?usage.correct/(usage.correct+usage.incorrect):null,results},
        revision,studyPlan:summary(study),currentCoverage:{lessonQuizzes:coverage,courses:courseCoverage,reading:activity,library:await libraryBooks(tx,actor.id)}};
    }));
}
