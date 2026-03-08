ALTER TABLE "public"."teams"
  ADD COLUMN "settings" jsonb NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN "public"."teams"."settings"
  IS 'Team-level admin configuration (partition, internal_tables)';
