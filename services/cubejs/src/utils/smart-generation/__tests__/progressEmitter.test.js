import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert';
import { createProgressEmitter } from '../progressEmitter.js';

/**
 * Create a mock response object that records calls.
 */
function mockRes() {
  const calls = {
    setHeader: [],
    flushHeaders: 0,
    write: [],
    end: 0,
    json: [],
    status: [],
  };

  const res = {
    setHeader(name, value) {
      calls.setHeader.push({ name, value });
    },
    flushHeaders() {
      calls.flushHeaders++;
    },
    write(chunk) {
      calls.write.push(chunk);
    },
    end() {
      calls.end++;
    },
    json(payload) {
      calls.json.push(payload);
    },
    status(code) {
      calls.status.push(code);
      return res; // chainable
    },
  };

  return { res, calls };
}

describe('progressEmitter – createProgressEmitter', () => {
  describe('SSE mode (Accept: text/event-stream)', () => {
    let emitter;
    let res;
    let calls;

    beforeEach(() => {
      ({ res, calls } = mockRes());
      emitter = createProgressEmitter(res, 'text/event-stream');
    });

    it('should set isStreaming to true', () => {
      assert.strictEqual(emitter.isStreaming, true);
    });

    it('should set correct SSE headers', () => {
      const headers = Object.fromEntries(calls.setHeader.map((h) => [h.name, h.value]));
      assert.strictEqual(headers['Content-Type'], 'text/event-stream');
      assert.strictEqual(headers['Cache-Control'], 'no-cache');
      assert.strictEqual(headers['Connection'], 'keep-alive');
      assert.strictEqual(headers['X-Accel-Buffering'], 'no');
    });

    it('should call flushHeaders', () => {
      assert.strictEqual(calls.flushHeaders, 1);
    });

    it('should write event: + data: + double newline format on emit', () => {
      emitter.emit('profiling', 'Profiling tables', 0.5);

      assert.strictEqual(calls.write.length, 1);
      const written = calls.write[0];
      assert.ok(written.startsWith('event: progress\n'));
      assert.ok(written.includes('data: '));
      assert.ok(written.endsWith('\n\n'));

      // Parse the data payload
      const dataLine = written.split('\n').find((l) => l.startsWith('data: '));
      const data = JSON.parse(dataLine.replace('data: ', ''));
      assert.strictEqual(data.step, 'profiling');
      assert.strictEqual(data.message, 'Profiling tables');
      assert.strictEqual(data.progress, 0.5);
    });

    it('should include detail field when provided', () => {
      emitter.emit('profiling', 'Working', 0.3, { table: 'events' });

      const dataLine = calls.write[0].split('\n').find((l) => l.startsWith('data: '));
      const data = JSON.parse(dataLine.replace('data: ', ''));
      assert.deepStrictEqual(data.detail, { table: 'events' });
    });

    it('should omit detail field when not provided', () => {
      emitter.emit('profiling', 'Working', 0.3);

      const dataLine = calls.write[0].split('\n').find((l) => l.startsWith('data: '));
      const data = JSON.parse(dataLine.replace('data: ', ''));
      assert.strictEqual(data.detail, undefined);
    });

    it('should write complete event and end response on complete()', () => {
      const payload = { cubes: [], summary: {} };
      emitter.complete(payload);

      assert.strictEqual(calls.write.length, 1);
      const written = calls.write[0];
      assert.ok(written.startsWith('event: complete\n'));

      const dataLine = written.split('\n').find((l) => l.startsWith('data: '));
      const data = JSON.parse(dataLine.replace('data: ', ''));
      assert.deepStrictEqual(data, payload);
      assert.strictEqual(calls.end, 1);
    });

    it('should not call res.json on complete', () => {
      emitter.complete({ result: 'ok' });
      assert.strictEqual(calls.json.length, 0);
    });
  });

  describe('error event format', () => {
    it('should write error event with message in SSE mode', () => {
      const { res, calls } = mockRes();
      const emitter = createProgressEmitter(res, 'text/event-stream');

      emitter.error('Something failed', 'profiling');

      assert.strictEqual(calls.write.length, 1);
      const written = calls.write[0];
      assert.ok(written.startsWith('event: error\n'));

      const dataLine = written.split('\n').find((l) => l.startsWith('data: '));
      const data = JSON.parse(dataLine.replace('data: ', ''));
      assert.strictEqual(data.error, 'Something failed');
      assert.strictEqual(data.step, 'profiling');
      assert.strictEqual(calls.end, 1);
    });

    it('should omit step from error data when not provided', () => {
      const { res, calls } = mockRes();
      const emitter = createProgressEmitter(res, 'text/event-stream');

      emitter.error('Connection lost');

      const dataLine = calls.write[0].split('\n').find((l) => l.startsWith('data: '));
      const data = JSON.parse(dataLine.replace('data: ', ''));
      assert.strictEqual(data.error, 'Connection lost');
      assert.strictEqual(data.step, undefined);
    });

    it('should return error as JSON with status 500 in non-SSE mode', () => {
      const { res, calls } = mockRes();
      const emitter = createProgressEmitter(res, 'application/json');

      emitter.error('Bad request', 'validation');

      assert.deepStrictEqual(calls.status, [500]);
      assert.strictEqual(calls.json.length, 1);
      assert.deepStrictEqual(calls.json[0], { error: 'Bad request', step: 'validation' });
    });
  });

  describe('no-op mode (non-SSE Accept header)', () => {
    let emitter;
    let res;
    let calls;

    beforeEach(() => {
      ({ res, calls } = mockRes());
      emitter = createProgressEmitter(res, 'application/json');
    });

    it('should set isStreaming to false', () => {
      assert.strictEqual(emitter.isStreaming, false);
    });

    it('should not set any headers', () => {
      assert.strictEqual(calls.setHeader.length, 0);
    });

    it('should not write anything on emit()', () => {
      emitter.emit('profiling', 'Profiling tables', 0.5);
      assert.strictEqual(calls.write.length, 0);
    });

    it('should call res.json on complete()', () => {
      const payload = { cubes: [{ name: 'test' }] };
      emitter.complete(payload);
      assert.strictEqual(calls.json.length, 1);
      assert.deepStrictEqual(calls.json[0], payload);
    });

    it('should not call res.end or res.write on complete()', () => {
      emitter.complete({ ok: true });
      assert.strictEqual(calls.end, 0);
      assert.strictEqual(calls.write.length, 0);
    });
  });

  describe('edge cases', () => {
    it('should treat undefined acceptHeader as non-SSE', () => {
      const { res, calls } = mockRes();
      const emitter = createProgressEmitter(res, undefined);
      assert.strictEqual(emitter.isStreaming, false);
      assert.strictEqual(calls.setHeader.length, 0);
    });

    it('should treat null acceptHeader as non-SSE', () => {
      const { res, calls } = mockRes();
      const emitter = createProgressEmitter(res, null);
      assert.strictEqual(emitter.isStreaming, false);
    });

    it('should detect text/event-stream within a complex Accept header', () => {
      const { res } = mockRes();
      const emitter = createProgressEmitter(res, 'text/event-stream, application/json');
      assert.strictEqual(emitter.isStreaming, true);
    });
  });
});
