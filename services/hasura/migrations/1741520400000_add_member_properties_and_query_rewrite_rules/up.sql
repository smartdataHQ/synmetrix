-- Add properties column to members table
ALTER TABLE public.members ADD COLUMN properties jsonb NOT NULL DEFAULT '{}'::jsonb;

-- Create query_rewrite_rules table
CREATE TABLE public.query_rewrite_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cube_name text NOT NULL,
  dimension text NOT NULL,
  property_source text NOT NULL CHECK (property_source IN ('team', 'member')),
  property_key text NOT NULL,
  operator text NOT NULL DEFAULT 'equals',
  created_by uuid REFERENCES public.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cube_name, dimension, property_source, property_key)
);

-- Create updated_at trigger for query_rewrite_rules
CREATE OR REPLACE FUNCTION public.set_query_rewrite_rules_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_query_rewrite_rules_updated_at
  BEFORE UPDATE ON public.query_rewrite_rules
  FOR EACH ROW
  EXECUTE FUNCTION public.set_query_rewrite_rules_updated_at();

-- Seed initial partition rules for the three target cubes
INSERT INTO public.query_rewrite_rules (cube_name, dimension, property_source, property_key, operator)
VALUES
  ('semantic_events', 'partition', 'team', 'partition', 'equals'),
  ('data_points', 'partition', 'team', 'partition', 'equals'),
  ('entities', 'partition', 'team', 'partition', 'equals');
