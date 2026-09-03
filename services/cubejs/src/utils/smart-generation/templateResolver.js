import YAML from 'yaml';

import { fetchGraphQL } from '../graphql.js';
import { parseCubesFromJs } from './diffModels.js';

/**
 * Published-template resolution for template-seeded smart generation (080 D2).
 *
 * The published template set is the dataschemas on the latest version of the
 * active branch of the platform-owned template datasource — the SAME surface
 * `fetchPublishedTemplates` (actions, 013 reconciler) consumes; replicated
 * here because smart-generate runs in the cubejs service. Keyed by
 * `DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID` (already in this service's env).
 */

const TEMPLATES_QUERY = `
  query ($id: uuid!) {
    datasources_by_pk(id: $id) {
      id
      branches(where: { status: { _eq: active } }, limit: 1) {
        id
        versions(limit: 1, order_by: { created_at: desc }) {
          id
          checksum
          dataschemas {
            id
            name
            code
          }
        }
      }
    }
  }
`;

/**
 * Fetch ONE published global template by its base name (file name without
 * extension). Returns `{ name, fileName, code, checksum, cubes }` or null
 * when no such template is published.
 */
export async function fetchPublishedTemplate(templateName) {
  const templateDatasourceId = process.env.DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID;
  if (!templateDatasourceId) {
    throw new Error('DEFAULT_MODELS_TEMPLATE_DATASOURCE_ID is not configured');
  }

  const res = await fetchGraphQL(TEMPLATES_QUERY, { id: templateDatasourceId });
  const version = res?.data?.datasources_by_pk?.branches?.[0]?.versions?.[0] || null;
  const schema = (version?.dataschemas || []).find(
    (s) => s.name.replace(/\.(yml|yaml|js)$/i, '') === templateName
  );
  if (!schema) return null;

  let cubes = null;
  try {
    cubes = /\.js$/i.test(schema.name)
      ? parseCubesFromJs(schema.code)
      : YAML.parse(schema.code)?.cubes;
  } catch {
    cubes = null;
  }

  return {
    name: templateName,
    fileName: schema.name,
    code: schema.code,
    checksum: version?.checksum || null,
    cubes: cubes || [],
  };
}
