-- Run as migration owner after creating the worker roles.
GRANT USAGE ON SCHEMA public TO zy2_campaign, zy2_youtube;
GRANT SELECT (id, opens, closes, youtube_video_id, youtube_state), UPDATE (youtube_state)
  ON classes TO zy2_youtube;

GRANT SELECT (id, product, steps, approved_by) ON admissions_campaigns TO zy2_campaign;
GRANT SELECT (student, allowed), UPDATE (updated_at) ON admissions_consent TO zy2_campaign;
-- PostgreSQL requires an UPDATE privilege for the delivery-time FOR SHARE locks.
GRANT SELECT (id, email, "emailVerified"), UPDATE ("updatedAt") ON "user" TO zy2_campaign;
GRANT SELECT (id, student_id, offer_id) ON payment_invoices TO zy2_campaign;
GRANT SELECT (id, product_key) ON payment_offers TO zy2_campaign;
GRANT SELECT (invoice_id) ON payment_receipts TO zy2_campaign;
GRANT SELECT (campaign, student, step), INSERT (campaign, student, step)
  ON admissions_deliveries TO zy2_campaign;
