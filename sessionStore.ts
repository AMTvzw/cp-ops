import session from "express-session";
import type { Knex } from "knex";

type SessionLike = session.SessionData & {
  cookie?: {
    expires?: string | Date | null;
    maxAge?: number | null;
  };
};

const SESSION_TABLE = "sessions";
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

const computeExpiryMs = (sess: SessionLike, nowMs: number, fallbackMs: number): number => {
  const expiresValue = sess?.cookie?.expires;
  if (expiresValue) {
    const expiresMs = new Date(expiresValue).getTime();
    if (Number.isFinite(expiresMs)) return expiresMs;
  }

  const maxAge = Number(sess?.cookie?.maxAge);
  if (Number.isFinite(maxAge) && maxAge > 0) {
    return nowMs + maxAge;
  }

  return nowMs + fallbackMs;
};

export class KnexSessionStore extends session.Store {
  private readonly idleTimeoutMs: number;

  constructor(
    private readonly knexDb: Knex,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
    cleanupIntervalMs = 10 * 60 * 1000,
  ) {
    super();
    this.idleTimeoutMs = Math.max(1, idleTimeoutMs);

    const timer = setInterval(() => {
      void this.clearExpired();
    }, cleanupIntervalMs);
    timer.unref?.();
  }

  private async clearExpired() {
    await this.knexDb(SESSION_TABLE)
      .where("expires_at", "<=", Date.now())
      .del();
  }

  get = (sid: string, callback: (err?: any, session?: SessionLike | null) => void): void => {
    void (async () => {
      try {
        const row = await this.knexDb(SESSION_TABLE).where({ sid }).first();
        if (!row) {
          callback(undefined, null);
          return;
        }

        if (Number(row.expires_at) <= Date.now()) {
          await this.knexDb(SESSION_TABLE).where({ sid }).del();
          callback(undefined, null);
          return;
        }

        callback(undefined, JSON.parse(String(row.sess)));
      } catch (error) {
        callback(error);
      }
    })();
  };

  set = (sid: string, sess: SessionLike, callback?: (err?: any) => void): void => {
    void (async () => {
      try {
        const now = Date.now();
        const expiresAt = computeExpiryMs(sess, now, this.idleTimeoutMs);

        await this.knexDb(SESSION_TABLE)
          .insert({
            sid,
            sess: JSON.stringify(sess),
            expires_at: expiresAt,
            updated_at: this.knexDb.fn.now(),
          })
          .onConflict("sid")
          .merge({
            sess: JSON.stringify(sess),
            expires_at: expiresAt,
            updated_at: this.knexDb.fn.now(),
          });

        callback?.();
      } catch (error) {
        callback?.(error);
      }
    })();
  };

  touch = (sid: string, sess: SessionLike, callback?: () => void): void => {
    void (async () => {
      try {
        const expiresAt = computeExpiryMs(sess, Date.now(), this.idleTimeoutMs);
        await this.knexDb(SESSION_TABLE)
          .where({ sid })
          .update({
            expires_at: expiresAt,
            updated_at: this.knexDb.fn.now(),
          });
        callback?.();
      } catch {
        callback?.();
      }
    })();
  };

  destroy = (sid: string, callback?: (err?: any) => void): void => {
    void (async () => {
      try {
        await this.knexDb(SESSION_TABLE).where({ sid }).del();
        callback?.();
      } catch (error) {
        callback?.(error);
      }
    })();
  };
}
