import { Pool } from "pg";
import { setTimeout as sleep } from "node:timers/promises";
import { mailer } from "./identity.ts";
import { deliverNext, queueReminders } from "./delivery.ts";

import { receiptDispatcher } from "./receipt-provider.ts";

if (!process.env.DELIVERY_DATABASE_URL) throw new Error("Missing DELIVERY_DATABASE_URL");
const db=new Pool({connectionString:process.env.DELIVERY_DATABASE_URL,max:2});
let smtp: ReturnType<typeof mailer> | undefined;
const dispatch=receiptDispatcher((to,subject,text)=>(smtp ??= mailer())(to,subject,text));
let running=true;
for(const signal of ["SIGTERM","SIGINT"]) process.once(signal,()=>{running=false;});
let nextScan=0;
try {
  while(running) {
    if (Date.now()>=nextScan) {
      await queueReminders(db);
      nextScan=Date.now()+60_000;
    }
    if (!await deliverNext(db,dispatch)) await sleep(2000);
  }
} finally {await db.end();}
