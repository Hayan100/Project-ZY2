-- Up Migration
ALTER TABLE payment_permissions ADD COLUMN plan_approver boolean NOT NULL DEFAULT false;
CREATE TABLE installment_plans (
  invoice_id uuid PRIMARY KEY REFERENCES payment_invoices,
  schedule jsonb NOT NULL CHECK (jsonb_typeof(schedule)='array' AND jsonb_array_length(schedule) BETWEEN 2 AND 48),
  agreed_by text NOT NULL REFERENCES "user", agreed_at timestamptz NOT NULL DEFAULT now(),
  approved_by text REFERENCES "user", approved_at timestamptz,
  CHECK ((approved_by IS NULL)=(approved_at IS NULL) AND agreed_by IS DISTINCT FROM approved_by)
);
ALTER TABLE payment_receipts DROP CONSTRAINT payment_receipts_pkey,
  DROP CONSTRAINT payment_receipts_enrollment_id_key,
  ADD PRIMARY KEY(invoice_id,revision),
  ADD COLUMN receipt_id uuid, ADD COLUMN part integer NOT NULL DEFAULT 1, ADD COLUMN amount_paisa integer;
UPDATE payment_receipts r SET receipt_id=r.invoice_id, amount_paisa=o.amount_paisa
  FROM payment_invoices i JOIN payment_offers o ON o.id=i.offer_id WHERE i.id=r.invoice_id;
ALTER TABLE payment_receipts ALTER COLUMN receipt_id SET NOT NULL, ALTER COLUMN receipt_id SET DEFAULT gen_random_uuid(),
  ALTER COLUMN amount_paisa SET NOT NULL, ADD UNIQUE(receipt_id), ADD UNIQUE(invoice_id,part), ADD CHECK(amount_paisa>0);

CREATE TABLE receipt_contacts (
  user_id text PRIMARY KEY REFERENCES "user", whatsapp text NOT NULL CHECK(whatsapp ~ '^\+[1-9][0-9]{7,14}$'),
  verified_by text REFERENCES staff_members, consent_at timestamptz NOT NULL
);
CREATE TABLE payment_messages (
  invoice_id uuid NOT NULL REFERENCES payment_invoices, part integer NOT NULL,
  kind text NOT NULL CHECK(kind IN ('receipt','reminder')), channel text NOT NULL CHECK(channel IN ('email','whatsapp')),
  attempts integer NOT NULL DEFAULT 0, next_attempt timestamptz NOT NULL DEFAULT now(), accepted_at timestamptz,
  provider_id text, PRIMARY KEY(invoice_id,part,kind,channel)
);
CREATE INDEX pending_payment_messages ON payment_messages(next_attempt) WHERE accepted_at IS NULL;
CREATE FUNCTION queue_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO payment_messages(invoice_id,part,kind,channel) VALUES
    (NEW.invoice_id,NEW.part,'receipt','email'),(NEW.invoice_id,NEW.part,'receipt','whatsapp');
  RETURN NEW;
END $$;
CREATE TRIGGER receipt_created AFTER INSERT ON payment_receipts FOR EACH ROW EXECUTE FUNCTION queue_receipt();

CREATE TABLE installment_extensions (
  invoice_id uuid NOT NULL REFERENCES installment_plans, part integer NOT NULL CHECK(part>0),
  due_at timestamptz NOT NULL, approved_by text NOT NULL REFERENCES "user", reason text NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(invoice_id,part,due_at)
);

CREATE VIEW installment_balance AS
SELECT i.id, coalesce(a.paid,0)::integer AS paid_paisa, coalesce(a.parts,0)::integer AS paid_parts,
  o.amount_paisa-coalesce(a.paid,0)::integer AS balance_paisa,
  CASE WHEN p.approved_at IS NOT NULL THEN coalesce((SELECT max(x.due_at) FROM installment_extensions x WHERE x.invoice_id=i.id AND x.part=a.parts+1),
    (p.schedule->coalesce(a.parts,0)::integer->>'dueAt')::timestamptz) END AS next_due
FROM payment_invoices i JOIN payment_offers o ON o.id=i.offer_id LEFT JOIN installment_plans p ON p.invoice_id=i.id
LEFT JOIN LATERAL (SELECT sum(amount_paisa) paid,count(*) parts FROM payment_receipts WHERE invoice_id=i.id) a ON true;

