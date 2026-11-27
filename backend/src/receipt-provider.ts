import type { Dispatch } from "./delivery.ts";
function setting(name:string) {
  const value=process.env[name];
  if (!value) throw new Error("Missing "+name);
  return value;
}

export function receiptDispatcher(send: (to:string, subject:string, text:string)=>Promise<void>, request:typeof fetch=fetch): Dispatch {
  const origin=new URL(setting("AUTH_ORIGIN")).origin;
  if (!origin.startsWith("https://")) throw new Error("Use an HTTPS receipt origin");
  return async n=>{
    const amount="PKR "+(n.amount_paisa/100).toFixed(2);
    const link=origin+"/api/v1/invoices/"+n.invoice_id;
    const access="Sign in with your student account to view your purchase and access dates.";
    if (n.channel==="email") {
      if (n.kind==="reminder") {
        await send(n.destination!,"Installment reminder",amount+" was due on "+n.due_at!.toISOString()+" for "+n.product_key+". View your invoice: "+link);
      } else {
        await send(n.destination!,"Payment receipt "+n.receipt_id,[
          "Receipt "+n.receipt_id, "Product: "+n.product_key, "Payment "+n.part+": "+amount,
          "Verified: "+n.verified_at!.toISOString(), access,link,
        ].join("\n"));
      }
      return {complete:true};
    }
    const sid=setting("TWILIO_ACCOUNT_SID");
    const token=setting("TWILIO_AUTH_TOKEN");
    const from=setting("TWILIO_WHATSAPP_FROM");
    const template=setting("TWILIO_RECEIPT_CONTENT_SID");
    if (!/^AC[0-9a-f]{32}$/i.test(sid)) throw new Error("Invalid Twilio account SID");
    const api="https://api.twilio.com/2010-04-01/Accounts/"+sid+"/Messages";
    const headers={Authorization:"Basic "+Buffer.from(sid+":"+token).toString("base64")};
    if (n.provider_id) {
      if (!/^(SM|MM)[0-9a-f]{32}$/i.test(n.provider_id)) throw new Error("Invalid message ID");
      const res=await request(api+"/"+n.provider_id+".json",{headers,signal:AbortSignal.timeout(15000)});
      if (!res.ok) throw new Error("WhatsApp status unavailable");
      const {status}=await res.json();
      if (["failed","undelivered","canceled"].includes(status)) return {complete:false,providerId:null};
      return {complete:["delivered","read"].includes(status),providerId:n.provider_id};
    }
    const body=new URLSearchParams({From:"whatsapp:"+from,To:"whatsapp:"+n.destination,ContentSid:template,
      ContentVariables:JSON.stringify({"1":n.receipt_id,"2":n.product_key,"3":amount,"4":String(n.part),"5":link})});
    const res=await request(api+".json",{method:"POST",headers,body,signal:AbortSignal.timeout(15000)});
    if (!res.ok) throw new Error("WhatsApp submission failed");
    const message=await res.json();
    if (!/^(SM|MM)[0-9a-f]{32}$/i.test(message.sid)) throw new Error("Missing WhatsApp message ID");
    return {complete:false,providerId:message.sid};
  };
}
