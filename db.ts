import knex from 'knex';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const defaultTeamTypes = ['Terrein', 'Interventie', 'DGH', 'NDPA', 'Dienstleiding'];

const defaultDbClient = process.env.VERCEL ? 'mysql2' : 'sqlite3';
const dbClient = process.env.DB_CLIENT || defaultDbClient;
const isMysqlClient = dbClient === 'mysql' || dbClient === 'mysql2';
const defaultSqliteFilename = process.env.VERCEL ? '/tmp/cp_ops.sqlite' : 'data/cp_ops.sqlite';

let sqliteFilePath = path.resolve(
  process.cwd(),
  process.env.DB_FILENAME || defaultSqliteFilename,
);

if (dbClient === 'sqlite3') {
  try {
    fs.mkdirSync(path.dirname(sqliteFilePath), { recursive: true });
  } catch (error) {
    const fallbackSqlitePath = '/tmp/cp_ops.sqlite';
    console.warn(`SQLite path "${sqliteFilePath}" is not writable, falling back to "${fallbackSqlitePath}".`, error);
    sqliteFilePath = fallbackSqlitePath;
    fs.mkdirSync(path.dirname(sqliteFilePath), { recursive: true });
  }
}

const asBool = (value: string | undefined, fallback = false) => {
  if (value == null) return fallback;
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
};