CREATE OR REPLACE FUNCTION approve_transfer(sid text, invoice uuid, proof_revision integer, amount integer, ref text, transferred timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor text; i payment_invoices; o payment_offers; p payment_proofs; r payment_receipts; b admission_batches;
  plan installment_plans; next_part integer; expected integer;
  ts timestamptz; begins timestamptz; ends timestamptz; grant_id uuid; extra boolean := false;
BEGIN
  SELECT s."userId" INTO actor FROM session s JOIN payment_permissions perm ON perm.staff_id=s."userId"
    WHERE s.id=sid AND s."expiresAt">clock_timestamp() AND perm.verifier
    AND NOT EXISTS (SELECT FROM temporary_credentials WHERE user_id=s."userId") FOR SHARE OF s,perm;
  IF actor IS NULL THEN RAISE EXCEPTION USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(invoice::text,2));
  SELECT * INTO STRICT i FROM payment_invoices WHERE id=invoice FOR UPDATE;
  IF actor IN (i.student_id,i.created_by) OR EXISTS (SELECT FROM payment_proofs WHERE invoice_id=invoice AND submitted_by=actor)
    THEN RAISE EXCEPTION USING ERRCODE='42501'; END IF;
  SELECT * INTO STRICT o FROM payment_offers WHERE id=i.offer_id;
  ref := upper(btrim(ref));
  SELECT * INTO r FROM payment_receipts WHERE invoice_id=invoice AND revision=proof_revision;
  IF FOUND THEN
    IF r.revision=proof_revision AND r.transfer_reference=ref AND r.transferred_at=transferred AND r.amount_paisa=amount THEN RETURN; END IF;
    RAISE EXCEPTION USING ERRCODE='P0409';
  END IF;
  SELECT * INTO plan FROM installment_plans WHERE invoice_id=invoice;
  SELECT count(*)+1 INTO next_part FROM payment_receipts WHERE invoice_id=invoice;
  IF plan.invoice_id IS NOT NULL AND plan.approved_at IS NULL THEN RAISE EXCEPTION USING ERRCODE='P0409'; END IF;
  expected := CASE WHEN plan.invoice_id IS NULL AND next_part=1 THEN o.amount_paisa
    ELSE (plan.schedule->(next_part-1)->>'amountPaisa')::integer END;
  SELECT * INTO p FROM payment_proofs WHERE invoice_id=invoice ORDER BY revision DESC LIMIT 1;
  IF p.revision IS DISTINCT FROM proof_revision OR p.correction IS NOT NULL OR expected IS NULL OR amount IS DISTINCT FROM expected
     OR ref IS NULL OR ref !~ '^[A-Z0-9][A-Z0-9/-]{2,79}$' OR transferred IS NULL
     OR transferred<i.issued_at OR transferred>clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409'; END IF;
  ts := clock_timestamp();
  IF next_part=1 THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(i.student_id,1));
    IF o.batch_id IS NOT NULL THEN SELECT * INTO STRICT b FROM admission_batches WHERE id=o.batch_id FOR UPDATE; END IF;
    ts := clock_timestamp(); begins := coalesce(o.starts_at,ts); ends := coalesce(o.ends_at,ts+make_interval(days=>o.duration_days));
    IF ends<=ts OR EXISTS (SELECT FROM enrollments WHERE user_id=i.student_id AND product_key=o.product_key AND revoked_at IS NULL
      AND starts_at<ends AND begins<ends_at) THEN RAISE EXCEPTION USING ERRCODE='P0409'; END IF;
    IF o.batch_id IS NOT NULL THEN
      extra := b.occupied>=b.capacity;
      IF extra AND transferred>=b.sold_out_at THEN RAISE EXCEPTION USING ERRCODE='P0409'; END IF;
      UPDATE admission_batches SET occupied=occupied+1, sold_out_at=coalesce(sold_out_at,CASE WHEN occupied+1>=capacity THEN ts END) WHERE id=b.id;
    END IF;
    INSERT INTO enrollments(user_id,product_key,starts_at,ends_at) VALUES (i.student_id,o.product_key,begins,ends) RETURNING id INTO grant_id;
  ELSE
    SELECT enrollment_id INTO STRICT grant_id FROM payment_receipts WHERE invoice_id=invoice AND part=1;
  END IF;
  INSERT INTO payment_receipts(invoice_id,revision,enrollment_id,verified_by,verified_at,transferred_at,receiving_account,
    transfer_reference,extra_seat,part,amount_paisa,receipt_id)
  VALUES (invoice,proof_revision,grant_id,actor,ts,transferred,o.receiving_account,ref,extra,next_part,amount,
    CASE WHEN next_part=1 THEN invoice ELSE gen_random_uuid() END);
END $$;

-- The delivery login can read only the contact and receipt fields required by its work.
CREATE VIEW payment_message_payload AS
SELECT m.invoice_id,m.part,m.kind,m.channel,m.provider_id,
  CASE WHEN m.channel='email' AND u."emailVerified" THEN u.email WHEN m.channel='whatsapp' AND c.verified_by IS NOT NULL THEN c.whatsapp END AS destination,
  o.product_key,r.receipt_id,r.verified_at,r.transfer_reference,
  coalesce(r.amount_paisa,(p.schedule->(m.part-1)->>'amountPaisa')::integer) AS amount_paisa,
  coalesce((SELECT max(x.due_at) FROM installment_extensions x WHERE x.invoice_id=i.id AND x.part=m.part),
    (p.schedule->(m.part-1)->>'dueAt')::timestamptz) AS due_at,
  r.receipt_id IS NOT NULL AS settled
FROM payment_messages m JOIN payment_invoices i ON i.id=m.invoice_id JOIN "user" u ON u.id=i.student_id
JOIN payment_offers o ON o.id=i.offer_id LEFT JOIN receipt_contacts c ON c.user_id=i.student_id
LEFT JOIN installment_plans p ON p.invoice_id=i.id LEFT JOIN payment_receipts r ON r.invoice_id=i.id AND r.part=m.part;

CREATE FUNCTION preserve_approved_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approved_at IS NOT NULL AND (TG_OP='DELETE' OR NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION USING ERRCODE='P0409';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_plan BEFORE UPDATE OR DELETE ON installment_plans
  FOR EACH ROW EXECUTE FUNCTION preserve_approved_schedule();
-- Down Migration
DO $$ BEGIN RAISE EXCEPTION 'Receipt and schedule audit records require a forward migration'; END $$;
