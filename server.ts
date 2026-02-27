import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
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

async function startServer() {
  const isProduction = process.env.NODE_ENV === "production";
  const defaultRootUsername = process.env.DEFAULT_ROOT_USERNAME || "root";
  const defaultRootPassword = process.env.DEFAULT_ROOT_PASSWORD || "AMT2610root";

  // Initialize Database
  await initDb();

  // Ensure at least one ROOT user exists
  const rootExists = await db("users").where({ role: 'ROOT' }).first();
  if (!rootExists) {
    const hashedPassword = await bcrypt.hash(defaultRootPassword, 10);
    await db("users").insert({ username: defaultRootUsername, password: hashedPassword, role: "ROOT" });
    console.log(`Default ROOT user created: ${defaultRootUsername} / ${defaultRootPassword}`);
  }

  const app = express();
  app.use(express.json());
  
  // Proxy trust is often needed for secure cookies behind proxies
  app.set('trust proxy', 1);

  app.use(session({
    secret: process.env.SESSION_SECRET || "cp-ops-secret-key",
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

  const PORT = Number(process.env.PORT) || 31987;

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
  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    try {
      const user = await db("users").where({ username }).first();
      
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

  // User Management (ROOT/ADMIN only)
  app.get("/api/users", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const users = await db("users").select("id", "username", "role");
    res.json(users);
  });

  app.post("/api/users", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const { username, password, role } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    try {
      const [id] = await db("users").insert({ username, password: hashedPassword, role });
      res.json({ id });
    } catch (e) {
      res.status(400).json({ error: "Username already exists" });
    }
  });

  app.delete("/api/users/:id", requireRole(["ROOT", "ADMIN"]), async (req: any, res) => {
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
  app.get("/api/announcements", async (req, res) => {
    const announcement = await db("announcements").first();
    res.json(announcement);
  });

  app.post("/api/announcements", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const { message, bg_color, is_active } = req.body;
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

  app.post("/api/events", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    const { name, date, end_date, location, organizer, contact_info, description } = req.body;
    try {
      const [eventId] = await db("events").insert({ 
        name, date, end_date, location, organizer, contact_info, description 
      });
      
      // Create default statuses for new event
      const defaultStatuses = [
        { name: 'Beschikbaar in hulppost', color: '#94a3b8', is_closed: 0 },
        { name: 'Radiofonisch op het terrein', color: '#3b82f6', is_closed: 0 },
        { name: 'Vertrokken op interventie', color: '#f59e0b', is_closed: 0 },
        { name: 'Aangekomen op interventie', color: '#eab308', is_closed: 0 },
        { name: 'Vertrokken naar de hulppost', color: '#f97316', is_closed: 0 },
        { name: 'Aangekomen in de hulppost', color: '#22c55e', is_closed: 1 }
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

  app.post("/api/events/:id/announcement", requireRole(["ROOT", "ADMIN", "OPERATOR"]), async (req, res) => {
    if (!await ensureEventAccess(req, res, req.params.id)) return;
    const { message, bg_color, is_active } = req.body;

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
    const { name, color, is_closed } = req.body;
    const [id] = await db("statuses").insert({
      event_id: req.params.id,
      name,
      color,
      is_closed: is_closed ? 1 : 0
    });
    res.json({ id });
  });

  app.patch("/api/statuses/:id", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    try {
      const status = await db("statuses").where({ id: req.params.id }).first();
      if (!status) return res.status(404).json({ error: "Status not found" });

      const { name, color, is_closed } = req.body || {};
      const updatePayload: Record<string, any> = {};

      if (typeof name === "string" && name.trim()) updatePayload.name = name.trim();
      if (typeof color === "string" && color.trim()) updatePayload.color = color.trim();
      if (typeof is_closed !== "undefined") updatePayload.is_closed = is_closed ? 1 : 0;

      if (Object.keys(updatePayload).length === 0) {
        return res.status(400).json({ error: "Geen geldige velden om te updaten" });
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

      const [id] = await db("teams").insert({ event_id: req.params.id, name, type });
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
      .orderBy("created_at", "desc");
    
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
        
        if (team_ids && team_ids.length > 0) {
          await trx("intervention_teams").insert(
            team_ids.map((teamId: number) => ({ 
              intervention_id: id, 
              team_id: teamId,
              status_id: status_id // Initial status for all teams
            }))
          );

          await trx("intervention_status_history").insert(
            team_ids.map((teamId: number) => ({
              intervention_id: id,
              team_id: teamId,
              status_id: status_id || null,
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
            .select("id", "name");
          const teamsToAdd = candidateTeams.filter((t: any) => !existingSet.has(Number(t.id)));

          let targetStatusId: number | null = default_status_id ? Number(default_status_id) : null;
          if (!targetStatusId) {
            const firstStatus = await trx("statuses")
              .where({ event_id: intervention.event_id })
              .orderBy("id", "asc")
              .first();
            targetStatusId = firstStatus ? Number(firstStatus.id) : null;
          } else {
            const statusExists = await trx("statuses")
              .where({ id: targetStatusId, event_id: intervention.event_id })
              .first();
            if (!statusExists) targetStatusId = null;
          }

          if (teamsToAdd.length > 0) {
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

  app.post("/api/settings", requireRole(["ROOT", "ADMIN"]), async (req, res) => {
    const settings = req.body;
    await db.transaction(async trx => {
      for (const [key, value] of Object.entries(settings)) {
        await trx("settings").where({ key }).update({ value: String(value) });
      }
    });
    res.json({ success: true });
  });

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

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer().catch(err => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
