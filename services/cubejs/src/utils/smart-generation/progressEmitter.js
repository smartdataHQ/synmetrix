/**
 * Dual-mode progress reporting for CubeJS routes.
 *
 * When the client sends `Accept: text/event-stream`, progress events are
 * streamed as SSE. Otherwise all emit/error calls are no-ops and the final
 * payload is returned as plain JSON via `complete()`.
 */

function writeSseEvent(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function createProgressEmitter(res, acceptHeader) {
  const streaming = typeof acceptHeader === 'string'
    && acceptHeader.includes('text/event-stream');

  if (streaming) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    return {
      isStreaming: true,

      emit(step, message, progress, detail) {
        const data = { step, message, progress };
        if (detail !== undefined) {
          data.detail = detail;
        }
        writeSseEvent(res, 'progress', data);
      },

      complete(payload) {
        writeSseEvent(res, 'complete', payload);
        res.end();
      },

      error(errorMessage, step) {
        const data = { error: errorMessage };
        if (step !== undefined) {
          data.step = step;
        }
        writeSseEvent(res, 'error', data);
        res.end();
      },
    };
  }

  // No-op / JSON mode
  return {
    isStreaming: false,

    emit() {},

    complete(payload) {
      res.json(payload);
    },

    error(errorMessage, step) {
      res.status(500).json({ error: errorMessage, step });
    },
  };
}
