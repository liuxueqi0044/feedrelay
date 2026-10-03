-- Apply these through a numbered server migration, never manually to bypass review.
-- IDs are deterministic in BillingService. These constraints also protect against
-- any future writer that uses another entity ID for the same business identity.
CREATE UNIQUE INDEX IF NOT EXISTS fr_checkouts_workspace_bot_key
  ON fr_checkouts (workspace_id, (data->>'botId'));
CREATE UNIQUE INDEX IF NOT EXISTS fr_checkouts_payload_bot_key
  ON fr_checkouts ((data->>'botId'), (data->>'payload'));
CREATE UNIQUE INDEX IF NOT EXISTS fr_subscriptions_workspace_bot_key
  ON fr_subscriptions (workspace_id, (data->>'botId'));
CREATE UNIQUE INDEX IF NOT EXISTS fr_subscriptions_payload_bot_key
  ON fr_subscriptions ((data->>'botId'), (data->>'payload'));
CREATE UNIQUE INDEX IF NOT EXISTS fr_payments_charge_bot_key
  ON fr_payments ((data->>'botId'), (data->>'chargeId'));
CREATE UNIQUE INDEX IF NOT EXISTS fr_refunds_charge_bot_key
  ON fr_refunds ((data->>'botId'), (data->>'chargeId'));
CREATE UNIQUE INDEX IF NOT EXISTS fr_grants_charge_bot_key
  ON fr_grants ((data->>'botId'), (data->>'chargeId'));
CREATE UNIQUE INDEX IF NOT EXISTS fr_reservations_delivery_period_key
  ON fr_reservations (workspace_id, (data->>'deliveryId'), (data->>'periodId'));
CREATE UNIQUE INDEX IF NOT EXISTS fr_ledger_logical_delivery_key
  ON fr_ledger (workspace_id, (data->>'deliveryId'));

-- Exact paid interval overlap checks remain in the serializable BillingService
-- transaction. A max-expiration subscription field cannot detect refunded gaps.
-- Do not add a UNIQUE(payload) index to payments: recurring receipts reuse payload.
