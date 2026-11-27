import type { FastifyInstance } from "fastify";
import type { PoolClient } from "pg";
import { fail, type sessionTransaction } from "./authorized.ts";

const uuid={type:"string",format:"uuid",pattern:"^[0-9a-f-]+$"};
const str=(maxLength:number)=>({type:"string",minLength:1,maxLength,pattern:"\\S"});
const integer=(minimum:number,maximum:number)=>({type:"integer",minimum,maximum});
const version=integer(0,2147483646);
const instant={type:"string",format:"date-time",pattern:"(Z|[+-][0-9]{2}:[0-9]{2})$"};
const obj=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const params=obj({id:uuid});
type CasePath={Params:{id:string}};
type Case={id:string;user_id:string;product_key:string;batch_id:string|null;route:string;starts_at:Date;ends_at:Date;
  mentoring_end:Date;mentor_id:string|null;assignment_version:number;open:boolean;checkin_days:number};
type Question={id:string;prompt:string;required:boolean};
const core:Question[]=[
  ["preparation","Which exam are you preparing for, and what have you studied so far?"],
  ["goals","What would you like to achieve?"],["subjects","Which subjects feel strongest or most difficult?"],
  ["availability","When can you study each week?"],["support","How would you prefer your Ghazi to support and contact you?"]
].map(([id,prompt])=>({id,prompt,required:false}));
const qid={type:"string",pattern:"^[a-z][a-z0-9_-]{0,49}$"};
const question=obj({id:qid,prompt:str(500),required:{type:"boolean"}});
function lock(tx:PoolClient,key:string,ns:number) {
  return tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,$2))",[key,ns]);
}
async function admin(tx:PoolClient,user:string) {
  if(!(await tx.query("SELECT FROM welcome_admins WHERE user_id=$1",[user])).rowCount) fail(403);
}
async function enrollment(tx:PoolClient,id:string,write=false) {
  if(write) await lock(tx,id,13);
  return (await tx.query<Case>(`SELECT *,route='mentored' AND revoked_at IS NULL AND mentoring_end>clock_timestamp() AS open
    FROM welcome_enrollments WHERE id=$1`,[id])).rows[0] ?? fail(404);
}
function owner(c:Case,user:string) {if(c.user_id!==user) fail(404);}
function open(c:Case) {if(!c.open) fail(403);}
function mentor(c:Case,user:string) {open(c);if(c.mentor_id!==user) fail(403);}
async function audit(tx:PoolClient,id:string,user:string,action:string) {
  await tx.query("INSERT INTO ghazi_access_log(enrollment_id,actor,action) VALUES($1,$2,$3)",[id,user,action]);
}
async function template(tx:PoolClient,c:Case) {
  const product="product:"+c.product_key,batch=c.batch_id?"batch:"+c.batch_id:null;
  return (await tx.query(`SELECT scope,revision,questions FROM welcome_templates WHERE scope IN ($1,$2)
    ORDER BY (scope=$1) DESC,revision DESC LIMIT 1`,[batch,product])).rows[0] ?? {scope:"core",revision:1,questions:core};
}
export async function welcomeChecklist(tx:PoolClient,user:string) {
  const rows=(await tx.query(`SELECT e.id,e.product_key AS "productKey",e.starts_at AS "startsAt",e.ends_at AS "endsAt",e.route,
    e.starts_at>now() AS "preStart",e.mentor_id AS "mentorId",e.mentoring_end AS "mentoringEnd",
    EXISTS(SELECT FROM lesson_progress lp JOIN courses x ON x.id=lp.course_id WHERE lp.user_id=e.user_id AND x.product_key=e.product_key) AS "startedLesson",p.student_id IS NOT NULL AS "profileConfirmed",i.submitted_at IS NOT NULL AS "intakeComplete",
    b.mode AS "welcomeMode",EXISTS(SELECT FROM ghazi_followups f WHERE f.enrollment_id=e.id) AS "welcomeCompleted"
    FROM welcome_enrollments e LEFT JOIN welcome_profiles p ON p.student_id=e.user_id LEFT JOIN welcome_intakes i ON i.enrollment_id=e.id
    LEFT JOIN welcome_bookings b ON b.enrollment_id=e.id WHERE e.user_id=$1 AND e.revoked_at IS NULL
    AND (e.ends_at>now() OR (e.route='mentored' AND e.mentoring_end>now())) ORDER BY e.starts_at,e.id`,[user])).rows;
  return rows.map(r=>({...r,entry:r.route==="test_only"?"test_portal":"my_camp",intakeRequiredForAccess:false,
    welcomeUrl:r.route==="mentored"?"/api/v1/onboarding/"+r.id:null}));
}
export function registerWelcome(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,revisionSummary:(tx:PoolClient,user:string)=>Promise<{dueCount:number}>) {
  const staff="/api/v1/staff/onboarding",path="/api/v1/onboarding/:id";
  app.get("/api/v1/me/onboarding",req=>session(req,async(tx,a)=>({enrollments:await welcomeChecklist(tx,a.id)})));
  app.get("/api/v1/me/mentoring/history",req=>session(req,async(tx,a)=>({cases:(await tx.query(`SELECT e.id,e.product_key,e.mentor_id,e.mentoring_end
    FROM welcome_enrollments e WHERE e.user_id=$1 AND e.assignment_version>0 ORDER BY e.starts_at DESC,e.id`,[a.id])).rows})));
  app.put("/api/v1/me/onboarding/profile",req=>session(req,async(tx,a)=>{
    await tx.query("INSERT INTO welcome_profiles(student_id) VALUES($1) ON CONFLICT DO NOTHING",[a.id]);
    return {confirmed:true};
  }));
  app.put<{Params:{product:string};Body:{route:string;checkinDays:number;plannerOverdueCount?:number;revisionDueCount?:number}}>(staff+"/products/:product",{
    schema:{params:obj({product:str(120)}),body:obj({route:{enum:["mentored","self_paced","test_only"]},checkinDays:integer(1,365),plannerOverdueCount:integer(1,10000),revisionDueCount:integer(1,10000)},["route","checkinDays"])}
  },req=>session(req,async(tx,a)=>{
    await admin(tx,a.id);
    await tx.query(`INSERT INTO welcome_products(product_key,route,checkin_days,planner_threshold,revision_threshold) VALUES($1,$2,$3,$4,$5) ON CONFLICT(product_key) DO UPDATE SET route=excluded.route,checkin_days=excluded.checkin_days,planner_threshold=excluded.planner_threshold,revision_threshold=excluded.revision_threshold`,
      [req.params.product,req.body.route,req.body.checkinDays,req.body.plannerOverdueCount,req.body.revisionDueCount]);
    return req.body;
  }));
  app.put<{Body:{scope:string;revision:number;questions:Question[]}}>(staff+"/templates",{schema:{body:obj({
    scope:{type:"string",pattern:"^(batch:|product:).+",maxLength:128},revision:version,questions:{type:"array",maxItems:50,items:question}})}},
    req=>session(req,async(tx,a)=>{
      await admin(tx,a.id);
      const {scope,revision,questions}=req.body;
      const ids=new Set(questions.map(q=>q.id));
      if(ids.size!==questions.length || core.some(q=>!ids.has(q.id))) fail(422);
      await lock(tx,scope,14);
      if((await tx.query("SELECT coalesce(max(revision),0) AS v FROM welcome_templates WHERE scope=$1",[scope])).rows[0].v!==revision) fail(409);
      await tx.query("INSERT INTO welcome_templates VALUES($1,$2,$3,$4)",[scope,revision+1,JSON.stringify(questions),a.id]);
      return {scope,revision:revision+1};
    }));
  app.get<CasePath>(path,{schema:{params}},req=>session(req,async(tx,a)=>{
    const c=await enrollment(tx,req.params.id);owner(c,a.id);
    const ghazi=c.mentor_id?(await tx.query(`SELECT g.user_id,u.name,g.working_hours,g.reply_minutes,d.on_duty,d.last_active FROM ghazis g LEFT JOIN ghazi_duty d ON d.mentor_id=g.user_id JOIN "user" u ON u.id=g.user_id WHERE g.user_id=$1`,[c.mentor_id])).rows[0]:null;
    const intake=(await tx.query("SELECT scope,template_revision AS revision,questions,answers,version,submitted_at FROM welcome_intakes WHERE enrollment_id=$1",[c.id])).rows[0];
    const booking=(await tx.query(`SELECT b.version,b.mode,b.preference,s.starts_at,s.minutes,s.mentor_id FROM welcome_bookings b LEFT JOIN welcome_slots s ON s.id=b.slot_id WHERE b.enrollment_id=$1`,[c.id])).rows[0];
    const summary=(await tx.query("SELECT strengths,priorities,first_week,next_checkin,status,created_at FROM ghazi_followups WHERE enrollment_id=$1 ORDER BY created_at DESC,id LIMIT 1",[c.id])).rows[0];
    const preparation=(await tx.query(`SELECT p.course_id AS "courseId",p.lesson_id AS "lessonId",p.diagnostic FROM welcome_resources p
      JOIN courses x ON x.id=p.course_id AND x.published_revision=p.revision WHERE p.enrollment_id=$1 AND $2::boolean ORDER BY p.lesson_id`,[c.id,c.open])).rows;
    return {enrollmentId:c.id,assignmentVersion:c.assignment_version,preparation,route:c.route,startsAt:c.starts_at,mentoringEnd:c.mentoring_end,mentoringOpen:c.open,ghazi,
      intake:c.route==="mentored"?(intake ?? {...await template(tx,c),answers:[],version:0}):null,booking:booking ?? null,summary:summary ?? null,
      privacy:"Your assigned Ghazi can read this assignment's conversation. Staff with an explicit, time-limited history grant can read the granted conversation. Staff access is logged."};
  }));
  app.put<CasePath & {Body:{version:number;scope:string;revision:number;answers:{id:string;value:string}[];submit:boolean}}>(path+"/intake",{
    schema:{params,body:obj({version,scope:str(128),revision:integer(1,2147483646),submit:{type:"boolean"},
      answers:{type:"array",maxItems:50,items:obj({id:qid,value:str(2000)})}})}},req=>session(req,async(tx,a)=>{
    const c=await enrollment(tx,req.params.id,true);owner(c,a.id);open(c);
    const prior=(await tx.query("SELECT scope,template_revision AS revision,questions,version,submitted_at FROM welcome_intakes WHERE enrollment_id=$1",[c.id])).rows[0];
    const t=prior ?? await template(tx,c), b=req.body;
    if(prior?.submitted_at || (prior?.version ?? 0)!==b.version || t.revision!==b.revision || t.scope!==b.scope) fail(409);
    const questions=t.questions as Question[], keys=new Set(b.answers.map(x=>x.id));
    if(keys.size!==b.answers.length || b.answers.some(x=>!questions.some(q=>q.id===x.id)) || (b.submit && questions.some(q=>q.required && !keys.has(q.id)))) fail(422);
    await tx.query(`INSERT INTO welcome_intakes VALUES($1,$2,$3,$4,$5,$6,CASE WHEN $7 THEN now() END)
      ON CONFLICT(enrollment_id) DO UPDATE SET answers=excluded.answers,version=excluded.version,submitted_at=excluded.submitted_at`,
      [c.id,t.scope,t.revision,JSON.stringify(questions),JSON.stringify(b.answers),b.version+1,b.submit]);
    return {version:b.version+1,submitted:b.submit};
  }));
  app.put<{Body:{onDuty:boolean}}>("/api/v1/mentor/duty",{schema:{body:obj({onDuty:{type:"boolean"}})}},req=>session(req,async(tx,a)=>{
    if(!(await tx.query("SELECT FROM ghazis WHERE user_id=$1",[a.id])).rowCount) fail(403);
    await tx.query("INSERT INTO ghazi_duty VALUES($1,$2,now()) ON CONFLICT(mentor_id) DO UPDATE SET on_duty=excluded.on_duty,last_active=now()",[a.id,req.body.onDuty]);
    return {onDuty:req.body.onDuty};
  }));
  app.get(staff+"/attention",req=>session(req,async(tx,a)=>{
    await admin(tx,a.id);
    return {awaitingReply:(await tx.query("SELECT * FROM ghazi_waits WHERE overdue ORDER BY since,id")).rows,
      slotRequests:(await tx.query(`SELECT b.enrollment_id,e.user_id,e.mentor_id,b.preference,b.version FROM welcome_bookings b
        JOIN welcome_enrollments e ON e.id=b.enrollment_id WHERE b.mode='request_time' AND e.revoked_at IS NULL AND e.mentoring_end>now() ORDER BY b.updated_at`)).rows};
  }));
  app.put<CasePath & {Body:{supervisorId:string;until:string}}>(staff+"/cases/:id/supervision",{schema:{params,body:obj({supervisorId:str(200),until:instant})}},
    req=>session(req,async(tx,a)=>{
      await admin(tx,a.id);const c=await enrollment(tx,req.params.id,true);open(c);
      const b=req.body;
      if(b.supervisorId===a.id || !(await tx.query("SELECT FROM staff_members WHERE user_id=$1",[b.supervisorId])).rowCount) fail(422);
      await tx.query(`INSERT INTO ghazi_supervision VALUES($1,$2,$3,$4) ON CONFLICT(enrollment_id,supervisor_id)
        DO UPDATE SET until_at=excluded.until_at,granted_by=excluded.granted_by`,[c.id,b.supervisorId,b.until,a.id]);
      await audit(tx,c.id,a.id,"supervision:"+b.supervisorId+":"+b.until);
      return {until:b.until};
    }));
  const mentorParams=obj({mentorId:str(200)});
  type Profile={priority:number;capacity:number;available:boolean;experience:string;workingHours:string;replyMinutes:number};
  app.put<{Params:{mentorId:string};Body:Profile}>(staff+"/ghazis/:mentorId",{schema:{params:mentorParams,body:obj({
    priority:integer(1,100000),capacity:integer(1,100),available:{type:"boolean"},experience:str(2000),workingHours:str(300),replyMinutes:integer(1,10080)})}},
    req=>session(req,async(tx,a)=>{
      await admin(tx,a.id);
      const b=req.body,id=req.params.mentorId;
      if(!(await tx.query("SELECT FROM staff_members WHERE user_id=$1",[id])).rowCount) fail(404);
      await tx.query(`INSERT INTO ghazis VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET
        priority=excluded.priority,capacity=excluded.capacity,available=excluded.available,experience=excluded.experience,
        working_hours=excluded.working_hours,reply_minutes=excluded.reply_minutes`,[id,b.priority,b.capacity,b.available,b.experience,b.workingHours,b.replyMinutes]);
      return {mentorId:id};
    }));
  const roster=`SELECT g.user_id AS id,u.name,g.priority,g.capacity,g.available,g.experience,
    (SELECT count(*)::int FROM ghazi_followups f WHERE f.author=g.user_id) AS recorded_checkins,
    (SELECT count(DISTINCT e.user_id)::int FROM welcome_enrollments e WHERE e.mentor_id=g.user_id AND e.route='mentored' AND e.revoked_at IS NULL AND e.mentoring_end>now()) AS caseload
    FROM ghazis g JOIN "user" u ON u.id=g.user_id`;
  app.get(staff+"/allocation",req=>session(req,async(tx,a)=>{
    await admin(tx,a.id);
    const ghazis=(await tx.query(roster+" ORDER BY g.priority,caseload DESC,g.user_id")).rows;
    const students=(await tx.query(`SELECT id,user_id,product_key,starts_at,mentor_id,assignment_version FROM welcome_enrollments
      WHERE route='mentored' AND revoked_at IS NULL AND mentoring_end>now() ORDER BY starts_at,id`)).rows;
    return {students,ghazis,suggestedMentorId:ghazis.find(g=>g.available && g.caseload<g.capacity)?.id ?? null};
  }));
  app.put<CasePath & {Body:{version:number;mentorId:string;overrideReason?:string}}>(staff+"/cases/:id/assignment",{schema:{params,
    body:obj({version,mentorId:str(200),overrideReason:str(500)},["version","mentorId"])}},req=>session(req,async(tx,a)=>{
    await admin(tx,a.id);
    const c=await enrollment(tx,req.params.id,true);open(c);
    const {version,mentorId,overrideReason}=req.body;
    if(c.assignment_version!==version || c.mentor_id===mentorId || mentorId===c.user_id) fail(409);
    await lock(tx,mentorId,15);
    const g=(await tx.query(roster+" WHERE g.user_id=$1",[mentorId])).rows[0] ?? fail(404);
    const already=(await tx.query("SELECT FROM welcome_enrollments WHERE mentor_id=$1 AND user_id=$2 AND route='mentored' AND revoked_at IS NULL AND mentoring_end>now()",[mentorId,c.user_id])).rowCount;
    const count=g.caseload+(already?0:1);
    if(!g.available || (count>Math.min(6,g.capacity) && !overrideReason)) fail(409);
    await tx.query(`INSERT INTO ghazi_assignments(enrollment_id,version,mentor_id,assigned_by,override_reason) VALUES($1,$2,$3,$4,$5)`,[c.id,version+1,mentorId,a.id,overrideReason]);
    await tx.query(`INSERT INTO revision_mentors(student_id,mentor_id,managed) VALUES($1,$2,true)
      ON CONFLICT(student_id,mentor_id) DO UPDATE SET managed=true`,[c.user_id,mentorId]);
    if(c.mentor_id) {
      await tx.query("UPDATE welcome_bookings SET slot_id=NULL,mode='cancelled',version=version+1,changed_by=$2,updated_at=now() WHERE enrollment_id=$1 AND slot_id IN (SELECT id FROM welcome_slots WHERE starts_at>now())",[c.id,a.id]);
      await tx.query("UPDATE welcome_cover SET until_at=now() WHERE enrollment_id=$1",[c.id]);
    }
    return {version:version+1,mentorId,caseload:count};
  }));
  app.put<CasePath & {Body:{endsAt:string}}>(staff+"/cases/:id/term",{schema:{params,body:obj({endsAt:instant})}},req=>session(req,async(tx,a)=>{
    await admin(tx,a.id);const c=await enrollment(tx,req.params.id,true);
    if(c.route!=="mentored") fail(409);
    await tx.query("INSERT INTO welcome_terms VALUES($1,$2,$3) ON CONFLICT(enrollment_id) DO UPDATE SET ends_at=excluded.ends_at,changed_by=excluded.changed_by",[c.id,req.body.endsAt,a.id]);
    await audit(tx,c.id,a.id,"mentoring_end:"+req.body.endsAt);
    return {endsAt:req.body.endsAt};
  }));
  app.put<CasePath & {Body:{courseId:string;lessonId:string;diagnostic:boolean;selected:boolean}}>(staff+"/cases/:id/preparation",{
    schema:{params,body:obj({courseId:uuid,lessonId:uuid,diagnostic:{type:"boolean"},selected:{type:"boolean"}})}
  },req=>session(req,async(tx,a)=>{
    const c=await enrollment(tx,req.params.id,true);open(c);
    if(c.mentor_id!==a.id) await admin(tx,a.id);
    const b=req.body;
    if(!b.selected) {
      await tx.query("DELETE FROM welcome_resources WHERE enrollment_id=$1 AND course_id=$2 AND lesson_id=$3",[c.id,b.courseId,b.lessonId]);
    } else {
      const result=await tx.query(`SELECT r.revision,l->>'type' AS type FROM courses x JOIN course_revisions r ON (x.id,x.published_revision)=(r.course_id,r.revision)
        CROSS JOIN LATERAL jsonb_array_elements(r.outline->'chapters') ch CROSS JOIN LATERAL jsonb_array_elements(ch->'lessons') l
        WHERE x.id=$1 AND x.product_key=$2 AND l->>'id'=$3`,[b.courseId,c.product_key,b.lessonId]);
      const l=result.rows[0] ?? fail(404);
      if(b.diagnostic && l.type!=="mcq_quiz") fail(422);
      await tx.query(`INSERT INTO welcome_resources VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(enrollment_id,course_id,lesson_id)
        DO UPDATE SET revision=excluded.revision,diagnostic=excluded.diagnostic,selected_by=excluded.selected_by`,[c.id,b.courseId,b.lessonId,l.revision,b.diagnostic,a.id]);
    }
    return {selected:b.selected};
  }));
  async function welcomeMentor(tx:PoolClient,c:Case) {
    return (await tx.query("SELECT mentor_id FROM welcome_cover WHERE enrollment_id=$1 AND until_at>clock_timestamp()",[c.id])).rows[0]?.mentor_id ?? c.mentor_id;
  }
  app.put<CasePath & {Body:{mentorId:string;until:string}}>(staff+"/cases/:id/welcome-cover",{schema:{params,body:obj({mentorId:str(200),until:instant})}},
    req=>session(req,async(tx,a)=>{
      await admin(tx,a.id);const c=await enrollment(tx,req.params.id,true);open(c);
      const end=Date.parse(req.body.until);
      if(!c.mentor_id || end<=Date.now() || end>+c.mentoring_end || !(await tx.query("SELECT FROM ghazis WHERE user_id=$1 AND available",[req.body.mentorId])).rowCount) fail(422);
      await tx.query("INSERT INTO welcome_cover VALUES($1,$2,$3) ON CONFLICT(enrollment_id) DO UPDATE SET mentor_id=excluded.mentor_id,until_at=excluded.until_at",[c.id,req.body.mentorId,req.body.until]);
      await audit(tx,c.id,a.id,"welcome_cover:"+req.body.mentorId);
      return {mentorId:req.body.mentorId,until:req.body.until};
    }));
  app.post<{Body:{id:string;mentorId:string;startsAt:string;minutes?:number;gap?:number}}>("/api/v1/mentoring/slots",{schema:{body:obj({
    id:uuid,mentorId:str(200),startsAt:instant,minutes:integer(5,180),gap:integer(0,60)},["id","mentorId","startsAt"])}},req=>session(req,async(tx,a)=>{
    const b=req.body,minutes=b.minutes ?? 20,gap=b.gap ?? 5,start=new Date(b.startsAt);
    if(b.mentorId!==a.id || minutes!==20 || gap!==5) await admin(tx,a.id);
    if(!(await tx.query("SELECT FROM ghazis WHERE user_id=$1",[b.mentorId])).rowCount) fail(403);
    await lock(tx,b.mentorId,16);
    if(+start<=Date.now()) fail(422);
    const conflict=await tx.query(`SELECT FROM welcome_slots WHERE mentor_id=$1 AND starts_at<$3 AND starts_at+(minutes+gap)*interval '1 minute'>$2`,
      [b.mentorId,start,new Date(+start+(minutes+gap)*60000)]);
    if(conflict.rowCount) fail(409);
    await tx.query("INSERT INTO welcome_slots VALUES($1,$2,$3,$4,$5)",[b.id,b.mentorId,start,minutes,gap]);
    return {id:b.id,minutes,gap};
  }));
  app.get<CasePath>(path+"/slots",{schema:{params}},req=>session(req,async(tx,a)=>{
    const c=await enrollment(tx,req.params.id);owner(c,a.id);open(c);
    const who=await welcomeMentor(tx,c);
    return {mentorId:who,changeCutoffMinutes:120,slots:(await tx.query(`SELECT s.id,s.starts_at,s.minutes,s.gap FROM welcome_slots s
      WHERE s.mentor_id=$1 AND s.starts_at>clock_timestamp() AND s.starts_at+s.minutes*interval '1 minute'<=$2
      AND NOT EXISTS(SELECT FROM welcome_bookings WHERE slot_id=s.id)
      AND ($1=$3 OR EXISTS(SELECT FROM welcome_cover WHERE enrollment_id=$4 AND until_at>=s.starts_at+s.minutes*interval '1 minute'))
      ORDER BY s.starts_at,s.id`,[who,c.mentoring_end,c.mentor_id,c.id])).rows};
  }));
  type Booking={version:number;mode:string;slotId?:string;preference?:string};
  const modes=["voice","video","scheduled_chat","async_chat","request_time","cancelled"];
  app.put<CasePath & {Body:Booking}>(path+"/booking",{schema:{params,body:obj({version,mode:{enum:modes},slotId:uuid,preference:str(500)},["version","mode"])}},
    req=>session(req,async(tx,a)=>{
      const c=await enrollment(tx,req.params.id,true);open(c);
      const override=a.id!==c.user_id;if(override) await admin(tx,a.id);
      const b=req.body;await lock(tx,c.user_id,17);
      const prior=(await tx.query(`SELECT b.version,s.starts_at FROM welcome_bookings b LEFT JOIN welcome_slots s ON s.id=b.slot_id WHERE enrollment_id=$1`,[c.id])).rows[0];
      if((prior?.version ?? 0)!==b.version) fail(409);
      if(!override && prior?.starts_at && +prior.starts_at-Date.now()<=7200000) fail(409);

      if(["voice","video","scheduled_chat"].includes(b.mode)!==!!b.slotId) fail(400);
      if(b.slotId) {
        const who=await welcomeMentor(tx,c);
        const slot=(await tx.query("SELECT * FROM welcome_slots WHERE id=$1 AND mentor_id=$2",[b.slotId,who])).rows[0] ?? fail(404);
        const finish=new Date(+slot.starts_at+slot.minutes*60000);
        if(+slot.starts_at<=Date.now() || +finish>+c.mentoring_end) fail(409);
        if(who!==c.mentor_id && !(await tx.query("SELECT FROM welcome_cover WHERE enrollment_id=$1 AND until_at>=$2",[c.id,finish])).rowCount) fail(409);
        if((await tx.query(`SELECT FROM welcome_bookings b JOIN welcome_slots s ON s.id=b.slot_id JOIN enrollments e ON e.id=b.enrollment_id
          WHERE e.user_id=$1 AND b.enrollment_id<>$2 AND s.starts_at<$4 AND s.starts_at+s.minutes*interval '1 minute'>$3`,[c.user_id,c.id,slot.starts_at,finish])).rowCount) fail(409);
      }
      await tx.query(`INSERT INTO welcome_bookings(enrollment_id,slot_id,mode,version,preference,changed_by) VALUES($1,$2,$3,$4,$5,$6)
        ON CONFLICT(enrollment_id) DO UPDATE SET slot_id=excluded.slot_id,mode=excluded.mode,version=excluded.version,preference=excluded.preference,
        changed_by=excluded.changed_by,updated_at=now()`,[c.id,b.slotId,b.mode,b.version+1,b.preference,a.id]);
      await audit(tx,c.id,a.id,"booking:"+b.mode+(b.slotId?":"+b.slotId:""));
      return {version:b.version+1,mode:b.mode,slotId:b.slotId ?? null};
    }));
  app.get("/api/v1/mentor/onboarding",req=>session(req,async(tx,a)=>{
    const students=(await tx.query(`SELECT e.id,e.user_id,u.name,e.product_key,e.starts_at,
    (e.mentor_id<>$1) AS welcome_cover,e.checkin_days,e.planner_threshold,e.revision_threshold,f.excused_until,f.created_at AS followed_at,CASE WHEN e.mentor_id=$1 THEN w.since END AS awaiting_reply_since,CASE WHEN e.mentor_id=$1 THEN w.overdue END AS reply_overdue,i.submitted_at AS intake_submitted,b.mode,b.preference,s.starts_at AS appointment,f.status,f.next_checkin,
    coalesce(f.next_checkin,g.assigned_at+e.checkin_days*interval '1 day')<=now() AS checkin_due
    FROM welcome_enrollments e JOIN "user" u ON u.id=e.user_id JOIN current_ghazis g ON g.enrollment_id=e.id
    LEFT JOIN ghazi_waits w ON w.id=e.id LEFT JOIN welcome_intakes i ON i.enrollment_id=e.id LEFT JOIN welcome_bookings b ON b.enrollment_id=e.id LEFT JOIN welcome_slots s ON s.id=b.slot_id
    LEFT JOIN LATERAL (SELECT * FROM ghazi_followups WHERE enrollment_id=e.id AND assignment_version=e.assignment_version ORDER BY created_at DESC,id LIMIT 1) f ON true
    WHERE (e.mentor_id=$1 OR EXISTS(SELECT FROM welcome_cover cv WHERE cv.enrollment_id=e.id AND cv.mentor_id=$1 AND cv.until_at>now())) AND e.revoked_at IS NULL AND e.route='mentored' AND e.mentoring_end>now() ORDER BY reply_overdue DESC NULLS LAST,checkin_due DESC,next_checkin NULLS FIRST,e.id`,[a.id])).rows;
    for(const s of students) {
      s.signals=[];
      if(s.welcome_cover || (s.excused_until && s.excused_until>new Date())) continue;
      if(s.reply_overdue) s.signals.push({kind:"awaiting_reply",since:s.awaiting_reply_since});
      if(s.checkin_due) s.signals.push({kind:"checkin_due",date:s.next_checkin});
      if(s.planner_threshold) {
        const {rows}=await tx.query(`SELECT count(*)::int AS n FROM planner_tasks WHERE student_id=$1 AND completed_at IS NULL
          AND starts_at+minutes*interval '1 minute'<now() AND starts_at+minutes*interval '1 minute'>coalesce($2,'-infinity'::timestamptz)`,
          [s.user_id,s.status==="resolved"?s.followed_at:null]);
        if(rows[0].n>=s.planner_threshold) s.signals.push({kind:"overdue_tasks",count:rows[0].n});
      }
      if(s.revision_threshold && !(s.status==="resolved" && !s.checkin_due)) {
        const {dueCount}=await revisionSummary(tx,s.user_id);
        if(dueCount>=s.revision_threshold) s.signals.push({kind:"due_revision",count:dueCount});
      }
    }
    students.sort((a,b)=>b.signals.length-a.signals.length);
    return {students};
  }));
  app.get<CasePath>("/api/v1/mentor/onboarding/:id",{schema:{params}},req=>session(req,async(tx,a)=>{
    const c=await enrollment(tx,req.params.id,true);open(c);
    const primary=c.mentor_id===a.id;
    const supervisor=!!(await tx.query("SELECT FROM ghazi_supervision WHERE enrollment_id=$1 AND supervisor_id=$2 AND until_at>now()",[c.id,a.id])).rowCount;
    if(!primary && !supervisor && (await welcomeMentor(tx,c))!==a.id) fail(403);
    await audit(tx,c.id,a.id,"read_intake");
    const intake=(await tx.query("SELECT questions,answers,submitted_at FROM welcome_intakes WHERE enrollment_id=$1 AND submitted_at IS NOT NULL",[c.id])).rows[0] ?? null;
    const followups=(primary || supervisor)?(await tx.query("SELECT * FROM ghazi_followups WHERE enrollment_id=$1 AND (assignment_version=$2 OR $3) ORDER BY created_at DESC,id",[c.id,c.assignment_version,supervisor])).rows:[];
    const diagnostics=(await tx.query(`SELECT r.id,r.submitted_at,r.correct,r.incorrect,r.omitted,r.total FROM lesson_quiz_results r
      JOIN quiz_attempts a ON a.id=r.id WHERE a.diagnostic_enrollment_id=$1 ORDER BY r.submitted_at`,[c.id])).rows;
    return {studentId:c.user_id,intake,followups,diagnostics};
  }));
  app.post<CasePath & {Body:{id:string;strengths:string;priorities:string;firstWeek:string;nextCheckin:string;privateNote?:string;excusedUntil?:string;status:string}}>(
    "/api/v1/mentor/onboarding/:id/followups",{schema:{params,body:obj({id:uuid,strengths:str(2000),priorities:str(2000),firstWeek:str(2000),
    nextCheckin:instant,privateNote:str(2000),excusedUntil:instant,status:{enum:["follow_up","resolved","escalated"]}},["id","strengths","priorities","firstWeek","nextCheckin","status"])}},
    req=>session(req,async(tx,a)=>{
      const c=await enrollment(tx,req.params.id,true);mentor(c,a.id);
      const b=req.body;
      await tx.query(`INSERT INTO ghazi_followups(id,enrollment_id,assignment_version,author,strengths,priorities,first_week,next_checkin,private_note,status,excused_until)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,[b.id,c.id,c.assignment_version,a.id,b.strengths,b.priorities,b.firstWeek,b.nextCheckin,b.privateNote ?? "",b.status,b.excusedUntil]);
      await tx.query("INSERT INTO planner_notices(recipient,actor,item_id,kind,new_start) VALUES($1,$2,$3,'mentor_followup',$4)",[c.user_id,a.id,c.id,b.nextCheckin]);
      return {id:b.id,nextCheckin:b.nextCheckin,plannerUrl:"/api/v1/mentor/students/"+encodeURIComponent(c.user_id)+"/planner/tasks/preview"};
    }));
  app.put<CasePath & {Body:{reader:string;assignmentVersion:number;until:string}}>(staff+"/cases/:id/history-grants",{schema:{params,
    body:obj({reader:str(200),assignmentVersion:integer(1,2147483646),until:instant})}},req=>session(req,async(tx,a)=>{
      await admin(tx,a.id);const c=await enrollment(tx,req.params.id,true);open(c);
      const b=req.body;
      if(b.reader===a.id || b.assignmentVersion>c.assignment_version || !(await tx.query("SELECT FROM staff_members WHERE user_id=$1",[b.reader])).rowCount) fail(422);
      await tx.query(`INSERT INTO ghazi_history_grants VALUES($1,$2,$3,$4,$5) ON CONFLICT(enrollment_id,assignment_version,reader)
        DO UPDATE SET until_at=excluded.until_at,granted_by=excluded.granted_by`,[c.id,b.assignmentVersion,b.reader,b.until,a.id]);
      await audit(tx,c.id,a.id,"history_grant:"+b.reader+":"+b.assignmentVersion+":"+b.until);
      return {until:b.until};
    }));
  app.get<CasePath>(path+"/access-log",{schema:{params}},req=>session(req,async(tx,a)=>{
    const c=await enrollment(tx,req.params.id);
    if(c.user_id!==a.id) await admin(tx,a.id);
    return {entries:(await tx.query("SELECT actor,action,occurred_at FROM ghazi_access_log WHERE enrollment_id=$1 ORDER BY occurred_at DESC LIMIT 100",[c.id])).rows};
  }));
  app.get<CasePath>(path+"/messages",{schema:{params}},req=>session(req,async(tx,a)=>{
    const c=await enrollment(tx,req.params.id,true);
    const student=c.user_id===a.id,cover=c.open && a.id!==c.mentor_id && (await welcomeMentor(tx,c))===a.id;
    if(!student) {
      if(!c.open) fail(403);
      if(c.mentor_id!==a.id && !cover && !(await tx.query("SELECT FROM ghazi_history_grants WHERE enrollment_id=$1 AND reader=$2 AND until_at>clock_timestamp()",[c.id,a.id])).rowCount) fail(403);
      await audit(tx,c.id,a.id,"read_chat");
    }
    const messages=(await tx.query(`SELECT m.id,m.author,m.body,m.created_at,m.assignment_version,m.welcome_mentor FROM ghazi_messages m WHERE m.enrollment_id=$1
      AND ($2 OR ($3 AND m.assignment_version=$4 AND m.welcome_mentor IS NULL) OR ($6 AND m.welcome_mentor=$5 AND m.assignment_version=$4) OR EXISTS(SELECT FROM ghazi_history_grants g WHERE g.enrollment_id=m.enrollment_id
      AND g.assignment_version=m.assignment_version AND g.reader=$5 AND g.until_at>clock_timestamp())) ORDER BY m.created_at,m.id`,
      [c.id,student,c.mentor_id===a.id,c.assignment_version,a.id,cover])).rows;
    return {messages,writable:c.open && !!c.mentor_id && (student || c.mentor_id===a.id || cover)};
  }));
  app.post<CasePath & {Body:{id:string;assignmentVersion:number;text:string;welcome?:boolean}}>(path+"/messages",{schema:{params,body:obj({
    id:uuid,assignmentVersion:integer(1,2147483646),text:str(4000),welcome:{type:"boolean"}},["id","assignmentVersion","text"])}},req=>session(req,async(tx,a)=>{
    const c=await enrollment(tx,req.params.id,true);open(c);
    const recipient=req.body.welcome?await welcomeMentor(tx,c):c.mentor_id;
    const segment=recipient===c.mentor_id?null:recipient;
    if(c.user_id!==a.id && recipient!==a.id) fail(403);
    if(!c.mentor_id || req.body.assignmentVersion!==c.assignment_version) fail(409);
    const b=req.body;
    const inserted=await tx.query("INSERT INTO ghazi_messages(id,enrollment_id,assignment_version,author,body,welcome_mentor) VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING",[b.id,c.id,c.assignment_version,a.id,b.text,segment]);
    if(inserted.rowCount) await tx.query("INSERT INTO planner_notices(recipient,actor,item_id,kind) VALUES($1,$2,$3,'mentor_message')",[a.id===c.user_id?recipient:c.user_id,a.id,c.id]);
    else if(!(await tx.query("SELECT FROM ghazi_messages WHERE id=$1 AND enrollment_id=$2 AND assignment_version=$3 AND author=$4 AND body=$5 AND welcome_mentor IS NOT DISTINCT FROM $6",[b.id,c.id,c.assignment_version,a.id,b.text,segment])).rowCount) fail(409);
    return {id:b.id};
  }));
}
