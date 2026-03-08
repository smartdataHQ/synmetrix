CREATE OR REPLACE FUNCTION public.hide_password(datasources_row datasources)
 RETURNS jsonb
 LANGUAGE sql
 STABLE
AS $function$
  SELECT (
    CASE WHEN datasources_row.db_params ? 'oauthClientSecret'
      THEN jsonb_set(
        CASE WHEN datasources_row.db_params ? 'oauthToken'
          THEN jsonb_set(
            jsonb_set(datasources_row.db_params, '{password}', '""'),
            '{oauthToken}', '""'
          )
          ELSE jsonb_set(datasources_row.db_params, '{password}', '""')
        END,
        '{oauthClientSecret}', '""'
      )
      WHEN datasources_row.db_params ? 'oauthToken'
      THEN jsonb_set(
        jsonb_set(datasources_row.db_params, '{password}', '""'),
        '{oauthToken}', '""'
      )
      ELSE jsonb_set(datasources_row.db_params, '{password}', '""')
    END
  )
$function$;
