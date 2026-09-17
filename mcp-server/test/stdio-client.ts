import type { Subprocess } from "bun";

type Pending = {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
};

/**
 * 依存なしの最小 MCP クライアント。stdio 上の改行区切り JSON-RPC を読み書きする。
 */
export class StdioClient {
  private readonly proc: Subprocess<"pipe", "pipe", "pipe">;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buffer = "";
  readonly notifications: Record<string, unknown>[] = [];
  readonly stderr: string[] = [];

  constructor(command: string[], env: Record<string, string>) {
    this.proc = Bun.spawn(command, {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, ...env },
    });
    void this.readLoop();
    void this.readStderr();
  }

  private async readLoop(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.buffer += decoder.decode(chunk, { stream: true });
      let newline = this.buffer.indexOf("\n");
      while (newline !== -1) {
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        newline = this.buffer.indexOf("\n");
        if (line !== "") this.dispatch(line);
      }
    }
  }

  private async readStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      this.stderr.push(decoder.decode(chunk, { stream: true }));
    }
  }

  private dispatch(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      this.stderr.push(`stdout に JSON 以外が出力されました: ${line}`);
      return;
    }

    if (typeof message.id === "number" && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) {
        const error = message.error as { message?: string };
        entry?.reject(new Error(error.message ?? JSON.stringify(message.error)));
      } else {
        entry?.resolve((message.result ?? {}) as Record<string, unknown>);
      }
      return;
    }

    if (typeof message.method === "string" && message.id === undefined) {
      this.notifications.push(message);
    }
  }

  private write(payload: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(payload)}\n`);
    this.proc.stdin.flush();
  }

  request(method: string, params?: Record<string, unknown>, timeoutMs = 20_000): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`${method} がタイムアウトしました\nstderr:\n${this.stderr.join("")}`));
        }
      }, timeoutMs);
    });
    this.write({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) });
    return promise;
  }

  notify(method: string, params?: Record<string, unknown>): void {
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  async close(): Promise<void> {
    this.proc.stdin.end();
    this.proc.kill();
    await this.proc.exited;
  }
}
