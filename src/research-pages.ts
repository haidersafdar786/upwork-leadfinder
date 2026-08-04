import type { Browser, BrowserContext, Page } from "playwright";
import { cancellationReason, checkpoint, currentCancellationSignal } from "./cancellation.ts";
import { newBackgroundPage } from "./upwork-browser.ts";
import type { HttpUrl } from "./types.ts";

export interface ResearchPageLease {
  readonly page: Page;
  release(): Promise<void>;
}

export interface ResearchPagePoolOptions {
  browser: Browser;
  context: BrowserContext;
  initialUrl: HttpUrl;
  capacity: number;
}

interface PageSlot {
  page: Page | null;
  busy: boolean;
}

interface Waiter {
  active: boolean;
  resolve: (lease: ResearchPageLease) => void;
  reject: (error: unknown) => void;
  onAbort: () => void;
}

export class ResearchPagePool {
  private readonly browser: Browser;
  private readonly context: BrowserContext;
  private readonly initialUrl: HttpUrl;
  private readonly signal = currentCancellationSignal();
  private readonly slots: PageSlot[];
  private readonly waiters: Waiter[] = [];
  private readonly abort = () => { void this.close(); };
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(options: ResearchPagePoolOptions) {
    this.browser = options.browser;
    this.context = options.context;
    this.initialUrl = options.initialUrl;
    const capacity = Number.isFinite(options.capacity) ? Math.max(1, Math.floor(options.capacity)) : 1;
    this.slots = Array.from({ length: capacity }, () => ({ page: null, busy: false }));
    this.signal?.addEventListener("abort", this.abort, { once: true });
  }

  async acquire(): Promise<ResearchPageLease> {
    checkpoint(this.signal);
    const slot = this.freeSlot();
    if (slot) return this.acquireSlot(slot);

    return new Promise<ResearchPageLease>((resolve, reject) => {
      let waiter: Waiter;
      const onAbort = () => {
        if (!waiter.active) return;
        waiter.active = false;
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(this.cancellationError("Run cancelled"));
        this.dispatch();
      };
      waiter = { active: true, resolve, reject, onAbort };
      this.waiters.push(waiter);
      this.signal?.addEventListener("abort", onAbort, { once: true });
      if (this.signal?.aborted) onAbort();
    });
  }

  async close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.signal?.removeEventListener("abort", this.abort);
    const error = this.cancellationError("Research page pool is closed");
    for (const waiter of this.waiters.splice(0)) {
      if (!waiter.active) continue;
      waiter.active = false;
      this.signal?.removeEventListener("abort", waiter.onAbort);
      waiter.reject(error);
    }
    const pages = this.slots.map((slot) => {
      const page = slot.page;
      slot.page = null;
      return page?.close().catch(() => {});
    });
    this.closePromise = Promise.all(pages).then(() => undefined);
    return this.closePromise;
  }

  private freeSlot(): PageSlot | null {
    return this.slots.find((slot) => !slot.busy) || null;
  }

  private async acquireSlot(slot: PageSlot): Promise<ResearchPageLease> {
    if (this.closed) throw this.cancellationError("Research page pool is closed");
    slot.busy = true;
    try {
      checkpoint(this.signal);
      if (!slot.page || slot.page.isClosed()) slot.page = await newBackgroundPage(this.browser, this.context, this.initialUrl);
      if (this.closed) {
        await slot.page?.close().catch(() => {});
        slot.page = null;
        throw this.cancellationError("Research page pool is closed");
      }
      const page = slot.page;
      if (!page) throw new Error("Research page pool failed to acquire a page");
      let released = false;
      return {
        page,
        release: async () => {
          if (released) return;
          released = true;
          slot.busy = false;
          if (this.closed) {
            slot.page = null;
            await page.close().catch(() => {});
          }
          this.dispatch();
        },
      } satisfies ResearchPageLease;
    } catch (error) {
      slot.busy = false;
      this.dispatch();
      throw error;
    }
  }

  private dispatch(): void {
    while (!this.closed && this.waiters.length) {
      const slot = this.freeSlot();
      if (!slot) return;
      const waiter = this.waiters.shift();
      if (!waiter) return;
      if (!waiter.active) continue;
      waiter.active = false;
      this.signal?.removeEventListener("abort", waiter.onAbort);
      void this.acquireSlot(slot).then(waiter.resolve, waiter.reject);
    }
  }

  private cancellationError(message: string): Error {
    return this.signal ? cancellationReason(this.signal, new Error(message)) : new Error(message);
  }
}
