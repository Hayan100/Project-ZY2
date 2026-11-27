import {Pool} from "pg";
import {sendCampaignStep} from "./admissions.ts";

// Run periodically. The adapter must deduplicate the Idempotency-Key before dispatch.
const connectionString=process.env.CAMPAIGN_DATABASE_URL,adapter=process.env.CAMPAIGN_DELIVERY_URL;
if(!connectionString || !adapter) throw new Error("Set CAMPAIGN_DATABASE_URL and CAMPAIGN_DELIVERY_URL");
const db=new Pool({connectionString});
try {
  const pending=await db.query(`SELECT c.id,m.student,step.n::int FROM admissions_campaigns c CROSS JOIN admissions_consent m
    CROSS JOIN LATERAL generate_series(0,jsonb_array_length(c.steps)-1) step(n)
    WHERE c.approved_by IS NOT NULL AND m.allowed AND (c.steps->step.n->>'sendAt')::timestamptz<=now()
    AND NOT EXISTS(SELECT FROM admissions_deliveries d WHERE (d.campaign,d.student,d.step)=(c.id,m.student,step.n))
    AND (step.n=0 OR EXISTS(SELECT FROM admissions_deliveries prev WHERE (prev.campaign,prev.student,prev.step)=(c.id,m.student,step.n-1)))
    AND EXISTS(SELECT FROM "user" u WHERE u.id=m.student AND u."emailVerified")
    AND NOT EXISTS(SELECT FROM payment_invoices i JOIN payment_offers o ON o.id=i.offer_id JOIN payment_receipts r ON r.invoice_id=i.id
      WHERE i.student_id=m.student AND o.product_key=c.product)
    ORDER BY (c.steps->step.n->>'sendAt')::timestamptz,c.id,m.student LIMIT 100`);
  for(const row of pending.rows) {
    const tx=await db.connect();
    try {
      await sendCampaignStep(tx,row.id,row.student,row.n,async mail=>{
        const res=await fetch(adapter,{method:"POST",redirect:"error",signal:AbortSignal.timeout(8000),
          headers:{"Content-Type":"application/json","Idempotency-Key":mail.key,
            ...(process.env.CAMPAIGN_DELIVERY_TOKEN?{Authorization:"Bearer "+process.env.CAMPAIGN_DELIVERY_TOKEN}:{})},body:JSON.stringify(mail)});
        if(!res.ok) throw new Error("Campaign adapter declined delivery");
      });
    } catch {process.exitCode=1;console.error(JSON.stringify({event:"campaign_retry",campaign:row.id,step:row.n}));}
    finally {tx.release();}
  }
} finally {await db.end();}
