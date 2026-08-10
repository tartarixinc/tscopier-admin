CREATE TABLE IF NOT EXISTS trade_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  symbol text NOT NULL DEFAULT '',
  direction text NOT NULL DEFAULT '',
  ticket text,
  broker_label text,
  entry_price numeric(20,8),
  sl numeric(20,8),
  tp numeric(20,8),
  lot_size numeric(10,2),
  category text,
  reason text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'open',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE trade_reports ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own trade reports"
  ON trade_reports FOR INSERT TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can view own trade reports"
  ON trade_reports FOR SELECT TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS trade_reports_user_created_idx
  ON trade_reports (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS trade_reports_status_idx
  ON trade_reports (status);
