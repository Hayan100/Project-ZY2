-- Up Migration
CREATE TABLE payment_permissions (
  staff_id text PRIMARY KEY REFERENCES staff_members ON DELETE CASCADE,
  sales boolean NOT NULL DEFAULT false, verifier boolean NOT NULL DEFAULT false
);
CREATE TABLE admission_batches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), capacity integer NOT NULL CHECK (capacity > 0),
  occupied integer NOT NULL DEFAULT 0 CHECK (occupied >= 0), sold_out_at timestamptz
);
-- Publish new offer versions for changed terms. Existing invoices keep their version.
CREATE TABLE payment_offers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), product_key text NOT NULL CHECK (length(product_key) BETWEEN 1 AND 120),
  amount_paisa integer NOT NULL CHECK (amount_paisa > 0), receiving_account text NOT NULL CHECK (length(receiving_account)>0),
  instructions text NOT NULL, policy_version text NOT NULL, policy_text text NOT NULL, support_contact text NOT NULL,
  review_hours integer NOT NULL CHECK (review_hours BETWEEN 1 AND 720),
  starts_at timestamptz, ends_at timestamptz, duration_days integer CHECK (duration_days > 0),
  batch_id uuid REFERENCES admission_batches, enabled boolean NOT NULL DEFAULT true,
  CHECK ((duration_days IS NOT NULL AND starts_at IS NULL AND ends_at IS NULL AND batch_id IS NULL)
      OR (duration_days IS NULL AND starts_at IS NOT NULL AND ends_at IS NOT NULL AND starts_at < ends_at))
);
CREATE FUNCTION immutable_offer() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF to_jsonb(OLD) - 'enabled' <> to_jsonb(NEW) - 'enabled' THEN RAISE EXCEPTION 'Create a new offer version'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER preserve_terms BEFORE UPDATE ON payment_offers FOR EACH ROW EXECUTE FUNCTION immutable_offer();

CREATE TABLE payment_invoices (
  id uuid PRIMARY KEY, student_id text NOT NULL REFERENCES "user", created_by text NOT NULL REFERENCES "user",
  assigned_sales text REFERENCES staff_members, offer_id uuid NOT NULL REFERENCES payment_offers, issued_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX payment_student ON payment_invoices(student_id,offer_id);
CREATE TABLE payment_proofs (
  invoice_id uuid NOT NULL REFERENCES payment_invoices, revision integer NOT NULL CHECK (revision > 0),
  submitted_by text NOT NULL REFERENCES "user", submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  screenshot bytea NOT NULL CHECK (octet_length(screenshot) BETWEEN 1 AND 3145728),
  correction text, reviewed_by text REFERENCES "user", reviewed_at timestamptz,
  PRIMARY KEY(invoice_id,revision)
);
CREATE TABLE payment_receipts (
  invoice_id uuid PRIMARY KEY REFERENCES payment_invoices, revision integer NOT NULL,
  enrollment_id uuid NOT NULL UNIQUE REFERENCES enrollments, verified_by text NOT NULL REFERENCES "user",
  verified_at timestamptz NOT NULL, transferred_at timestamptz NOT NULL, receiving_account text NOT NULL,
  transfer_reference text NOT NULL, extra_seat boolean NOT NULL,
  UNIQUE(receiving_account,transfer_reference),
  FOREIGN KEY(invoice_id,revision) REFERENCES payment_proofs
);

CREATE FUNCTION approve_transfer(sid text, invoice uuid, proof_revision integer, amount integer, ref text, transferred timestamptz)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, pg_temp AS $$
DECLARE actor text; i payment_invoices; o payment_offers; p payment_proofs; r payment_receipts; b admission_batches;
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
  SELECT * INTO r FROM payment_receipts WHERE invoice_id=invoice;
  IF FOUND THEN
    IF r.revision=proof_revision AND r.transfer_reference=ref AND r.transferred_at=transferred AND o.amount_paisa=amount THEN RETURN; END IF;
    RAISE EXCEPTION USING ERRCODE='P0409';
  END IF;
  SELECT * INTO p FROM payment_proofs WHERE invoice_id=invoice ORDER BY revision DESC LIMIT 1;
  IF p.revision IS DISTINCT FROM proof_revision OR p.correction IS NOT NULL OR amount IS DISTINCT FROM o.amount_paisa
     OR ref IS NULL OR ref !~ '^[A-Z0-9][A-Z0-9/-]{2,79}$' OR transferred IS NULL
     OR transferred<i.issued_at OR transferred>clock_timestamp() THEN RAISE EXCEPTION USING ERRCODE='P0409'; END IF;
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
  INSERT INTO payment_receipts VALUES (invoice,proof_revision,grant_id,actor,ts,transferred,o.receiving_account,ref,extra);
END $$;
REVOKE ALL ON FUNCTION approve_transfer(text,uuid,integer,integer,text,timestamptz) FROM PUBLIC;

-- Down Migration
DROP FUNCTION approve_transfer(text,uuid,integer,integer,text,timestamptz);
DROP TABLE payment_receipts,payment_proofs,payment_invoices,payment_offers,admission_batches,payment_permissions;
DROP FUNCTION immutable_offer();
