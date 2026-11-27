import type {FastifyInstance} from "fastify";
import {fail,type sessionTransaction} from "./authorized.ts";
import {loadCourse} from "./learning.ts";
import {libraryBooks} from "./ebooks.ts";
export function registerDiscovery(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,accessible:string) {
  app.get<{Querystring:{q:string}}>("/api/v1/me/search",{schema:{querystring:{type:"object",required:["q"],additionalProperties:false,
    properties:{q:{type:"string",pattern:"\\S",maxLength:120}}}}},req=>session(req,async(tx,a)=>{
    const term=req.query.q.trim().toLowerCase();
    const results:{kind:string;id:string;title:string;href:string}[]=[];
    const add=(kind:string,id:string,title:string,href:string)=>results.push({kind,id,title,href});
    const courses=await tx.query("SELECT c.id "+accessible+" ORDER BY c.id",[a.id]);
    for(const {id} of courses.rows) {
      const c=await loadCourse(tx,accessible,a.id,id);
      const href="/api/v1/courses/"+id;
      if(c.outline.title.toLowerCase().includes(term)) add("course",id,c.outline.title,href);
      for(const lesson of c.lessons) if(!c.lockReason(lesson) && lesson.title.toLowerCase().includes(term))
        add("lesson",lesson.id,lesson.title,href+"/lessons/"+lesson.id+"/workspace");
    }
    for(const b of await libraryBooks(tx,a.id,term)) add("ebook",b.id,b.title,"/api/v1/ebooks/"+b.id);
    const notes=await tx.query(`SELECT id,title FROM personal_notes WHERE student_id=$1 AND strpos(lower(concat_ws(' ',title,subject,topic,body)),$2)>0
      ORDER BY title,id LIMIT 100`,[a.id,term]);
    for(const n of notes.rows) add("note",n.id,n.title,"/api/v1/me/notes/"+n.id+"/history");
    return {results:results.sort((a,b)=>a.title.localeCompare(b.title)||a.id.localeCompare(b.id)).slice(0,100)};
  }));
  app.get("/api/v1/staff/home",req=>session(req,async(tx,a)=>{
    if(!(await tx.query("SELECT FROM staff_members WHERE user_id=$1",[a.id])).rowCount) fail(403);
    const {rows}=await tx.query(`SELECT 'academic_reports' AS queue,'/api/v1/staff/qbank/reports' AS href FROM academic_staff WHERE user_id=$1
      UNION ALL SELECT 'replay_requests','/api/v1/staff/replay-requests' FROM academic_staff WHERE user_id=$1
      UNION ALL SELECT 'payment_reviews','/api/v1/payments/overdue' FROM payment_permissions WHERE staff_id=$1 AND verifier
      UNION ALL SELECT 'refunds','/api/v1/payments/refunds' FROM payment_permissions WHERE staff_id=$1 AND verifier
      UNION ALL SELECT 'onboarding','/api/v1/staff/onboarding/attention' FROM welcome_admins WHERE user_id=$1
      UNION ALL SELECT 'assigned_students','/api/v1/mentor/onboarding' WHERE EXISTS(SELECT FROM active_mentors WHERE mentor_id=$1)
      UNION ALL SELECT 'community_resources','/api/v1/staff/community/resources' FROM community_moderators WHERE user_id=$1
      UNION ALL SELECT 'support','/api/v1/staff/support/tickets' WHERE EXISTS(SELECT FROM support_reviewers WHERE reviewer=$1)
      ORDER BY queue`,[a.id]);
    return {queues:rows};
  }));
}
