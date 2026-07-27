import type { Readable } from "node:stream";
import { AbstractMessageReader, Disposable, type DataCallback, type Message } from "vscode-jsonrpc/node";

/**
 * Bounds on what may be retained while a frame is still incomplete. There is no separate cap on the
 * number of buffered frames: the parser drains every complete frame from the buffer as soon as it
 * arrives, so at most one incomplete frame is ever held, and these byte limits are what bound it.
 * A count of frames per chunk would only measure throughput, which is not a memory risk.
 */
export interface ReaderLimits { maxHeaderBytes: number; maxBodyBytes: number }

export class BoundedStreamMessageReader extends AbstractMessageReader {
  private buffer = Buffer.alloc(0);
  private callback?: DataCallback;
  private disposed = false;
  private listening = false;

  constructor(private readonly stream: Readable, private readonly limits: ReaderLimits) { super(); }

  listen(callback: DataCallback): Disposable {
    if (this.listening) throw new Error("BoundedStreamMessageReader can listen only once");
    this.listening = true;
    this.callback = callback;
    this.stream.on("data", this.onData);
    this.stream.once("end", this.handleClose);
    this.stream.once("close", this.handleClose);
    this.stream.once("error", this.handleError);
    return Disposable.create(() => this.detach());
  }

  override dispose(): void { if (this.disposed) return; this.disposed = true; this.detach(); this.buffer = Buffer.alloc(0); super.dispose(); }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.disposed) return;
    try {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const maxRetained = this.limits.maxHeaderBytes + this.limits.maxBodyBytes;
      let offset = 0;
      while (offset < incoming.length) {
        const capacity = maxRetained - this.buffer.length;
        if (capacity <= 0) throw new Error("LSP input buffer limit exceeded");
        const end = Math.min(incoming.length, offset + capacity);
        const slice = incoming.subarray(offset, end);
        this.buffer = this.buffer.length ? Buffer.concat([this.buffer, slice]) : Buffer.from(slice);
        offset = end;
        this.parse();
      }
    } catch (error) { this.fail(error); }
  };

  private parse(): void {
    while (this.buffer.length) {
      const separator = this.buffer.indexOf("\r\n\r\n");
      if (separator < 0) {
        if (this.buffer.length > this.limits.maxHeaderBytes) throw new Error("LSP frame header limit exceeded");
        return;
      }
      if (separator > this.limits.maxHeaderBytes) throw new Error("LSP frame header limit exceeded");
      const header = this.buffer.subarray(0, separator).toString("ascii");
      const lengths = [...header.matchAll(/(?:^|\r\n)Content-Length:\s*([0-9]+)\s*(?=\r\n|$)/gi)];
      if (lengths.length !== 1) throw new Error("LSP frame requires exactly one Content-Length header");
      const length = Number(lengths[0]![1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.limits.maxBodyBytes) throw new Error(`Invalid or oversized LSP Content-Length: ${length}`);
      const bodyStart = separator + 4;
      if (this.buffer.length - bodyStart < length) return;
      const body = this.buffer.subarray(bodyStart, bodyStart + length);
      this.buffer = this.buffer.subarray(bodyStart + length);
      let message: unknown;
      try { message = JSON.parse(body.toString("utf8")); } catch { throw new Error("Malformed JSON in LSP frame"); }
      if (!message || typeof message !== "object" || (message as { jsonrpc?: unknown }).jsonrpc !== "2.0") throw new Error("Malformed JSON-RPC message");
      this.callback?.(message as Message);
    }
  }

  private readonly handleClose = (): void => { if (!this.disposed) this.fireClose(); };
  private readonly handleError = (error: Error): void => this.fail(error);
  private fail(error: unknown): void { this.fireError(error instanceof Error ? error : new Error(String(error))); this.dispose(); }
  private detach(): void {
    this.stream.off("data", this.onData);
    this.stream.off("end", this.handleClose);
    this.stream.off("close", this.handleClose);
    this.stream.off("error", this.handleError);
  }
}
