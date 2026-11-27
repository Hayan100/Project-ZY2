import type { Pool } from "pg";

export type Notice = {
  invoice_id: string; part: number; kind: "receipt" | "reminder"; channel: "email" | "whatsapp";
  destination: string | null; receipt_id: string | null; product_key: string; amount_paisa: number;
  verified_at: Date | null; due_at: Date | null; settled: boolean; provider_id: string | null;
};
export type Dispatch = (notice: Notice) => Promise<{ complete: boolean; providerId?: string | null }>;

export async function queueReminders(db: Pool) {
  await db.query(`INSERT INTO payment_messages(invoice_id,part,kind,channel)
    SELECT id,paid_parts+1,'reminder','email' FROM installment_balance WHERE next_due<=now()
    ON CONFLICT DO NOTHING`);
}

export async function deliverNext(db: Pool, dispatch: Dispatch) {
  const tx=await db.connect();
  try {
    await tx.query("BEGIN");
    const {rows}=await tx.query<Notice>(`SELECT p.* FROM payment_messages m
      JOIN payment_message_payload p USING(invoice_id,part,kind,channel)
      WHERE m.accepted_at IS NULL AND m.next_attempt<=now() ORDER BY m.next_attempt
      LIMIT 1 FOR UPDATE OF m SKIP LOCKED`);
    const notice=rows[0];
    if (notice) {
      const key=[notice.invoice_id,notice.part,notice.kind,notice.channel];
      const where=" WHERE invoice_id=$1 AND part=$2 AND kind=$3 AND channel=$4";
      if (notice.kind==="reminder" && !notice.settled && notice.due_at && notice.due_at.getTime()>Date.now()) {
        await tx.query("UPDATE payment_messages SET next_attempt=$5"+where,[...key,notice.due_at]);
        await tx.query("COMMIT");
        return true;
      }
      try {
        let result:{complete:boolean;providerId?:string|null}={complete:true};
        if (!(notice.kind==="reminder" && notice.settled)) {
          if (!notice.destination && !notice.provider_id) throw new Error("Missing verified contact");
          result=await dispatch(notice);
        }
        await tx.query(`UPDATE payment_messages SET attempts=attempts+1,provider_id=$5,
          accepted_at=CASE WHEN $6 THEN now() END,next_attempt=now()+interval '5 minutes'`+where,
          [...key,result.providerId??null,result.complete]);
      } catch {
        // Preserve a WhatsApp SID if polling fails transiently.
        await tx.query(`UPDATE payment_messages SET attempts=attempts+1,
          next_attempt=now()+make_interval(mins=>least(360,1<<least(attempts,9)))`+where,key);
      }
    }
    await tx.query("COMMIT");
    return Boolean(notice);
  } catch(error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {tx.release();}
}
