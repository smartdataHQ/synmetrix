import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { installProcessGuards } from "../processGuards.js";

// --- Helpers ---

/**
 * A stand-in for Node's `process` that records handler registrations without
 * touching the real process. Tests drive the handlers directly via `emit`.
 */
function fakeProcess() {
  const handlers = {};
  return {
    on(event, handler) {
      handlers[event] = handler;
      return this;
    },
    emit(event, ...args) {
      if (!handlers[event]) {
        throw new Error(`no handler registered for "${event}"`);
      }
      return handlers[event](...args);
    },
    registered() {
      return Object.keys(handlers).sort();
    },
  };
}

function recordingLogger() {
  const calls = [];
  const logger = async (message, event) => {
    calls.push({ message, event });
  };
  logger.calls = calls;
  return logger;
}

/** Collects console.error output for the duration of `fn`. */
async function captureConsoleError(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return lines;
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

// --- Tests ---

describe("installProcessGuards", () => {
  it("registers handlers for both process-level failure events", () => {
    const proc = fakeProcess();

    installProcessGuards({
      logger: recordingLogger(),
      exit: () => {},
      proc,
    });

    assert.deepEqual(proc.registered(), [
      "uncaughtException",
      "unhandledRejection",
    ]);
  });

  it("does not exit when a promise rejection goes unhandled", async () => {
    const proc = fakeProcess();
    const logger = recordingLogger();
    let exitCalls = 0;

    installProcessGuards({
      logger,
      exit: () => {
        exitCalls += 1;
      },
      proc,
    });

    proc.emit("unhandledRejection", new Error("Stream query failed"));
    await flush();

    assert.equal(exitCalls, 0, "an unhandled rejection must not end the process");
  });

  it("logs the rejection reason with its stack", async () => {
    const proc = fakeProcess();
    const logger = recordingLogger();

    installProcessGuards({ logger, exit: () => {}, proc });

    proc.emit("unhandledRejection", new Error("Stream query failed"));
    await flush();

    assert.equal(logger.calls.length, 1);
    assert.match(logger.calls[0].event.error, /Stream query failed/);
  });

  it("logs a non-Error rejection reason without throwing", async () => {
    const proc = fakeProcess();
    const logger = recordingLogger();

    installProcessGuards({ logger, exit: () => {}, proc });

    proc.emit("unhandledRejection", "plain string rejection");
    await flush();

    assert.equal(logger.calls.length, 1);
    assert.match(logger.calls[0].event.error, /plain string rejection/);
  });

  it("exits with code 1 on an uncaught exception", async () => {
    const proc = fakeProcess();
    const exitCodes = [];

    installProcessGuards({
      logger: recordingLogger(),
      exit: (code) => exitCodes.push(code),
      proc,
    });

    proc.emit("uncaughtException", new Error("corrupt state"));
    await flush();

    assert.deepEqual(exitCodes, [1]);
  });

  it("still exits when the logger rejects during an uncaught exception", async () => {
    const proc = fakeProcess();
    const exitCodes = [];

    installProcessGuards({
      logger: async () => {
        throw new Error("redis is down");
      },
      exit: (code) => exitCodes.push(code),
      proc,
    });

    await captureConsoleError(async () => {
      proc.emit("uncaughtException", new Error("corrupt state"));
      await flush();
    });

    assert.deepEqual(
      exitCodes,
      [1],
      "a failing logger must not prevent the fatal exit"
    );
  });

  it("falls back to console.error when the logger rejects", async () => {
    const proc = fakeProcess();

    installProcessGuards({
      logger: async () => {
        throw new Error("redis is down");
      },
      exit: () => {},
      proc,
    });

    const lines = await captureConsoleError(async () => {
      proc.emit("unhandledRejection", new Error("Stream query failed"));
      await flush();
    });

    assert.ok(
      lines.some((l) => /Stream query failed/.test(l)),
      `expected the reason on console.error, got: ${JSON.stringify(lines)}`
    );
  });

  it("survives a logger that throws synchronously", async () => {
    const proc = fakeProcess();
    let exitCalls = 0;

    installProcessGuards({
      logger: () => {
        throw new Error("logger blew up");
      },
      exit: () => {
        exitCalls += 1;
      },
      proc,
    });

    const lines = await captureConsoleError(async () => {
      proc.emit("unhandledRejection", new Error("Stream query failed"));
      await flush();
    });

    assert.equal(exitCalls, 0);
    assert.ok(
      lines.some((l) => /Stream query failed/.test(l)),
      "a synchronously throwing logger must still produce output"
    );
  });

  it("does not re-enter the rejection handler when the logger rejects", async () => {
    const proc = fakeProcess();
    let loggerCalls = 0;

    installProcessGuards({
      logger: async () => {
        loggerCalls += 1;
        throw new Error("redis is down");
      },
      exit: () => {},
      proc,
    });

    await captureConsoleError(async () => {
      proc.emit("unhandledRejection", new Error("Stream query failed"));
      await flush();
      await flush();
    });

    assert.equal(
      loggerCalls,
      1,
      "the handler's own logging failure must not feed back into itself"
    );
  });
});
