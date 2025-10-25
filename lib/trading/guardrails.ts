import {
  type ClosedTrade,
  type FootprintSignal,
  type RiskGuardrailBlock,
  type RiskGuardrailSettings,
  type RiskGuardrailState,
  type RiskGuardrailStatus,
  type TradingSession,
} from "@/types";

const PRICE_EPSILON = 1e-8;
const MAX_LOG_ENTRIES = 60;
const SESSION_KEYS: TradingSession[] = ["asia", "eu", "us", "other"];

const SESSION_LABELS: Record<TradingSession, string> = {
  asia: "Asia",
  eu: "Europa",
  us: "Estados Unidos",
  other: "Otras",
};

interface ParsedNewsWindow {
  id: string;
  label: string;
  start: number;
  end: number;
}

export const DEFAULT_GUARDRAIL_SETTINGS: RiskGuardrailSettings = {
  enabled: false,
  maxDailyLossR: null,
  maxTradesPerDay: null,
  maxConsecutiveLosses: null,
  perSessionMaxTrades: {},
  perSessionMaxLossR: {},
  lossCooldownTrigger: 0,
  lossCooldownMinutes: 15,
  dailyStopCooldownMinutes: 1440,
  allowedSessions: ["eu", "us"],
  newsWindows: [],
};

export function cloneGuardrailSettings(settings: RiskGuardrailSettings): RiskGuardrailSettings {
  return {
    ...settings,
    perSessionMaxTrades: { ...settings.perSessionMaxTrades },
    perSessionMaxLossR: { ...settings.perSessionMaxLossR },
    allowedSessions: [...settings.allowedSessions],
    newsWindows: settings.newsWindows.map((window) => ({ ...window })),
  };
}

function createSessionStats(): RiskGuardrailState["sessionStats"] {
  return {
    asia: { trades: 0, netR: 0, losses: 0 },
    eu: { trades: 0, netR: 0, losses: 0 },
    us: { trades: 0, netR: 0, losses: 0 },
    other: { trades: 0, netR: 0, losses: 0 },
  };
}

