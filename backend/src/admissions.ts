import type {FastifyInstance} from "fastify";
import type {PoolClient} from "pg";
import {fail,type sessionTransaction} from "./authorized.ts";
const object=(properties:Record<string,object>)=>({type:"object",properties,required:Object.keys(properties),additionalProperties:false});
const uuid={type:"string",format:"uuid"},label=(maxLength:number)=>({type:"string",pattern:"\\S",maxLength});
type Step={sendAt:string;subject:string;text:string};
const audience=`FROM admissions_consent m JOIN "user" u ON u.id=m.student
  WHERE m.allowed AND u."emailVerified" AND NOT EXISTS(SELECT FROM payment_invoices i
    JOIN payment_offers o ON o.id=i.offer_id JOIN payment_receipts r ON r.invoice_id=i.id
    WHERE i.student_id=m.student AND o.product_key=$1)`;
async function role(tx:PoolClient,id:string,approve=false) {
  if(!(await tx.query("SELECT FROM marketing_staff WHERE staff=$1 AND (NOT $2::boolean OR approver)",[id,approve])).rowCount) fail(403);
}
export function registerAdmissions(app:FastifyInstance,session:ReturnType<typeof sessionTransaction>) {
  const base="/api/v1/staff/admissions-campaigns",params=object({id:uuid});
  app.put<{Body:{allowed:boolean}}>("/api/v1/me/admissions-consent",{schema:{body:object({allowed:{type:"boolean"}})}},
    req=>session(req,async(tx,a)=>{
      await tx.query(`INSERT INTO admissions_consent(student,allowed) VALUES($1,$2) ON CONFLICT(student)
        DO UPDATE SET allowed=excluded.allowed,updated_at=now()`,[a.id,req.body.allowed]);
      return req.body;
    }));
  app.post<{Body:{id:string;product:string;steps:Step[]}}>(base,{schema:{body:object({id:uuid,product:label(120),
    steps:{type:"array",minItems:1,maxItems:20,items:object({sendAt:{type:"string",format:"date-time"},subject:label(200),text:label(8000)})}})}},
    req=>session(req,async(tx,a)=>{
      await role(tx,a.id);
      const b=req.body;
      if(b.steps.some((s,i)=>i>0 && Date.parse(s.sendAt)<=Date.parse(b.steps[i-1].sendAt))) fail(422);
      await tx.query("INSERT INTO admissions_campaigns(id,product,steps,author) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [b.id,b.product,JSON.stringify(b.steps),a.id]);
      return (await tx.query("SELECT id FROM admissions_campaigns WHERE id=$1 AND product=$2 AND steps=$3 AND author=$4",
        [b.id,b.product,JSON.stringify(b.steps),a.id])).rows[0]??fail(409);
    }));
  app.get<{Params:{id:string}}>(base+"/:id/preview",{schema:{params}},req=>session(req,async(tx,a)=>{
    await role(tx,a.id);
    const campaign=(await tx.query("SELECT * FROM admissions_campaigns WHERE id=$1",[req.params.id])).rows[0]??fail(404);
    return {...campaign,eligible:(await tx.query("SELECT count(*)::int AS n "+audience,[campaign.product])).rows[0].n};
  }));
  app.put<{Params:{id:string}}>(base+"/:id/approval",{schema:{params}},req=>session(req,async(tx,a)=>{
    await role(tx,a.id,true);
    await tx.query("UPDATE admissions_campaigns SET approved_by=$2,approved_at=now() WHERE id=$1 AND author<>$2 AND approved_by IS NULL",
      [req.params.id,a.id]);
    return (await tx.query("SELECT id,approved_at FROM admissions_campaigns WHERE id=$1 AND approved_by=$2",[req.params.id,a.id])).rows[0]??fail(409);
  }));
}

// A delivery adapter must honor the stable key on retries after a provider acknowledgement.
export async function sendCampaignStep(tx:PoolClient,campaignId:string,student:string,index:number,
  send:(mail:{key:string;email:string;subject:string;text:string})=>Promise<void>) {
  await tx.query("BEGIN");
  try {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,1))",[student]);
    const c=(await tx.query("SELECT product,steps FROM admissions_campaigns WHERE id=$1 AND approved_by IS NOT NULL",[campaignId])).rows[0];
    const step:Step|undefined=c?.steps[index];
    const to=step && Date.parse(step.sendAt)<=Date.now() && (await tx.query("SELECT u.email "+audience+" AND m.student=$2 FOR SHARE OF m,u",
      [c.product,student])).rows[0];
    if(!to || (index>0 && !(await tx.query("SELECT FROM admissions_deliveries WHERE campaign=$1 AND student=$2 AND step=$3",
      [campaignId,student,index-1])).rowCount)) {await tx.query("COMMIT");return false;}
    const claim=await tx.query("INSERT INTO admissions_deliveries(campaign,student,step) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING step",[campaignId,student,index]);
    if(claim.rowCount) await send({key:`${campaignId}/${student}/${index}`,email:to.email,subject:step.subject,text:step.text});
    await tx.query("COMMIT");
    return !!claim.rowCount;
  } catch(e) {await tx.query("ROLLBACK");throw e;}
}
