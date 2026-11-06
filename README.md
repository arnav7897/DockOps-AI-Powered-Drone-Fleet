# DroneOps

DroneOps is a planned AI-native control plane for drone operations. It will coordinate devices, missions and high-level commands over MQTT, with an operator-facing dashboard and an AI copilot constrained by backend policy. The flight controller remains responsible for flight stabilization, navigation and other flight-critical functions.

**Status:** Foundation, MQTT status ingestion and mission orchestration are in progress. Devices can be registered and monitored; operators can create, inspect and cancel draft missions. Assignment and dispatch are not yet available. See [PRD.md](PRD.md) for the full MVP requirements.

## Intended users

- Fleet operators monitor devices and missions, investigate alerts, and approve or reject AI-proposed actions.
- Developers run the backend, broker and simulators, inspect event flows, and exercise the test and evaluation suites.

## Planned stack

The PRD proposes Node.js and Express, MongoDB and Mongoose, MQTT.js and Mosquitto, Zod, JWT with role-based authorization, and a provider-agnostic LLM adapter. It suggests Docker Compose and GitHub Actions for local services and CI. Socket.IO versus server-sent events, Jest versus Vitest, and the optional ESP32 framework remain open choices.

## MVP roadmap

Phase 1 is in progress; later phases are planned. Each phase includes appropriate automated tests and updates to the operational documentation.

1. **Software foundation:** Establish the Express API, MongoDB, Mosquitto, authentication and device registry. Done when devices can be registered and retrieved through validated, authorized requests and the local services are reproducible.
2. **Event-driven communication:** Add MQTT ingestion, message validation, device snapshots and a Node.js simulator. Done when multiple simulators report validated state and that state is persisted and queryable.
3. **Orchestration:** Implement mission transitions, eligibility, device reservation, governed commands and acknowledgements. Done when an eligible mission can be assigned and tracked without concurrent reservations or unrestricted commands.
4. **Reliability:** Add stale-state detection, duplicate handling, reconnect reconciliation, searchable event timelines and scenario replay. Done when disconnects, retries, timeouts and replayed failures are observable and covered by tests.
5. **AI-native layer:** Add grounded fleet queries, mission proposals, operator approval and evidence-based fault explanations. Done when backend policy and fresh eligibility checks govern dispatch and AI-generated hypotheses are distinguished from facts.
6. **Evaluation harness:** Version evaluation data, prompts and tool schemas; retain traces and add CI gates. Done when deterministic tests and critical AI policy, schema and approval checks run in CI.
7. **Optional ESP32 demo:** Add a minimal authenticated MQTT client for heartbeat, simulated status and constrained command acknowledgements. Done when it demonstrates the contract without being required for the software MVP.
8. **Demo and documentation:** Document the implemented architecture, MQTT contract, API and test results, and record a walkthrough. Done when the software-only MVP and its failure scenarios can be demonstrated from the documented steps.

The MVP excludes autopilot development, autonomous navigation, unrestricted model-issued commands and claims of flight readiness or safety certification.

## Local development

Use Node.js 24, Docker Compose and a strong, private JWT secret. Install dependencies with `npm ci`. The database and broker are bound to localhost for development; MongoDB has no authentication in this local configuration and must not be exposed to a network.

Before starting Compose, create the broker password file interactively (replace `backend` with the intended local username):

```sh
docker run --rm -it -v "$PWD/mosquitto/config:/mosquitto/config" --entrypoint mosquitto_passwd eclipse-mosquitto:2 -c /mosquitto/config/passwd backend
docker compose up -d
```

Copy `.env.example` to `.env`, replace the example secret, and export the variables in your shell before running `npm start`. The API requires an externally issued HS256 JWT with issuer `droneops`, audience `droneops-api`, a subject, an expiry and role `admin` or `operator`. Admins can register devices with `POST /api/v1/devices` using `deviceId`, `name` and a `capabilities` string array; either role can call `GET /api/v1/devices` and `GET /api/v1/devices/:id/events` (most recent 100). `GET /api/v1/health` is public. Token issuance and user management are not implemented. Run `npm test` for API tests.

Authenticated operators and admins may create a draft with `POST /api/v1/missions` using `{ "type": "survey", "parameters": {} }`, inspect it with `GET /api/v1/missions/:id`, and cancel a draft with `POST /api/v1/missions/:id/cancel`. Cancellation of non-drafts returns a conflict; no command is dispatched by these endpoints.

To enable status ingestion, set and export `MQTT_URL`, `MQTT_USERNAME=backend`, and `MQTT_PASSWORD` before starting the API. Create each simulator's broker account using `docker run --rm -it -v "$PWD/mosquitto/config:/mosquitto/config" --entrypoint mosquitto_passwd eclipse-mosquitto:2 /mosquitto/config/passwd DEVICE_ID`, replacing `DEVICE_ID` with its registered ID; restart the broker after changes. Run `DEVICE_ID=DEVICE_ID MQTT_USERNAME=DEVICE_ID MQTT_PASSWORD=... MQTT_URL=mqtt://127.0.0.1:1883 node simulator/device.js` in a separate shell. Each device username must match its registered ID; reserve `backend` for the API and never assign it to a device. Avoid placing real passwords in shell history; supply them through your environment instead. The simulator sends heartbeats and a graceful offline update; last-will handling and command processing are not yet implemented.
