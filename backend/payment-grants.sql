GRANT SELECT ON payment_offers, payment_invoices, payment_proofs, payment_receipts, admission_batches, payment_permissions TO zy2_api;
GRANT INSERT (id,student_id,created_by,offer_id), UPDATE (assigned_sales) ON payment_invoices TO zy2_api;
GRANT INSERT (invoice_id,revision,submitted_by,screenshot), UPDATE (correction,reviewed_by,reviewed_at) ON payment_proofs TO zy2_api;
GRANT EXECUTE ON FUNCTION approve_transfer(text,uuid,integer,integer,text,timestamptz) TO zy2_api;
