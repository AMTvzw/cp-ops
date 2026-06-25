import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import session from "express-session";
import db, { initDb } from "./db";
import { KnexSessionStore } from "./sessionStore";

const defaultTeamTypes = ["Terrein", "Interventie", "DGH", "NDPA", "Dienstleiding"];

const toPositiveInt = (value: unknown): number | null => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  const normalized = Math.trunc(parsed);
  return normalized > 0 ? normalized : null;
};

const toPositiveIntArray = (value: unknown): number[] => {
  if (!Array.isArray(value)) return [];
  const unique = new Set<number>();
  for (const entry of value) {
    const parsed = toPositiveInt(entry);
    if (parsed != null) unique.add(parsed);
  }
  return [...unique];
};

const dateKeyFromLocalDate = (date: Date) => {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
};

const normalizeDateKey = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  return trimmed;
};

const addDaysToDateKey = (dateKey: string, days: number): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateKey);
  if (!match) return dateKey;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const base = new Date(year, month - 1, day);
  base.setDate(base.getDate() + days);
  return dateKeyFromLocalDate(base);
};

const canRoleAccessEventOnDate = (
  role: string | undefined,
  eventDate: unknown,
  eventEndDate: unknown,
  todayKey = dateKeyFromLocalDate(new Date()),
) => {
  if (role !== "OPERATOR" && role !== "VIEWER") return true;

  const startDate = normalizeDateKey(eventDate);
  if (!startDate) return false;

  const configuredEndDate = normalizeDateKey(eventEndDate);
  const endDate = configuredEndDate || startDate;
  const effectiveEndDate = role === "OPERATOR" ? addDaysToDateKey(endDate, 1) : endDate;

  return todayKey >= startDate && todayKey <= effectiveEndDate;
};

const UI_LITERAL_MIN_LENGTH = 2;
const UI_LITERAL_MAX_LENGTH = 300;

