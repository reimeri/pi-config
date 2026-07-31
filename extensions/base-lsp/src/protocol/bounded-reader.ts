import type { Readable } from "node:stream";
import { AbstractMessageReader, Disposable, type DataCallback, type Message } from "vscode-jsonrpc/node";

// Complete frames drain immediately, so byte limits bound the one buffered incomplete frame.
export interface ReaderLimits { maxHeaderBytes: number; maxBodyBytes: number }

const SEPARATOR = "\r\n\r\n";
const INITIAL_CAPACITY = 8 * 1024;

export class BoundedStreamMessageReader extends AbstractMessageReader {
  /** Retain bytes in [start,end); compact only when needed to avoid repeated copying and backing-buffer retention. */
  private buffer = Buffer.alloc(INITIAL_CAPACITY);
  private start = 0;
  private end = 0;
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

  override dispose(): void { if (this.disposed) return; this.disposed = true; this.detach(); this.buffer = Buffer.alloc(0); this.start = 0; this.end = 0; super.dispose(); }

  private readonly onData = (chunk: Buffer | string): void => {
    if (this.disposed) return;
    try {
      const incoming = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const maxRetained = this.limits.maxHeaderBytes + this.limits.maxBodyBytes;
      let offset = 0;
      while (offset < incoming.length) {
        const capacity = maxRetained - (this.end - this.start);
        if (capacity <= 0) throw new Error("LSP input buffer limit exceeded");
        const end = Math.min(incoming.length, offset + capacity);
        this.append(incoming.subarray(offset, end));
        offset = end;
        this.parse();
      }
    } catch (error) { this.fail(error); }
  };

  private append(slice: Buffer): void {
    if (this.end + slice.length > this.buffer.length) this.makeRoom(slice.length);
    slice.copy(this.buffer, this.end);
    this.end += slice.length;
  }

  /** Reclaim the space consumed frames left in front, growing the allocation only if that is not enough. */
  private makeRoom(incoming: number): void {
    const retained = this.end - this.start;
    const required = retained + incoming;
    if (required > this.buffer.length) {
      let capacity = this.buffer.length;
      while (capacity < required) capacity *= 2;
      // `incoming` is limit-clamped; grow until the requested capacity fits.
      capacity = Math.max(required, Math.min(capacity, this.limits.maxHeaderBytes + this.limits.maxBodyBytes));
      const grown = Buffer.alloc(capacity);
      this.buffer.copy(grown, 0, this.start, this.end);
      this.buffer = grown;
    } else if (this.start > 0) {
      this.buffer.copyWithin(0, this.start, this.end);
    }
    this.start = 0;
    this.end = retained;
  }

  private parse(): void {
    while (this.end > this.start) {
      const separator = this.buffer.indexOf(SEPARATOR, this.start);
      // Reject separators beyond `end`; those bytes are stale buffer contents.
      if (separator < 0 || separator + SEPARATOR.length > this.end) {
        if (this.end - this.start > this.limits.maxHeaderBytes) throw new Error("LSP frame header limit exceeded");
        return;
      }
      if (separator - this.start > this.limits.maxHeaderBytes) throw new Error("LSP frame header limit exceeded");
      const header = this.buffer.toString("ascii", this.start, separator);
      const lengths = [...header.matchAll(/(?:^|\r\n)Content-Length:\s*([0-9]+)\s*(?=\r\n|$)/gi)];
      if (lengths.length !== 1) throw new Error("LSP frame requires exactly one Content-Length header");
      const length = Number(lengths[0]![1]);
      if (!Number.isSafeInteger(length) || length < 0 || length > this.limits.maxBodyBytes) throw new Error(`Invalid or oversized LSP Content-Length: ${length}`);
      const bodyStart = separator + SEPARATOR.length;
      if (this.end - bodyStart < length) return;
      const body = this.buffer.toString("utf8", bodyStart, bodyStart + length);
      this.start = bodyStart + length;
      if (this.start === this.end) { this.start = 0; this.end = 0; }
      let message: unknown;
      try { message = JSON.parse(body); } catch { throw new Error("Malformed JSON in LSP frame"); }
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
