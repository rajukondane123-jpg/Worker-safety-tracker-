# ALTIGUARD — Enterprise Worker Safety Monitoring Platform

ALTIGUARD is a real-time worker safety command center for construction, industrial and infrastructure sites. It combines location telemetry, reference-level monitoring, polygon geofencing, incident automation, operational broadcasts and persistent telemetry into one web application.

> **Important:** ALTIGUARD is a monitoring and decision-support system, not a certified life-safety controller. Field deployments must be validated against site procedures, local regulations, sensor limitations and emergency systems.

## What this release adds

### Spatial control
- Live Leaflet command map
- Worker markers with live status
- Polygonal red-zone creation
- Server-side point-in-polygon enforcement
- Zone severity and descriptions
- Historical telemetry heatmap
- Worker centering and map controls
- Floorplan overlay data model and API

### Telemetry + safety engine
- GPS latitude/longitude
- Altitude/reference-level delta
- Heart rate and SpO2 fields
- Temperature/humidity fields
- Device battery telemetry
- Accuracy, speed and heading fields
- Batch telemetry endpoint
- Telemetry rate limiting
- Stale-worker detection
- Event deduplication/cooldown
- Server-authoritative incident generation

### Incident operations
- Critical/high/warning severity
- Open → acknowledged → closed workflow
- Incident feed and management view
- Worker-specific incident context
- PDF incident report endpoint
- Map screenshot attachment support
- Audit events

### Communications
- Admin broadcast channel
- Normal/high/critical priority
- Full-screen worker command overlay
- Worker acknowledgement endpoint
- Socket.IO real-time delivery

### Enterprise persistence
- PostgreSQL data model
- Prisma ORM
- Workers
- Shifts
- Telemetry
- Zones
- Incidents
- Broadcasts
- Audit logs
- Floorplans
- System settings

### Frontend
- Responsive command-center UI
- Dark/night and light/day modes
- Worker registry
- Incident center
- Spatial-control page
- Analytics page
- Broadcast page
- Floorplan page
- System page
- Worker profile modal
- Mobile-friendly layout

## Architecture

```text
                    ┌───────────────────────────┐
                    │       Worker Devices      │
                    │ GPS / Altitude / Wearable │
                    └─────────────┬─────────────┘
                                  │ HTTPS
                                  ▼
┌─────────────────┐      ┌────────────────────────┐
│ Admin Browser   │◄────►│ Express + Socket.IO    │
│ Leaflet / HUD   │      │ ALTIGUARD Safety Core  │
└────────┬────────┘      └───────────┬────────────┘
         │                           │
         │ WebSocket                 │ Prisma
         │                           ▼
         │                  ┌──────────────────┐
         └─────────────────►│ PostgreSQL       │
                            │ telemetry/events │
                            └──────────────────┘
```

## Project structure

```text
ALTIGUARD/
├── public/
│   ├── index.html
│   ├── app.js              # command-center controller
│   └── styles.css          # responsive visual system
├── prisma/
│   ├── schema.prisma       # enterprise data model
│   └── seed.js
├── tests/
│   └── geo.test.js
├── server.js               # HTTP API + Socket.IO + safety engine
├── src-geo.js              # geometry helpers
├── prisma.config.js
├── docker-compose.yml
├── .env.example
├── .gitignore
└── package.json
```

## Requirements

- Node.js 22+
- PostgreSQL 14+
- A modern browser

Prisma's current PostgreSQL documentation supports self-hosted PostgreSQL as well as hosted PostgreSQL-compatible services. For a new project, check the Prisma version you intend to pin before deployment. citeturn0search3turn0search8

## Quick start — demo mode

Demo mode does not require PostgreSQL.

```bash
npm install
npm start
```

Open:

```text
http://localhost:3000
```

The server automatically starts with sample workers when `DATABASE_URL` is not configured.

## PostgreSQL mode

Copy the environment template:

```bash
cp .env.example .env
```

Set:

```env
DATABASE_URL="postgresql://altiguard:altiguard@localhost:5432/altiguard?schema=public"
PORT=3000
```

Start PostgreSQL:

```bash
docker compose up -d
```

Generate the client and apply the schema:

```bash
npm run db:generate
npm run db:push
npm run seed
npm start
```

Prisma's current docs show PostgreSQL projects using a `DATABASE_URL` connection and Prisma schema/CLI workflow. citeturn0search0turn0search5

## Core API

### Workers

```text
GET    /api/workers
POST   /api/workers
GET    /api/workers/:id
PATCH  /api/workers/:id
DELETE /api/workers/:id
```

### Telemetry

```text
POST /api/telemetry
POST /api/telemetry/batch
GET  /api/telemetry/:workerId
GET  /api/telemetry/:workerId/range
```

Example:

