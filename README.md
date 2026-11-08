# DroneOps

DroneOps is a planned AI-native control plane for drone operations. It will coordinate devices, missions and high-level commands over MQTT, with an operator-facing dashboard and an AI copilot constrained by backend policy. The flight controller remains responsible for flight stabilization, navigation and other flight-critical functions.

**Status:** Foundation, MQTT status ingestion and mission orchestration are in progress. Operators can register and monitor devices, reserve eligible devices, and issue simulated mission requests with acknowledgement tracking. See [PRD.md](PRD.md) for the full MVP requirements.

## Intended users

- Fleet operators monitor devices and missions, investigate alerts, and approve or reject AI-proposed actions.
- Developers run the backend, broker and simulators, inspect event flows, and exercise the test and evaluation suites.

## Planned stack

The PRD proposes Node.js and Express, MongoDB and Mongoose, MQTT.js and Mosquitto, Zod, JWT with role-based authorization, and a provider-agnostic LLM adapter. It suggests Docker Compose and GitHub Actions for local services and CI. Socket.IO versus server-sent events, Jest versus Vitest, and the optional ESP32 framework remain open choices.

## MVP roadmap

Phases 1–4 are in progress; later phases are planned. Each phase includes appropriate automated tests and updates to the operational documentation.

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

Authenticated operators and admins may create a draft with `POST /api/v1/missions` using `{ "type": "survey", "parameters": {} }`, inspect it with `GET /api/v1/missions/:id`, and reserve a device with `POST /api/v1/missions/:id/assign` using `{ "deviceId": "drone-1" }`. The device must be online, idle, unreserved, report the mission type as a capability, and have reported status within the configurable `STALE_AFTER_MS` (default 60 seconds). Device lists expose a `stale` flag. Cancel a draft or unsent reservation with `POST /api/v1/missions/:id/cancel`. Assignment and cancellation use MongoDB transactions, requiring the configured replica set; wait for the Compose MongoDB health check before starting the API. For the database integration tests, set `TEST_MONGODB_URI` to a dedicated test replica set URI and run `npm test`; the tests create and drop temporary databases.

With the broker connected and subscriptions ready, `POST /api/v1/missions/:id/start`, `/pause`, `/resume`, `/complete`, and `/cancel` request the corresponding valid transition. These endpoints return a command with HTTP 202; poll `GET /api/v1/commands/:id` and the mission endpoint for its outcome. The API rechecks authorization expiry and device eligibility immediately before publication, and changes mission state only after a matching device acknowledgement. Requests have unique IDs, a correlation ID and an expiry no later than 30 seconds or the operator token's expiry. A rejected request leaves the mission in its prior state. A timeout or uncertain publish retains the device reservation and blocks further commands. A matching late acknowledgement can reconcile a timeout if the authenticated device reports a timestamp within the command's validity window. This relies on the device's clock and reported outcome; acknowledgements are not proof of physical flight or completion. If no acknowledgement arrives, manual recovery is not yet implemented.

To enable MQTT, set and export `MQTT_URL`, `MQTT_USERNAME=backend`, and `MQTT_PASSWORD` before starting the API. Create each simulator's broker account using `docker run --rm -it -v "$PWD/mosquitto/config:/mosquitto/config" --entrypoint mosquitto_passwd eclipse-mosquitto:2 /mosquitto/config/passwd DEVICE_ID`, replacing `DEVICE_ID` with its registered ID; restart the broker after changes. Export `DEVICE_ID`, matching `MQTT_USERNAME`, `MQTT_PASSWORD`, and `MQTT_URL=mqtt://127.0.0.1:1883`, then run `node simulator/device.js` in a separate shell. Reserve `backend` for the API and never assign it to a device. Avoid placing real passwords in shell history. The backend uses a persistent MQTT session (`MQTT_CLIENT_ID`, default `droneops-backend`); run one backend per client ID. Its QoS 1 messages are acknowledged only after processing, and the Compose broker persists sessions in a named volume. Each simulator connection uses a new session ID and a non-retained last will. A will affects only the current session; retained status and disconnect notices are ignored. The simulator persists mission state and acknowledgements under the Git-ignored `.simulator-state/` directory (override with `DEVICE_STATE_DIR`) and resends acknowledgements on reconnect and heartbeats. Run one simulator per device with a persistent state directory. It fails closed after retaining 1,000 commands because a backend receipt protocol for safe pruning does not yet exist.

Authenticated operators can query `GET /api/v1/alerts` for offline or stale devices, timed-out commands, and recorded command failures or rejections. `GET /api/v1/events` returns up to 100 recent device events, command snapshots, and mission/command audit events; optional `deviceId`, `missionId`, `correlationId`, and `kind=device|command|audit` filters narrow the results. Audit records are created transactionally for new mission and command transitions and are not backfilled for earlier activity. `GET /api/v1/devices/:id/replay` replays up to 1,000 recorded device events through validation into an isolated in-memory snapshot. `GET /api/v1/missions/:id/replay` reconstructs mission state from audit records and marks incomplete histories; neither endpoint publishes commands or changes stored state. Replay is diagnostic, not evidence of physical device state.

To exercise the broker integration test as well as the database tests, set `TEST_MQTT_URL`, `TEST_MQTT_BACKEND_PASSWORD`, and `TEST_MQTT_DEVICE_PASSWORD` for a dedicated test broker with `backend` and `drone1` accounts and the supplied ACL. Tests start disposable API and simulator processes and use a temporary test database and state directory.
