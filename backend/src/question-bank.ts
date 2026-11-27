import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type Academic,type sessionTransaction} from "./authorized.ts";
import {loadCourse} from "./learning.ts";
import type {Question,Quiz} from "./quizzes.ts";

const uuid={type:"string",format:"uuid"},label={type:"string",maxLength:200};
const object=(properties:Record<string,object>,required=Object.keys(properties))=>({type:"object",properties,required,additionalProperties:false});
const filters={exam:label,syllabus:label,subject:label,chapter:label,topic:label,difficulty:label,
  bank:{enum:["authored","past_paper"]},pool:{enum:["all","unused","used","correct","incorrect","omitted","marked"]}};
type Filter=Partial<Record<keyof typeof filters,string>>;
type Request={id:string;mode:"tutor"|"timed";count:number;minutes?:number;filter:Filter};
type Item=Question & {quizId:string};
type Attempt={id:string;mode:string;deadline:Date|null;submitted_at:Date|null;questions:Item[];
  answers:Record<string,{choice:string;at:string}>;version:number};
const done=(a:Attempt)=>!!a.submitted_at || !!a.deadline && +a.deadline<=Date.now();
const version={type:"integer",minimum:0,maximum:2147483646};
async function catalog(tx:PoolClient,user:string,accessible:string) {
  const courses=await tx.query("SELECT c.id "+accessible,[user]);
  const ids=new Set<string>();
  for(const course of courses.rows) {
    const state=await loadCourse(tx,accessible,user,course.id);
    for(const l of state.lessons) if(!state.lockReason(l)) {
      if(l.type==="mcq_quiz" && l.resourceId) ids.add(l.resourceId);
      for(const id of l.relatedResourceIds??[]) ids.add(id);
    }
  }
  const {rows}=await tx.query<{quiz_id:string;quiz:Quiz}>(`SELECT DISTINCT ON(quiz_id) quiz_id,quiz FROM quiz_revisions
    WHERE published_at IS NOT NULL AND quiz_id=ANY($1::uuid[]) ORDER BY quiz_id,revision DESC`,[[...ids]]);
  return rows.flatMap(r=>r.quiz.questions.map(q=>({...q,bank:q.bank??"authored",quizId:r.quiz_id})));
}
async function candidates(tx:PoolClient,user:string,accessible:string,filter:Filter) {
  const rows=await catalog(tx,user,accessible);
  const history=await tx.query(`SELECT question_id,
    (array_agg(correct ORDER BY recorded_at DESC,attempt DESC NULLS LAST) FILTER(WHERE correct IS NOT NULL))[1] AS correct,
    (array_agg(option_id IS NULL ORDER BY recorded_at DESC,attempt DESC NULLS LAST))[1] AS omitted FROM individual_question_history
    WHERE student_id=$1 GROUP BY question_id`,[user]);
  const states=new Map(history.rows.map(r=>[r.question_id,r]));
  const marked=new Set((await tx.query("SELECT question FROM marked_questions WHERE student=$1",[user])).rows.map(r=>r.question));
  const {pool,...tags}=filter;
  const unique=new Map<string,Item>();
  for(const q of rows) {
    if(!Object.entries(tags).every(([k,v])=>q[k as keyof Item]===v)) continue;
    const last=states.get(q.id),used=last?.correct!=null;
    if(pool==="unused" && used || pool==="used" && !used || pool==="correct" && last?.correct!==true ||
      pool==="incorrect" && last?.correct!==false || pool==="omitted" && !last?.omitted || pool==="marked" && !marked.has(q.id)) continue;
    if(!unique.has(q.id)) unique.set(q.id,q);
  }
  return {items:[...unique.values()],used:[...unique.keys()].filter(id=>states.get(id)?.correct!=null).length};
}
export function registerQuestionBank(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,accessible:string,academic:Academic) {
  const base="/api/v1/me/qbank",route=base+"/quizzes/:id",params=object({id:uuid});
  const staff="/api/v1/staff/qbank";
  app.get(base+"/mistakes",req=>session(req,async(tx,a)=>{
    const questions=new Map((await catalog(tx,a.id,accessible)).map(q=>[q.id,q]));
    const {rows}=await tx.query(`SELECT h.source,h.attempt,h.question_id,h.recorded_at,h.option_id IS NULL AS omitted,r.body AS reflection,r.version
      FROM individual_question_history h LEFT JOIN LATERAL (SELECT body,version FROM mistake_reflections
        WHERE (student,attempt,question)=(h.student_id,h.attempt,h.question_id) ORDER BY version DESC LIMIT 1) r ON true
      WHERE h.student_id=$1 AND h.correct IS DISTINCT FROM true ORDER BY h.recorded_at DESC,h.question_id`,[a.id]);
    return {mistakes:rows.map(row=>({...row,question:questions.get(row.question_id)?.stem??null}))};
  }));
  app.put<{Params:{attempt:string;question:string};Body:{version:number;body:string}}>(base+"/mistakes/:attempt/:question/reflection",
    {schema:{params:object({attempt:uuid,question:uuid}),body:object({version,body:{type:"string",maxLength:10000}})}},req=>session(req,async(tx,a)=>{
      const args=[a.id,req.params.attempt,req.params.question,req.body.body,req.body.version+1];
      await tx.query(`INSERT INTO mistake_reflections SELECT $1,$2,$3,$4,$5 WHERE EXISTS(SELECT FROM individual_question_history
        WHERE (student_id,attempt,question_id)=($1,$2,$3) AND correct IS DISTINCT FROM true) AND
        $5::int=(SELECT coalesce(max(version),0)+1 FROM mistake_reflections WHERE (student,attempt,question)=($1,$2,$3))
        ON CONFLICT DO NOTHING`,args);
      return (await tx.query("SELECT version FROM mistake_reflections WHERE (student,attempt,question,body,version)=($1,$2,$3,$4,$5)",args)).rows[0]??fail(409);
    }));
  app.get(base+"/reports",req=>session(req,async(tx,a)=>({reports:(await tx.query(`SELECT id,question,detail,at,decision,reply,decided_at
    FROM question_reports WHERE student=$1 ORDER BY at DESC,id`,[a.id])).rows})));
  app.post<{Body:{id:string;question:string;detail:string}}>(base+"/reports",{schema:{body:object({id:uuid,question:uuid,detail:{type:"string",pattern:"\\S",maxLength:2000}})}},
    req=>session(req,async(tx,a)=>{
      const b=req.body;
      if(!(await catalog(tx,a.id,accessible)).some(q=>q.id===b.question)) fail(404);
      const args=[b.id,a.id,b.question,b.detail];
      await tx.query("INSERT INTO question_reports(id,student,question,detail) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",args);
      return (await tx.query("SELECT id FROM question_reports WHERE (id,student,question,detail)=($1,$2,$3,$4)",args)).rows[0]??fail(409);
    }));
  app.get(staff+"/reports",req=>academic(req,async tx=>({reports:(await tx.query("SELECT id,question,detail,at FROM question_reports WHERE decision IS NULL ORDER BY at,id")).rows})));
  app.put<{Params:{id:string};Body:{decision:string;reply:string}}>(staff+"/reports/:id",{schema:{params,body:object({
    decision:{enum:["resolved","declined"]},reply:{type:"string",pattern:"\\S",maxLength:2000}})}},req=>academic(req,async(tx,a)=>{
    const args=[req.params.id,req.body.decision,req.body.reply,a];
    await tx.query("UPDATE question_reports SET decision=$2,reply=$3,reviewer=$4,decided_at=now() WHERE id=$1 AND decision IS NULL AND student<>$4",args);
    return (await tx.query("SELECT id,decision FROM question_reports WHERE (id,decision,reply,reviewer)=($1,$2,$3,$4)",args)).rows[0]??fail(409);
  }));
  type Season={id:string;product:string;exam:string;syllabus:string;begins:string;ends:string;minAnswers:number;minPeers:number};
  const instant={type:"string",format:"date-time"},minimum={type:"integer",minimum:1,maximum:1000000};
  app.post<{Body:Season}>(staff+"/seasons",{schema:{body:object({id:uuid,product:label,exam:label,syllabus:label,begins:instant,ends:instant,
    minAnswers:minimum,minPeers:minimum})}},req=>academic(req,async tx=>{
    const b=req.body;
    if(Date.parse(b.ends)<=Date.parse(b.begins) || !b.exam.trim() || !b.syllabus.trim() || !b.product.trim()) fail(422);
    await tx.query("INSERT INTO comparison_seasons VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [b.id,b.product,b.exam,b.syllabus,b.begins,b.ends,b.minAnswers,b.minPeers]);
    return {id:b.id};
  }));
  const membership=`EXISTS(SELECT FROM enrollments e WHERE e.user_id=$1 AND e.product_key=s.product
    AND e.revoked_at IS NULL AND e.starts_at<=now() AND e.ends_at>now())`;
  app.put<{Body:{id:string;question:string;started:string;ended:string}}>(base+"/activity",{schema:{body:object({
    id:uuid,question:uuid,started:instant,ended:instant})}},req=>session(req,async(tx,a)=>{
    const b=req.body,from=Date.parse(b.started),to=Date.parse(b.ended);
    if(to<=from || to-from>60000 || to>Date.now()) fail(422);
    if(!(await catalog(tx,a.id,accessible)).some(q=>q.id===b.question)) fail(404);
    const args=[a.id,b.id,b.question,b.started,b.ended];
    await tx.query("INSERT INTO question_activity VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING",args);
    return (await tx.query("SELECT id FROM question_activity WHERE (student,id,question,started_at,ended_at)=($1,$2,$3,$4,$5)",args)).rows[0]??fail(409);
  }));
  app.get<{Querystring:{subject?:string;from?:string;to?:string}}>(base+"/performance",{schema:{querystring:object({
    subject:label,from:instant,to:instant},[])}},req=>session(req,async(tx,a)=>{
    const {subject,from,to}=req.query;
    if(from && to && Date.parse(to)<=Date.parse(from)) fail(422);
    const ids=subject?(await catalog(tx,a.id,accessible)).filter(q=>q.subject===subject).map(q=>q.id):null;
    const args=[a.id,from,to,ids];
    const {rows}=await tx.query(`SELECT to_char(recorded_at AT TIME ZONE 'Asia/Karachi','YYYY-MM-DD') AS day,
      count(*) FILTER(WHERE correct)::int AS correct,count(*) FILTER(WHERE NOT correct)::int AS incorrect,
      count(*) FILTER(WHERE option_id IS NULL)::int AS omitted FROM individual_question_history WHERE student_id=$1
      AND recorded_at>=coalesce($2,'-infinity'::timestamptz) AND recorded_at<coalesce($3,'infinity'::timestamptz)
      AND ($4::uuid[] IS NULL OR question_id=ANY($4)) GROUP BY 1 ORDER BY 1`,args);
    const activity=(await tx.query(`SELECT coalesce(sum(extract(epoch FROM upper(segment)-lower(segment))),0)::float AS seconds
      FROM unnest((SELECT range_agg(tstzrange(started_at,ended_at)*tstzrange($2,$3)) FROM question_activity
        WHERE student=$1 AND ($4::uuid[] IS NULL OR question=ANY($4)))) segment`,args)).rows[0];
    return {days:rows,activeSeconds:activity.seconds};
  }));
  app.get(base+"/seasons",req=>session(req,async(tx,a)=>({seasons:(await tx.query(`SELECT s.* FROM comparison_seasons s
    WHERE s.begins<=now() AND now()<s.ends AND ${membership} ORDER BY begins DESC,id`,[a.id])).rows})));
  app.get<{Params:{id:string}}>(base+"/seasons/:id/percentile",{schema:{params}},req=>session(req,async(tx,a)=>{
    const s=(await tx.query(`SELECT * FROM comparison_seasons s WHERE id=$2 AND ${membership}`,[a.id,req.params.id])).rows[0]??fail(404);
    const {rows}=await tx.query(`WITH population AS (
      SELECT h.student_id,avg(h.correct::int) AS accuracy FROM individual_question_history h WHERE h.correct IS NOT NULL
        AND h.recorded_at>=$2 AND h.recorded_at<$3 AND EXISTS(SELECT FROM enrollments e WHERE e.user_id=h.student_id
          AND e.product_key=$4 AND e.revoked_at IS NULL AND e.starts_at<=h.recorded_at AND h.recorded_at<e.ends_at)
        GROUP BY student_id HAVING count(*)>=$5), mine AS (SELECT accuracy FROM population WHERE student_id=$1)
      SELECT count(*)::int AS sample, CASE WHEN count(*)-1>=$6 AND EXISTS(SELECT FROM mine)
        THEN round(100.0*(count(*) FILTER(WHERE accuracy<(SELECT accuracy FROM mine))
          +0.5*(count(*) FILTER(WHERE accuracy=(SELECT accuracy FROM mine))-1))/(count(*)-1),2)::float END AS percentile FROM population`,
      [a.id,s.begins,s.ends,s.product,s.min_answers,s.min_peers]);
    return {exam:s.exam,syllabus:s.syllabus,begins:s.begins,ends:s.ends,repeatInclusive:true,...rows[0]};
  }));
  app.get<{Querystring:Filter}>(base+"/availability",{schema:{querystring:object(filters,[])}},req=>session(req,async(tx,a)=>{
    const {items,used}=await candidates(tx,a.id,accessible,req.query);
    return {available:items.length,used,remaining:items.length-used};
  }));
  app.get(base+"/quizzes",req=>session(req,async(tx,a)=>({quizzes:(await tx.query(`SELECT id,mode,created_at,deadline,submitted_at,version,
    jsonb_array_length(questions) AS total FROM custom_practice WHERE student=$1 ORDER BY created_at DESC,id`,[a.id])).rows})));
  app.post<{Body:Request}>(base+"/quizzes",{schema:{body:object({id:uuid,mode:{enum:["tutor","timed"]},count:{type:"integer",minimum:1,maximum:200},
    minutes:{type:"integer",minimum:1,maximum:1440},filter:object(filters,[])},["id","mode","count","filter"])}},req=>session(req,async(tx,a)=>{
    const b=req.body;
    if((b.mode==="timed")!==!!b.minutes) fail(422);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,25))",[b.id]);
    const prior=(await tx.query("SELECT student,request=$2 AS same FROM custom_practice WHERE id=$1",[b.id,b])).rows[0];
    if(prior) return prior.student===a.id && prior.same?{id:b.id}:fail(409);
    const {items}=await candidates(tx,a.id,accessible,b.filter);
    if(items.length<b.count) fail(422);
    await tx.query(`INSERT INTO custom_practice(id,student,mode,request,questions,deadline)
      VALUES ($1,$2,$3,$4,$5,now()+$6::int*interval '1 minute')`,[b.id,a.id,b.mode,b,JSON.stringify(items.slice(0,b.count)),b.minutes]);
    return {id:b.id};
  }));
  async function attempt(tx:PoolClient,user:string,id:string) {
    const a=(await tx.query<Attempt>("SELECT * FROM custom_practice WHERE student=$1 AND id=$2 FOR UPDATE",[user,id])).rows[0]??fail(404);
    const available=new Set((await catalog(tx,user,accessible)).map(q=>q.quizId+"/"+q.id));
    if(!a.questions.every(q=>available.has(q.quizId+"/"+q.id))) fail(403);
    return a;
  }
  app.get<{Params:{id:string}}>(route,{schema:{params}},req=>session(req,async(tx,user)=>{
    const a=await attempt(tx,user.id,req.params.id),finished=done(a);
    return {id:a.id,mode:a.mode,deadline:a.deadline,finished,version:a.version,questions:a.questions.map(q=>{
      const answer=a.answers[q.id]?.choice??null;
      return {id:q.id,stem:q.stem,options:q.options,answer,...(finished || a.mode==="tutor" && answer?
        {correctOptionId:q.correctOptionId,explanation:q.explanation}: {})};
    })};
  }));
  app.put<{Params:{id:string;question:string};Body:{option:string;version:number}}>(route+"/answers/:question",{
    schema:{params:object({id:uuid,question:uuid}),body:object({option:uuid,version})}
  },req=>session(req,async(tx,user)=>{
    const a=await attempt(tx,user.id,req.params.id),q=a.questions.find(q=>q.id===req.params.question)??fail(404);
    const prior=a.answers[q.id],option=req.body.option;
    if(!q.options.some(o=>o.id===option)) fail(422);
    if(prior?.choice===option) return {version:a.version};
    if(done(a) || a.version!==req.body.version || a.mode==="tutor" && prior) fail(409);
    return (await tx.query(`UPDATE custom_practice SET version=version+1,answers=answers||jsonb_build_object($2::text,
      jsonb_build_object('choice',$3::text,'at',clock_timestamp())) WHERE id=$1 AND (deadline IS NULL OR deadline>clock_timestamp())
      RETURNING version`,[a.id,q.id,option])).rows[0]??fail(409);
  }));
  app.post<{Params:{id:string};Body:{version:number}}>(route+"/submit",{schema:{params,body:object({version})}},
    req=>session(req,async(tx,user)=>{
      const a=await attempt(tx,user.id,req.params.id);
      if(a.version!==req.body.version) fail(409);
      return (await tx.query(`UPDATE custom_practice SET submitted_at=coalesce(submitted_at,least(clock_timestamp(),deadline))
        WHERE id=$1 RETURNING id,submitted_at`,[a.id])).rows[0];
    }));
}
