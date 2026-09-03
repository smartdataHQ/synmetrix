/**
 * Process-level failure guards.
 *
 * Cube's orchestrator already treats a failed pre-aggregation build as
 * recoverable — it catches the driver error, logs it, and rethrows. When that
 * rethrow finds no handler above it, the rejection reaches the process, and
 * Node's default behaviour ends the process. One unbuildable pre-aggregation
 * then takes down every in-flight build in the refresh worker with it.
 *
 * These guards keep the process alive for that case while leaving genuinely
 * unsafe failures fatal:
 *
 *   - unhandledRejection -> log, keep running
 *   - uncaughtException  -> log, exit(1)
 *
 * The logging call is deliberately fire-and-forget and fully insulated. The
 * injected logger is async and may touch Redis, so an unguarded call inside the
 * rejection handler could reject and re-enter this very handler — a feedback
 * loop that would be worse than the crash it replaces.
 */

/**
 * Installs handlers for process-level failure events.
 *
 * @param {Object} deps
 * @param {Function} deps.logger - Logger taking (message, event). May be async.
 * @param {Function} [deps.exit] - Process exit function, injectable for tests.
 * @param {Object} [deps.proc] - Event target, injectable for tests.
 * @returns {void}
 */
export const installProcessGuards = ({
  logger,
  exit = (code) => process.exit(code),
  proc = process,
}) => {
  const report = (message, reason) => {
    const error = reason?.stack || String(reason);

    try {
      Promise.resolve(logger(message, { error })).catch(() => {
        console.error(`${message}: ${error}`);
      });
    } catch {
      console.error(`${message}: ${error}`);
    }
  };

  proc.on("unhandledRejection", (reason) => {
    report("Unhandled promise rejection", reason);
  });

  proc.on("uncaughtException", (err) => {
    report("Uncaught exception", err);
    exit(1);
  });
};
