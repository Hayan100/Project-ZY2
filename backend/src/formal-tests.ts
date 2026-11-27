import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type Academic,type sessionTransaction} from "./authorized.ts";
import {quizSchema,validateQuiz,type Quiz} from "./quizzes.ts";

const uuid={type:"string",format:"uuid"},instant={type:"string",format:"date-time"};
const integer=(minimum:number,maximum:number)=>({type:"integer",minimum,maximum});
const label=(maxLength:number)=>({type:"string",maxLength,pattern:"\\S"});
const object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const params=object({id:uuid});
type Id={Params:{id:string}};
type Rules={opens:string;entryCutoff:string;rankedClose:string;scoreRelease:string;rankRelease:string;keyRelease:string;
  mode:"strict"|"grace"|"window";durationMinutes:number;graceMinutes:number;pause:boolean;omrLocked:boolean;
  rankedAttempts:number;correctPoints:number;wrongPoints:number;omitPoints:number;product?:string;offer?:string;batch?:string;fields?:string[];practiceUntil?:string};
const ruleFields={opens:instant,entryCutoff:instant,rankedClose:instant,scoreRelease:instant,rankRelease:instant,keyRelease:instant,
  mode:{enum:["strict","grace","window"]},durationMinutes:integer(1,1440),graceMinutes:integer(0,1440),
  pause:{type:"boolean"},omrLocked:{type:"boolean"},rankedAttempts:integer(1,100),correctPoints:integer(1,100),
  wrongPoints:integer(-100,0),omitPoints:integer(-100,0)};
const rulesSchema=object({...ruleFields,product:label(120),offer:uuid,batch:uuid,practiceUntil:instant,
  fields:{type:"array",items:label(80),uniqueItems:true,maxItems:20}},Object.keys(ruleFields));
export const testEligibility=`(t.rules->>'product' IS NULL OR EXISTS(SELECT FROM enrollments e WHERE e.user_id=$1
  AND e.product_key=t.rules->>'product' AND e.revoked_at IS NULL AND now()>=e.starts_at AND now()<e.ends_at))
  AND (t.rules->>'batch' IS NULL OR EXISTS(SELECT FROM active_planner_batches b WHERE b.user_id=$1
    AND b.batch_id=(t.rules->>'batch')::uuid AND now()>=b.starts_at AND now()<b.ends_at))`;
type Event={id:string;rules:Rules;quiz:Quiz};
async function event(tx:PoolClient,user:string,id:string) {
  return (await tx.query<Event>(`SELECT t.id,t.rules,t.quiz FROM formal_tests t WHERE t.id=$2 AND ${testEligibility}`,[user,id])).rows[0]??fail(404);
}
function initialDeadline(r:Rules,start:number) {
  const duration=r.durationMinutes*60000,open=Date.parse(r.opens);
  const end=r.mode==="strict"?open+duration:r.mode==="grace"?Math.min(start+duration,open+r.graceMinutes*60000+duration):start+duration;
  return Math.min(end,Date.parse(r.rankedClose));
}
type Attempt={id:string;registration:string;ranked:boolean;deadline:Date;hard_close:Date;paused_at:Date|null;submitted_at:Date|null;
  answers:Record<string,string>;version:number;superseded:boolean};
