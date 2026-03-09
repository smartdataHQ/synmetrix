-- Drop query_rewrite_rules table (cascade drops trigger)
DROP TABLE IF EXISTS public.query_rewrite_rules;

-- Drop the trigger function
DROP FUNCTION IF EXISTS public.set_query_rewrite_rules_updated_at();

-- Remove properties column from members
ALTER TABLE public.members DROP COLUMN IF EXISTS properties;
