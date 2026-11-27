import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type sessionTransaction} from "./authorized.ts";
import type {FastifyRequest} from "fastify";
import type {registerEbooks} from "./ebooks.ts";
import {obj,uuid,label} from "./community.ts";
import {mediaViewer,pdfStamp} from "./media-watermark.ts";
type Policy={graceSeconds:number;shortSeconds:number;longSeconds:number;shortMax:number;longMax:number;holdSeconds:number};
const positive={type:"integer",minimum:1,maximum:2592000};
export async function ebookDelivery(tx:PoolClient,user:string,book:string,page:string,course?:string) {
  const key=(await tx.query(`SELECT coalesce((SELECT product_key FROM courses WHERE id=$2),library_product_key) AS product FROM ebooks WHERE id=$1`,
    [book,course])).rows[0]?.product;
  if(!key) return true;
  const policy=(await tx.query("SELECT * FROM content_policy WHERE product=$1",[key])).rows[0];
  if(!policy) return true;
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,37))",[user+key]);
  if((await tx.query("SELECT FROM content_alerts WHERE student=$1 AND product=$2 AND hold_until>now() AND reviewed_at IS NULL",[user,key])).rowCount) return false;
  const counts=(await tx.query(`SELECT count(DISTINCT resource) FILTER(WHERE delivered_at>=now()-$3::int*interval '1 second')::int AS short,
    count(DISTINCT resource)::int AS long FROM content_deliveries WHERE student=$1 AND product=$2
    AND delivered_at>=now()-$4::int*interval '1 second' AND resource<>$5 AND delivered_at>
      coalesce((SELECT max(reviewed_at) FROM content_alerts WHERE student=$1 AND product=$2),'-infinity'::timestamptz)`,
    [user,key,policy.short_seconds,policy.long_seconds,book+"/"+page])).rows[0];
  if(counts.short>=policy.short_max || counts.long>=policy.long_max) {
    await tx.query(`INSERT INTO content_alerts(student,product,short_count,long_count,hold_until) VALUES ($1,$2,$3,$4,now()+$5::int*interval '1 second')`,
      [user,key,counts.short,counts.long,policy.hold_seconds]);
    return false;
  }
  await tx.query("INSERT INTO content_deliveries(student,product,kind,resource) VALUES ($1,$2,'page',$3)",[user,key,book+"/"+page]);
  return true;
}
export function registerContentAccess(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>,bookFor:ReturnType<typeof registerEbooks>) {
  const staff="/api/v1/staff/content-access";
  function security<T>(req:FastifyRequest,work:(tx:PoolClient,user:string)=>Promise<T>) {
    return session(req,async(tx,a)=>{
      if(!(await tx.query("SELECT FROM content_security_staff WHERE staff=$1",[a.id])).rowCount) fail(403);
      return work(tx,a.id);
    });
  }
  app.put<{Params:{product:string};Body:Policy}>(staff+"/policy/:product",{schema:{params:obj({product:label(120)}),body:obj({
    graceSeconds:positive,shortSeconds:positive,longSeconds:positive,shortMax:positive,longMax:positive,holdSeconds:positive})}},
    req=>security(req,async tx=>{
      const b=req.body;
      if(b.shortSeconds>=b.longSeconds || b.shortMax>b.longMax) fail(422);
      await tx.query(`INSERT INTO content_policy VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(product) DO UPDATE SET
        grace_seconds=excluded.grace_seconds,short_seconds=excluded.short_seconds,long_seconds=excluded.long_seconds,
        short_max=excluded.short_max,long_max=excluded.long_max,hold_seconds=excluded.hold_seconds`,
      [req.params.product,b.graceSeconds,b.shortSeconds,b.longSeconds,b.shortMax,b.longMax,b.holdSeconds]);
      return b;
    }));
  app.get(staff+"/alerts",req=>security(req,async tx=>({alerts:(await tx.query("SELECT * FROM content_alerts WHERE reviewed_at IS NULL ORDER BY flagged_at,id")).rows})));
  app.put<{Params:{id:string};Body:{decision:string}}>(staff+"/alerts/:id",{schema:{params:obj({id:uuid}),body:obj({decision:label(2000)})}},
    req=>security(req,async(tx,a)=>(await tx.query("UPDATE content_alerts SET reviewer=$2,decision=$3,reviewed_at=now() WHERE id=$1 AND reviewed_at IS NULL RETURNING id",
      [req.params.id,a,req.body.decision])).rows[0]??fail(409)));
  app.post<{Body:{book:string;courseId?:string;lessonId?:string}}>("/api/v1/me/offline/ebook",{schema:{body:{...obj({book:uuid,courseId:uuid,lessonId:uuid},["book"]),
    dependencies:{courseId:["lessonId"],lessonId:["courseId"]}}}},req=>session(req,async(tx,a)=>{
    const b=req.body,book=await bookFor(tx,a.id,b.book,b);
    const row=(await tx.query(`SELECT least(now()+p.grace_seconds*interval '1 second',max(e.ends_at)) AS expires
      FROM ebooks b JOIN content_policy p ON p.product=coalesce((SELECT product_key FROM courses WHERE id=$3),b.library_product_key)
      JOIN enrollments e ON e.product_key=p.product AND e.user_id=$1 AND e.revoked_at IS NULL AND e.starts_at<=now() AND now()<e.ends_at
      WHERE b.id=$2 AND NOT EXISTS(SELECT FROM content_alerts x WHERE x.student=$1 AND x.product=p.product AND x.hold_until>now() AND x.reviewed_at IS NULL)
      GROUP BY p.grace_seconds`,[a.id,b.book,b.courseId])).rows[0]??fail(403);
    return {book:b.book,revision:book.revision,session:a.session,expiresAt:row.expires,watermark:pdfStamp(await mediaViewer(tx,a.id))};
  }));
}
