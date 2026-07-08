import { verifyAndProvision } from "../utils/directVerifyAuth.js";
import { fetchPublishedTemplate } from "../utils/smart-generation/templateResolver.js";

/**
 * GET /api/v1/published-template?name=<templateName> (cxs2 spec 080 — additive).
 *
 * Returns the published global template (name, fileName, code, checksum) from
 * the platform template datasource — the seed the row-type pipeline passes to
 * the modeling agent as part of the FR-020 maturation context. Auth: any
 * verified FraiOS/WorkOS identity (global templates are platform content that
 * is seeded into every tenant's models; no tenant data is exposed).
 */
export default async (req, res) => {
  const auth = await verifyAndProvision(req);
  if (auth.error) {
    return res.status(auth.error.status).json(auth.error);
  }

  const name = typeof req.query?.name === "string" ? req.query.name.trim() : "";
  if (!name) {
    return res.status(400).json({
      code: "published_template_missing_name",
      message: "The name query parameter is required.",
    });
  }

  try {
    const template = await fetchPublishedTemplate(name);
    if (!template) {
      return res.status(404).json({
        code: "published_template_not_found",
        message: `No published global template named '${name}' was found.`,
      });
    }
    const { cubes, ...rest } = template;
    return res.json(rest);
  } catch (err) {
    console.error("[publishedTemplate]", err);
    return res.status(500).json({
      code: "published_template_error",
      message: err.message || String(err),
    });
  }
};