function getDayKey(timestamp: number): string {
  const date = new Date(timestamp);
  const year = date.getUTCFullYear();
  const month = `${date.getUTCMonth() + 1}`.padStart(2, "0");
  const day = `${date.getUTCDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function computeResetAt(now: number): number {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.getTime();
}

function sanitizeAllowedSessions(input: TradingSession[]): TradingSession[] {
  if (!Array.isArray(input) || !input.length) {
    return [];
  }
  const unique = new Set<TradingSession>();
  for (const session of input) {
    if (SESSION_KEYS.includes(session)) {
      unique.add(session);
    }
  }
  return [...unique];
}

function sanitizePerSessionValues(input?: Partial<Record<TradingSession, number | null>>): Partial<Record<TradingSession, number | null>> {
  const result: Partial<Record<TradingSession, number | null>> = {};
  if (!input) {
    return result;
  }
  for (const key of SESSION_KEYS) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      const value = input[key];
      if (value === null || value === undefined) {
        result[key] = null;
      } else if (Number.isFinite(value) && value >= 0) {
        result[key] = value;
      }
    }
  }
  return result;
}

function sanitizeNewsWindows(windows: RiskGuardrailSettings["newsWindows"]): ParsedNewsWindow[] {
  if (!Array.isArray(windows) || !windows.length) {
    return [];
  }
  const result: ParsedNewsWindow[] = [];
  for (const window of windows) {
    if (!window || typeof window !== "object") {
      continue;
    }
    const start = Date.parse(window.start);
    const end = Date.parse(window.end);
    if (!Number.isFinite(start) || !Number.isFinite(end)) {
      continue;
    }
    if (end <= start) {
      continue;
    }
    result.push({
      id: window.id || `${start}-${end}`,
      label: window.label?.trim() ?? "",
      start,
      end,
    });
  }
  result.sort((a, b) => a.start - b.start);
  return result;
}

function blocksEqual(a: RiskGuardrailBlock[], b: RiskGuardrailBlock[]): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let index = 0; index < a.length; index += 1) {
    const blockA = a[index];
    const blockB = b[index];
    if (blockA.source !== blockB.source) {
      return false;
    }
    if (blockA.session !== blockB.session) {
      return false;
    }
    if (blockA.until !== blockB.until) {
      return false;
    }
    if (blockA.reason !== blockB.reason) {
      return false;
    }
  }
  return true;
}

function cloneBlocks(blocks: RiskGuardrailBlock[]): RiskGuardrailBlock[] {
  return blocks.map((block) => ({ ...block }));
}

function formatTime(until: number | null): string {
  if (!until) {
    return "--";
  }
  return new Date(until).toISOString().slice(11, 16);
}

function formatRemaining(now: number, until: number): string {
  const remainingMs = until - now;
  if (remainingMs <= 0) {
    return "0m";
  }
  const minutes = Math.round(remainingMs / 60_000);
  if (minutes >= 90) {
    const hours = minutes / 60;
    return `${hours.toFixed(1)}h`;
  }
  return `${minutes}m`;
}

export class RiskGuardrailManager {
  private settings: RiskGuardrailSettings;

  private state: RiskGuardrailState;

  private parsedNews: ParsedNewsWindow[] = [];

  private lastLossCooldownTrigger = 0;

  private dailyStopTriggered = false;

  constructor(options?: { settings?: Partial<RiskGuardrailSettings>; now?: number }) {
    const now = options?.now ?? Date.now();
    this.settings = this.mergeSettings(options?.settings);
    this.parsedNews = sanitizeNewsWindows(this.settings.newsWindows);
    const day = getDayKey(now);
    this.state = {
      status: "ok",
      day,
      resetAt: computeResetAt(now),
      tradesToday: 0,
      netRToday: 0,
      consecutiveLosses: 0,
      sessionStats: createSessionStats(),
      activeBlocks: [],
      cooldowns: {
        lossUntil: null,
        dailyStopUntil: null,
      },
      lastBlock: null,
      logs: [],
    };
  }

  getSettings(): RiskGuardrailSettings {
    return cloneGuardrailSettings(this.settings);
  }

  getState(): RiskGuardrailState {
    return {
      status: this.state.status,
      day: this.state.day,
      resetAt: this.state.resetAt,
      tradesToday: this.state.tradesToday,
      netRToday: this.state.netRToday,
      consecutiveLosses: this.state.consecutiveLosses,
      sessionStats: {
        asia: { ...this.state.sessionStats.asia },
        eu: { ...this.state.sessionStats.eu },
        us: { ...this.state.sessionStats.us },
        other: { ...this.state.sessionStats.other },
      },
      activeBlocks: cloneBlocks(this.state.activeBlocks),
      cooldowns: { ...this.state.cooldowns },
      lastBlock: this.state.lastBlock ? { ...this.state.lastBlock } : null,
      logs: this.state.logs.map((entry) => ({ ...entry })),
    };
  }

  updateSettings(partial: Partial<RiskGuardrailSettings>): boolean {
    const merged = this.mergeSettings({ ...this.settings, ...partial });
    const changed = JSON.stringify(merged) !== JSON.stringify(this.settings);
    if (!changed) {
      return false;
    }
    this.settings = merged;
    this.parsedNews = sanitizeNewsWindows(this.settings.newsWindows);
    const now = Date.now();
    this.ensureDay(now);
    const blocksChanged = this.refreshBlocks(now);
    if (!this.settings.enabled) {
      this.state.lastBlock = null;
    }
    return blocksChanged || changed;
  }

  ensureDay(now: number): void {
    const day = getDayKey(now);
    if (day === this.state.day) {
      return;
    }
    this.applyReset(now, "Reset diario automático");
  }

  reset(now: number = Date.now()): void {
    this.applyReset(now, "Reset manual");
  }

  private applyReset(now: number, reason: string): void {
    const day = getDayKey(now);
    this.state.day = day;
    this.state.resetAt = computeResetAt(now);
    this.state.tradesToday = 0;
    this.state.netRToday = 0;
    this.state.consecutiveLosses = 0;
    this.state.sessionStats = createSessionStats();
    this.state.activeBlocks = [];
    this.state.cooldowns = {
      lossUntil: null,
      dailyStopUntil: null,
    };
    this.state.status = "ok";
    this.state.lastBlock = null;
    this.lastLossCooldownTrigger = 0;
    this.dailyStopTriggered = false;
    this.appendLog({
      timestamp: now,
      source: "cooldown",
      message: reason,
      auto: true,
    });
  }

  evaluateEntry(args: { now: number; signal?: FootprintSignal | null; auto: boolean }): {
    allowed: boolean;
    block?: RiskGuardrailBlock;
    changed: boolean;
  } {
    const { now, signal, auto } = args;
    this.ensureDay(now);
    const blocksChanged = this.refreshBlocks(now);

    if (!this.settings.enabled) {
      return { allowed: true, changed: blocksChanged };
    }

    let allowed = true;
    let blocking: RiskGuardrailBlock | undefined;

    if (this.state.activeBlocks.length) {
      blocking = this.findBlockingBlock(signal ?? null, this.state.activeBlocks);
      allowed = !blocking;
    }

    if (allowed && signal) {
      const session = signal.session;
      if (this.settings.allowedSessions.length && !this.settings.allowedSessions.includes(session)) {
        allowed = false;
        blocking = {
          source: "session-window",
          reason: `Sesión ${SESSION_LABELS[session]} no permitida`,
          until: this.state.resetAt,
          session,
        };
      }
    }

    if (!allowed && blocking) {
      this.state.lastBlock = {
        ...blocking,
        timestamp: now,
        signalId: signal?.id,
        auto,
      };
      this.appendLog({
        timestamp: now,
        source: blocking.source,
        message: blocking.reason,
        signalId: signal?.id,
        auto,
      });
      return {
        allowed: false,
        block: blocking,
        changed: true,
      };
    }

    if (blocksChanged) {
      return { allowed: true, changed: true };
    }

    return { allowed: true, changed: false };
  }

  recordClosedTrade(trade: ClosedTrade): boolean {
    const now = trade.exitTime ?? Date.now();
    this.ensureDay(now);

    this.state.tradesToday += 1;
    this.state.netRToday += trade.realizedR;

    const sessionStats = this.state.sessionStats[trade.session] ?? (this.state.sessionStats[trade.session] = { trades: 0, netR: 0, losses: 0 });
    sessionStats.trades += 1;
    sessionStats.netR += trade.realizedR;

    if (trade.realizedR < -PRICE_EPSILON) {
      this.state.consecutiveLosses += 1;
      sessionStats.losses += 1;
    } else if (trade.realizedR > PRICE_EPSILON) {
      this.state.consecutiveLosses = 0;
      this.lastLossCooldownTrigger = 0;
    } else {
      this.state.consecutiveLosses = 0;
      this.lastLossCooldownTrigger = 0;
    }

    if (this.settings.enabled) {
      this.evaluateLossCooldown(now);
      this.evaluateDailyStop(now);
    }

    const blocksChanged = this.refreshBlocks(now);
    return blocksChanged || this.settings.enabled;
  }

  private mergeSettings(partial?: Partial<RiskGuardrailSettings>): RiskGuardrailSettings {
    const base = cloneGuardrailSettings(DEFAULT_GUARDRAIL_SETTINGS);
    if (!partial) {
      return base;
    }
    const merged: RiskGuardrailSettings = {
      ...base,
      ...partial,
      perSessionMaxTrades: {
        ...base.perSessionMaxTrades,
        ...sanitizePerSessionValues(partial.perSessionMaxTrades),
      },
      perSessionMaxLossR: {
        ...base.perSessionMaxLossR,
        ...sanitizePerSessionValues(partial.perSessionMaxLossR),
      },
      allowedSessions: sanitizeAllowedSessions(partial.allowedSessions ?? base.allowedSessions),
      newsWindows: partial.newsWindows ? partial.newsWindows.map((window) => ({ ...window })) : base.newsWindows,
    };

    if (merged.maxDailyLossR !== null && merged.maxDailyLossR < PRICE_EPSILON) {
      merged.maxDailyLossR = null;
    }
    if (merged.maxTradesPerDay !== null && merged.maxTradesPerDay < 1) {
      merged.maxTradesPerDay = null;
    }
    if (merged.maxConsecutiveLosses !== null && merged.maxConsecutiveLosses < 1) {
      merged.maxConsecutiveLosses = null;
    }
    merged.lossCooldownTrigger = Math.max(0, Math.floor(merged.lossCooldownTrigger));
    merged.lossCooldownMinutes = Math.max(0, Math.round(merged.lossCooldownMinutes));
    merged.dailyStopCooldownMinutes = Math.max(0, Math.round(merged.dailyStopCooldownMinutes));

    return merged;
  }

  private refreshBlocks(now: number): boolean {
    if (!this.settings.enabled) {
      if (this.state.activeBlocks.length || this.state.status !== "ok") {
        this.state.activeBlocks = [];
        this.state.status = "ok";
        return true;
      }
      return false;
    }

    if (this.state.cooldowns.lossUntil !== null && now >= this.state.cooldowns.lossUntil - 500) {
      this.state.cooldowns.lossUntil = null;
      this.lastLossCooldownTrigger = this.state.consecutiveLosses;
    }
    if (this.state.cooldowns.dailyStopUntil !== null && now >= this.state.cooldowns.dailyStopUntil - 500) {
      this.state.cooldowns.dailyStopUntil = null;
    }

    const { blocks, status } = this.computeGlobalBlocks(now);
    const changed = !blocksEqual(this.state.activeBlocks, blocks) || status !== this.state.status;
    if (changed) {
      this.state.activeBlocks = blocks;
      this.state.status = status;
    }
    return changed;
  }

  private computeGlobalBlocks(now: number): { blocks: RiskGuardrailBlock[]; status: RiskGuardrailStatus } {
    const blocks: RiskGuardrailBlock[] = [];

    const news = this.getActiveNewsWindow(now);
    if (news) {
      blocks.push({
        source: "news",
        reason: news.label ? `Ventana de noticias: ${news.label}` : "Ventana de noticias activa",
        until: news.end,
      });
    }

    if (this.state.cooldowns.lossUntil !== null && now < this.state.cooldowns.lossUntil) {
      blocks.push({
        source: "cooldown",
        reason: `Cooldown por pérdidas (${formatRemaining(now, this.state.cooldowns.lossUntil)} restantes)` ,
        until: this.state.cooldowns.lossUntil,
      });
    }

    if (this.state.cooldowns.dailyStopUntil !== null && now < this.state.cooldowns.dailyStopUntil) {
      blocks.push({
        source: "cooldown",
        reason: `Cooldown daily stop hasta ${formatTime(this.state.cooldowns.dailyStopUntil)} UTC`,
        until: this.state.cooldowns.dailyStopUntil,
      });
    }

    if (this.settings.maxDailyLossR !== null && this.state.netRToday <= -this.settings.maxDailyLossR) {
      blocks.push({
        source: "daily-loss",
        reason: `Pérdida diaria máxima alcanzada (${this.state.netRToday.toFixed(2)}R)`,
        until: this.state.resetAt,
      });
    }

    if (this.settings.maxTradesPerDay !== null && this.state.tradesToday >= this.settings.maxTradesPerDay) {
      blocks.push({
        source: "daily-trades",
        reason: `Límite diario de trades alcanzado (${this.state.tradesToday})`,
        until: this.state.resetAt,
      });
    }

    if (
      this.settings.maxConsecutiveLosses !== null &&
      this.state.consecutiveLosses >= this.settings.maxConsecutiveLosses
    ) {
      blocks.push({
        source: "max-consecutive-losses",
        reason: `Máximo de pérdidas consecutivas alcanzado (${this.state.consecutiveLosses})`,
        until: this.state.resetAt,
      });
    }

    for (const session of SESSION_KEYS) {
      const stats = this.state.sessionStats[session];
      if (!stats) {
        continue;
      }
      const maxTrades = this.settings.perSessionMaxTrades[session];
      if (maxTrades !== null && maxTrades !== undefined && stats.trades >= maxTrades) {
        blocks.push({
          source: "session-trades",
          reason: `Sesión ${SESSION_LABELS[session]} limitada (${stats.trades}/${maxTrades})`,
          until: this.state.resetAt,
          session,
        });
      }
      const maxLoss = this.settings.perSessionMaxLossR[session];
      if (maxLoss !== null && maxLoss !== undefined && stats.netR <= -maxLoss) {
        blocks.push({
          source: "session-loss",
          reason: `Límite de pérdida en ${SESSION_LABELS[session]} alcanzado (${stats.netR.toFixed(2)}R)`,
          until: this.state.resetAt,
          session,
        });
      }
    }

    if (this.settings.allowedSessions.length) {
      for (const session of SESSION_KEYS) {
        if (!this.settings.allowedSessions.includes(session)) {
          blocks.push({
            source: "session-window",
            reason: `Sesión ${SESSION_LABELS[session]} deshabilitada`,
            until: this.state.resetAt,
            session,
          });
        }
      }
    }

    let status: RiskGuardrailStatus = "ok";
    if (blocks.some((block) => block.source === "daily-loss" || block.source === "daily-trades" || block.source === "max-consecutive-losses")) {
      status = "locked";
    } else if (blocks.some((block) => block.source === "cooldown")) {
      status = "cooldown";
    } else if (blocks.length) {
      status = "limited";
    }

    return { blocks, status };
  }

  private findBlockingBlock(signal: FootprintSignal | null, blocks: RiskGuardrailBlock[]): RiskGuardrailBlock | undefined {
    if (!blocks.length) {
      return undefined;
    }
    for (const block of blocks) {
      if (!block.session) {
        return block;
      }
      if (signal && block.session === signal.session) {
        return block;
      }
    }
    return undefined;
  }

  private getActiveNewsWindow(now: number): ParsedNewsWindow | null {
    for (const window of this.parsedNews) {
      if (now >= window.start && now <= window.end) {
        return window;
      }
    }
    return null;
  }

  private evaluateLossCooldown(now: number): void {
    if (this.settings.lossCooldownTrigger <= 0 || this.settings.lossCooldownMinutes <= 0) {
      return;
    }
    if (this.state.consecutiveLosses < this.settings.lossCooldownTrigger) {
      return;
    }
    if (this.state.consecutiveLosses <= this.lastLossCooldownTrigger) {
      return;
    }
    const minutes = Math.max(1, this.settings.lossCooldownMinutes);
    const until = now + minutes * 60_000;
    this.state.cooldowns.lossUntil = Math.max(this.state.cooldowns.lossUntil ?? 0, until);
    this.lastLossCooldownTrigger = this.state.consecutiveLosses;
    this.appendLog({
      timestamp: now,
      source: "cooldown",
      message: `Cooldown de ${minutes}m tras ${this.state.consecutiveLosses} pérdidas consecutivas`,
      auto: true,
    });
  }

  private evaluateDailyStop(now: number): void {
    if (this.settings.maxDailyLossR === null) {
      return;
    }
    if (this.state.netRToday > -this.settings.maxDailyLossR) {
      return;
    }
    if (!this.dailyStopTriggered) {
      this.dailyStopTriggered = true;
      if (this.settings.dailyStopCooldownMinutes > 0) {
        const until = now + this.settings.dailyStopCooldownMinutes * 60_000;
        this.state.cooldowns.dailyStopUntil = Math.min(this.state.resetAt, until);
      } else {
        this.state.cooldowns.dailyStopUntil = this.state.resetAt;
      }
      this.appendLog({
        timestamp: now,
        source: "daily-loss",
        message: `Daily stop activado (${this.state.netRToday.toFixed(2)}R)`,
        auto: true,
      });
    }
  }

  private appendLog(entry: RiskGuardrailState["logs"][number]): void {
    this.state.logs.push(entry);
    if (this.state.logs.length > MAX_LOG_ENTRIES) {
      this.state.logs.splice(0, this.state.logs.length - MAX_LOG_ENTRIES);
    }
  }
}
