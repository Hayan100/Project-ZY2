import assert from "node:assert/strict";
import test from "node:test";
import { receiptDispatcher } from "../src/receipt-provider.ts";
import type { Notice } from "../src/delivery.ts";

test("sends receipt details to each channel and checks WhatsApp delivery by SID", async () => {
  Object.assign(process.env,{
    AUTH_ORIGIN:"https://example.org",TWILIO_ACCOUNT_SID:"AC"+"a".repeat(32),
    TWILIO_AUTH_TOKEN:"test",TWILIO_WHATSAPP_FROM:"+15555550111",TWILIO_RECEIPT_CONTENT_SID:"HX"+"b".repeat(32),
  });
  const sid="SM"+"c".repeat(32);
  const n:Notice={invoice_id:"invoice",part:2,kind:"receipt",channel:"email",destination:"owner@example.org",
    receipt_id:"receipt",product_key:"biology",amount_paisa:12345,verified_at:new Date(),due_at:null,settled:true,provider_id:null};
  const emails:string[][]=[];
  let status="queued";
  const dispatch=receiptDispatcher(async(...mail)=>{emails.push(mail);},async(url,options)=>{
    if(options?.method==="POST"){
      const params=options.body as URLSearchParams;
      assert.equal(params.get("To"),"whatsapp:+15555550122");
      assert.equal(JSON.parse(params.get("ContentVariables")!)["3"],"PKR 123.45");
      return Response.json({sid});
    }
    assert.ok(url.toString().endsWith(sid+".json"));
    return Response.json({status});
  });
  assert.deepEqual(await dispatch(n),{complete:true});
  assert.equal(emails[0][0],"owner@example.org");
  assert.ok(emails[0][2].includes("Payment 2: PKR 123.45"));
  n.channel="whatsapp"; n.destination="+15555550122";
  assert.deepEqual(await dispatch(n),{complete:false,providerId:sid});
  n.provider_id=sid;
  assert.equal((await dispatch(n)).complete,false);
  status="delivered";
  assert.equal((await dispatch(n)).complete,true);
  status="undelivered";
  assert.deepEqual(await dispatch(n),{complete:false,providerId:null});
});