type AttemptTiming=Pick<Attempt,"id"|"ranked"|"deadline"|"hard_close"|"paused_at"|"submitted_at">;
function finished(a:AttemptTiming,now:number) {return !!a.submitted_at || now>=+(a.paused_at?a.hard_close:a.deadline);}
async function owned(tx:PoolClient,user:string,id:string) {
  const row=(await tx.query<Attempt & {event:string}>(`SELECT a.*,r.event FROM formal_attempts a JOIN formal_registrations r ON r.id=a.registration
    WHERE a.id=$1 AND r.student=$2 AND NOT a.superseded FOR UPDATE OF a`,[id,user])).rows[0]??fail(404);
  return {a:row,t:await event(tx,user,row.event)};
}
export function registerFormalTests(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,academic:Academic) {
  const base="/api/v1/tests",staff="/api/v1/staff/tests",attempt="/api/v1/test-attempts/:id";
  app.post<{Body:{id:string;rules:Rules;quiz:Quiz}}>(staff,{bodyLimit:2*1024*1024,schema:{body:object({id:uuid,rules:rulesSchema,quiz:quizSchema})}},
    req=>academic(req,async(tx,author)=>{
      const {id,rules:r,quiz}=req.body;
      validateQuiz(quiz);
      if(!quiz.questions.length || Date.parse(r.opens)>Date.parse(r.entryCutoff) || Date.parse(r.entryCutoff)>Date.parse(r.rankedClose)
        || Math.min(...[r.scoreRelease,r.rankRelease,r.keyRelease].map(Date.parse))<Date.parse(r.rankedClose)
        || Date.parse(r.rankRelease)<Date.parse(r.scoreRelease) || r.practiceUntil && Date.parse(r.practiceUntil)<=Date.parse(r.rankedClose)) fail(422);
      await tx.query("INSERT INTO formal_tests(id,author,rules,quiz) VALUES ($1,$2,$3,$4)",[id,author,r,quiz]);
      return {id};
    }));
  app.get(base,req=>session(req,async(tx,a)=>({tests:(await tx.query(`SELECT t.id,t.quiz->>'title' AS title,t.rules,r.id AS registration
    FROM formal_tests t LEFT JOIN formal_registrations r ON r.event=t.id AND r.student=$1 WHERE ${testEligibility}
    ORDER BY (t.rules->>'opens')::timestamptz,t.id`,[a.id])).rows})));
  type Form={name:string;email:string;phone:string;exam:string;province:string;city:string;preparation:string;
    admissionsConsent:boolean;extra:Record<string,string>};
  const form=object({name:label(200),email:{type:"string",format:"email",maxLength:320},phone:label(40),exam:label(120),
    province:label(120),city:label(120),preparation:label(200),admissionsConsent:{type:"boolean"},
    extra:{type:"object",maxProperties:20,additionalProperties:label(1000)}});
  app.put<Id & {Body:Form}>(base+"/:id/registration",{schema:{params,body:form}},req=>session(req,async(tx,a)=>{
    const t=await event(tx,a.id,req.params.id),f=req.body;
    const existing=(await tx.query("SELECT id,form FROM formal_registrations WHERE student=$1 AND event=$2",[a.id,t.id])).rows[0];
    if(existing) return {id:existing.id,form:existing.form};
    if(Date.now()>Date.parse(t.rules.entryCutoff)) fail(409);
    const fields=t.rules.fields??[];
    if(fields.some(k=>!Object.hasOwn(f.extra,k)) || Object.keys(f.extra).some(k=>!fields.includes(k))) fail(422);
    if(t.rules.offer && !(await tx.query(`SELECT FROM payment_invoices i JOIN payment_receipts p ON p.invoice_id=i.id
      WHERE i.student_id=$1 AND i.offer_id=$2`,[a.id,t.rules.offer])).rowCount) fail(403);
    await tx.query("INSERT INTO formal_registrations(event,student,form) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[t.id,a.id,f]);
    return (await tx.query("SELECT id,form FROM formal_registrations WHERE student=$1 AND event=$2",[a.id,t.id])).rows[0];
  }));
  app.get<Id>(base+"/:id/lobby",{schema:{params}},req=>session(req,async(tx,a)=>{
    const t=await event(tx,a.id,req.params.id);
    const registration=(await tx.query("SELECT id FROM formal_registrations WHERE event=$1 AND student=$2",[t.id,a.id])).rows[0];
    const attempts=(await tx.query("SELECT id,ranked,deadline,submitted_at FROM formal_attempts WHERE registration=$1 AND NOT superseded ORDER BY started_at",[registration?.id])).rows;
    return {id:t.id,title:t.quiz.title,rules:t.rules,registration:registration?.id??null,attempts,serverTime:new Date()};
  }));
  app.post<Id & {Body:{id:string}}>(base+"/:id/attempts",{schema:{params,body:object({id:uuid})}},req=>session(req,async(tx,a)=>{
    const t=await event(tx,a.id,req.params.id),r=t.rules;
    const reg=(await tx.query("SELECT id FROM formal_registrations WHERE event=$1 AND student=$2",[t.id,a.id])).rows[0]??fail(403);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,24))",[reg.id]);
    const prior=(await tx.query<AttemptTiming>("SELECT id,ranked,deadline,hard_close,paused_at,submitted_at FROM formal_attempts WHERE registration=$1 AND NOT superseded",[reg.id])).rows;
    const now=Date.now(),same=prior.find(p=>p.id===req.body.id);
    if(same) return {id:same.id,deadline:same.deadline,ranked:same.ranked};
    const practice=!!r.practiceUntil && now>=Date.parse(r.rankedClose) && now<Date.parse(r.practiceUntil);
    if(prior.some(p=>!finished(p,now)) || now<Date.parse(r.opens) || !practice && now>Date.parse(r.entryCutoff)) fail(409);
    const close=practice?r.practiceUntil!:r.rankedClose;
    const deadline=practice?Math.min(now+r.durationMinutes*60000,Date.parse(close)):initialDeadline(r,now);
    if(deadline<=now) fail(409);
    const ranked=!practice && prior.filter(p=>p.ranked).length<r.rankedAttempts;
    const hardClose=!practice && r.mode==="strict"?new Date(deadline):close;
    return (await tx.query(`INSERT INTO formal_attempts(id,registration,ranked,deadline,hard_close)
      VALUES ($1,$2,$3,$4,$5) RETURNING id,deadline,ranked`,[req.body.id,reg.id,ranked,new Date(deadline),hardClose])).rows[0];
  }));
  app.get<Id>(attempt,{schema:{params}},req=>session(req,async(tx,actor)=>{
    const {a,t}=await owned(tx,actor.id,req.params.id),done=finished(a,Date.now());
    return {id:a.id,version:a.version,deadline:a.deadline,hardClose:a.hard_close,paused:!!a.paused_at,finished:done,
      ...(!done && !a.paused_at?{answers:a.answers,questions:t.quiz.questions.map(({id,stem,options})=>({id,stem,options}))}:{})};
  }));
  const changes={type:"object",maxProperties:200,propertyNames:uuid,additionalProperties:{anyOf:[uuid,{type:"null"}]}};
  app.put<Id & {Body:{version:number;changes:Record<string,string|null>}}>(attempt+"/answers",
    {schema:{params,body:object({version:integer(0,2147483646),changes})}},req=>session(req,async(tx,actor)=>{
      const {a,t}=await owned(tx,actor.id,req.params.id);
      if(a.paused_at || finished(a,Date.now())) fail(409);
      const next={...a.answers},questions=new Map(t.quiz.questions.map(q=>[q.id,q]));
      for(const [id,choice] of Object.entries(req.body.changes)) {
        const q=questions.get(id)??fail(422);
        if(choice!==null && !q.options.some(o=>o.id===choice)) fail(422);
        if(t.rules.omrLocked && a.answers[id] && a.answers[id]!==choice) fail(409);
        if(choice===null) delete next[id]; else next[id]=choice;
      }
      if(Object.keys(req.body.changes).every(k=>next[k]===a.answers[k])) return {version:a.version};
      if(req.body.version!==a.version) fail(409);
      return (await tx.query(`UPDATE formal_attempts SET answers=$2,version=version+1 WHERE id=$1 AND clock_timestamp()<deadline RETURNING version`,
        [a.id,next])).rows[0]??fail(409);
    }));
  app.put<Id & {Body:{paused:boolean}}>(attempt+"/pause",{schema:{params,body:object({paused:{type:"boolean"}})}},req=>session(req,async(tx,actor)=>{
    const {a,t}=await owned(tx,actor.id,req.params.id);
    if(!t.rules.pause || finished(a,Date.now())) fail(409);
    if(req.body.paused!==!!a.paused_at) {
      const updated=await tx.query(req.body.paused
        ?"UPDATE formal_attempts SET paused_at=clock_timestamp() WHERE id=$1 AND clock_timestamp()<deadline RETURNING deadline"
        :"UPDATE formal_attempts SET deadline=least(hard_close,deadline+(clock_timestamp()-paused_at)),paused_at=NULL WHERE id=$1 AND clock_timestamp()<hard_close RETURNING deadline",[a.id]);
      if(!updated.rowCount) fail(409);
      a.deadline=updated.rows[0].deadline;
    }
    return {paused:req.body.paused,deadline:a.deadline};
  }));
  app.post<Id & {Body:{version:number}}>(attempt+"/submit",{schema:{params,body:object({version:integer(0,2147483646)})}},req=>session(req,async(tx,actor)=>{
    const {a}=await owned(tx,actor.id,req.params.id);
    if(a.version!==req.body.version || a.paused_at && !finished(a,Date.now())) fail(409);
    return (await tx.query(`UPDATE formal_attempts SET submitted_at=coalesce(submitted_at,least(clock_timestamp(),
      CASE WHEN paused_at IS NULL THEN deadline ELSE hard_close END)) WHERE id=$1 RETURNING id,submitted_at`,[a.id])).rows[0];
  }));
  app.put<Id & {Body:{id:string;changes:Record<string,string|null>}}>(attempt+"/late-changes",{schema:{params,body:object({id:uuid,changes})}},
    req=>session(req,async(tx,actor)=>{
      const {a}=await owned(tx,actor.id,req.params.id);
      if(!finished(a,Date.now())) fail(409);
      await tx.query("INSERT INTO formal_late_changes VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",[a.id,req.body.id,req.body.changes]);
      return (await tx.query("SELECT id,received_at FROM formal_late_changes WHERE attempt=$1 AND id=$2 AND changes=$3",
        [a.id,req.body.id,req.body.changes])).rows[0]??fail(409);
    }));
  app.get<Id>(staff+"/attempts/:id/late-changes",{schema:{params}},req=>academic(req,async tx=>({changes:
    (await tx.query("SELECT id,changes,received_at FROM formal_late_changes WHERE attempt=$1 ORDER BY received_at",[req.params.id])).rows})));
  app.post<Id & {Body:{replacement:string;deadline:string;reason:string}}>(staff+"/attempts/:id/reset",{schema:{params,
    body:object({replacement:uuid,deadline:instant,reason:label(2000)})}},req=>academic(req,async(tx,reviewer)=>{
    const {replacement,deadline,reason}=req.body;
    const ref=(await tx.query("SELECT registration FROM formal_attempts WHERE id=$1",[req.params.id])).rows[0]??fail(404);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,24))",[ref.registration]);
    const prior=(await tx.query(`SELECT a.*,t.rules FROM formal_attempts a JOIN formal_registrations r ON r.id=a.registration
      JOIN formal_tests t ON t.id=r.event WHERE a.id=$1 FOR UPDATE OF a`,[req.params.id])).rows[0];
    const same=(await tx.query(`SELECT a.id,a.deadline,a.ranked FROM formal_resets s JOIN formal_attempts a ON a.id=s.replacement
      WHERE original=$1 AND replacement=$2 AND reviewer=$3 AND reason=$4 AND a.hard_close=$5`,[prior.id,replacement,reviewer,reason,deadline])).rows[0];
    if(same) return same;
    const now=Date.now(),r=prior.rules as Rules;
    if(prior.superseded || !prior.submitted_at || Date.parse(deadline)<=now) fail(409);
    const active=(await tx.query<AttemptTiming>("SELECT id,ranked,deadline,hard_close,paused_at,submitted_at FROM formal_attempts WHERE registration=$1 AND NOT superseded",[ref.registration])).rows;
    if(active.some(a=>!finished(a,now))) fail(409);
    const ranked=prior.ranked && now<=Date.parse(r.entryCutoff) && now<Date.parse(r.rankedClose);
    const boundary=now<Date.parse(r.rankedClose)?r.rankedClose:r.practiceUntil;
    if(!boundary || Date.parse(deadline)>Date.parse(boundary)) fail(422);
    if(ranked && r.mode==="strict" && Date.parse(deadline)>initialDeadline(r,now)) fail(422);
    // A post-release practice replacement preserves the already released ranked result.
    if(ranked || !prior.ranked) await tx.query("UPDATE formal_attempts SET superseded=true WHERE id=$1",[prior.id]);
    const fresh=(await tx.query(`INSERT INTO formal_attempts(id,registration,ranked,deadline,hard_close) VALUES ($1,$2,$3,$4,$4)
      RETURNING id,deadline,ranked`,[replacement,ref.registration,ranked,deadline])).rows[0];
    await tx.query("INSERT INTO formal_resets(original,replacement,reviewer,reason) VALUES ($1,$2,$3,$4)",[prior.id,replacement,reviewer,reason]);
    return fresh;
  }));
  app.get<Id>(base+"/:id/results",{schema:{params}},req=>session(req,async(tx,actor)=>{
    const t=(await tx.query<Event & {eligible:boolean}>(`SELECT t.id,t.rules,t.quiz,(${testEligibility}) AS eligible FROM formal_tests t
      WHERE t.id=$2 AND EXISTS(SELECT FROM formal_registrations r WHERE r.event=t.id AND r.student=$1)`,[actor.id,req.params.id])).rows[0]??fail(403);
    const now=Date.now();
    const scores=now<Date.parse(t.rules.scoreRelease)?[]:(await tx.query("SELECT id,correct,incorrect,omitted,score,started_at,finished_at FROM formal_scores WHERE student=$1 AND event=$2 ORDER BY started_at",[actor.id,t.id])).rows;
    const ranks=now<Date.parse(t.rules.rankRelease)?[]:(await tx.query(`WITH best AS (
      SELECT registration,max(score) AS score FROM formal_scores WHERE event=$1 AND ranked GROUP BY registration)
      SELECT dense_rank() OVER(ORDER BY score DESC)::int AS rank,b.registration,r.form->>'name' AS name,b.score FROM best b
      JOIN formal_registrations r ON r.id=b.registration ORDER BY rank,r.id`,[t.id])).rows;
    return {scores,ranks,review:t.eligible && now>=Date.parse(t.rules.keyRelease)?t.quiz.questions:null};
  }));
}
