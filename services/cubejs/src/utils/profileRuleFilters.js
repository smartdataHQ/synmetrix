export function profileRuleFilters(rules, table, userScope = {}) {
  return rules
    .filter((rule) => rule.cube_name === table)
    .map((rule) => {
      if (!["team", "member"].includes(rule.property_source)) {
        throw new Error("Unsupported profile rule property source");
      }
      const source =
        rule.property_source === "team"
          ? userScope.teamProperties
          : userScope.memberProperties;
      const value = source?.[rule.property_key];
      if (value === undefined || value === null) {
        throw new Error("Required profile rule property is unavailable");
      }
      const operator =
        rule.operator === "equals"
          ? "="
          : rule.operator === "notEquals"
            ? "!="
            : null;
      if (!operator) {
        throw new Error("Profile rule operator cannot be translated safely");
      }
      if (!["string", "number", "boolean"].includes(typeof value)) {
        throw new Error("Unsupported profile rule property value");
      }
      if (typeof value === "number" && !Number.isFinite(value)) {
        throw new Error("Unsupported profile rule property value");
      }
      return { column: rule.dimension, operator, value: String(value) };
    });
}
