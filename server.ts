import express from "express";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import bcrypt from "bcryptjs";
import session from "express-session";
import db, { initDb } from "./db.js";

const defaultTeamTypes = ["Terrein", "Interventie", "DGH", "NDPA", "Dienstleiding"];

// Extend express-session to include custom properties
declare module 'express-session' {
  interface SessionData {
    userId: number;
    username: string;
    role: string;
  }
}

class KnexSessionStore extends session.Store {
  private tableReady: Promise<void> | null = null;

  private async ensureTable() {
    if (!this.tableReady) {
      this.tableReady = (async () => {
        const exists = await db.schema.hasTable("sessions");
        if (exists) return;
        await db.schema.createTable("sessions", (table) => {
          table.string("sid", 255).primary();
          table.text("sess").notNullable();
          table.bigInteger("expires_at").index();
          table.timestamp("created_at").defaultTo(db.fn.now());
        });
      })();
    }
    await this.tableReady;
  }

  get(sid: string, callback: (err?: any, session?: session.SessionData | null) => void) {
    (async () => {
      await this.ensureTable();
      const row = await db("sessions").where({ sid }).first();
      if (!row) return callback(undefined, null);

      const expiresAt = row.expires_at != null ? Number(row.expires_at) : null;
      if (expiresAt != null && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        await db("sessions").where({ sid }).del();
        return callback(undefined, null);
      }

      const parsed = JSON.parse(String(row.sess));
      return callback(undefined, parsed);
    })().catch((error) => callback(error));
  }

  set(sid: string, sess: session.SessionData, callback?: (err?: any) => void) {
    (async () => {
      await this.ensureTable();
      const cookieExpires = sess?.cookie?.expires ? new Date(sess.cookie.expires as any).getTime() : null;
      const maxAge = typeof sess?.cookie?.maxAge === "number" ? sess.cookie.maxAge : null;
      const expiresAt = Number.isFinite(cookieExpires as number)
        ? cookieExpires
        : (maxAge != null ? Date.now() + maxAge : null);

      await db("sessions")
        .insert({
          sid,
          sess: JSON.stringify(sess),
          expires_at: expiresAt,
        })
        .onConflict("sid")
        .merge({
          sess: JSON.stringify(sess),
          expires_at: expiresAt,
        });
    })()
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  destroy(sid: string, callback?: (err?: any) => void) {
    (async () => {
      await this.ensureTable();
      await db("sessions").where({ sid }).del();
    })()
      .then(() => callback?.())
      .catch((error) => callback?.(error));
  }

  touch(sid: string, sess: session.SessionData, callback?: () => void) {
    this.set(sid, sess, () => callback?.());
  }
}

export async function createApp() {
  const isProduction = process.env.NODE_ENV === "production";
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

  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const runDatabaseBootstrap = async () => {
    await initDb();

    const rootExists = await db("users").where({ role: "ROOT" }).first();
    if (rootExists) return;

    if (!defaultRootPassword || defaultRootPassword.length < 6) {
      throw new Error("DEFAULT_ROOT_PASSWORD is required (min 6 chars) when no ROOT user exists");
    }

    const hashedPassword = await bcrypt.hash(defaultRootPassword, 10);
    try {
      await db("users").insert({ username: defaultRootUsername, password: hashedPassword, role: "ROOT" });
      console.log(`Default ROOT user created: ${defaultRootUsername}`);
    } catch (error: any) {
      const code = String(error?.code || "");
      if (code !== "ER_DUP_ENTRY" && code !== "SQLITE_CONSTRAINT") {
        throw error;
      }
      const existingRoot = await db("users").where({ role: "ROOT" }).first();
      if (!existingRoot) throw error;
    }
  };

  let dbBootstrapPromise: Promise<void> | null = null;
  const ensureDatabaseReady = async () => {
    if (!dbBootstrapPromise) {
      dbBootstrapPromise = (async () => {
        const maxAttempts = Number(process.env.DB_INIT_MAX_ATTEMPTS || 3);
        let lastError: unknown;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          try {
            await runDatabaseBootstrap();
            return;
          } catch (error) {
            lastError = error;
            console.error(`Database bootstrap failed (attempt ${attempt}/${maxAttempts})`, error);
            if (attempt < maxAttempts) {
              await sleep(300 * attempt);
            }
          }
        }
        throw lastError;
      })();
      dbBootstrapPromise.catch(() => {
        dbBootstrapPromise = null;
      });
    }
    await dbBootstrapPromise;
  };

