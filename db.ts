import knex from 'knex';
import fs from 'fs';
import path from 'path';
import 'dotenv/config';

const defaultTeamTypes = ['Terrein', 'Interventie', 'DGH', 'NDPA', 'Dienstleiding'];

const dbClient = process.env.DB_CLIENT || 'sqlite3';

const sqliteFilePath = path.resolve(
  process.cwd(),
  process.env.DB_FILENAME || 'data/cp_ops.sqlite',
);

if (dbClient === 'sqlite3') {
  fs.mkdirSync(path.dirname(sqliteFilePath), { recursive: true });
}

const db = knex({
  client: dbClient,
  connection:
    dbClient === 'mysql' || dbClient === 'mysql2'
      ? process.env.DB_URL
        ? process.env.DB_URL
        : {
            host: process.env.DB_HOST,
            user: process.env.DB_USER,
            password: process.env.DB_PASSWORD,
            database: process.env.DB_NAME,
            port: Number(process.env.DB_PORT) || 3306,
          }
      : {
          filename: sqliteFilePath,
        },
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
    });
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
    });
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
      { key: 'logo_url', value: '' }
    ]);
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
  }
}

export default db;
