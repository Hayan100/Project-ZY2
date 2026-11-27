GRANT SELECT ON payment_message_payload,installment_balance,payment_messages TO zy2_delivery;
GRANT INSERT (invoice_id,part,kind,channel), UPDATE (attempts,next_attempt,accepted_at,provider_id) ON payment_messages TO zy2_delivery;
