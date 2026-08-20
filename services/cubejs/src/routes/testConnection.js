/**
 * Asynchronous function to test the database connection using Cube.js.
 *
 * @param {Object} req - The request object from the client.
 * @param {Object} req.securityContext - The security context from the request.
 * @param {Object} res - The response object to the client.
 * @param {Object} cubejs - The Cube.js server instance.
 * @returns {Promise} - A promise that resolves to a JSON object indicating the status of the connection.
 *
 * @throws {Error} - Throws an error if testing the connection fails.
 */
import { emitQueryEvent } from "../utils/eventEmitter.js";

export default async (req, res, cubejs) => {
  const { securityContext } = req;

  // 099 T089 (FR-091): tenant + subject attribution for `Datasource Connection
  // Tested`. Tenant rides tokenPayload; the datasource is the subject (a
  // Connection) via ABOUT keyed by its id.
  const tokenPayload = securityContext?.tokenPayload || {};
  const tenant = {
    accountId: tokenPayload.accountId ?? null,
    partition: tokenPayload.partition ?? null,
    userId: securityContext?.userId ?? null,
  };
  const dataSource = securityContext?.userScope?.dataSource;
  const dataSourceId = dataSource?.dataSourceId ?? null;
  const dbType = dataSource?.dbType ?? null;
  const startedAt = Date.now();

  const emitTested = (status, extra) =>
    emitQueryEvent({
      event: "Datasource Connection Tested",
      ...tenant,
      status,
      about: dataSourceId
        ? { entity_type: "Connection", id: dataSourceId }
        : null,
      dimensions: dbType ? { datasource_type: dbType } : null,
      metrics: { duration_ms: Date.now() - startedAt },
      properties: extra || null,
    });

  try {
    const driver = await cubejs.options.driverFactory({ securityContext });
    await driver.testConnection();

    // Fire-and-forget; never blocks the response (FR-007).
    emitTested("ok");

    res.json({
      code: "ok",
      message: "Connection is OK",
    });
  } catch (err) {
    console.error(err);

    emitTested("error", { error_message: err?.message || String(err) });

    res.status(500).json({
      code: "test_connection_failed",
      message: err.message || err,
    });
  }
};
