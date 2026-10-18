// Limits for the public question API. Each question costs paid model calls, so requests over a
// limit are refused before planning. State is in memory: one server process, reset on restart.

export type LimitConfig = {
  maxBodyBytes: number;
  perClient: { limit: number; windowMs: number };
  maxConcurrent: number;
  dailyBudget: number;
  // Only behind a proxy that sets X-Forwarded-For can the header be trusted; otherwise clients
  // could pick their own key, so everyone shares one.
  trustProxy: boolean;
};

export type Admission =
  | { ok: true; release: () => void }
  | { ok: false; reason: "concurrency" | "client_rate" | "daily_budget"; retryAfterSeconds: number; message: string };

const DAY_MS = 86_400_000;
const MAX_TRACKED_CLIENTS = 10_000;

export class QuestionLimiter {
  private inFlight = 0;
  private readonly recent = new Map<string, number[]>();
  private day = -1;
  private usedToday = 0;

  constructor(
    readonly config: LimitConfig,
    private readonly now: () => number = Date.now,
  ) {}

  clientKey(headers: Headers): string {
    if (!this.config.trustProxy) return "shared";
    const first = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    return first ? `ip:${first.slice(0, 64)}` : "shared";
  }

  // Checks every limit first and records usage only when all pass.
  admit(key: string): Admission {
    const now = this.now();
    if (this.inFlight >= this.config.maxConcurrent) {
      return { ok: false, reason: "concurrency", retryAfterSeconds: 5, message: "The demo is answering other questions; try again in a few seconds." };
    }

    const { limit, windowMs } = this.config.perClient;
    const times = (this.recent.get(key) ?? []).filter((time) => time > now - windowMs);
    if (times.length >= limit) {
      const retry = Math.ceil(((times[0] ?? now) + windowMs - now) / 1000);
      return { ok: false, reason: "client_rate", retryAfterSeconds: Math.max(1, retry), message: `At most ${limit} question${limit === 1 ? "" : "s"} per ${Math.round(windowMs / 60_000)} minutes; try again later.` };
    }

    const today = Math.floor(now / DAY_MS);
    if (today !== this.day) {
      this.day = today;
      this.usedToday = 0;
    }
    if (this.usedToday >= this.config.dailyBudget) {
      return { ok: false, reason: "daily_budget", retryAfterSeconds: Math.max(1, Math.ceil(((today + 1) * DAY_MS - now) / 1000)), message: "The demo's daily question budget is used up; try again tomorrow (UTC)." };
    }

    if (!this.recent.has(key) && this.recent.size >= MAX_TRACKED_CLIENTS) this.forgetIdle(now);
    this.recent.set(key, [...times, now]);
    this.usedToday++;
    this.inFlight++;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        this.inFlight--;
      },
    };
  }

  private forgetIdle(now: number) {
    for (const [key, times] of this.recent) {
      if (!times.some((time) => time > now - this.config.perClient.windowMs)) this.recent.delete(key);
    }
  }
}
