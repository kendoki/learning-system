import assert from "node:assert/strict";
import test from "node:test";

import { SseDecoder } from "../src/lib/api/sse.ts";

test("decodes events across fragmented CRLF boundaries", () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push("event: planning_started\r"), []);
  assert.deepEqual(decoder.push("\ndata: {\"kind\":\"planning_started\"}\r"), []);
  assert.deepEqual(decoder.push("\n\r"), []);
  assert.deepEqual(decoder.push("\n"), [
    {
      event: "planning_started",
      data: "{\"kind\":\"planning_started\"}",
    },
  ]);
  decoder.finish();
});

test("ignores complete keep-alive comments", () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push(": ping\r\n\r\n"), []);
  assert.deepEqual(decoder.push("event: proposal_ready\ndata: {}\n\n"), [
    { event: "proposal_ready", data: "{}" },
  ]);
  decoder.finish();
});

test("joins repeated data fields and rejects a truncated frame", () => {
  const decoder = new SseDecoder();

  assert.deepEqual(decoder.push("event: note\ndata: first\ndata: second\n\n"), [
    { event: "note", data: "first\nsecond" },
  ]);
  decoder.push("event: unfinished\ndata: {}");

  assert.throws(() => {
    decoder.finish();
  }, /incomplete SSE frame/);
});