```json
{
  "workerId": "demo-AG-001",
  "lat": 20.7002,
  "lng": 77.0084,
  "altitudeM": 3.4,
  "accuracyM": 4.2,
  "speedMps": 0.7,
  "headingDeg": 140,
  "heartRate": 82,
  "spo2": 98,
  "temperatureC": 31.5,
  "humidityPct": 61,
  "batteryPct": 82,
  "source": "PHONE_GPS"
}
```

### Zones

```text
GET    /api/zones
POST   /api/zones
DELETE /api/zones/:id
```

Polygon format:

```json
{
  "name": "Crane Exclusion Area",
  "kind": "RED",
  "severity": "CRITICAL",
  "polygon": [
    [20.7000, 77.0080],
    [20.7000, 77.0090],
    [20.7010, 77.0090],
    [20.7010, 77.0080]
  ]
}
```

### Incidents

```text
GET  /api/incidents
POST /api/incidents
POST /api/incidents/:id/ack
POST /api/incidents/:id/close
GET  /api/incidents/:id/report.pdf
POST /api/incidents/:id/screenshot
```

### Communications

```text
POST /api/broadcast
POST /api/broadcast/:id/ack
```

### Operations

```text
GET /api/health
GET /api/meta
GET /api/dashboard
GET /api/analytics/summary?hours=24
GET /api/audit
GET /api/settings
PUT /api/settings/:key
```

## Real-time events

The browser receives Socket.IO events including:

```text
worker:update
worker:deleted
worker:stale
zone:created
zone:deleted
incident:new
incident:update
broadcast:new
broadcast:ack
audit:new
snapshot
```

## Safety-engine behavior

The server evaluates telemetry rather than trusting the browser to generate safety events.

1. Validate coordinates and telemetry ranges.
2. Apply per-IP and per-worker telemetry rate limits.
3. Persist telemetry when PostgreSQL is enabled.
4. Update the worker's current state.
5. Compare altitude against the worker reference/baseline.
6. Evaluate vital telemetry thresholds.
7. Test the worker point against every enabled exclusion polygon.
8. Deduplicate repeated events during the configured cooldown period.
9. Create an incident.
10. Broadcast the event to connected command-center clients.

This architecture means a modified browser cannot simply disable the frontend alert renderer and thereby prevent the backend from recording an event.

## Configuration

```env
PORT=3000
DATABASE_URL=
TELEMETRY_INTERVAL_MS=2500
STALE_AFTER_MS=15000
ALTITUDE_DROP_M=5
ALTITUDE_JUMP_M=5
GEOFENCE_COOLDOWN_MS=30000
```

Treat these values as engineering configuration, not universal safety limits. Site-specific thresholds must be validated before operational use.

## Next engineering modules

### Phase 1 — worker mobile client
- Dedicated worker view
- Permission onboarding
- Background-location strategy where supported
- Battery-aware sampling
- Offline queue + retry
- Device identity and authentication

### Phase 2 — weather/heat stress
- Weather provider adapter
- Site weather cache
- Work/rest advisory calculation
- Supervisor acknowledgement
- Configurable environmental policy

### Phase 3 — wearables
- Bluetooth sensor adapter
- Heart-rate stream
- SpO2 stream where device exposes it
- Device pairing lifecycle
- Sensor freshness indicator

### Phase 4 — communications
- WebRTC push-to-talk
- Worker groups
- Channel membership
- Audio permission handling
- Connection fallback

### Phase 5 — indoor spatial intelligence
- Floorplan image upload
- Map calibration wizard
- Indoor zones
- Building/floor hierarchy
- Room-level worker presence

### Phase 6 — enterprise security
- Authentication
- Role-based access control
- Site/organization tenancy
- Device tokens
- TLS-only production deployment
- Audit retention policies
- Secrets management

### Phase 7 — drone/video integration
Keep the browser responsible for display/control metadata while using a dedicated media service for RTMP/WebRTC conversion. Do not send raw RTMP directly to an ordinary browser `<video>` element.

## Production checklist

Before using ALTIGUARD on an actual worksite:

- Use HTTPS.
- Authenticate every worker device.
- Authenticate administrators.
- Add organization/site tenancy.
- Encrypt sensitive telemetry in transit and at rest.
- Define data retention periods.
- Validate GPS accuracy under site conditions.
- Validate altitude sensor behavior and reference calibration.
- Establish emergency procedures independent of this application.
- Test network loss and server restart behavior.
- Test duplicate telemetry and delayed packets.
- Test zone boundary behavior.
- Test false positives and false negatives.
- Conduct a security review.
- Conduct a privacy review before collecting biometric/health-related telemetry.

## License

Private prototype / research project. Add an appropriate commercial open-source or proprietary license before public distribution.