const shouldKeepUiLiteral = (value: string) => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.length < UI_LITERAL_MIN_LENGTH || trimmed.length > UI_LITERAL_MAX_LENGTH) return false;
  if (/^[0-9\s.,:/_-]+$/.test(trimmed)) return false;
  if (/^[{}[\]()<>]+$/.test(trimmed)) return false;
  if (/^[.#][a-z0-9_-]+$/i.test(trimmed)) return false;
  return true;
};

const normalizeUiLiteral = (value: string) => value.replace(/\s+/g, " ").trim();

const extractUiLiteralsFromSource = (source: string) => {
  const found = new Set<string>();

  const addCandidate = (raw: string) => {
    const normalized = normalizeUiLiteral(raw);
    if (!shouldKeepUiLiteral(normalized)) return;
    found.add(normalized);
  };

  const textNodeRegex = />\s*([^<>{}\n][^<>{}]*)\s*</g;
  let textMatch: RegExpExecArray | null = null;
  while ((textMatch = textNodeRegex.exec(source)) !== null) {
    addCandidate(textMatch[1]);
  }

  const attrRegex = /(placeholder|title|aria-label|alt|label)\s*=\s*["']([^"']+)["']/g;
  let attrMatch: RegExpExecArray | null = null;
  while ((attrMatch = attrRegex.exec(source)) !== null) {
    addCandidate(attrMatch[2]);
  }

  const dialogRegex = /\b(?:alert|confirm|prompt)\s*\(\s*["'`]([^"'`]+)["'`]/g;
  let dialogMatch: RegExpExecArray | null = null;
  while ((dialogMatch = dialogRegex.exec(source)) !== null) {
    addCandidate(dialogMatch[1]);
  }

  return [...found];
};

const collectUiLiteralCandidates = async () => {
  const srcRoot = path.join(process.cwd(), "src");
  const files: string[] = [];

  const walk = async (dir: string) => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "i18n" || entry.name === "assets") continue;
        await walk(fullPath);
        continue;
      }
      if (!/\.(tsx?|jsx?)$/i.test(entry.name)) continue;
      files.push(fullPath);
    }
  };

  await walk(srcRoot);

  const literals = new Set<string>();
  for (const filePath of files) {
    const content = await fs.readFile(filePath, "utf-8");
    const extracted = extractUiLiteralsFromSource(content);
    for (const literal of extracted) {
      literals.add(literal);
    }
  }

  return [...literals].sort((a, b) => a.localeCompare(b));
};

// Extend express-session to include custom properties
declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    role: string;
    language_code: string;
  }
}

export async function createApp() {
  const isProduction = process.env.NODE_ENV === "production";
  const configuredSessionIdleTimeoutMinutes = Number(process.env.SESSION_IDLE_TIMEOUT_MINUTES);
  const sessionIdleTimeoutMinutes = Number.isFinite(configuredSessionIdleTimeoutMinutes) && configuredSessionIdleTimeoutMinutes > 0
    ? configuredSessionIdleTimeoutMinutes
    : 60;
  const sessionIdleTimeoutMs = Math.trunc(sessionIdleTimeoutMinutes * 60 * 1000);
  const defaultRootUsername = process.env.DEFAULT_ROOT_USERNAME || "root";
  const defaultRootPassword = process.env.DEFAULT_ROOT_PASSWORD;
  const configuredSessionSecret = process.env.SESSION_SECRET;
  const sessionSecret = (configuredSessionSecret && configuredSessionSecret.length >= 32)
    ? configuredSessionSecret
    : (isProduction ? null : "dev-only-insecure-session-secret-change-me-123456");

  if (!sessionSecret) {
    throw new Error("SESSION_SECRET is required and must be at least 32 characters long");
  }
  if (!configuredSessionSecret || configuredSessionSecret.length < 32) {
    console.warn("Using fallback SESSION_SECRET for development/testing. Set SESSION_SECRET in .env.");
  }

  // Initialize Database
  await initDb();

  // Ensure at least one ROOT user exists
  const rootExists = await db("users").where({ role: 'ROOT' }).first();
  if (!rootExists) {
    if (!defaultRootPassword || defaultRootPassword.length < 6) {
      throw new Error("DEFAULT_ROOT_PASSWORD is required (min 6 chars) when no ROOT user exists");
    }
    const hashedPassword = await bcrypt.hash(defaultRootPassword, 10);
    await db("users").insert({ username: defaultRootUsername, password: hashedPassword, role: "ROOT" });
    console.log(`Default ROOT user created: ${defaultRootUsername}`);
  }

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.disable("x-powered-by");
  
  // Proxy trust is often needed for secure cookies behind proxies
  app.set('trust proxy', 1);

  const sessionStore = new KnexSessionStore(db, sessionIdleTimeoutMs);

  app.use(session({
    store: sessionStore,
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    name: 'cp_ops_session',
    cookie: { 
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      httpOnly: true,
      maxAge: sessionIdleTimeoutMs
    }
  }));

  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options", "DENY");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (isProduction) {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  app.use("/api", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    next();
  });

  const redisUrl = process.env.REDIS_URL;
  const uploadsRoot = process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : (process.env.VERCEL ? "/tmp/uploads" : path.join(process.cwd(), "uploads"));
  const uploadStorage = (process.env.UPLOAD_STORAGE || (process.env.VERCEL ? "db" : "fs")).toLowerCase();
  const useDbUploads = uploadStorage === "db";

  type RateLimitOptions = {
    windowMs: number;
    max: number;
    key?: (req: any) => string;
  };
  type RateDecision = { allowed: boolean; retryAfterSec: number };
  interface RateLimitStore {
    consume(key: string, windowMs: number, max: number): Promise<RateDecision>;
  }

  type RateBucket = { count: number; resetAt: number };
  const memoryBuckets = new Map<string, RateBucket>();

  const memoryStore: RateLimitStore = {
    async consume(key: string, windowMs: number, max: number) {
      const now = Date.now();
      const bucket = memoryBuckets.get(key);

      if (!bucket || bucket.resetAt <= now) {
        memoryBuckets.set(key, { count: 1, resetAt: now + windowMs });
        return { allowed: true, retryAfterSec: 0 };
      }

      if (bucket.count >= max) {
        return {
          allowed: false,
          retryAfterSec: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
        };
      }

      bucket.count += 1;
      memoryBuckets.set(key, bucket);
      return { allowed: true, retryAfterSec: 0 };
    }
  };

  let rateStore: RateLimitStore = memoryStore;

  if (redisUrl) {
    try {
      const dynamicImport = new Function("m", "return import(m)") as (moduleName: string) => Promise<any>;
      const redisModule = await dynamicImport("redis");
      const redisClient = redisModule.createClient({ url: redisUrl });
      redisClient.on("error", (err: unknown) => {
        console.error("Redis rate limiter error:", err);
      });
      await redisClient.connect();
      console.log("Redis-backed rate limiting enabled");

      rateStore = {
        async consume(key: string, windowMs: number, max: number) {
          const redisKey = `cpops:ratelimit:${key}`;
          const count = await redisClient.incr(redisKey);
          if (count === 1) {
            await redisClient.pExpire(redisKey, windowMs);
          }
          if (count > max) {
            const ttl = await redisClient.pTtl(redisKey);
            const retryAfterSec = Math.max(1, Math.ceil((Number(ttl) > 0 ? Number(ttl) : windowMs) / 1000));
            return { allowed: false, retryAfterSec };
          }
          return { allowed: true, retryAfterSec: 0 };
        }
      };
    } catch (error) {
      console.warn("REDIS_URL is set but Redis client is unavailable, falling back to in-memory rate limiting.", error);
    }
  }

  const createRateLimiter = (opts: RateLimitOptions) => {
    return async (req: any, res: any, next: any) => {
      const key = opts.key ? opts.key(req) : `${req.ip}:${req.path}`;
      try {
        const decision = await rateStore.consume(key, opts.windowMs, opts.max);
        if (!decision.allowed) {
          res.setHeader("Retry-After", String(decision.retryAfterSec));
          return res.status(429).json({ error: "Too many requests. Please try again later." });
        }
      } catch (error) {
        console.error("Rate limiter failed, allowing request:", error);
      }
      return next();
    };
  };

  const loginRateLimit = createRateLimiter({
    windowMs: 15 * 60 * 1000,
    max: 10,
    key: (req: any) => `${req.ip}:login:${String(req.body?.username || "").toLowerCase()}`,
  });

  const sensitiveRateLimit = createRateLimiter({
    windowMs: 60 * 1000,
    max: 120,
    key: (req: any) => `${req.ip}:${req.path}`,
  });

  const uploadRateLimit = createRateLimiter({
    windowMs: 10 * 60 * 1000,
    max: 20,
    key: (req: any) => `${req.ip}:upload:${req.path}`,
  });

  app.use((req: any, res: any, next: any) => {
    if (!req.path.startsWith("/api/")) return next();
    const mutating = req.method === "POST" || req.method === "PUT" || req.method === "PATCH" || req.method === "DELETE";
    if (!mutating) return next();

    const host = String(req.get("host") || "");
    const origin = req.get("origin");
    const referer = req.get("referer");

    const sameHost = (value: string) => {
      try {
        const parsed = new URL(value);
        return parsed.host === host && (parsed.protocol === "http:" || parsed.protocol === "https:");
      } catch {
        return false;
      }
    };

    if (origin) {
      if (!sameHost(origin)) {
        return res.status(403).json({ error: "CSRF origin denied" });
      }
      return next();
    }

    if (referer) {
      if (!sameHost(referer)) {
        return res.status(403).json({ error: "CSRF referer denied" });
      }
      return next();
    }

    if (req.session?.userId) {
      return res.status(403).json({ error: "Missing origin headers" });
    }

    return next();
  });

  // Auth Middleware
  const requireAuth = (req: any, res: any, next: any) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    next();
  };

  const requireRole = (roles: string[]) => (req: any, res: any, next: any) => {
    if (!req.session.userId || !roles.includes(req.session.role)) {
      return res.status(403).json({ error: "Forbidden" });
    }
    next();
  };

  const isPrivileged = (req: any) => req.session?.role === "ROOT" || req.session?.role === "ADMIN";
  const normalizeLanguageCode = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const normalized = value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9_-]{1,15}$/.test(normalized)) return null;
    return normalized;
  };

  const hasEventAccess = async (req: any, eventId: number | string) => {
    if (!req.session?.userId) return false;
    if (isPrivileged(req)) return true;
    const row = await db("event_user_access")
      .where({ event_id: eventId, user_id: req.session.userId })
      .first();
    if (!row) return false;

    const event = await db("events")
      .where({ id: eventId })
      .select("date", "end_date")
      .first();
    if (!event) return false;

    return canRoleAccessEventOnDate(req.session?.role, event.date, event.end_date);
  };

  const ensureEventAccess = async (req: any, res: any, eventId: number | string) => {
    const allowed = await hasEventAccess(req, eventId);
    if (!allowed) {
      res.status(403).json({ error: "Geen toegang tot dit evenement" });
      return false;
    }
    return true;
  };

  const getViewerAidPostIdForEvent = async (req: any, eventId: number | string): Promise<number | null> => {
    if (req.session?.role !== "VIEWER") return null;
    const row = await db("event_user_access")
      .where({ event_id: eventId, user_id: req.session.userId })
      .select("aid_post_id")
      .first();
    return toPositiveInt(row?.aid_post_id);
  };

  const validateAidPostForEvent = async (
    eventId: number | string,
    rawAidPostId: unknown,
    {
      allowNull = true,
      requiredError = "Hulppost is verplicht",
      invalidError = "Ongeldige hulppost voor dit evenement",
    }: { allowNull?: boolean; requiredError?: string; invalidError?: string } = {},
  ): Promise<{ ok: true; aidPostId: number | null } | { ok: false; error: string }> => {
    if (rawAidPostId == null || rawAidPostId === "") {
      if (allowNull) return { ok: true, aidPostId: null };
      return { ok: false, error: requiredError };
    }

    const parsedAidPostId = toPositiveInt(rawAidPostId);
    if (!parsedAidPostId) {
      return { ok: false, error: invalidError };
    }

    const aidPost = await db("aid_posts")
      .where({ id: parsedAidPostId, event_id: eventId })
      .first();
    if (!aidPost) {
      return { ok: false, error: invalidError };
    }

    return { ok: true, aidPostId: parsedAidPostId };
  };

  const recalculateInterventionClosedState = async (trx: any, interventionId: number | string) => {
    const intervention = await trx("interventions").where({ id: interventionId }).first();
    if (!intervention) return;

    const allTeams = await trx("intervention_teams as it")
      .leftJoin("statuses as s", "it.status_id", "s.id")
      .where("it.intervention_id", interventionId)
      .select("s.is_closed");

    const allClosed = allTeams.length > 0 && allTeams.every((t: any) => Number(t.is_closed) === 1);
    const nowIso = new Date().toISOString();

    if (allTeams.length === 0 && !intervention.closed_at) {
      await trx("interventions")
        .where({ id: interventionId })
        .update({ closed_at: nowIso });

      await trx("intervention_status_history")
        .where({ intervention_id: interventionId })
        .whereNull("ended_at")
        .update({ ended_at: nowIso });
      return "closed_no_active_teams";
    }

    if (allTeams.length === 0) return null;

    if (allClosed && !intervention.closed_at) {
      await trx("interventions")
        .where({ id: interventionId })
        .update({ closed_at: nowIso });

      await trx("intervention_status_history")
        .where({ intervention_id: interventionId })
        .whereNull("ended_at")
        .update({ ended_at: nowIso });
      return "closed_all_teams";
    }

    if (!allClosed && intervention.closed_at) {
      await trx("interventions")
        .where({ id: interventionId })
        .update({ closed_at: null });

      const openRows = await trx("intervention_status_history")
        .where({ intervention_id: interventionId })
        .whereNull("ended_at")
        .select("team_id");
      const openSet = new Set(openRows.map((r: any) => toPositiveInt(r.team_id)).filter((id): id is number => id != null));

      const links = await trx("intervention_teams")
        .where({ intervention_id: interventionId })
        .select("team_id", "status_id");

      const missingRows = links
        .filter((r: any) => !openSet.has(Number(r.team_id)))
        .map((r: any) => ({
          intervention_id: interventionId,
          team_id: r.team_id,
          status_id: r.status_id || null,
          started_at: nowIso,
          ended_at: null,
        }));

      if (missingRows.length > 0) {
        await trx("intervention_status_history").insert(missingRows);
      }
      return "reopened";
    }

    return null;
  };

  const setTeamCurrentStatus = async (
    executor: any,
    eventId: number | string,
    teamId: number | string,
    statusId: number | string | null,
  ) => {
    const nowIso = new Date().toISOString();
    const existing = await executor("team_current_statuses")
      .where({ team_id: teamId })
      .first();

    if (existing) {
      await executor("team_current_statuses")
        .where({ team_id: teamId })
        .update({
          event_id: eventId,
          status_id: statusId || null,
          updated_at: nowIso,
        });
      return;
    }

    await executor("team_current_statuses").insert({
      team_id: teamId,
      event_id: eventId,
      status_id: statusId || null,
      updated_at: nowIso,
    });
  };

  const validateStatusFlags = (isStart: number, isBusy: number) => {
    if (isStart === 1 && isBusy === 1) {
      throw new Error("STATUS_START_BUSY_CONFLICT");
    }
  };

  const resolveDefaultStatusId = async (
    trx: any,
    eventId: number | string,
    preferredStatusId?: number | null
  ) => {
    if (preferredStatusId) {
      const specific = await trx("statuses")
        .where({ id: preferredStatusId, event_id: eventId })
        .first();
      if (specific) return Number(specific.id);
    }

    const busyStatus = await trx("statuses")
      .where({ event_id: eventId, is_busy: 1 })
      .orderBy("id", "asc")
      .first();
    if (busyStatus) return Number(busyStatus.id);

    const firstStatus = await trx("statuses")
      .where({ event_id: eventId })
      .orderBy("id", "asc")
      .first();
    return firstStatus ? Number(firstStatus.id) : null;
  };

  const resolveStartStatusId = async (
    trx: any,
    eventId: number | string,
    preferredStatusId?: number | null,
  ) => {
    if (preferredStatusId) {
      const specific = await trx("statuses")
        .where({ id: preferredStatusId, event_id: eventId })
        .first();
      if (specific && Number(specific.is_start) === 1) return Number(specific.id);
    }

    const startStatus = await trx("statuses")
      .where({ event_id: eventId, is_start: 1 })
      .orderBy("id", "asc")
      .first();
    if (startStatus) return Number(startStatus.id);

    const firstStatus = await trx("statuses")
      .where({ event_id: eventId })
      .orderBy("id", "asc")
      .first();
    return firstStatus ? Number(firstStatus.id) : null;
  };

  const getBlockedTeamsForInterventionAdd = async (
    trx: any,
    eventId: number | string,
    teamIds: number[],
    excludeInterventionId?: number | null
  ) => {
    if (teamIds.length === 0) return [];

    const activeRows = await trx("intervention_teams as it")
      .join("interventions as i", "it.intervention_id", "i.id")
      .join("teams as t", "it.team_id", "t.id")
      .leftJoin("statuses as s", "it.status_id", "s.id")
      .where("i.event_id", eventId)
      .whereNull("i.closed_at")
      .whereIn("it.team_id", teamIds)
      .modify((qb: any) => {
        if (excludeInterventionId) {
          qb.whereNot("it.intervention_id", excludeInterventionId);
        }
      })
      .select("it.team_id", "t.name as team_name", "s.name as status_name", "s.is_start", "s.is_closed");

    const blockedByTeam = new Map<number, { team_name: string; status_name: string | null }>();
    for (const row of activeRows) {
      if (Number(row.is_start) === 1 || Number(row.is_closed) === 1) continue;
      const teamId = Number(row.team_id);
      if (!blockedByTeam.has(teamId)) {
        blockedByTeam.set(teamId, {
          team_name: row.team_name,
          status_name: row.status_name || null,
        });
      }
    }

    return Array.from(blockedByTeam.entries()).map(([team_id, info]) => ({
      team_id,
      ...info,
    }));
  };

  const writeActionLog = async (
    executor: any,
    req: any,
    payload: {
      event_id: number | string;
      message: string;
      team_id?: number | string | null;
      intervention_id?: number | string | null;
    }
  ) => {
    await executor("logs").insert({
      event_id: payload.event_id,
      actor_user_id: req.session?.userId || null,
      actor_username: req.session?.username || null,
      team_id: payload.team_id ?? null,
      intervention_id: payload.intervention_id ?? null,
      message: payload.message,
    });
  };

  const eventAnnouncementSubscribers = new Map<string, Set<any>>();

  const getEventAnnouncement = async (eventId: number | string) => {
    const announcement = await db("event_announcements").where({ event_id: eventId }).first();
    return announcement || { message: "", bg_color: "#ef4444", is_active: 0 };
  };

  const publishEventAnnouncement = async (eventId: number | string) => {
    const key = String(eventId);
    const subscribers = eventAnnouncementSubscribers.get(key);
    if (!subscribers || subscribers.size === 0) return;

    const announcement = await getEventAnnouncement(eventId);
    const payload = `data: ${JSON.stringify(announcement)}\n\n`;
    for (const streamRes of subscribers) {
      streamRes.write(payload);
    }
  };

  const csvEscape = (value: unknown) => {
    const str = value == null ? "" : String(value);
    if (/[",\n]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };

  const toCsv = (headers: string[], rows: Array<Record<string, unknown>>) => {
    const headerLine = headers.map(csvEscape).join(",");
    const dataLines = rows.map((row) => headers.map((h) => csvEscape(row[h])).join(","));
    return [headerLine, ...dataLines].join("\n");
  };

  const toExcelHtmlTable = (title: string, headers: string[], rows: Array<Record<string, unknown>>) => {
    const escapeHtml = (value: unknown) => {
      const str = value == null ? "" : String(value);
      return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    };

    const head = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
    const body = rows
      .map((row) => `<tr>${headers.map((h) => `<td>${escapeHtml(row[h])}</td>`).join("")}</tr>`)
      .join("");

    return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
</head>
<body>
  <table border="1">
    <thead><tr>${head}</tr></thead>
    <tbody>${body}</tbody>
  </table>
</body>
</html>`;
  };

  // Auth Routes
  app.post("/api/login", loginRateLimit, async (req, res) => {
    const { username, password } = req.body;
    if (typeof username !== "string" || typeof password !== "string") {
      return res.status(400).json({ error: "Invalid credentials format" });
    }
    const normalizedUsername = username.trim();
    if (!normalizedUsername || normalizedUsername.length > 64 || password.length > 256) {
      return res.status(400).json({ error: "Invalid credentials format" });
    }
    try {
      const user = await db("users").where({ username: normalizedUsername }).first();
      
      if (user && await bcrypt.compare(password, user.password)) {
        req.session.userId = user.id;
        req.session.username = user.username;
        req.session.role = user.role;
        req.session.language_code = user.language_code || "en";
        res.json({ id: user.id, username: user.username, role: user.role, language_code: user.language_code || "en" });
      } else {
        res.status(401).json({ error: "Invalid credentials" });
      }
    } catch (error) {
      res.status(500).json({ error: "Login failed" });
    }
  });

  app.post("/api/logout", (req, res) => {
    req.session.destroy(() => {
      res.json({ success: true });
    });
  });

  app.get("/api/me", async (req: any, res) => {
    if (req.session.userId) {
      if (!req.session.language_code) {
        const currentUser = await db("users").where({ id: req.session.userId }).select("language_code").first();
        req.session.language_code = currentUser?.language_code || "en";
      }
      res.json({
        id: req.session.userId,
        username: req.session.username,
        role: req.session.role,
        language_code: req.session.language_code || "en",
      });
    } else {
      res.status(401).json({ error: "Not logged in" });
    }
  });

  app.get("/api/languages", requireAuth, async (req: any, res) => {
    const languages = await db("app_languages")
      .where({ is_active: 1 })
      .select("code", "name", "is_active")
      .orderBy("name", "asc");
    res.json(languages);
  });

  app.get("/api/translations", requireAuth, async (req: any, res) => {
    const requested = normalizeLanguageCode(req.query.lang);
    const languageCode = requested || req.session.language_code || "en";
    const rows = await db("app_translations")
      .where({ language_code: languageCode })
      .select("translation_key", "translation_value");

    const translations = rows.reduce((acc: Record<string, string>, row: any) => {
      acc[String(row.translation_key)] = String(row.translation_value ?? "");
      return acc;
    }, {});

    res.json({ language_code: languageCode, translations });
  });

  app.post("/api/users/me/language", requireAuth, async (req: any, res) => {
    const languageCode = normalizeLanguageCode(req.body?.language_code);
    if (!languageCode) {
      return res.status(400).json({ error: "Invalid language code" });
    }

    const language = await db("app_languages").where({ code: languageCode, is_active: 1 }).first();
    if (!language) {
      return res.status(400).json({ error: "Language is not available" });
    }

    await db("users").where({ id: req.session.userId }).update({ language_code: languageCode });
    req.session.language_code = languageCode;
    res.json({ success: true, language_code: languageCode });
  });

  app.post("/api/users/me/password", requireAuth, sensitiveRateLimit, async (req: any, res) => {
    const { old_password, new_password } = req.body || {};
    if (typeof old_password !== "string" || !old_password) {
      return res.status(400).json({ error: "Oud wachtwoord is verplicht" });
    }
    if (typeof new_password !== "string" || new_password.length < 6) {
      return res.status(400).json({ error: "Nieuw wachtwoord moet minstens 6 tekens bevatten" });
    }

    const currentUser = await db("users").where({ id: req.session.userId }).first();
    if (!currentUser) return res.status(404).json({ error: "Gebruiker niet gevonden" });

    const oldMatches = await bcrypt.compare(old_password, currentUser.password);
    if (!oldMatches) {
      return res.status(400).json({ error: "Oud wachtwoord is onjuist" });
    }

    const hashedPassword = await bcrypt.hash(new_password, 10);
    await db("users").where({ id: req.session.userId }).update({ password: hashedPassword });
    res.json({ success: true });
  });

  // User Management (ROOT/ADMIN only)
  app.get("/api/users", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const users = await db("users").select("id", "username", "role", "language_code");
    res.json(users);
  });

  app.post("/api/users", requireRole(["ROOT", "ADMIN"]), sensitiveRateLimit, async (req, res) => {
    const { username, password, role } = req.body;
    const languageCode = normalizeLanguageCode(req.body?.language_code) || "en";
    if (typeof username !== "string" || !username.trim() || username.trim().length > 64) {
      return res.status(400).json({ error: "Ongeldige gebruikersnaam" });
    }
    if (typeof password !== "string" || password.length < 6 || password.length > 256) {
      return res.status(400).json({ error: "Wachtwoord moet tussen 6 en 256 tekens bevatten" });
    }
    const allowedRoles = ["ROOT", "ADMIN", "OPERATOR", "VIEWER"];
    if (!allowedRoles.includes(role)) {
      return res.status(400).json({ error: "Ongeldige rol" });
    }
    if (req.session.role === "ADMIN" && role === "ROOT") {
      return res.status(403).json({ error: "Admin mag geen ROOT-gebruiker aanmaken" });
    }
    const language = await db("app_languages").where({ code: languageCode, is_active: 1 }).first();
    if (!language) {
      return res.status(400).json({ error: "Ongeldige taal" });
    }
    const hashedPassword = await bcrypt.hash(password, 10);
    try {
      const [id] = await db("users").insert({ username: username.trim(), password: hashedPassword, role, language_code: languageCode });
      res.json({ id });
    } catch (e) {
      res.status(400).json({ error: "Username already exists" });
    }
  });

  app.patch("/api/users/:id", requireRole(["ROOT", "ADMIN"]), sensitiveRateLimit, async (req: any, res) => {
    const targetId = Number(req.params.id);
    if (!targetId) return res.status(400).json({ error: "Ongeldige gebruiker" });

    const targetUser = await db("users").where({ id: targetId }).first();
    if (!targetUser) return res.status(404).json({ error: "User not found" });

    if (req.session.role === "ADMIN" && targetUser.role === "ROOT") {
      return res.status(403).json({ error: "Admin mag geen ROOT-gebruiker aanpassen" });
    }

    const { username, role, password } = req.body || {};
    const languageCode = typeof req.body?.language_code !== "undefined"
      ? normalizeLanguageCode(req.body.language_code)
      : null;
    const allowedRoles = ["ROOT", "ADMIN", "OPERATOR", "VIEWER"];
    const updatePayload: Record<string, any> = {};

    if (typeof username === "string") {
      const normalizedUsername = username.trim();
      if (!normalizedUsername) {
        return res.status(400).json({ error: "Gebruikersnaam is verplicht" });
      }
      updatePayload.username = normalizedUsername;
    }

    if (typeof role !== "undefined") {
      if (!allowedRoles.includes(role)) {
        return res.status(400).json({ error: "Ongeldige rol" });
      }
      if (
        req.session.role === "ADMIN" &&
        Number(req.session.userId) === targetId &&
        role !== targetUser.role
      ) {
        return res.status(403).json({ error: "Admin mag eigen rol niet wijzigen" });
      }
      if (req.session.role === "ADMIN" && role === "ROOT") {
        return res.status(403).json({ error: "Admin mag geen ROOT-rol toekennen" });
      }
      if (
        targetUser.role === "ROOT" &&
        role !== "ROOT"
      ) {
        const otherRoot = await db("users")
          .where({ role: "ROOT" })
          .whereNot({ id: targetId })
          .first();
        if (!otherRoot) {
          return res.status(400).json({ error: "Minstens 1 ROOT-gebruiker is verplicht" });
        }
      }
      updatePayload.role = role;
    }

    if (typeof password !== "undefined") {
      if (typeof password !== "string" || password.length < 6) {
        return res.status(400).json({ error: "Wachtwoord moet minstens 6 tekens bevatten" });
      }
      updatePayload.password = await bcrypt.hash(password, 10);
    }

    if (typeof req.body?.language_code !== "undefined") {
      if (!languageCode) {
        return res.status(400).json({ error: "Ongeldige taal" });
      }
      const language = await db("app_languages").where({ code: languageCode, is_active: 1 }).first();
      if (!language) {
        return res.status(400).json({ error: "Ongeldige taal" });
      }
      updatePayload.language_code = languageCode;
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: "Geen geldige velden om te updaten" });
    }

    try {
      await db("users").where({ id: targetId }).update(updatePayload);
      const updated = await db("users").where({ id: targetId }).select("id", "username", "role", "language_code").first();

      if (Number(req.session.userId) === targetId) {
        req.session.username = updated.username;
        req.session.role = updated.role;
        req.session.language_code = updated.language_code || "en";
      }

      res.json(updated);
    } catch (error: any) {
      const message = String(error?.message || "");
      if (message.toLowerCase().includes("unique")) {
        return res.status(400).json({ error: "Username already exists" });
      }
      res.status(500).json({ error: "Update failed" });
    }
  });

  app.delete("/api/users/:id", requireRole(["ROOT", "ADMIN"]), sensitiveRateLimit, async (req: any, res) => {
    try {
      const targetUser = await db("users").where({ id: req.params.id }).first();
      if (!targetUser) return res.status(404).json({ error: "User not found" });
      
      // Only ROOT can delete ROOT users. ADMIN may never delete ROOT.
      if (targetUser.role === "ROOT" && req.session.role !== "ROOT") {
        return res.status(403).json({ error: "Admin mag nooit een ROOT-gebruiker verwijderen" });
      }
      
      await db("users").where({ id: req.params.id }).del();
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: "Delete failed" });
    }
  });

  // Language Management (ROOT/ADMIN only)
  app.get("/api/admin/languages", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const languages = await db("app_languages")
      .select("code", "name", "is_active", "created_at")
      .orderBy("name", "asc");
    res.json(languages);
  });

  app.post("/api/admin/languages", requireRole(["ROOT", "ADMIN"]), sensitiveRateLimit, async (req, res) => {
    const code = normalizeLanguageCode(req.body?.code);
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!code) return res.status(400).json({ error: "Invalid language code" });
    if (!name) return res.status(400).json({ error: "Language name is required" });

    const existing = await db("app_languages").where({ code }).first();
    if (existing) return res.status(400).json({ error: "Language already exists" });

    await db("app_languages").insert({ code, name, is_active: 1 });
    res.json({ success: true, code, name });
  });

  app.patch("/api/admin/languages/:code", requireRole(["ROOT", "ADMIN"]), sensitiveRateLimit, async (req, res) => {
    const code = normalizeLanguageCode(req.params.code);
    if (!code) return res.status(400).json({ error: "Invalid language code" });

    const language = await db("app_languages").where({ code }).first();
    if (!language) return res.status(404).json({ error: "Language not found" });

    const updatePayload: Record<string, any> = {};
    if (typeof req.body?.name === "string" && req.body.name.trim()) {
      updatePayload.name = req.body.name.trim();
    }
    if (typeof req.body?.is_active !== "undefined") {
      updatePayload.is_active = req.body.is_active ? 1 : 0;
    }
    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: "No valid changes" });
    }

    await db("app_languages").where({ code }).update(updatePayload);
    const updated = await db("app_languages").where({ code }).first();
    res.json(updated);
  });

  app.get("/api/admin/translations/:code", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const code = normalizeLanguageCode(req.params.code);
    if (!code) return res.status(400).json({ error: "Invalid language code" });

    const language = await db("app_languages").where({ code }).first();
    if (!language) return res.status(404).json({ error: "Language not found" });

    const rows = await db("app_translations")
      .where({ language_code: code })
      .select("translation_key", "translation_value")
      .orderBy("translation_key", "asc");

    const translations = rows.reduce((acc: Record<string, string>, row: any) => {
      acc[String(row.translation_key)] = String(row.translation_value ?? "");
      return acc;
    }, {});

    res.json({ code, translations });
  });

  app.put("/api/admin/translations/:code", requireRole(["ROOT", "ADMIN"]), sensitiveRateLimit, async (req, res) => {
    const code = normalizeLanguageCode(req.params.code);
    if (!code) return res.status(400).json({ error: "Invalid language code" });
    if (code === "en") return res.status(400).json({ error: "English is the base language and cannot be overwritten" });

    const language = await db("app_languages").where({ code }).first();
    if (!language) return res.status(404).json({ error: "Language not found" });

    const submitted = req.body?.translations;
    if (!submitted || typeof submitted !== "object" || Array.isArray(submitted)) {
      return res.status(400).json({ error: "Invalid translations payload" });
    }

    const entries = Object.entries(submitted)
      .filter(([key]) => typeof key === "string" && key.trim().length > 0)
      .map(([key, value]) => ({
        language_code: code,
        translation_key: key.trim(),
        translation_value: typeof value === "string" ? value : "",
      }));

    await db.transaction(async (trx) => {
      for (const entry of entries) {
        if (entry.translation_value.trim() === "") {
          await trx("app_translations")
            .where({ language_code: code, translation_key: entry.translation_key })
            .del();
          continue;
        }
        await trx("app_translations")
          .insert(entry)
          .onConflict(["language_code", "translation_key"])
          .merge({
            translation_value: entry.translation_value,
            updated_at: trx.fn.now(),
          });
      }
    });

    res.json({ success: true, updated: entries.length });
  });

  app.get("/api/admin/translations/extract-literals", requireRole(["ROOT", "ADMIN"]), async (_req, res) => {
    try {
      const literals = await collectUiLiteralCandidates();
      const keys = literals.map((value) => ({
        key: `literal:${value}`,
        base: value,
      }));
      res.json({ count: keys.length, keys });
    } catch (error) {
      console.error("Failed to extract ui literals:", error);
      res.status(500).json({ error: "Failed to extract UI literals" });
    }
  });

  // Announcements
  app.get("/api/announcements", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const announcement = await db("announcements").first();
    res.json(announcement);
  });

  app.post("/api/announcements", requireRole(["ROOT", "ADMIN"]), sensitiveRateLimit, async (req, res) => {
    const { message, bg_color, is_active } = req.body;
    if (typeof message !== "string" || message.length > 2000) {
      return res.status(400).json({ error: "Ongeldig bericht" });
    }
    if (typeof bg_color !== "string" || bg_color.length > 32) {
      return res.status(400).json({ error: "Ongeldige kleur" });
    }
    await db("announcements").update({ message, bg_color, is_active: is_active ? 1 : 0 });
    res.json({ success: true });
  });

  // Events
  app.get("/api/events", requireAuth, async (req, res) => {
    const isAdminOrRoot = req.session.role === "ROOT" || req.session.role === "ADMIN";
    const events = isAdminOrRoot
      ? await db("events").orderBy("date", "desc")
      : await db("events as e")
          .join("event_user_access as eua", "e.id", "eua.event_id")
          .where("eua.user_id", req.session.userId)
          .select("e.*")
          .orderBy("e.date", "desc");

    if (isAdminOrRoot) {
      res.json(events);
      return;
    }

    const filteredEvents = events.filter((event: any) =>
      canRoleAccessEventOnDate(req.session?.role, event.date, event.end_date)
    );
    res.json(filteredEvents);
  });

  app.post("/api/events", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const { name, date, end_date, location, organizer, contact_info, description } = req.body;
    try {
      const [eventId] = await db("events").insert({ 
        name, date, end_date, location, organizer, contact_info, description 
      });
      
      // Create default statuses for new event
      const defaultStatuses = [
        { name: 'Beschikbaar in hulppost', color: '#94a3b8', is_closed: 0, is_start: 1, is_busy: 0 },
        { name: 'Radiofonisch op het terrein', color: '#3b82f6', is_closed: 0, is_start: 1, is_busy: 0 },
        { name: 'Vertrokken op interventie', color: '#f59e0b', is_closed: 0, is_start: 0, is_busy: 1 },
        { name: 'Aangekomen op interventie', color: '#eab308', is_closed: 0, is_start: 0, is_busy: 1 },
        { name: 'Vertrokken naar de hulppost', color: '#f97316', is_closed: 0, is_start: 0, is_busy: 1 },
        { name: 'Aangekomen in de hulppost', color: '#22c55e', is_closed: 1, is_start: 1, is_busy: 0 }
      ];
      
      await db("statuses").insert(defaultStatuses.map(s => ({ ...s, event_id: eventId })));
      await db("team_types").insert(defaultTeamTypes.map(name => ({ event_id: eventId, name })));
      await db("aid_posts").insert({
        event_id: eventId,
        name: "Algemene hulppost",
        location: "",
        description: "",
      });
      await db("event_announcements").insert({
        event_id: eventId,
        message: "",
        bg_color: "#ef4444",
        is_active: 0,
      });
      if (!isPrivileged(req)) {
        await db("event_user_access").insert({
          event_id: eventId,
          user_id: req.session.userId,
        });
      }
      await writeActionLog(db, req, {
        event_id: eventId,
        message: `Evenement aangemaakt: ${name}`,
      });

      res.json({ id: eventId });
    } catch (error) {
      console.error("Error creating event:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.get("/api/events/:id", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const event = await db("events").where({ id: req.params.id }).first();
    if (!event) return res.status(404).json({ error: "Event not found" });
    res.json(event);
  });

  app.get("/api/events/:id/announcement", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const announcement = await getEventAnnouncement(req.params.id);
    res.json(announcement);
  });

  app.get("/api/events/:id/announcement/stream", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const eventId = String(req.params.id);

    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    if (typeof (res as any).flushHeaders === "function") {
      (res as any).flushHeaders();
    }

    const subscribers = eventAnnouncementSubscribers.get(eventId) || new Set<any>();
    subscribers.add(res);
    eventAnnouncementSubscribers.set(eventId, subscribers);

    const announcement = await getEventAnnouncement(eventId);
    res.write(`data: ${JSON.stringify(announcement)}\n\n`);

    const keepAlive = setInterval(() => {
      res.write(": keep-alive\n\n");
    }, 25000);

    req.on("close", () => {
      clearInterval(keepAlive);
      const current = eventAnnouncementSubscribers.get(eventId);
      if (!current) return;
      current.delete(res);
      if (current.size === 0) {
        eventAnnouncementSubscribers.delete(eventId);
      }
    });
  });

  app.post("/api/events/:id/announcement", requireRole(["ROOT", "ADMIN", "OPERATOR"]), sensitiveRateLimit, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const { message, bg_color, is_active } = req.body;
    if (typeof message !== "string" || message.length > 2000) {
      return res.status(400).json({ error: "Ongeldig bericht" });
    }
    if (typeof bg_color !== "string" || bg_color.length > 32) {
      return res.status(400).json({ error: "Ongeldige kleur" });
    }

    const existing = await db("event_announcements").where({ event_id: req.params.id }).first();
    if (existing) {
      await db("event_announcements")
        .where({ event_id: req.params.id })
        .update({ message, bg_color, is_active: is_active ? 1 : 0 });
    } else {
      await db("event_announcements").insert({
        event_id: req.params.id,
        message,
        bg_color,
        is_active: is_active ? 1 : 0,
      });
    }

    await writeActionLog(db, req, {
      event_id: req.params.id,
      message: is_active ? "Event melding geactiveerd of bijgewerkt" : "Event melding gedeactiveerd",
    });
    await publishEventAnnouncement(req.params.id);
    res.json({ success: true });
  });

  app.patch("/api/events/:id", requireRole(["ROOT", "ADMIN"]), async (req: any, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const event = await db("events").where({ id: req.params.id }).first();
    if (!event) return res.status(404).json({ error: "Event not found" });

    const {
      name,
      date,
      end_date,
      location,
      organizer,
      contact_info,
      description
    } = req.body || {};

    if (typeof name !== "string" || !name.trim()) {
      return res.status(400).json({ error: "Naam is verplicht" });
    }
    if (typeof date !== "string" || !date.trim()) {
      return res.status(400).json({ error: "Startdatum is verplicht" });
    }

    if (end_date != null && typeof end_date !== "string") {
      return res.status(400).json({ error: "Einddatum is ongeldig" });
    }
    if (location != null && typeof location !== "string") {
      return res.status(400).json({ error: "Locatie is ongeldig" });
    }
    if (organizer != null && typeof organizer !== "string") {
      return res.status(400).json({ error: "Organisator is ongeldig" });
    }
    if (contact_info != null && typeof contact_info !== "string") {
      return res.status(400).json({ error: "Contactinformatie is ongeldig" });
    }
    if (description != null && typeof description !== "string") {
      return res.status(400).json({ error: "Omschrijving is ongeldig" });
    }

    const normalizedUpdate = {
      name: name.trim(),
      date: date.trim(),
      end_date: typeof end_date === "string" ? (end_date.trim() || null) : null,
      location: typeof location === "string" ? (location.trim() || null) : null,
      organizer: typeof organizer === "string" ? (organizer.trim() || null) : null,
      contact_info: typeof contact_info === "string" ? (contact_info.trim() || null) : null,
      description: typeof description === "string" ? description : null,
    };

    await db("events").where({ id: req.params.id }).update(normalizedUpdate);
    await writeActionLog(db, req, {
      event_id: req.params.id,
      message: `Evenementgegevens bijgewerkt`,
    });
    res.json({ success: true });
  });

  app.get("/api/events/:id/assignments", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const event = await db("events").where({ id: req.params.id }).first();
    if (!event) return res.status(404).json({ error: "Event not found" });

    const assigned = await db("event_user_access as eua")
      .join("users as u", "eua.user_id", "u.id")
      .where("eua.event_id", req.params.id)
      .whereIn("u.role", ["OPERATOR", "VIEWER"])
      .select("u.id", "u.username", "u.role", "eua.aid_post_id")
      .orderBy("u.username", "asc");

    res.json(assigned);
  });

  app.put("/api/events/:id/assignments", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const event = await db("events").where({ id: req.params.id }).first();
    if (!event) return res.status(404).json({ error: "Event not found" });

    const requestedAssignmentsRaw = Array.isArray(req.body?.assignments)
      ? req.body.assignments
      : null;

    const requestedAssignments = requestedAssignmentsRaw
      ? requestedAssignmentsRaw
          .map((row: any) => ({
            user_id: toPositiveInt(row?.user_id),
            aid_post_id: row?.aid_post_id == null || row?.aid_post_id === "" ? null : toPositiveInt(row?.aid_post_id),
          }))
          .filter((row: any): row is { user_id: number; aid_post_id: number | null } => row.user_id != null)
      : toPositiveIntArray(req.body?.user_ids).map((user_id) => ({ user_id, aid_post_id: null }));

    const requestedUserIds = [...new Set(requestedAssignments.map((row) => row.user_id))];

    const allowedUsers = await db("users")
      .whereIn("id", requestedUserIds.length ? requestedUserIds : [-1])
      .whereIn("role", ["OPERATOR", "VIEWER"])
      .select("id", "role");

    const allowedById = new Map<number, { id: number; role: string }>();
    for (const user of allowedUsers) {
      const parsedId = Number(user.id);
      if (!Number.isFinite(parsedId)) continue;
      allowedById.set(parsedId, { id: parsedId, role: String(user.role) });
    }

    const validAidPosts = await db("aid_posts")
      .where({ event_id: req.params.id })
      .select("id");
    const validAidPostIds = new Set(
      validAidPosts
        .map((row: any) => toPositiveInt(row.id))
        .filter((id): id is number => id != null),
    );

    const normalizedAssignmentsByUser = new Map<number, { user_id: number; aid_post_id: number | null }>();
    for (const row of requestedAssignments) {
      const allowedUser = allowedById.get(row.user_id);
      if (!allowedUser) continue;

      let aidPostId: number | null = row.aid_post_id;
      if (aidPostId != null && !validAidPostIds.has(aidPostId)) {
        return res.status(400).json({ error: "Ongeldige hulppost voor dit evenement" });
      }

      if (allowedUser.role === "VIEWER") {
        if (aidPostId == null) {
          return res.status(400).json({ error: "Viewer moet aan een hulppost gekoppeld zijn" });
        }
      } else {
        aidPostId = aidPostId != null && validAidPostIds.has(aidPostId) ? aidPostId : null;
      }

      normalizedAssignmentsByUser.set(allowedUser.id, { user_id: allowedUser.id, aid_post_id: aidPostId });
    }
    const normalizedAssignments = [...normalizedAssignmentsByUser.values()];

    await db.transaction(async trx => {
      const existingAccessUsers = await trx("event_user_access as eua")
        .join("users as u", "eua.user_id", "u.id")
        .where("eua.event_id", req.params.id)
        .whereIn("u.role", ["OPERATOR", "VIEWER"])
        .select("eua.user_id", "eua.aid_post_id");

      const existingIds = existingAccessUsers
        .map((r: any) => toPositiveInt(r.user_id))
        .filter((id): id is number => id != null);
      const nextIds = normalizedAssignments.map((row) => row.user_id);
      const toDelete = existingIds.filter(id => !nextIds.includes(id));
      const toInsert = normalizedAssignments.filter(row => !existingIds.includes(row.user_id));
      const toUpdate = normalizedAssignments.filter(row => existingIds.includes(row.user_id));

      if (toDelete.length > 0) {
        await trx("event_user_access")
          .where("event_id", req.params.id)
          .whereIn("user_id", toDelete)
          .del();
      }

      if (toInsert.length > 0) {
        await trx("event_user_access").insert(
          toInsert.map(row => ({
            event_id: req.params.id,
            user_id: row.user_id,
            aid_post_id: row.aid_post_id,
          }))
        );
      }

      for (const row of toUpdate) {
        await trx("event_user_access")
          .where({ event_id: req.params.id, user_id: row.user_id })
          .update({ aid_post_id: row.aid_post_id });
      }
    });

    res.json({ success: true });
  });

  app.delete("/api/events/:id", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    try {
      const event = await db("events").where({ id: req.params.id }).first();
      if (!event) return res.status(404).json({ error: "Event not found" });

      await db("events").where({ id: req.params.id }).del();
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting event:", error);
      res.status(500).json({ error: "Delete failed" });
    }
  });

  // Statuses
  app.get("/api/events/:id/statuses", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const statuses = await db("statuses").where({ event_id: req.params.id });
    res.json(statuses);
  });

  app.post("/api/events/:id/statuses", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    try {
      const { name, color, is_closed, is_start, is_busy } = req.body || {};
      const isClosed = is_closed ? 1 : 0;
      const isStart = is_start ? 1 : 0;
      const isBusy = is_busy ? 1 : 0;
      validateStatusFlags(isStart, isBusy);

      const [id] = await db("statuses").insert({
        event_id: req.params.id,
        name,
        color,
        is_closed: isClosed,
        is_start: isStart,
        is_busy: isBusy,
      });
      res.json({ id });
    } catch (error) {
      if (error instanceof Error && error.message === "STATUS_START_BUSY_CONFLICT") {
        return res.status(400).json({ error: "Een status kan niet tegelijk 'begin' en 'bezig' zijn" });
      }
      res.status(500).json({ error: "Status aanmaken mislukt" });
    }
  });

  app.patch("/api/statuses/:id", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    try {
      const status = await db("statuses").where({ id: req.params.id }).first();
      if (!status) return res.status(404).json({ error: "Status not found" });

      const { name, color, is_closed, is_start, is_busy } = req.body || {};
      const updatePayload: Record<string, any> = {};

      if (typeof name === "string" && name.trim()) updatePayload.name = name.trim();
      if (typeof color === "string" && color.trim()) updatePayload.color = color.trim();
      if (typeof is_closed !== "undefined") updatePayload.is_closed = is_closed ? 1 : 0;
      if (typeof is_start !== "undefined") updatePayload.is_start = is_start ? 1 : 0;
      if (typeof is_busy !== "undefined") updatePayload.is_busy = is_busy ? 1 : 0;

      const finalIsStart = typeof is_start !== "undefined" ? (is_start ? 1 : 0) : Number(status.is_start) || 0;
      const finalIsBusy = typeof is_busy !== "undefined" ? (is_busy ? 1 : 0) : Number(status.is_busy) || 0;
      validateStatusFlags(finalIsStart, finalIsBusy);

      if (Object.keys(updatePayload).length === 0) {
        return res.status(400).json({ error: "Geen geldige velden om te updaten" });
      }

      if ((Number(status.is_start) || 0) === 1 && finalIsStart !== 1) {
        const otherStart = await db("statuses")
          .where({ event_id: status.event_id, is_start: 1 })
          .whereNot({ id: status.id })
          .first();
        if (!otherStart) {
          return res.status(400).json({ error: "Minstens 1 beginstatus is verplicht" });
        }
      }

      await db.transaction(async trx => {
        await trx("statuses").where({ id: req.params.id }).update(updatePayload);

        if (typeof is_closed !== "undefined") {
          const linkedInterventions = await trx("intervention_teams")
            .distinct("intervention_id")
            .where({ status_id: req.params.id });

          for (const row of linkedInterventions) {
            await recalculateInterventionClosedState(trx, row.intervention_id);
          }
        }
      });

      res.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message === "STATUS_START_BUSY_CONFLICT") {
        return res.status(400).json({ error: "Een status kan niet tegelijk 'begin' en 'bezig' zijn" });
      }
      console.error("Error updating status:", error);
      res.status(500).json({ error: "Update failed" });
    }
  });

  app.delete("/api/statuses/:id", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    try {
      const status = await db("statuses").where({ id: req.params.id }).first();
      if (!status) return res.status(404).json({ error: "Status not found" });

      const { action, reassign_to_status_id } = req.body || {};

      const linkedCount = await db("intervention_teams")
        .where({ status_id: req.params.id })
        .count<{ count: number }>("status_id as count")
        .first();

      const totalStatuses = await db("statuses")
        .where({ event_id: status.event_id })
        .count<{ count: number }>("id as count")
        .first();

      if ((Number(totalStatuses?.count) || 0) <= 1) {
        return res.status(400).json({ error: "Minstens 1 status is verplicht" });
      }

      if ((Number(status.is_start) || 0) === 1) {
        const otherStart = await db("statuses")
          .where({ event_id: status.event_id, is_start: 1 })
          .whereNot({ id: status.id })
          .first();
        if (!otherStart) {
          return res.status(400).json({ error: "Minstens 1 beginstatus is verplicht" });
        }
      }

      await db.transaction(async trx => {
        const linkedInterventions = await trx("intervention_teams")
          .distinct("intervention_id")
          .where({ status_id: req.params.id });

        if ((Number(linkedCount?.count) || 0) > 0) {
          if (action === "set_null") {
            await trx("intervention_teams")
              .where({ status_id: req.params.id })
              .update({ status_id: null });
          } else if (action === "reassign") {
            const targetStatus = await trx("statuses")
              .where({ id: reassign_to_status_id, event_id: status.event_id })
              .first();

            if (!targetStatus || Number(targetStatus.id) === Number(req.params.id)) {
              throw new Error("INVALID_REASSIGN_STATUS");
            }

            await trx("intervention_teams")
              .where({ status_id: req.params.id })
              .update({ status_id: targetStatus.id });
          } else {
            throw new Error("LINKED_STATUS_REQUIRES_ACTION");
          }
        }

        await trx("statuses").where({ id: req.params.id }).del();

        for (const row of linkedInterventions) {
          await recalculateInterventionClosedState(trx, row.intervention_id);
        }
      });

      res.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message === "LINKED_STATUS_REQUIRES_ACTION") {
        return res.status(400).json({
          error: "Status is in gebruik bij interventies",
          code: "STATUS_LINKED",
          options: ["set_null", "reassign"]
        });
      }
      if (error instanceof Error && error.message === "INVALID_REASSIGN_STATUS") {
        return res.status(400).json({ error: "Ongeldige doelstatus voor herkoppelen" });
      }
      console.error("Error deleting status:", error);
      res.status(500).json({ error: "Delete failed" });
    }
  });

  // Aid Posts
  app.get("/api/events/:id/aid-posts", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const aidPosts = await db("aid_posts")
      .where({ event_id: req.params.id })
      .orderBy("name", "asc");
    res.json(aidPosts);
  });

  app.post("/api/events/:id/aid-posts", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const { name, location, description } = req.body || {};
    const normalizedName = typeof name === "string" ? name.trim() : "";
    if (!normalizedName) {
      return res.status(400).json({ error: "Naam hulppost is verplicht" });
    }

    const existing = await db("aid_posts")
      .where({ event_id: req.params.id, name: normalizedName })
      .first();
    if (existing) {
      return res.status(400).json({ error: "Hulppost met deze naam bestaat al in dit evenement" });
    }

    const [id] = await db("aid_posts").insert({
      event_id: req.params.id,
      name: normalizedName,
      location: typeof location === "string" ? location.trim() : "",
      description: typeof description === "string" ? description.trim() : "",
    });
    await writeActionLog(db, req, {
      event_id: req.params.id,
      message: `Hulppost aangemaakt: ${normalizedName}`,
    });
    res.json({ id });
  });

  app.patch("/api/aid-posts/:id", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const aidPost = await db("aid_posts").where({ id: req.params.id }).first();
    if (!aidPost) return res.status(404).json({ error: "Hulppost niet gevonden" });
    if (!await ensureEventAccess(req, res, aidPost.event_id)) return;

    const { name, location, description } = req.body || {};
    const updatePayload: Record<string, any> = {};

    if (typeof name === "string") {
      const normalizedName = name.trim();
      if (!normalizedName) return res.status(400).json({ error: "Naam hulppost is verplicht" });
      const duplicate = await db("aid_posts")
        .where({ event_id: aidPost.event_id, name: normalizedName })
        .whereNot({ id: aidPost.id })
        .first();
      if (duplicate) {
        return res.status(400).json({ error: "Hulppost met deze naam bestaat al in dit evenement" });
      }
      updatePayload.name = normalizedName;
    }
    if (typeof location === "string") {
      updatePayload.location = location.trim();
    }
    if (typeof description === "string") {
      updatePayload.description = description.trim();
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: "Geen geldige velden om te updaten" });
    }

    await db("aid_posts").where({ id: req.params.id }).update(updatePayload);
    await writeActionLog(db, req, {
      event_id: aidPost.event_id,
      message: `Hulppost bijgewerkt: ${updatePayload.name || aidPost.name}`,
    });
    res.json({ success: true });
  });

  // Team Types
  app.get("/api/events/:id/team-types", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const teamTypes = await db("team_types")
      .where({ event_id: req.params.id })
      .orderBy("name", "asc");
    res.json(teamTypes);
  });

  app.post("/api/events/:id/team-types", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    try {
      const name = String(req.body?.name || "").trim();
      if (!name) return res.status(400).json({ error: "Naam is verplicht" });

      const [id] = await db("team_types").insert({
        event_id: req.params.id,
        name
      });

      res.json({ id });
    } catch (error) {
      res.status(400).json({ error: "Teamsoort bestaat al of is ongeldig" });
    }
  });

  app.patch("/api/team-types/:id", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    try {
      const teamType = await db("team_types").where({ id: req.params.id }).first();
      if (!teamType) return res.status(404).json({ error: "Teamsoort niet gevonden" });

      const newName = String(req.body?.name || "").trim();
      if (!newName) return res.status(400).json({ error: "Naam is verplicht" });

      await db.transaction(async trx => {
        await trx("team_types").where({ id: req.params.id }).update({ name: newName });
        await trx("teams")
          .where({ event_id: teamType.event_id, type: teamType.name })
          .update({ type: newName });
      });

      res.json({ success: true });
    } catch (error) {
      res.status(400).json({ error: "Teamsoort bestaat al of is ongeldig" });
    }
  });

  app.delete("/api/team-types/:id", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    try {
      const teamType = await db("team_types").where({ id: req.params.id }).first();
      if (!teamType) return res.status(404).json({ error: "Teamsoort niet gevonden" });

      const { action, reassign_to_type_id } = req.body || {};

      const totalTypes = await db("team_types")
        .where({ event_id: teamType.event_id })
        .count<{ count: number }>("id as count")
        .first();
      if ((Number(totalTypes?.count) || 0) <= 1) {
        return res.status(400).json({ error: "Minstens 1 teamsoort is verplicht" });
      }

      const linkedTeamsCount = await db("teams")
        .where({ event_id: teamType.event_id, type: teamType.name })
        .count<{ count: number }>("id as count")
        .first();

      await db.transaction(async trx => {
        if ((Number(linkedTeamsCount?.count) || 0) > 0) {
          if (action !== "reassign") {
            throw new Error("TEAM_TYPE_LINKED");
          }

          const targetType = await trx("team_types")
            .where({ id: reassign_to_type_id, event_id: teamType.event_id })
            .first();
          if (!targetType || Number(targetType.id) === Number(req.params.id)) {
            throw new Error("INVALID_REASSIGN_TEAM_TYPE");
          }

          await trx("teams")
            .where({ event_id: teamType.event_id, type: teamType.name })
            .update({ type: targetType.name });
        }

        await trx("team_types").where({ id: req.params.id }).del();
      });

      res.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message === "TEAM_TYPE_LINKED") {
        return res.status(400).json({
          error: "Teamsoort is in gebruik bij bestaande ploegen",
          code: "TEAM_TYPE_LINKED",
          options: ["reassign"]
        });
      }
      if (error instanceof Error && error.message === "INVALID_REASSIGN_TEAM_TYPE") {
        return res.status(400).json({ error: "Ongeldige doel-teamsoort voor herkoppelen" });
      }
      res.status(500).json({ error: "Teamsoort verwijderen mislukt" });
    }
  });

  // Teams
  app.get("/api/events/:id/teams", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const viewerAidPostId = await getViewerAidPostIdForEvent(req, req.params.id);
    const teamsQuery = db("teams as t")
      .leftJoin("aid_posts as ap", "t.aid_post_id", "ap.id")
      .leftJoin("team_current_statuses as tcs", "t.id", "tcs.team_id")
      .leftJoin("statuses as cs", "tcs.status_id", "cs.id")
      .where("t.event_id", req.params.id)
      .select(
        "t.*",
        "ap.name as aid_post_name",
        "tcs.status_id as current_status_id",
        "tcs.updated_at as current_status_updated_at",
        "cs.name as current_status_name",
        "cs.color as current_status_color",
        "cs.is_start as current_status_is_start",
        "cs.is_closed as current_status_is_closed",
        "cs.is_busy as current_status_is_busy",
      );
    if (req.session?.role === "VIEWER") {
      if (viewerAidPostId) {
        teamsQuery.andWhere("t.aid_post_id", viewerAidPostId);
      } else {
        teamsQuery.whereRaw("1 = 0");
      }
    }
    const teams = await teamsQuery;
    const teamsWithMembers = await Promise.all(teams.map(async team => {
      const members = await db("team_members").where({ team_id: team.id });
      return { ...team, members };
    }));
    res.json(teamsWithMembers);
  });

  app.post("/api/events/:id/teams", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const { name, type, aid_post_id } = req.body || {};
    try {
      const typeExists = await db("team_types")
        .where({ event_id: req.params.id, name: type })
        .first();
      if (!typeExists) {
        return res.status(400).json({ error: "Onbekende teamsoort voor dit evenement" });
      }

      const aidPostValidation = await validateAidPostForEvent(req.params.id, aid_post_id, {
        allowNull: true,
      });
      if ("error" in aidPostValidation) {
        return res.status(400).json({ error: aidPostValidation.error });
      }

      const [id] = await db.transaction(async trx => {
        const [createdId] = await trx("teams").insert({
          event_id: req.params.id,
          name,
          type,
          aid_post_id: aidPostValidation.aidPostId,
          is_deployed: 1,
        });
        const startStatus = await trx("statuses")
          .where({ event_id: req.params.id, is_start: 1 })
          .orderBy("id", "asc")
          .first();
        if (startStatus) {
          await setTeamCurrentStatus(trx, req.params.id, createdId, startStatus.id);
        }
        return [createdId];
      });
      const aidPostName = aidPostValidation.aidPostId
        ? (await db("aid_posts").where({ id: aidPostValidation.aidPostId }).select("name").first())?.name
        : null;
      await writeActionLog(db, req, {
        event_id: req.params.id,
        team_id: id,
        message: `Ploeg aangemaakt: ${name} (${type})${aidPostName ? ` - hulppost ${aidPostName}` : ""}`,
      });
      res.json({ id });
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.patch("/api/teams/:id", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    try {
      const team = await db("teams").where({ id: req.params.id }).first();
      if (!team) return res.status(404).json({ error: "Ploeg niet gevonden" });
      if (!await ensureEventAccess(req, res, team.event_id)) return;

      const { name, type, is_deployed, aid_post_id } = req.body || {};
      const updatePayload: Record<string, any> = {};

      if (typeof name === "string" && name.trim()) {
        updatePayload.name = name.trim();
      }
      if (typeof type === "string" && type.trim()) {
        const typeExists = await db("team_types")
          .where({ event_id: team.event_id, name: type.trim() })
          .first();
        if (!typeExists) {
          return res.status(400).json({ error: "Onbekende teamsoort voor dit evenement" });
        }
        updatePayload.type = type.trim();
      }
      if (typeof is_deployed !== "undefined") {
        updatePayload.is_deployed = is_deployed ? 1 : 0;
      }
      if (typeof aid_post_id !== "undefined") {
        const aidPostValidation = await validateAidPostForEvent(team.event_id, aid_post_id, {
          allowNull: true,
        });
        if ("error" in aidPostValidation) {
          return res.status(400).json({ error: aidPostValidation.error });
        }
        updatePayload.aid_post_id = aidPostValidation.aidPostId;
      }

      if (Object.keys(updatePayload).length === 0) {
        return res.status(400).json({ error: "Geen geldige velden om te updaten" });
      }

      await db("teams").where({ id: req.params.id }).update(updatePayload);

      const newName = updatePayload.name ?? team.name;
      if (updatePayload.name && updatePayload.name !== team.name) {
        await writeActionLog(db, req, {
          event_id: team.event_id,
          team_id: team.id,
          message: `Ploeg hernoemd van "${team.name}" naar "${newName}"`,
        });
      }
      if (updatePayload.type && updatePayload.type !== team.type) {
        await writeActionLog(db, req, {
          event_id: team.event_id,
          team_id: team.id,
          message: `Ploeg "${newName}" categorie gewijzigd van "${team.type}" naar "${updatePayload.type}"`,
        });
      }
      if (typeof updatePayload.is_deployed !== "undefined" && Number(updatePayload.is_deployed) !== Number(team.is_deployed)) {
        await writeActionLog(db, req, {
          event_id: team.event_id,
          team_id: team.id,
          message: `Ploeg "${newName}" gemarkeerd als ${Number(updatePayload.is_deployed) === 1 ? "ingezetbaar" : "niet-ingezet"}`,
        });
      }
      if (typeof updatePayload.aid_post_id !== "undefined" && Number(updatePayload.aid_post_id || 0) !== Number(team.aid_post_id || 0)) {
        const nextAidPost = updatePayload.aid_post_id
          ? await db("aid_posts").where({ id: updatePayload.aid_post_id }).first()
          : null;
        await writeActionLog(db, req, {
          event_id: team.event_id,
          team_id: team.id,
          message: `Ploeg "${newName}" gekoppeld aan hulppost "${nextAidPost?.name || "Geen hulppost"}"`,
        });
      }

      res.json({ success: true });
    } catch (error) {
      console.error("Error updating team:", error);
      res.status(500).json({ error: "Ploeg bijwerken mislukt" });
    }
  });

  app.delete("/api/teams/:id", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const team = await db("teams").where({ id: req.params.id }).first();
    if (!team) return res.status(404).json({ error: "Ploeg niet gevonden" });
    if (!await ensureEventAccess(req, res, team.event_id)) return;

    await db("teams").where({ id: req.params.id }).del();
    await writeActionLog(db, req, {
      event_id: team.event_id,
      message: `Ploeg verwijderd: ${team.name}`,
    });
    res.json({ success: true });
  });

  app.post("/api/teams/:id/members", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const { name, role } = req.body;
    try {
      const team = await db("teams").where({ id: req.params.id }).first();
      if (!team) return res.status(404).json({ error: "Ploeg niet gevonden" });
      if (!await ensureEventAccess(req, res, team.event_id)) return;

      const [id] = await db("team_members").insert({ team_id: req.params.id, name, role });
      await writeActionLog(db, req, {
        event_id: team.event_id,
        team_id: team.id,
        message: `Lid toegevoegd aan ploeg "${team.name}": ${name}${role ? ` (${role})` : ""}`,
      });
      res.json({ id });
    } catch (error) {
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.delete("/api/members/:id", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const member = await db("team_members").where({ id: req.params.id }).first();
    if (!member) return res.status(404).json({ error: "Lid niet gevonden" });
    const team = await db("teams").where({ id: member.team_id }).first();
    if (team && !await ensureEventAccess(req, res, team.event_id)) return;

    await db("team_members").where({ id: req.params.id }).del();
    if (team) {
      await writeActionLog(db, req, {
        event_id: team.event_id,
        team_id: team.id,
        message: `Lid verwijderd uit ploeg "${team.name}": ${member.name}`,
      });
    }
    res.json({ success: true });
  });

  // Interventions
  app.get("/api/events/:id/interventions", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const now = Date.now();
    const viewerAidPostId = await getViewerAidPostIdForEvent(req, req.params.id);
    const interventions = await db("interventions")
      .where("event_id", req.params.id)
      .orderBy("created_at", "asc");
    
    const interventionsWithTeams = await Promise.all(interventions.map(async inter => {
      const activeHistory = await db("intervention_status_history")
        .where({ intervention_id: inter.id })
        .whereNull("ended_at")
        .select("team_id", "started_at");
      const activeByTeam = new Map(activeHistory.map(h => [Number(h.team_id), h.started_at]));

      const teamsQuery = db("teams as t")
        .join("intervention_teams as it", "t.id", "it.team_id")
        .leftJoin("statuses as s", "it.status_id", "s.id")
        .select("t.*", "it.status_id", "s.name as status_name", "s.color as status_color", "s.is_closed as status_is_closed")
        .where("it.intervention_id", inter.id);
      if (req.session?.role === "VIEWER") {
        if (viewerAidPostId) {
          teamsQuery.andWhere("t.aid_post_id", viewerAidPostId);
        } else {
          teamsQuery.whereRaw("1 = 0");
        }
      }
      const teams = await teamsQuery;

      const teamsWithDuration = teams.map(team => {
        const statusStartedAt = activeByTeam.get(Number(team.id)) || null;
        const statusDurationSeconds = statusStartedAt
          ? Math.max(0, Math.floor((now - new Date(statusStartedAt).getTime()) / 1000))
          : null;
        return {
          ...team,
          status_started_at: statusStartedAt,
          status_duration_seconds: statusDurationSeconds,
        };
      });

      const history = await db("intervention_status_history as h")
        .leftJoin("statuses as s", "h.status_id", "s.id")
        .where("h.intervention_id", inter.id)
        .select("h.status_id", "s.name as status_name", "h.started_at", "h.ended_at");

      const durationByStatus = new Map<string, number>();
      for (const row of history) {
        const from = new Date(row.started_at).getTime();
        const to = row.ended_at ? new Date(row.ended_at).getTime() : now;
        const seconds = Math.max(0, Math.floor((to - from) / 1000));
        const key = row.status_name || `Status ${row.status_id ?? "Onbekend"}`;
        durationByStatus.set(key, (durationByStatus.get(key) || 0) + seconds);
      }

      const status_durations = Array.from(durationByStatus.entries()).map(([status_name, total_seconds]) => ({
        status_name,
        total_seconds,
      }));

      const historyQuery = db("intervention_status_history as h")
        .join("teams as t", "h.team_id", "t.id")
        .leftJoin("statuses as s", "h.status_id", "s.id")
        .where("h.intervention_id", inter.id)
        .select(
          "h.id",
          "h.team_id",
          "t.name as team_name",
          "t.type as team_type",
          "h.status_id",
          "s.name as status_name",
          "s.color as status_color",
          "h.started_at",
          "h.ended_at",
        )
        .orderBy("h.started_at", "asc")
        .orderBy("h.id", "asc");
      if (req.session?.role === "VIEWER") {
        if (viewerAidPostId) {
          historyQuery.andWhere("t.aid_post_id", viewerAidPostId);
        } else {
          historyQuery.whereRaw("1 = 0");
        }
      }
      const team_history = await historyQuery;

      const openedAt = new Date(inter.created_at).getTime();
      const closedAt = inter.closed_at ? new Date(inter.closed_at).getTime() : now;
      const open_seconds = Math.max(0, Math.floor((closedAt - openedAt) / 1000));

      return { ...inter, open_seconds, status_durations, team_history, teams: teamsWithDuration };
    }));
    
    res.json(interventionsWithTeams);
  });

  app.post("/api/events/:id/interventions", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const { title, location, description, status_id, team_ids } = req.body;
    const normalizedTitle = String(title || "").trim();
    if (!normalizedTitle) return res.status(400).json({ error: "Titel is verplicht" });
    try {
      const interventionId = await db.transaction(async trx => {
        const requestedTeamIds = Array.isArray(team_ids)
          ? toPositiveIntArray(team_ids)
          : [];

        const candidateTeams = requestedTeamIds.length > 0
          ? await trx("teams")
              .where({ event_id: req.params.id })
              .whereIn("id", requestedTeamIds)
              .select("id", "name", "is_deployed")
          : [];
        const notDeployedTeams = candidateTeams.filter((t: any) => Number(t.is_deployed) !== 1);
        if (notDeployedTeams.length > 0) {
          throw new Error(`TEAM_NOT_DEPLOYED:${notDeployedTeams.map((t: any) => t.name).join(", ")}`);
        }
        const validTeamIds = candidateTeams.map((t: any) => Number(t.id));

        const blockedTeams = await getBlockedTeamsForInterventionAdd(
          trx,
          req.params.id,
          validTeamIds
        );
        if (blockedTeams.length > 0) {
          const details = blockedTeams
            .map((t: any) => `${t.team_name} (${t.status_name || "geen status"})`)
            .join(", ");
          throw new Error(`TEAM_NOT_ALLOWED_STATUS:${details}`);
        }

        const resolvedStatusId = await resolveDefaultStatusId(
          trx,
          req.params.id,
          status_id ? Number(status_id) : null
        );

        const maxNoRow = await trx("interventions")
          .where({ event_id: req.params.id })
          .max<{ max_no: number }>("intervention_number as max_no")
          .first();
        const nextInterventionNo = (Number(maxNoRow?.max_no) || 0) + 1;

        const [id] = await trx("interventions").insert({
          event_id: req.params.id,
          intervention_number: nextInterventionNo,
          title: normalizedTitle,
          location: typeof location === "string" ? location.trim() : "",
          description: typeof description === "string" ? description.trim() : ""
        });
        
        if (validTeamIds.length > 0) {
          await trx("intervention_teams").insert(
            validTeamIds.map((teamId: number) => ({ 
              intervention_id: id, 
              team_id: teamId,
              status_id: resolvedStatusId
            }))
          );

          await trx("intervention_status_history").insert(
            validTeamIds.map((teamId: number) => ({
              intervention_id: id,
              team_id: teamId,
              status_id: resolvedStatusId || null,
              started_at: new Date().toISOString(),
              ended_at: null,
            }))
          );

          for (const teamId of validTeamIds) {
            await setTeamCurrentStatus(trx, req.params.id, teamId, resolvedStatusId);
          }
        }
        
        await writeActionLog(trx, req, {
          event_id: req.params.id,
          intervention_id: id,
          message: `Nieuwe interventie aangemaakt: ${normalizedTitle}`
        });
          
        return id;
      });
      
      res.json({ id: interventionId });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TEAM_NOT_DEPLOYED:")) {
        return res.status(400).json({
          error: `Niet-ingezette ploeg kan niet gekoppeld worden aan interventie: ${error.message.replace("TEAM_NOT_DEPLOYED:", "")}`,
        });
      }
      if (error instanceof Error && error.message.startsWith("TEAM_NOT_ALLOWED_STATUS:")) {
        return res.status(400).json({
          error: `Ploeg toevoegen kan enkel vanuit een beginstatus of gesloten status. Blokkering: ${error.message.replace("TEAM_NOT_ALLOWED_STATUS:", "")}`,
        });
      }
      console.error("Error creating intervention:", error);
      res.status(500).json({ error: "Internal Server Error" });
    }
  });

  app.patch("/api/interventions/:id", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req: any, res) => {
    const { location, description, add_team_ids, remove_team_ids, default_status_id } = req.body || {};
    try {
      const intervention = await db("interventions").where({ id: req.params.id }).first();
      if (!intervention) return res.status(404).json({ error: "Interventie niet gevonden" });
      if (!await ensureEventAccess(req, res, intervention.event_id)) return;

      const addTeamIds = toPositiveIntArray(add_team_ids);
      const removeTeamIds = toPositiveIntArray(remove_team_ids);

      await db.transaction(async trx => {
        if (typeof location === "string" && location !== intervention.location) {
          await trx("interventions")
            .where({ id: intervention.id })
            .update({ location });

          await writeActionLog(trx, req, {
            event_id: intervention.event_id,
            intervention_id: intervention.id,
            message: `Locatie van interventie "${intervention.title}" gewijzigd naar "${location || "Geen locatie"}"`,
          });
        }

        if (typeof description === "string" && description !== (intervention.description || "")) {
          await trx("interventions")
            .where({ id: intervention.id })
            .update({ description });

          await writeActionLog(trx, req, {
            event_id: intervention.event_id,
            intervention_id: intervention.id,
            message: `Omschrijving van interventie "${intervention.title}" bijgewerkt`,
          });
        }

        if (removeTeamIds.length > 0) {
          const linkedToRemove = await trx("intervention_teams as it")
            .join("teams as t", "it.team_id", "t.id")
            .where("it.intervention_id", intervention.id)
            .whereIn("it.team_id", removeTeamIds)
            .where("t.event_id", intervention.event_id)
            .select("it.team_id", "t.name");

          if (linkedToRemove.length > 0) {
            const ids = linkedToRemove.map((r: any) => r.team_id);
            const startStatusId = await resolveStartStatusId(trx, intervention.event_id, null);

            await trx("intervention_teams")
              .where({ intervention_id: intervention.id })
              .whereIn("team_id", ids)
              .del();

            await trx("intervention_status_history")
              .where({ intervention_id: intervention.id })
              .whereIn("team_id", ids)
              .whereNull("ended_at")
              .update({ ended_at: new Date().toISOString() });

            for (const t of linkedToRemove) {
              await setTeamCurrentStatus(trx, intervention.event_id, t.team_id, startStatusId);
              await writeActionLog(trx, req, {
                event_id: intervention.event_id,
                intervention_id: intervention.id,
                team_id: t.team_id,
                message: `Ploeg "${t.name}" verwijderd uit interventie "${intervention.title}"`,
              });
            }
          }
        }

        if (addTeamIds.length > 0) {
          const existingLinks = await trx("intervention_teams")
            .where({ intervention_id: intervention.id })
            .whereIn("team_id", addTeamIds)
            .select("team_id");
          const existingSet = new Set(
            existingLinks
              .map((r: any) => toPositiveInt(r.team_id))
              .filter((teamId): teamId is number => teamId != null)
          );
          if (existingSet.size > 0) {
            const duplicateTeams = await trx("teams")
              .where({ event_id: intervention.event_id })
              .whereIn("id", [...existingSet])
              .select("name");
            throw new Error(`TEAM_ALREADY_LINKED:${duplicateTeams.map((t: any) => t.name).join(", ")}`);
          }

          const candidateTeams = await trx("teams")
            .where({ event_id: intervention.event_id })
            .whereIn("id", addTeamIds)
            .select("id", "name", "is_deployed");
          const notDeployedTeams = candidateTeams.filter((t: any) => Number(t.is_deployed) !== 1);
          if (notDeployedTeams.length > 0) {
            throw new Error(`TEAM_NOT_DEPLOYED:${notDeployedTeams.map((t: any) => t.name).join(", ")}`);
          }
          const teamsToAdd = candidateTeams.filter((t: any) => !existingSet.has(Number(t.id)));

          const targetStatusId = await resolveDefaultStatusId(
            trx,
            intervention.event_id,
            default_status_id ? Number(default_status_id) : null
          );

          if (teamsToAdd.length > 0) {
            const blockedTeams = await getBlockedTeamsForInterventionAdd(
              trx,
              intervention.event_id,
              teamsToAdd.map((t: any) => Number(t.id)),
              intervention.id
            );
            if (blockedTeams.length > 0) {
              const details = blockedTeams
                .map((t: any) => `${t.team_name} (${t.status_name || "geen status"})`)
                .join(", ");
              throw new Error(`TEAM_NOT_ALLOWED_STATUS:${details}`);
            }

            await trx("intervention_teams").insert(
              teamsToAdd.map((t: any) => ({
                intervention_id: intervention.id,
                team_id: t.id,
                status_id: targetStatusId,
              }))
            );

            await trx("intervention_status_history").insert(
              teamsToAdd.map((t: any) => ({
                intervention_id: intervention.id,
                team_id: t.id,
                status_id: targetStatusId,
                started_at: new Date().toISOString(),
                ended_at: null,
              }))
            );

            for (const t of teamsToAdd) {
              await setTeamCurrentStatus(trx, intervention.event_id, t.id, targetStatusId);
              await writeActionLog(trx, req, {
                event_id: intervention.event_id,
                intervention_id: intervention.id,
                team_id: t.id,
                message: `Ploeg "${t.name}" toegevoegd aan interventie "${intervention.title}"`,
              });
            }
          }
        }

        const closeReason = await recalculateInterventionClosedState(trx, intervention.id);
        if (closeReason === "closed_no_active_teams" || closeReason === "closed_all_teams") {
          await writeActionLog(trx, req, {
            event_id: intervention.event_id,
            intervention_id: intervention.id,
            message: `Interventie "${intervention.title}" automatisch gesloten${closeReason === "closed_no_active_teams" ? " omdat er geen ploegen meer gekoppeld zijn" : " omdat alle gekoppelde ploegen een eindstatus hebben"}`,
          });
        }
      });

      res.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TEAM_NOT_DEPLOYED:")) {
        return res.status(400).json({
          error: `Niet-ingezette ploeg kan niet gekoppeld worden aan interventie: ${error.message.replace("TEAM_NOT_DEPLOYED:", "")}`,
        });
      }
      if (error instanceof Error && error.message.startsWith("TEAM_NOT_ALLOWED_STATUS:")) {
        return res.status(400).json({
          error: `Ploeg toevoegen kan enkel vanuit een beginstatus of gesloten status. Blokkering: ${error.message.replace("TEAM_NOT_ALLOWED_STATUS:", "")}`,
        });
      }
      if (error instanceof Error && error.message.startsWith("TEAM_ALREADY_LINKED:")) {
        return res.status(400).json({
          error: `Ploeg is al gekoppeld aan deze interventie: ${error.message.replace("TEAM_ALREADY_LINKED:", "")}`,
        });
      }
      console.error("Error updating intervention:", error);
      res.status(500).json({ error: "Interventie bewerken mislukt" });
    }
  });

  app.delete("/api/interventions/:id", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    try {
      const intervention = await db("interventions").where({ id: req.params.id }).first();
      if (!intervention) return res.status(404).json({ error: "Interventie niet gevonden" });
      if (!await ensureEventAccess(req, res, intervention.event_id)) return;

      await db.transaction(async trx => {
        await trx("interventions").where({ id: req.params.id }).del();
        await writeActionLog(trx, req, {
          event_id: intervention.event_id,
          intervention_id: intervention.id,
          message: `Interventie verwijderd: ${intervention.title}`
        });
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting intervention:", error);
      res.status(500).json({ error: "Delete failed" });
    }
  });

  app.patch("/api/interventions/:id/close-empty", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req: any, res) => {
    try {
      const intervention = await db("interventions").where({ id: req.params.id }).first();
      if (!intervention) return res.status(404).json({ error: "Interventie niet gevonden" });
      if (!await ensureEventAccess(req, res, intervention.event_id)) return;
      if (intervention.closed_at) return res.json({ success: true });

      const activeLink = await db("intervention_teams")
        .where({ intervention_id: intervention.id })
        .first();
      if (activeLink) {
        return res.status(400).json({ error: "Interventie kan niet manueel gesloten worden: er zijn gekoppelde ploegen" });
      }

      await db.transaction(async trx => {
        await trx("interventions")
          .where({ id: intervention.id })
          .update({ closed_at: new Date().toISOString() });

        await writeActionLog(trx, req, {
          event_id: intervention.event_id,
          intervention_id: intervention.id,
          message: `Interventie manueel gesloten zonder actieve ploegkoppeling: ${intervention.title}`,
        });
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error closing empty intervention:", error);
      res.status(500).json({ error: "Interventie sluiten mislukt" });
    }
  });

  app.patch("/api/interventions/:id/teams/:teamId", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const { status_id, aid_post_id } = req.body || {};
    const { id: interventionId, teamId } = req.params;
    try {
      const status = await db("statuses").where({ id: status_id }).first();
      const intervention = await db("interventions").where({ id: interventionId }).first();
      const team = await db("teams").where({ id: teamId }).first();
      if (!intervention || !team || !status) {
        return res.status(404).json({ error: "Interventie, ploeg of status niet gevonden" });
      }
      if (Number(status.event_id) !== Number(intervention.event_id) || Number(team.event_id) !== Number(intervention.event_id)) {
        return res.status(400).json({ error: "Ploeg of status hoort niet bij dit evenement" });
      }
      if (!await ensureEventAccess(req, res, intervention.event_id)) return;

      const aidPostValidation = await validateAidPostForEvent(intervention.event_id, aid_post_id, {
        allowNull: true,
        invalidError: "Ongeldige bestemmingshulppost voor dit evenement",
      });
      if ("error" in aidPostValidation) return res.status(400).json({ error: aidPostValidation.error });
      
      await db.transaction(async trx => {
        const currentLink = await trx("intervention_teams")
          .where({ intervention_id: interventionId, team_id: teamId })
          .first();
        if (!currentLink) {
          throw new Error("TEAM_NOT_LINKED");
        }

        const nowIso = new Date().toISOString();

        if (currentLink && Number(currentLink.status_id) !== Number(status_id)) {
          await trx("intervention_status_history")
            .where({ intervention_id: interventionId, team_id: teamId })
            .whereNull("ended_at")
            .update({ ended_at: nowIso });

          await trx("intervention_status_history").insert({
            intervention_id: interventionId,
            team_id: teamId,
            status_id: status_id || null,
            started_at: nowIso,
            ended_at: null,
          });
        }

        if (Number(status.is_start) === 1) {
          await trx("intervention_teams")
            .where({ intervention_id: interventionId, team_id: teamId })
            .del();
          await trx("intervention_status_history")
            .where({ intervention_id: interventionId, team_id: teamId })
            .whereNull("ended_at")
            .update({ ended_at: nowIso });
        } else {
          await trx("intervention_teams")
            .where({ intervention_id: interventionId, team_id: teamId })
            .update({ status_id });
        }

        await setTeamCurrentStatus(trx, intervention.event_id, team.id, status.id);

        if (aidPostValidation.aidPostId) {
          await trx("teams").where({ id: team.id }).update({ aid_post_id: aidPostValidation.aidPostId });
        }

        const closeReason = await recalculateInterventionClosedState(trx, interventionId);

        const destination = aidPostValidation.aidPostId
          ? await trx("aid_posts").where({ id: aidPostValidation.aidPostId }).first()
          : null;

        await writeActionLog(trx, req, {
          event_id: intervention.event_id,
          team_id: team.id,
          intervention_id: intervention.id,
          message: `Status van ploeg "${team.name}" in interventie "${intervention.title}" gewijzigd naar "${status.name}"${destination ? `; afgevoerd naar hulppost "${destination.name}"` : ""}${Number(status.is_start) === 1 ? "; ploeg ontkoppeld en radiografisch beschikbaar" : ""}`
        });
        if (closeReason === "closed_no_active_teams" || closeReason === "closed_all_teams") {
          await writeActionLog(trx, req, {
            event_id: intervention.event_id,
            intervention_id: intervention.id,
            message: `Interventie "${intervention.title}" automatisch gesloten${closeReason === "closed_no_active_teams" ? " omdat er geen ploegen meer gekoppeld zijn" : " omdat alle gekoppelde ploegen een eindstatus hebben"}`,
          });
        }
      });
      
      res.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message === "TEAM_NOT_LINKED") {
        return res.status(400).json({ error: "Ploeg is niet gekoppeld aan deze interventie" });
      }
      console.error("Error updating team status:", error);
      res.status(500).json({ error: "Update failed" });
    }
  });

  app.delete("/api/interventions/:id/teams/:teamId", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const { id: interventionId, teamId } = req.params;
    const requestedStatusId = toPositiveInt(req.body?.status_id);
    const unlinkAction = String(req.body?.action || "unlink").toLowerCase();
    const isOvtz = unlinkAction === "ovtz";
    try {
      const intervention = await db("interventions").where({ id: interventionId }).first();
      const team = await db("teams").where({ id: teamId }).first();
      if (!intervention || !team) {
        return res.status(404).json({ error: "Interventie of ploeg niet gevonden" });
      }
      if (Number(team.event_id) !== Number(intervention.event_id)) {
        return res.status(400).json({ error: "Ploeg hoort niet bij dit evenement" });
      }
      if (!await ensureEventAccess(req, res, intervention.event_id)) return;

      await db.transaction(async trx => {
        const currentLink = await trx("intervention_teams")
          .where({ intervention_id: intervention.id, team_id: team.id })
          .first();
        if (!currentLink) throw new Error("TEAM_NOT_LINKED");

        const startStatusId = await resolveStartStatusId(trx, intervention.event_id, requestedStatusId);
        const nowIso = new Date().toISOString();

        await trx("intervention_teams")
          .where({ intervention_id: intervention.id, team_id: team.id })
          .del();
        await trx("intervention_status_history")
          .where({ intervention_id: intervention.id, team_id: team.id })
          .whereNull("ended_at")
          .update({ ended_at: nowIso });
        await setTeamCurrentStatus(trx, intervention.event_id, team.id, startStatusId);
        const closeReason = await recalculateInterventionClosedState(trx, intervention.id);

        const status = startStatusId
          ? await trx("statuses").where({ id: startStatusId }).first()
          : null;
        await writeActionLog(trx, req, {
          event_id: intervention.event_id,
          intervention_id: intervention.id,
          team_id: team.id,
          message: isOvtz
            ? `OVTZ: ploeg "${team.name}" ontkoppeld van interventie "${intervention.title}"${status ? ` en radiografisch beschikbaar gezet op "${status.name}"` : " en radiografisch beschikbaar gezet"}`
            : `Ploeg "${team.name}" ontkoppeld van interventie "${intervention.title}"${status ? ` en op "${status.name}" gezet` : ""}`,
        });
        if (closeReason === "closed_no_active_teams" || closeReason === "closed_all_teams") {
          await writeActionLog(trx, req, {
            event_id: intervention.event_id,
            intervention_id: intervention.id,
            message: `Interventie "${intervention.title}" automatisch gesloten omdat er geen ploegen meer gekoppeld zijn`,
          });
        }
      });

      res.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message === "TEAM_NOT_LINKED") {
        return res.status(400).json({ error: "Ploeg is niet gekoppeld aan deze interventie" });
      }
      console.error("Error unlinking team:", error);
      res.status(500).json({ error: "Ploeg ontkoppelen mislukt" });
    }
  });

  app.patch("/api/teams/:id/status", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const statusId = toPositiveInt(req.body?.status_id);
    if (!statusId) return res.status(400).json({ error: "Status is verplicht" });

    try {
      const team = await db("teams").where({ id: req.params.id }).first();
      const status = await db("statuses").where({ id: statusId }).first();
      if (!team || !status) return res.status(404).json({ error: "Ploeg of status niet gevonden" });
      if (Number(team.event_id) !== Number(status.event_id)) {
        return res.status(400).json({ error: "Status hoort niet bij dit evenement" });
      }
      if (!await ensureEventAccess(req, res, team.event_id)) return;

      await db.transaction(async trx => {
        const activeLinks = await trx("intervention_teams as it")
          .join("interventions as i", "it.intervention_id", "i.id")
          .where("it.team_id", team.id)
          .where("i.event_id", team.event_id)
          .whereNull("i.closed_at")
          .select("i.title");
        if (activeLinks.length > 0) {
          throw new Error(`TEAM_HAS_ACTIVE_INTERVENTION:${activeLinks.map((r: any) => r.title).join(", ")}`);
        }

        await setTeamCurrentStatus(trx, team.event_id, team.id, status.id);
        await writeActionLog(trx, req, {
          event_id: team.event_id,
          team_id: team.id,
          message: `Status van ploeg "${team.name}" zonder interventie gewijzigd naar "${status.name}"`,
        });
      });

      res.json({ success: true });
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("TEAM_HAS_ACTIVE_INTERVENTION:")) {
        return res.status(400).json({
          error: `Ploeg is nog gekoppeld aan een actieve interventie: ${error.message.replace("TEAM_HAS_ACTIVE_INTERVENTION:", "")}`,
        });
      }
      console.error("Error updating standalone team status:", error);
      res.status(500).json({ error: "Ploegstatus wijzigen mislukt" });
    }
  });

  // Logs
  app.get("/api/events/:id/logs", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(10, Number(req.query.limit) || 20));
    const userId = req.query.user_id ? Number(req.query.user_id) : null;
    const teamId = req.query.team_id ? Number(req.query.team_id) : null;
    const interventionId = req.query.intervention_id ? Number(req.query.intervention_id) : null;

    const baseQuery = db("logs").where({ event_id: req.params.id });
    if (userId) baseQuery.andWhere({ actor_user_id: userId });
    if (teamId) baseQuery.andWhere({ team_id: teamId });
    if (interventionId) baseQuery.andWhere({ intervention_id: interventionId });

    const totalResult = await baseQuery.clone().count<{ count: number }>("id as count").first();
    const total = Number(totalResult?.count) || 0;

    const items = await baseQuery
      .clone()
      .orderBy("created_at", "desc")
      .orderBy("id", "desc")
      .offset((page - 1) * limit)
      .limit(limit);

    res.json({
      items,
      page,
      limit,
      total,
      hasMore: page * limit < total,
    });
  });

  app.get("/api/events/:id/log-users", requireAuth, async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const users = await db("logs")
      .where({ event_id: req.params.id })
      .whereNotNull("actor_user_id")
      .select("actor_user_id", "actor_username")
      .groupBy("actor_user_id", "actor_username")
      .orderBy("actor_username", "asc");

    res.json(
      users.map((u) => ({
        id: u.actor_user_id,
        username: u.actor_username || `Gebruiker ${u.actor_user_id}`,
      }))
    );
  });

  app.post("/api/events/:id/logs", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const { message, team_id, intervention_id } = req.body;
    await writeActionLog(db, req, {
      event_id: req.params.id,
      team_id: team_id || null,
      intervention_id: intervention_id || null,
      message,
    });
    res.json({ success: true });
  });

  // Intervention Chat Messages
  app.get("/api/interventions/:id/messages", requireAuth, async (req, res) => {
    const intervention = await db("interventions").where({ id: req.params.id }).first();
    if (!intervention) return res.status(404).json({ error: "Interventie niet gevonden" });
    if (!await ensureEventAccess(req, res, intervention.event_id)) return;
    const messages = await db("intervention_messages")
      .where({ intervention_id: req.params.id })
      .orderBy("created_at", "desc")
      .orderBy("id", "desc");
    res.json(messages);
  });

  app.post("/api/interventions/:id/messages", requireAuth, async (req: any, res) => {
    const message = String(req.body?.message || "").trim();
    if (!message) return res.status(400).json({ error: "Bericht is verplicht" });

    const intervention = await db("interventions").where({ id: req.params.id }).first();
    if (!intervention) return res.status(404).json({ error: "Interventie niet gevonden" });
    if (!await ensureEventAccess(req, res, intervention.event_id)) return;

    const [id] = await db("intervention_messages").insert({
      intervention_id: req.params.id,
      actor_user_id: req.session.userId,
      actor_username: req.session.username,
      message,
    });

    await writeActionLog(db, req, {
      event_id: intervention.event_id,
      intervention_id: intervention.id,
      message: `Interventiebericht toegevoegd: ${message}`,
    });

    res.json({ id });
  });

  // Export Data
  app.get("/api/events/:id/export", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const eventId = req.params.id;
    const format = String(req.query.format || "json").toLowerCase();
    const dataset = String(req.query.dataset || "logs").toLowerCase();
    const event = await db("events").where({ id: eventId }).first();
    if (!event) return res.status(404).json({ error: "Event not found" });

    const safeEventName = String(event.name || `event-${eventId}`).replace(/[^\w\-]+/g, "_");

    if (format === "csv" || format === "excel") {
      let headers: string[] = [];
      let rows: Array<Record<string, unknown>> = [];

      if (dataset === "teams") {
        const teams = await db("teams").where({ event_id: eventId }).orderBy("name", "asc");
        rows = teams.map((t) => ({
          id: t.id,
          name: t.name,
          type: t.type,
        }));
        headers = ["id", "name", "type"];
      } else if (dataset === "interventions") {
        const interventions = await db("interventions")
          .where({ event_id: eventId })
          .orderBy("created_at", "desc");
        rows = interventions.map((i) => ({
          id: i.id,
          title: i.title,
          location: i.location,
          created_at: i.created_at,
          closed_at: i.closed_at,
        }));
        headers = ["id", "title", "location", "created_at", "closed_at"];
      } else if (dataset === "all") {
        const logs = await db("logs as l")
          .leftJoin("teams as t", "l.team_id", "t.id")
          .leftJoin("interventions as i", "l.intervention_id", "i.id")
          .where("l.event_id", eventId)
          .select(
            "l.id",
            "l.created_at",
            "l.actor_user_id",
            "l.actor_username",
            "l.message",
            "t.name as team_name",
            "i.title as intervention_title"
          )
          .orderBy("l.created_at", "desc")
          .orderBy("l.id", "desc");
        const teams = await db("teams").where({ event_id: eventId }).orderBy("name", "asc");
        const interventions = await db("interventions")
          .where({ event_id: eventId })
          .orderBy("created_at", "desc");

        rows = [
          ...logs.map((l) => ({
            record_type: "log",
            id: l.id,
            created_at: l.created_at,
            actor_user_id: l.actor_user_id,
            actor_username: l.actor_username,
            team_name: l.team_name,
            intervention_title: l.intervention_title,
            title_or_name: "",
            location: "",
            closed_at: "",
            message: l.message,
          })),
          ...teams.map((t) => ({
            record_type: "team",
            id: t.id,
            created_at: "",
            actor_user_id: "",
            actor_username: "",
            team_name: t.name,
            intervention_title: "",
            title_or_name: t.name,
            location: "",
            closed_at: "",
            message: `Type: ${t.type}`,
          })),
          ...interventions.map((i) => ({
            record_type: "intervention",
            id: i.id,
            created_at: i.created_at,
            actor_user_id: "",
            actor_username: "",
            team_name: "",
            intervention_title: i.title,
            title_or_name: i.title,
            location: i.location,
            closed_at: i.closed_at,
            message: "",
          })),
        ];

        headers = [
          "record_type",
          "id",
          "created_at",
          "actor_user_id",
          "actor_username",
          "team_name",
          "intervention_title",
          "title_or_name",
          "location",
          "closed_at",
          "message",
        ];
      } else {
        const logs = await db("logs as l")
          .leftJoin("teams as t", "l.team_id", "t.id")
          .leftJoin("interventions as i", "l.intervention_id", "i.id")
          .where("l.event_id", eventId)
          .select(
            "l.id",
            "l.created_at",
            "l.actor_user_id",
            "l.actor_username",
            "l.message",
            "t.name as team_name",
            "i.title as intervention_title"
          )
          .orderBy("l.created_at", "desc")
          .orderBy("l.id", "desc");

        rows = logs.map((l) => ({
          id: l.id,
          created_at: l.created_at,
          actor_user_id: l.actor_user_id,
          actor_username: l.actor_username,
          team_name: l.team_name,
          intervention_title: l.intervention_title,
          message: l.message,
        }));
        headers = [
          "id",
          "created_at",
          "actor_user_id",
          "actor_username",
          "team_name",
          "intervention_title",
          "message",
        ];
      }

      const filenameBase = `${safeEventName}_${dataset}_${new Date().toISOString().slice(0, 10)}`;

      if (format === "csv") {
        const csv = toCsv(headers, rows);
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.csv"`);
        return res.send(csv);
      }

      const html = toExcelHtmlTable(`${event.name} - ${dataset}`, headers, rows);
      res.setHeader("Content-Type", "application/vnd.ms-excel; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${filenameBase}.xls"`);
      return res.send(html);
    }

    const interventions = await db("interventions")
      .where("event_id", eventId);
    
    const interventionsWithTeams = await Promise.all(interventions.map(async inter => {
      const teams = await db("teams as t")
        .join("intervention_teams as it", "t.id", "it.team_id")
        .leftJoin("statuses as s", "it.status_id", "s.id")
        .select("t.*", "s.name as status_name")
        .where("it.intervention_id", inter.id);
      return { ...inter, teams };
    }));
    
    const teams = await db("teams").where({ event_id: eventId });
    const logs = await db("logs").where({ event_id: eventId }).orderBy("created_at", "desc");
    
    res.json({ event, interventions: interventionsWithTeams, teams, logs });
  });

  // Settings & Branding
  app.get("/api/settings", async (req, res) => {
    const settings = await db("settings").select();
    const settingsObj = settings.reduce((acc: any, curr: any) => {
      acc[curr.key] = curr.value;
      return acc;
    }, {});
    res.json(settingsObj);
  });

  app.post("/api/settings", requireRole(["ROOT", "ADMIN"]), sensitiveRateLimit, async (req, res) => {
    const settings = req.body;
    await db.transaction(async trx => {
      for (const [key, value] of Object.entries(settings)) {
        await trx("settings").where({ key }).update({ value: String(value) });
      }
    });
    res.json({ success: true });
  });

  app.post("/api/settings/logo-upload", requireRole(["ROOT", "ADMIN"]), uploadRateLimit, async (req, res) => {
    const { data_url, filename } = req.body || {};
    if (typeof data_url !== "string" || !data_url.startsWith("data:image/")) {
      return res.status(400).json({ error: "Ongeldige afbeelding" });
    }

    const match = data_url.match(/^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/);
    if (!match) {
      return res.status(400).json({ error: "Ongeldige afbeelding data" });
    }

    const mime = match[1].toLowerCase();
    const base64Data = match[2];
    const allowedMimes: Record<string, string> = {
      "image/png": "png",
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/webp": "webp",
      "image/gif": "gif",
    };
    const ext = allowedMimes[mime];
    if (!ext) {
      return res.status(400).json({ error: "Bestandstype niet ondersteund" });
    }

    let buffer: Buffer;
    try {
      buffer = Buffer.from(base64Data, "base64");
    } catch {
      return res.status(400).json({ error: "Ongeldige afbeelding data" });
    }
    const maxBytes = 5 * 1024 * 1024;
    if (buffer.length > maxBytes) {
      return res.status(400).json({ error: "Afbeelding is te groot (max 5MB)" });
    }

    const safeBaseName = (typeof filename === "string" ? filename : "logo")
      .toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "logo";

    let logoUrl: string;
    if (useDbUploads) {
      const [assetId] = await db("uploaded_assets").insert({
        scope: "branding",
        mime,
        content: buffer,
      });
      logoUrl = `/api/uploads/${assetId}`;
    } else {
      const fileName = `${safeBaseName}-${Date.now()}.${ext}`;
      const uploadDir = path.join(uploadsRoot, "branding");
      await fs.mkdir(uploadDir, { recursive: true });
      await fs.writeFile(path.join(uploadDir, fileName), buffer);
      logoUrl = `/uploads/branding/${fileName}`;
    }

    await db("settings").where({ key: "logo_url" }).update({ value: logoUrl });

    res.json({ url: logoUrl });
  });

  app.get("/api/uploads/:id", async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Ongeldig upload id" });
    }

    const asset = await db("uploaded_assets")
      .where({ id })
      .select("id", "mime", "content")
      .first();

    if (!asset) {
      return res.status(404).json({ error: "Upload niet gevonden" });
    }

    const content = Buffer.isBuffer(asset.content)
      ? asset.content
      : Buffer.from(asset.content);

    res.setHeader("Content-Type", String(asset.mime || "application/octet-stream"));
    res.setHeader("Cache-Control", "public, max-age=3600");
    return res.send(content);
  });

  app.use("/uploads", express.static(uploadsRoot));

  // Catch-all for API routes to prevent falling through to SPA fallback
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(path.join(process.cwd(), "dist")));
    app.get("*", (req, res) => {
      res.sendFile(path.join(process.cwd(), "dist", "index.html"));
    });
  }

  return app;
}

const isDirectRun = (() => {
  const entryFile = process.argv[1];
  if (!entryFile) return false;
  return fileURLToPath(import.meta.url) === path.resolve(entryFile);
})();

if (isDirectRun) {
  const PORT = Number(process.env.PORT) || 31987;
  createApp()
    .then((app) => {
      app.listen(PORT, "0.0.0.0", () => {
        console.log(`Server running on http://localhost:${PORT}`);
      });
    })
    .catch((err) => {
      console.error("Failed to start server:", err);
      process.exit(1);
    });
}
