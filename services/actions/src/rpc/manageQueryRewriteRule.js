import apiError from "../utils/apiError.js";
import { invalidateRulesCache } from "../utils/cubeCache.js";
import { fetchGraphQL } from "../utils/graphql.js";
import { isPortalAdmin } from "../utils/portalAdmin.js";
import { emitLifecycleEvent } from "../utils/semanticEvents.js";

// 099 US7 (FR-091, T089): row-level Access Rules (query_rewrite_rules) are
// PLATFORM-GLOBAL config edited only by portal admins — there is no per-tenant
// row. They are attributed to the platform tenant (partition), overridable via
// PLATFORM_PARTITION; ACTED_BY carries the acting admin. Emission is
// fire-and-forget and never affects the mutation (FR-007).
const PLATFORM_PARTITION = process.env.PLATFORM_PARTITION || "fftech.is";

async function emitAccessRule(event, status, ruleId, userId, properties) {
  await emitLifecycleEvent({
    event,
    partition: PLATFORM_PARTITION,
    userId,
    about: { entity_type: "Policy", id: ruleId, label: properties?.cube_name ?? null },
    status,
    properties,
  });
}

const insertRuleMutation = `
  mutation InsertRule($object: query_rewrite_rules_insert_input!) {
    insert_query_rewrite_rules_one(object: $object) {
      id
    }
  }
`;

const updateRuleMutation = `
  mutation UpdateRule($id: uuid!, $set: query_rewrite_rules_set_input!) {
    update_query_rewrite_rules_by_pk(pk_columns: { id: $id }, _set: $set) {
      id
    }
  }
`;

const deleteRuleMutation = `
  mutation DeleteRule($id: uuid!) {
    delete_query_rewrite_rules_by_pk(id: $id) {
      id
    }
  }
`;

const getRuleQuery = `
  query GetRule($id: uuid!) {
    query_rewrite_rules_by_pk(id: $id) {
      id
    }
  }
`;

const VALID_OPERATORS = ["equals"];
const VALID_SOURCES = ["team", "member"];

export default async (session, input) => {
  const userId = session?.["x-hasura-user-id"];

  try {
    const admin = await isPortalAdmin(userId);
    if (!admin) {
      return { success: false, rule_id: null };
    }

    const { action, id, cube_name, dimension, property_source, property_key, operator } =
      input || {};

    if (action === "create") {
      // Validate required fields
      if (!cube_name || !dimension || !property_source || !property_key) {
        return { success: false, rule_id: null };
      }

      // Validate property_source
      if (!VALID_SOURCES.includes(property_source)) {
        return { success: false, rule_id: null };
      }

      // Validate operator (MVP: equals only)
      const op = operator || "equals";
      if (!VALID_OPERATORS.includes(op)) {
        return { success: false, rule_id: null };
      }

      // Validate dimension does not contain '.' (must be short name)
      if (dimension.includes(".")) {
        return { success: false, rule_id: null };
      }

      const res = await fetchGraphQL(insertRuleMutation, {
        object: {
          cube_name,
          dimension,
          property_source,
          property_key,
          operator: op,
          created_by: userId,
        },
      });

      const ruleId = res?.data?.insert_query_rewrite_rules_one?.id;
      if (ruleId) {
        invalidateRulesCache();
        void emitAccessRule("Access Rule Created", "created", ruleId, userId, {
          cube_name,
          dimension,
          property_source,
          property_key,
          operator: op,
        });
      }
      return { success: !!ruleId, rule_id: ruleId || null };
    }

    if (action === "update") {
      if (!id) return { success: false, rule_id: null };

      // Verify rule exists
      const existing = await fetchGraphQL(getRuleQuery, { id });
      if (!existing?.data?.query_rewrite_rules_by_pk) {
        return { success: false, rule_id: null };
      }

      const updates = {};
      if (cube_name) updates.cube_name = cube_name;
      if (dimension) {
        if (dimension.includes(".")) return { success: false, rule_id: null };
        updates.dimension = dimension;
      }
      if (property_source) {
        if (!VALID_SOURCES.includes(property_source)) return { success: false, rule_id: null };
        updates.property_source = property_source;
      }
      if (property_key) updates.property_key = property_key;
      if (operator) {
        if (!VALID_OPERATORS.includes(operator)) return { success: false, rule_id: null };
        updates.operator = operator;
      }

      if (Object.keys(updates).length === 0) {
        return { success: true, rule_id: id };
      }

      await fetchGraphQL(updateRuleMutation, { id, set: updates });
      invalidateRulesCache();
      void emitAccessRule("Access Rule Updated", "updated", id, userId, updates);
      return { success: true, rule_id: id };
    }

    if (action === "delete") {
      if (!id) return { success: false, rule_id: null };

      // Verify rule exists
      const existing = await fetchGraphQL(getRuleQuery, { id });
      if (!existing?.data?.query_rewrite_rules_by_pk) {
        return { success: false, rule_id: null };
      }

      await fetchGraphQL(deleteRuleMutation, { id });
      invalidateRulesCache();
      void emitAccessRule("Access Rule Deleted", "deleted", id, userId, null);
      return { success: true, rule_id: id };
    }

    return { success: false, rule_id: null };
  } catch (err) {
    return apiError(err);
  }
};
