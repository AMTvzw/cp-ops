# CP-OPS

CP-OPS is an open-source incident coordination tool for event operations.  
It helps teams manage events, interventions, statuses, logs, announcements, and access roles in one web application.

## Important Disclaimer

This project is open source and largely vibe-coded.

No guarantees are provided for:
- Correctness
- Availability
- Security
- Stability
- Fitness for any specific purpose

Use this software at your own risk.  
You are fully responsible for deployment, hardening, backups, data protection, and operational safety.

## What the App Does

CP-OPS supports:
- Event management (create, edit, close workflows)
- Intervention tracking (card/list views, status timelines, durations)
- Team management (types, members, deployable/non-deployable state)
- Status configuration (start/busy/closed semantics)
- Role-based access (`ROOT`, `ADMIN`, `OPERATOR`, `VIEWER`)
- Event-scoped and global announcements
- Audit logs and data export
- Basic branding and theme customization

## Tech Stack

- Frontend: React, TypeScript, Vite, Tailwind CSS
- Backend: Express, TypeScript
- Database: SQLite (default) or MySQL/MariaDB via Knex
- Auth: Session-based authentication

## Getting Started

### 1. Prerequisites

- Node.js 20+ recommended
- npm

### 2. Install dependencies

```bash
npm install
```

### 3. Configure environment

Copy `.env.example` to `.env` and update values as needed.

Example configuration:

```env
# Database Configuration (default local SQLite)
DB_CLIENT=sqlite3
DB_FILENAME=data/cp_ops.sqlite

# Environment mode: development | test | production
NODE_ENV=development

# Session secret (required in production, min 32 chars)
SESSION_SECRET=replace-with-a-long-random-secret

# Optional Redis for shared rate limiting across multiple app instances
# REDIS_URL=redis://localhost:6379

# Default root user (used only when no ROOT user exists yet)
DEFAULT_ROOT_USERNAME=root
DEFAULT_ROOT_PASSWORD=replace-this-password

# External MariaDB/MySQL via URL:
# DB_CLIENT=mysql2
# DB_URL=mysql://user:password@localhost:3306/cp_ops
# DB_SSL=true
# DB_SSL_REJECT_UNAUTHORIZED=true

# External MariaDB/MySQL via separate values:
# DB_CLIENT=mysql2
# DB_HOST=localhost
# DB_PORT=3306
# DB_USER=root
# DB_PASSWORD=password
# DB_NAME=cp_ops
# DB_SSL=true
# DB_SSL_REJECT_UNAUTHORIZED=true
```

Notes:
- `NODE_ENV=production` enables production behavior; any other value is treated as non-production.
- In development/test, the app can start without `SESSION_SECRET` using a fallback secret (warning in logs).
- In production, `SESSION_SECRET` is mandatory and must be at least 32 characters.
- If no ROOT user exists, `DEFAULT_ROOT_PASSWORD` must be set (minimum 6 characters).
- For hosted MariaDB/MySQL (for example Easyhost), you may need `DB_SSL=true`.

### 4. Run in development

```bash
npm run dev
```

The app starts with the backend and frontend in one process (via `server.ts` + Vite middleware).

## Build for Production

```bash
npm run build
```

This creates the frontend build in `dist/`.

## Deploy on Vercel

This repository now includes:
- `vercel.json` (routes all requests to `api/index.ts`)
- `api/index.ts` (serverless entrypoint)

Required Vercel environment variables:

```env
NODE_ENV=production
SESSION_SECRET=replace-with-a-long-random-secret-min-32
DEFAULT_ROOT_USERNAME=root
DEFAULT_ROOT_PASSWORD=replace-this-password

DB_CLIENT=mysql2
DB_HOST=your-db-host
DB_PORT=3306
DB_USER=your-db-user
DB_PASSWORD=your-db-password
DB_NAME=your-db-name
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=true
UPLOAD_STORAGE=db
```

Notes:
- With `UPLOAD_STORAGE=db`, logo uploads are persisted in MariaDB/MySQL and served via `/api/uploads/:id`.
- If you set `UPLOAD_STORAGE=fs`, Vercel writes to ephemeral storage (`/tmp/uploads`).
- If your DB provider uses a custom CA chain, temporarily set `DB_SSL_REJECT_UNAUTHORIZED=false` while validating certificate setup.

## Run with Docker

### Build image

```bash
docker build -f deploy/docker/Dockerfile -t cp-ops:latest .
```

### Run container

```bash
docker run --rm -p 31987:31987 \
  -e NODE_ENV=production \
  -e SESSION_SECRET='replace-with-a-long-random-secret-min-32' \
  -e DEFAULT_ROOT_PASSWORD='replace-this-password' \
  -e PUBLIC_ORIGIN='http://your-host-or-domain:31987' \
  -v cp_ops_data:/app/data \
  -v cp_ops_uploads:/app/uploads \
  cp-ops:latest
```

### Run with Docker Compose

```bash
docker compose -f deploy/docker/docker-compose.yml up -d --build
```

SQLite is the default. To start the optional local MariaDB service and connect CP-OPS to it:

```bash
DB_CLIENT=mysql2 \
DB_HOST=mariadb \
DB_USER=cp_ops \
DB_PASSWORD=replace-this-db-password \
DB_NAME=cp_ops \
UPLOAD_STORAGE=db \
MARIADB_DATABASE=cp_ops \
MARIADB_USER=cp_ops \
MARIADB_PASSWORD=replace-this-db-password \
MARIADB_ROOT_PASSWORD=replace-this-root-db-password \
docker compose --profile mariadb -f deploy/docker/docker-compose.yml up -d --build
```

For Docker deployments, keep `NODE_ENV=production`. If the container is exposed over plain HTTP through Proxmox or another proxy, set the browser-facing origin so sessions and CSRF checks line up:

```env
SESSION_COOKIE_SECURE=auto
SESSION_COOKIE_SAMESITE=lax
PUBLIC_ORIGIN=http://your-host-or-domain:31987
```

If users access the app through multiple hostnames or ports, add them to `ALLOWED_ORIGINS` as a comma-separated list.

Files included:
- `deploy/docker/Dockerfile`
- `deploy/docker/docker-compose.yml`
- `deploy/docker/docker-compose.server.yml` (direct server use with `.env` and bind mounts)

Direct server command:

```bash
docker compose -f deploy/docker/docker-compose.server.yml up -d --build
```

## Security Notes

Before any real deployment, you should at minimum:
- Change all default credentials
- Set a strong `SESSION_SECRET`
- Use HTTPS and secure cookie settings
- Restrict network/database access
- Add monitoring, backups, and incident recovery procedures

## Contributing

Contributions are welcome through issues and pull requests.  
When submitting changes, include:
- Clear scope
- Reproducible steps
- Validation or test notes

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file.
