import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

test('new intervention applies the selected initial status to linked teams', async (t) => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cp-ops-initial-status-'));
  process.env.DB_CLIENT = 'sqlite3';
  process.env.DB_FILENAME = path.join(tempDir, 'test.sqlite');
  process.env.DEFAULT_ROOT_USERNAME = 'root';
  process.env.DEFAULT_ROOT_PASSWORD = 'test-password';
  process.env.SESSION_SECRET = 'test-session-secret-test-session-secret';
  process.env.NODE_ENV = 'production';

  const [{ createApp }, dbModule] = await Promise.all([
    import('../server.ts'),
    import('../db.ts'),
  ]);

  const app = await createApp();
  const server = app.listen(0);
  t.after(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    await dbModule.default.destroy();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;
  let cookie = '';

  const request = async (url: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    if (cookie) headers.set('Cookie', cookie);
    if (init.method && init.method !== 'GET') headers.set('Origin', baseUrl);
    const response = await fetch(`${baseUrl}${url}`, { ...init, headers });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    return response;
  };

  let response = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'root', password: 'test-password' }),
  });
  assert.equal(response.status, 200);

  response = await request('/api/events', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: 'Initial status event',
      date: '2026-06-29',
      end_date: '',
      location: '',
      organizer: '',
      contact_info: '',
      description: '',
    }),
  });
  assert.equal(response.status, 200);
  const event = await response.json() as { id: number };

  response = await request(`/api/events/${event.id}/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Team 1', type: 'Terrein', aid_post_id: null }),
  });
  assert.equal(response.status, 200);
  const team = await response.json() as { id: number };

  response = await request(`/api/events/${event.id}/teams`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Team 2', type: 'Terrein', aid_post_id: null }),
  });
  assert.equal(response.status, 200);
  const secondTeam = await response.json() as { id: number };

  response = await request(`/api/events/${event.id}/statuses`);
  assert.equal(response.status, 200);
  const statuses = await response.json() as Array<{ id: number; name: string; is_busy: number }>;
  const selectedStatus = statuses.find(status => Number(status.is_busy) !== 1);
  assert(selectedStatus, 'expected a non-busy status to use as alternative initial status');
  const busyStatus = statuses.find(status => Number(status.is_busy) === 1);
  assert(busyStatus, 'expected a busy status for restart regression');

  response = await request(`/api/events/${event.id}/interventions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      title: 'Alternative initial status',
      location: '',
      description: '',
      status_id: selectedStatus.id,
      team_ids: [team.id, secondTeam.id],
    }),
  });
  assert.equal(response.status, 200);
  const intervention = await response.json() as { id: number };

  const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await dbModule.default('interventions')
    .where({ id: intervention.id })
    .update({ created_at: tenMinutesAgo });
  await dbModule.default('intervention_status_history')
    .where({ intervention_id: intervention.id })
    .update({ started_at: tenMinutesAgo });

  response = await request(`/api/events/${event.id}/interventions`);
  assert.equal(response.status, 200);
  const interventions = await response.json() as Array<{ open_seconds: number; teams: Array<{ id: number; status_id: number }> }>;
  const linkedTeam = interventions[0]?.teams.find(row => Number(row.id) === Number(team.id));
  assert(linkedTeam, 'expected team to be linked to intervention');
  assert.equal(Number(linkedTeam.status_id), Number(selectedStatus.id));
  assert(interventions[0].open_seconds >= 595 && interventions[0].open_seconds <= 605);

  response = await request(`/api/interventions/${intervention.id}/teams/${team.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_id: busyStatus.id, aid_post_id: null }),
  });
  assert.equal(response.status, 200);

  response = await request(`/api/interventions/${intervention.id}/teams/${team.id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ status_id: busyStatus.id, aid_post_id: null }),
  });
  assert.equal(response.status, 200);

  response = await request(`/api/events/${event.id}/interventions`);
  assert.equal(response.status, 200);
  const restartedInterventions = await response.json() as Array<{
    teams: Array<{ id: number; status_id: number; status_duration_seconds: number }>;
  }>;
  const restartedTeam = restartedInterventions[0]?.teams.find(row => Number(row.id) === Number(team.id));
  assert(restartedTeam, 'expected restarted team to remain linked');
  assert.equal(Number(restartedTeam.status_id), Number(busyStatus.id));
  assert(restartedTeam.status_duration_seconds >= 0 && restartedTeam.status_duration_seconds <= 5);
});