  const app = express();
  app.use(express.json({ limit: "10mb" }));
  app.disable("x-powered-by");
  
  // Proxy trust is often needed for secure cookies behind proxies
  app.set('trust proxy', 1);

  app.use(session({
    store: new KnexSessionStore(),
    secret: sessionSecret,
    resave: false,
    saveUninitialized: false,
    name: 'cp_ops_session',
    cookie: { 
      secure: isProduction,
      sameSite: isProduction ? 'none' : 'lax',
      httpOnly: true,
      maxAge: 24 * 60 * 60 * 1000 // 24 hours
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

  app.use("/api", async (req, res, next) => {
    try {
      await ensureDatabaseReady();
      next();
    } catch (error) {
      console.error("API blocked: database is unavailable", error);
      return res.status(503).json({ error: "Database unavailable" });
    }
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

    const normalizeHost = (value: string) =>
      value
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "")
        .replace(/:80$/, "")
        .replace(/:443$/, "");

    const rawHost = String(req.get("host") || "");
    const rawForwardedHost = String(req.get("x-forwarded-host") || "");
    const forwardedHosts = rawForwardedHost
      .split(",")
      .map((h) => normalizeHost(h))
      .filter(Boolean);
    const allowedHosts = new Set<string>([normalizeHost(rawHost), ...forwardedHosts].filter(Boolean));

    const origin = req.get("origin");
    const referer = req.get("referer");
    const secFetchSite = String(req.get("sec-fetch-site") || "").toLowerCase();

    const sameHost = (value: string) => {
      try {
        const parsed = new URL(value);
        const originHost = normalizeHost(parsed.host);
        return (
          allowedHosts.has(originHost) &&
          (parsed.protocol === "http:" || parsed.protocol === "https:")
        );
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
      if (secFetchSite === "same-origin" || secFetchSite === "same-site" || secFetchSite === "none") {
        return next();
      }
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

  const hasEventAccess = async (req: any, eventId: number | string) => {
    if (!req.session?.userId) return false;
    if (isPrivileged(req)) return true;
    const row = await db("event_user_access")
      .where({ event_id: eventId, user_id: req.session.userId })
      .first();
    return Boolean(row);
  };

  const ensureEventAccess = async (req: any, res: any, eventId: number | string) => {
    const allowed = await hasEventAccess(req, eventId);
    if (!allowed) {
      res.status(403).json({ error: "Geen toegang tot dit evenement" });
      return false;
    }
    return true;
  };

  const recalculateInterventionClosedState = async (trx: any, interventionId: number | string) => {
    const intervention = await trx("interventions").where({ id: interventionId }).first();
    if (!intervention) return;

    const allTeams = await trx("intervention_teams as it")
      .leftJoin("statuses as s", "it.status_id", "s.id")
      .where("it.intervention_id", interventionId)
      .select("s.is_closed");

    // Interventions without linked teams are managed manually (if needed)
    if (allTeams.length === 0) return;

    const allClosed = allTeams.length > 0 && allTeams.every((t: any) => Number(t.is_closed) === 1);
    const nowIso = new Date().toISOString();

    if (allClosed && !intervention.closed_at) {
      await trx("interventions")
        .where({ id: interventionId })
        .update({ closed_at: nowIso });

      await trx("intervention_status_history")
        .where({ intervention_id: interventionId })
        .whereNull("ended_at")
        .update({ ended_at: nowIso });
      return;
    }

    if (!allClosed && intervention.closed_at) {
      await trx("interventions")
        .where({ id: interventionId })
        .update({ closed_at: null });

      const openRows = await trx("intervention_status_history")
        .where({ intervention_id: interventionId })
        .whereNull("ended_at")
        .select("team_id");
      const openSet = new Set(openRows.map((r: any) => Number(r.team_id)));

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
    }
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
        res.json({ id: user.id, username: user.username, role: user.role });
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

  app.get("/api/me", (req: any, res) => {
    if (req.session.userId) {
      res.json({ id: req.session.userId, username: req.session.username, role: req.session.role });
    } else {
      res.status(401).json({ error: "Not logged in" });
    }
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
    const users = await db("users").select("id", "username", "role");
    res.json(users);
  });

  app.post("/api/users", requireRole(["ROOT", "ADMIN"]), sensitiveRateLimit, async (req, res) => {
    const { username, password, role } = req.body;
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
    const hashedPassword = await bcrypt.hash(password, 10);
    try {
      const [id] = await db("users").insert({ username: username.trim(), password: hashedPassword, role });
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

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({ error: "Geen geldige velden om te updaten" });
    }

    try {
      await db("users").where({ id: targetId }).update(updatePayload);
      const updated = await db("users").where({ id: targetId }).select("id", "username", "role").first();

      if (Number(req.session.userId) === targetId) {
        req.session.username = updated.username;
        req.session.role = updated.role;
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
    res.json(events);
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
      .select("u.id", "u.username", "u.role")
      .orderBy("u.username", "asc");

    res.json(assigned);
  });

  app.put("/api/events/:id/assignments", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const event = await db("events").where({ id: req.params.id }).first();
    if (!event) return res.status(404).json({ error: "Event not found" });

    const userIds = Array.isArray(req.body?.user_ids)
      ? req.body.user_ids.map((v: any) => Number(v)).filter(Boolean)
      : [];

    const allowedUsers = await db("users")
      .whereIn("id", userIds.length ? userIds : [-1])
      .whereIn("role", ["OPERATOR", "VIEWER"])
      .select("id");

    const allowedIds = allowedUsers.map(u => Number(u.id));

    await db.transaction(async trx => {
      const existingAccessUsers = await trx("event_user_access as eua")
        .join("users as u", "eua.user_id", "u.id")
        .where("eua.event_id", req.params.id)
        .whereIn("u.role", ["OPERATOR", "VIEWER"])
        .select("eua.user_id");

      const existingIds = existingAccessUsers.map((r: any) => Number(r.user_id));
      const toDelete = existingIds.filter(id => !allowedIds.includes(id));
      const toInsert = allowedIds.filter(id => !existingIds.includes(id));

      if (toDelete.length > 0) {
        await trx("event_user_access")
          .where("event_id", req.params.id)
          .whereIn("user_id", toDelete)
          .del();
      }

      if (toInsert.length > 0) {
        await trx("event_user_access").insert(
          toInsert.map(id => ({ event_id: req.params.id, user_id: id }))
        );
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
    const teams = await db("teams").where({ event_id: req.params.id });
    const teamsWithMembers = await Promise.all(teams.map(async team => {
      const members = await db("team_members").where({ team_id: team.id });
      return { ...team, members };
    }));
    res.json(teamsWithMembers);
  });

  app.post("/api/events/:id/teams", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const { name, type } = req.body;
    try {
      const typeExists = await db("team_types")
        .where({ event_id: req.params.id, name: type })
        .first();
      if (!typeExists) {
        return res.status(400).json({ error: "Onbekende teamsoort voor dit evenement" });
      }

      const [id] = await db("teams").insert({ event_id: req.params.id, name, type, is_deployed: 1 });
      await writeActionLog(db, req, {
        event_id: req.params.id,
        team_id: id,
        message: `Ploeg aangemaakt: ${name} (${type})`,
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

      const { name, type, is_deployed } = req.body || {};
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

      res.json({ success: true });
    } catch (error) {
      console.error("Error updating team:", error);
      res.status(500).json({ error: "Ploeg bijwerken mislukt" });
    }
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
    const interventions = await db("interventions")
      .where("event_id", req.params.id)
      .orderBy("created_at", "asc");
    
    const interventionsWithTeams = await Promise.all(interventions.map(async inter => {
      const activeHistory = await db("intervention_status_history")
        .where({ intervention_id: inter.id })
        .whereNull("ended_at")
        .select("team_id", "started_at");
      const activeByTeam = new Map(activeHistory.map(h => [Number(h.team_id), h.started_at]));

      const teams = await db("teams as t")
        .join("intervention_teams as it", "t.id", "it.team_id")
        .leftJoin("statuses as s", "it.status_id", "s.id")
        .select("t.*", "it.status_id", "s.name as status_name", "s.color as status_color", "s.is_closed as status_is_closed")
        .where("it.intervention_id", inter.id);

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

      const openedAt = new Date(inter.created_at).getTime();
      const closedAt = inter.closed_at ? new Date(inter.closed_at).getTime() : now;
      const open_seconds = Math.max(0, Math.floor((closedAt - openedAt) / 1000));

      return { ...inter, open_seconds, status_durations, teams: teamsWithDuration };
    }));
    
    res.json(interventionsWithTeams);
  });

  app.post("/api/events/:id/interventions", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const { title, location, description, status_id, team_ids } = req.body;
    try {
      const interventionId = await db.transaction(async trx => {
        const requestedTeamIds = Array.isArray(team_ids)
          ? team_ids.map((v: any) => Number(v)).filter(Boolean)
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
          title,
          location,
          description
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
        }
        
        await writeActionLog(trx, req, {
          event_id: req.params.id,
          intervention_id: id,
          message: `Nieuwe interventie aangemaakt: ${title}`
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

      const addTeamIds = Array.isArray(add_team_ids) ? add_team_ids.map((v: any) => Number(v)).filter(Boolean) : [];
      const removeTeamIds = Array.isArray(remove_team_ids) ? remove_team_ids.map((v: any) => Number(v)).filter(Boolean) : [];

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
          const existingSet = new Set(existingLinks.map((r: any) => Number(r.team_id)));

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
              await writeActionLog(trx, req, {
                event_id: intervention.event_id,
                intervention_id: intervention.id,
                team_id: t.id,
                message: `Ploeg "${t.name}" toegevoegd aan interventie "${intervention.title}"`,
              });
            }
          }
        }

        await recalculateInterventionClosedState(trx, intervention.id);
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

      const historyRow = await db("intervention_status_history")
        .where({ intervention_id: intervention.id })
        .first();
      if (historyRow) {
        return res.status(400).json({ error: "Interventie kan enkel gesloten worden als er nooit een ploeg gekoppeld is geweest" });
      }

      await db.transaction(async trx => {
        await trx("interventions")
          .where({ id: intervention.id })
          .update({ closed_at: new Date().toISOString() });

        await writeActionLog(trx, req, {
          event_id: intervention.event_id,
          intervention_id: intervention.id,
          message: `Interventie manueel gesloten zonder ploegkoppeling: ${intervention.title}`,
        });
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error closing empty intervention:", error);
      res.status(500).json({ error: "Interventie sluiten mislukt" });
    }
  });

  app.patch("/api/interventions/:id/teams/:teamId", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const { status_id } = req.body;
    const { id: interventionId, teamId } = req.params;
    try {
      const status = await db("statuses").where({ id: status_id }).first();
      const intervention = await db("interventions").where({ id: interventionId }).first();
      const team = await db("teams").where({ id: teamId }).first();
      if (!intervention || !team || !status) {
        return res.status(404).json({ error: "Interventie, ploeg of status niet gevonden" });
      }
      if (!await ensureEventAccess(req, res, intervention.event_id)) return;
      
      await db.transaction(async trx => {
        const currentLink = await trx("intervention_teams")
          .where({ intervention_id: interventionId, team_id: teamId })
          .first();

        await trx("intervention_teams")
          .where({ intervention_id: interventionId, team_id: teamId })
          .update({ status_id });

        if (currentLink && Number(currentLink.status_id) !== Number(status_id)) {
          await trx("intervention_status_history")
            .where({ intervention_id: interventionId, team_id: teamId })
            .whereNull("ended_at")
            .update({ ended_at: new Date().toISOString() });

          await trx("intervention_status_history").insert({
            intervention_id: interventionId,
            team_id: teamId,
            status_id: status_id || null,
            started_at: new Date().toISOString(),
            ended_at: null,
          });
        }

        await recalculateInterventionClosedState(trx, interventionId);

        await writeActionLog(trx, req, {
          event_id: intervention.event_id,
          team_id: team.id,
          intervention_id: intervention.id,
          message: `Status van ploeg "${team.name}" in interventie "${intervention.title}" gewijzigd naar "${status.name}"`
        });
      });
      
      res.json({ success: true });
    } catch (error) {
      console.error("Error updating team status:", error);
      res.status(500).json({ error: "Update failed" });
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
    const { createServer: createViteServer } = await import("vite");
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
