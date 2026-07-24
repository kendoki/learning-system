/**
 * Incremental decoder for server-sent event frames.
 *
 * Fetch body chunks can split anywhere, including between the CR and
 * LF of an event boundary. The decoder retains incomplete text until
 * a full blank-line delimiter arrives.
 */

export type SseFrame = {
  event: string | undefined;
  data: string;
};

const FRAME_BOUNDARY = /\r\n\r\n|\n\n|\r\r/;
const LINE_BOUNDARY = /\r\n|\n|\r/;

export class SseDecoder {
  private buffer = "";

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const frames: SseFrame[] = [];

    for (;;) {
      const boundary = FRAME_BOUNDARY.exec(this.buffer);
      if (boundary === null || boundary.index === undefined) {
        break;
      }

      const rawFrame = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      const frame = parseFrame(rawFrame);
      if (frame !== null) {
        frames.push(frame);
      }
    }

    return frames;
  }

  finish(): void {
    if (this.buffer.trim().length !== 0) {
      throw new Error("Stream ended with an incomplete SSE frame.");
    }
    this.buffer = "";
  }
}

function parseFrame(rawFrame: string): SseFrame | null {
  let event: string | undefined;
  const data: string[] = [];

  for (const line of rawFrame.split(LINE_BOUNDARY)) {
    if (line.length === 0 || line.startsWith(":")) {
      continue;
    }

    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) {
      value = value.slice(1);
    }

    if (field === "event") {
      event = value;
    } else if (field === "data") {
      data.push(value);
    }
  }

  if (data.length === 0) {
    return null;
  }
  return {
    event,
    data: data.join("\n"),
  };
}