const buildMysqlConnection = () => {
  const useSsl = asBool(process.env.DB_SSL, false);
  const rejectUnauthorized = asBool(process.env.DB_SSL_REJECT_UNAUTHORIZED, true);

  let baseConnection: {
    host?: string;
    user?: string;
    password?: string;
    database?: string;
    port?: number;
  };

  if (process.env.DB_URL) {
    try {
      const parsed = new URL(process.env.DB_URL);
      baseConnection = {
        host: parsed.hostname,
        user: decodeURIComponent(parsed.username),
        password: decodeURIComponent(parsed.password),
        database: parsed.pathname.replace(/^\//, ''),
        port: parsed.port ? Number(parsed.port) : 3306,
      };
    } catch (error) {
      console.warn('Invalid DB_URL format, falling back to DB_HOST/DB_USER/DB_PASSWORD/DB_NAME.', error);
      baseConnection = {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: Number(process.env.DB_PORT) || 3306,
      };
    }
  } else {
    baseConnection = {
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: Number(process.env.DB_PORT) || 3306,
    };
  }

  if (useSsl) {
    return {
      ...baseConnection,
      ssl: { rejectUnauthorized },
    };
  }

  return baseConnection;
};

const db = knex({
  client: dbClient,
  connection:
    isMysqlClient
      ? buildMysqlConnection()
      : {
          filename: sqliteFilePath,
        },
  ...(isMysqlClient
    ? {
        pool: {
          min: 0,
          max: Number(process.env.DB_POOL_MAX || 2),
          acquireTimeoutMillis: Number(process.env.DB_POOL_ACQUIRE_TIMEOUT_MS || 15000),
          idleTimeoutMillis: Number(process.env.DB_POOL_IDLE_TIMEOUT_MS || 30000),
        },
        acquireConnectionTimeout: Number(process.env.DB_ACQUIRE_CONNECTION_TIMEOUT_MS || 15000),
      }
    : {}),
  useNullAsDefault: dbClient === 'sqlite3',
});

export async function initDb() {
  // Users Table
  if (!await db.schema.hasTable('users')) {
    await db.schema.createTable('users', (table) => {
      table.increments('id').primary();
      table.string('username').unique().notNullable();
      table.string('password').notNullable();
      table.string('role').notNullable().defaultTo('VIEWER');
    });
  }

  // Events Table
  if (!await db.schema.hasTable('events')) {
    await db.schema.createTable('events', (table) => {
      table.increments('id').primary();
      table.string('name').notNullable();
      table.string('date').notNullable();
      table.string('end_date');
      table.string('location');
      table.string('organizer');
      table.string('contact_info');
      table.text('description');
      table.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  // Event User Access Table
  if (!await db.schema.hasTable('event_user_access')) {
    await db.schema.createTable('event_user_access', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.integer('user_id').unsigned().notNullable().references('id').inTable('users').onDelete('CASCADE');
      table.unique(['event_id', 'user_id']);
    });
  }

  // Announcements Table
  if (!await db.schema.hasTable('announcements')) {
    await db.schema.createTable('announcements', (table) => {
      table.increments('id').primary();
      table.text('message');
      table.string('bg_color').defaultTo('#ef4444');
      table.integer('is_active').defaultTo(0);
    });
    await db('announcements').insert({ message: '', is_active: 0 });
  }

  // Event Announcements Table
  if (!await db.schema.hasTable('event_announcements')) {
    await db.schema.createTable('event_announcements', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.text('message');
      table.string('bg_color').defaultTo('#ef4444');
      table.integer('is_active').defaultTo(0);
      table.unique(['event_id']);
    });
  }

  // Statuses Table
  if (!await db.schema.hasTable('statuses')) {
    await db.schema.createTable('statuses', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().references('id').inTable('events').onDelete('CASCADE');
      table.string('name').notNullable();
      table.string('color').defaultTo('#3b82f6');
      table.integer('is_closed').defaultTo(0);
      table.integer('is_start').defaultTo(0);
      table.integer('is_busy').defaultTo(0);
    });
  } else {
    if (!await db.schema.hasColumn('statuses', 'is_start')) {
      await db.schema.table('statuses', (table) => {
        table.integer('is_start').defaultTo(0);
      });
    }
    if (!await db.schema.hasColumn('statuses', 'is_busy')) {
      await db.schema.table('statuses', (table) => {
        table.integer('is_busy').defaultTo(0);
      });
    }
  }

  // Team Types Table
  if (!await db.schema.hasTable('team_types')) {
    await db.schema.createTable('team_types', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().notNullable().references('id').inTable('events').onDelete('CASCADE');
      table.string('name').notNullable();
      table.unique(['event_id', 'name']);
    });
  }

  // Teams Table
  if (!await db.schema.hasTable('teams')) {
    await db.schema.createTable('teams', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().references('id').inTable('events').onDelete('CASCADE');
      table.string('name').notNullable();
      table.string('type').notNullable();
      table.integer('is_deployed').defaultTo(1);
    });
  } else {
    if (!await db.schema.hasColumn('teams', 'is_deployed')) {
      await db.schema.table('teams', (table) => {
        table.integer('is_deployed').defaultTo(1);
      });
      await db('teams').whereNull('is_deployed').update({ is_deployed: 1 });
    }
  }

  // Team Members Table
  if (!await db.schema.hasTable('team_members')) {
    await db.schema.createTable('team_members', (table) => {
      table.increments('id').primary();
      table.integer('team_id').unsigned().references('id').inTable('teams').onDelete('CASCADE');
      table.string('name').notNullable();
      table.string('role');
    });
  }

  // Interventions Table
  if (!await db.schema.hasTable('interventions')) {
    await db.schema.createTable('interventions', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().references('id').inTable('events').onDelete('CASCADE');
      table.integer('intervention_number').unsigned();
      table.string('title').notNullable();
      table.string('location');
      table.text('description');
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.timestamp('closed_at');
    });
  } else {
    if (!await db.schema.hasColumn('interventions', 'intervention_number')) {
      await db.schema.table('interventions', (table) => {
        table.integer('intervention_number').unsigned();
      });
    }
    if (!await db.schema.hasColumn('interventions', 'description')) {
      await db.schema.table('interventions', (table) => {
        table.text('description');
      });
    }
  }

  // Intervention Teams Junction Table
  if (!await db.schema.hasTable('intervention_teams')) {
    await db.schema.createTable('intervention_teams', (table) => {
      table.integer('intervention_id').unsigned().references('id').inTable('interventions').onDelete('CASCADE');
      table.integer('team_id').unsigned().references('id').inTable('teams').onDelete('CASCADE');
      table.integer('status_id').unsigned().references('id').inTable('statuses');
      table.primary(['intervention_id', 'team_id']);
    });
  } else {
    // Check if status_id column exists, if not add it
    if (!await db.schema.hasColumn('intervention_teams', 'status_id')) {
      await db.schema.table('intervention_teams', (table) => {
        table.integer('status_id').unsigned().references('id').inTable('statuses');
      });
    }
  }

  // Intervention Status History Table
  if (!await db.schema.hasTable('intervention_status_history')) {
    await db.schema.createTable('intervention_status_history', (table) => {
      table.increments('id').primary();
      table.integer('intervention_id').unsigned().notNullable().references('id').inTable('interventions').onDelete('CASCADE');
      table.integer('team_id').unsigned().notNullable().references('id').inTable('teams').onDelete('CASCADE');
      table.integer('status_id').unsigned().references('id').inTable('statuses');
      table.timestamp('started_at').defaultTo(db.fn.now());
      table.timestamp('ended_at');
      table.index(['intervention_id', 'team_id']);
    });
  }

  // Intervention Messages Table
  if (!await db.schema.hasTable('intervention_messages')) {
    await db.schema.createTable('intervention_messages', (table) => {
      table.increments('id').primary();
      table.integer('intervention_id').unsigned().notNullable().references('id').inTable('interventions').onDelete('CASCADE');
      table.integer('actor_user_id').unsigned();
      table.string('actor_username');
      table.text('message').notNullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
    });
  }

  // Logs Table
  if (!await db.schema.hasTable('logs')) {
    await db.schema.createTable('logs', (table) => {
      table.increments('id').primary();
      table.integer('event_id').unsigned().references('id').inTable('events').onDelete('CASCADE');
      table.integer('actor_user_id').unsigned();
      table.string('actor_username');
      table.integer('team_id').unsigned();
      table.integer('intervention_id').unsigned();
      table.text('message').notNullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
    });
  } else {
    if (!await db.schema.hasColumn('logs', 'actor_user_id')) {
      await db.schema.table('logs', (table) => {
        table.integer('actor_user_id').unsigned();
      });
    }
    if (!await db.schema.hasColumn('logs', 'actor_username')) {
      await db.schema.table('logs', (table) => {
        table.string('actor_username');
      });
    }
    if (!await db.schema.hasColumn('logs', 'team_id')) {
      await db.schema.table('logs', (table) => {
        table.integer('team_id').unsigned();
      });
    }
    if (!await db.schema.hasColumn('logs', 'intervention_id')) {
      await db.schema.table('logs', (table) => {
        table.integer('intervention_id').unsigned();
      });
    }
  }

  // Settings Table
  if (!await db.schema.hasTable('settings')) {
    await db.schema.createTable('settings', (table) => {
      table.string('key').primary();
      table.text('value');
    });
    await db('settings').insert([
      { key: 'app_name', value: 'CP-OPS' },
      { key: 'primary_color', value: '#2563eb' },
      { key: 'logo_url', value: '' },
      { key: 'primary_hover_color', value: '#1d4ed8' },
      { key: 'background_color', value: '#f8fafc' },
      { key: 'surface_color', value: '#ffffff' },
      { key: 'surface_alt_color', value: '#f1f5f9' },
      { key: 'text_color', value: '#0f172a' },
      { key: 'muted_text_color', value: '#475569' },
      { key: 'border_color', value: '#cbd5e1' },
      { key: 'danger_color', value: '#dc2626' },
      { key: 'danger_hover_color', value: '#b91c1c' }
    ]);
  }

  // Uploaded Assets Table
  if (!await db.schema.hasTable('uploaded_assets')) {
    await db.schema.createTable('uploaded_assets', (table) => {
      table.increments('id').primary();
      table.string('scope').notNullable().defaultTo('branding');
      table.string('mime').notNullable();
      table.specificType('content', 'longblob').notNullable();
      table.timestamp('created_at').defaultTo(db.fn.now());
      table.index(['scope']);
    });
  }

  const defaultSettings: Record<string, string> = {
    app_name: 'CP-OPS',
    primary_color: '#2563eb',
    logo_url: '',
    primary_hover_color: '#1d4ed8',
    background_color: '#f8fafc',
    surface_color: '#ffffff',
    surface_alt_color: '#f1f5f9',
    text_color: '#0f172a',
    muted_text_color: '#475569',
    border_color: '#cbd5e1',
    danger_color: '#dc2626',
    danger_hover_color: '#b91c1c',
  };

  for (const [key, value] of Object.entries(defaultSettings)) {
    const existing = await db('settings').where({ key }).first();
    if (!existing) {
      await db('settings').insert({ key, value });
    }
  }

  // Ensure each event has default team types
  const events = await db('events').select('id');
  for (const event of events) {
    const countResult = await db('team_types')
      .where({ event_id: event.id })
      .count<{ count: number }>('id as count')
      .first();
    const typeCount = Number(countResult?.count) || 0;

    if (typeCount === 0) {
      await db('team_types').insert(
        defaultTeamTypes.map(name => ({ event_id: event.id, name }))
      );
    }

    const eventAnnouncementExists = await db('event_announcements')
      .where({ event_id: event.id })
      .first();
    if (!eventAnnouncementExists) {
      await db('event_announcements').insert({
        event_id: event.id,
        message: '',
        bg_color: '#ef4444',
        is_active: 0,
      });
    }

    // Ensure intervention numbering per event is contiguous starting at 1
    const interventions = await db('interventions')
      .where({ event_id: event.id })
      .orderBy('created_at', 'asc')
      .orderBy('id', 'asc')
      .select('id', 'intervention_number');

    for (let index = 0; index < interventions.length; index++) {
      const expectedNo = index + 1;
      if (Number(interventions[index].intervention_number) !== expectedNo) {
        await db('interventions')
          .where({ id: interventions[index].id })
          .update({ intervention_number: expectedNo });
      }
    }

    // Ensure each event has at least one begin-status and one bezig-status
    const eventStatuses = await db('statuses')
      .where({ event_id: event.id })
      .orderBy('id', 'asc')
      .select('id', 'name', 'is_closed', 'is_start', 'is_busy');

    if (eventStatuses.length > 0) {
      const hasStart = eventStatuses.some(s => Number(s.is_start) === 1);
      const hasBusy = eventStatuses.some(s => Number(s.is_busy) === 1);

      if (!hasStart) {
        const preferredStart =
          eventStatuses.find(s => /beschikbaar|hulppost|vrij|start/i.test(String(s.name || ''))) ||
          eventStatuses.find(s => Number(s.is_closed) === 1) ||
          eventStatuses[0];
        if (preferredStart) {
          await db('statuses').where({ id: preferredStart.id }).update({ is_start: 1 });
        }
      }

      if (!hasBusy) {
        const preferredBusy =
          eventStatuses.find(s => /interventie|vertrokken|bezig|onderweg|aangekomen/i.test(String(s.name || ''))) ||
          eventStatuses.find(s => Number(s.is_start) !== 1) ||
          eventStatuses[0];
        if (preferredBusy) {
          await db('statuses').where({ id: preferredBusy.id }).update({ is_busy: 1 });
        }
      }
    }
  }
}

export default db;
