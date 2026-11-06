# DroneOps

DroneOps is a planned AI-native control plane for drone operations. It will coordinate devices, missions and high-level commands over MQTT, with an operator-facing dashboard and an AI copilot constrained by backend policy. The flight controller remains responsible for flight stabilization, navigation and other flight-critical functions.

**Status:** Requirements only. No application, infrastructure, or user flow has been implemented yet. See [PRD.md](PRD.md) for the full MVP requirements. Setup and run instructions will be added when the relevant components exist.

## Intended users

- Fleet operators monitor devices and missions, investigate alerts, and approve or reject AI-proposed actions.
- Developers run the backend, broker and simulators, inspect event flows, and exercise the test and evaluation suites.

## Planned stack

The PRD proposes Node.js and Express, MongoDB and Mongoose, MQTT.js and Mosquitto, Zod, JWT with role-based authorization, and a provider-agnostic LLM adapter. It suggests Docker Compose and GitHub Actions for local services and CI. Socket.IO versus server-sent events, Jest versus Vitest, and the optional ESP32 framework remain open choices.

## MVP roadmap

All phases are planned; none is complete. Each phase includes appropriate automated tests and updates to the operational documentation.

1. **Software foundation:** Establish the Express API, MongoDB, Mosquitto, authentication and device registry. Done when devices can be registered and retrieved through validated, authorized requests and the local services are reproducible.
2. **Event-driven communication:** Add MQTT ingestion, message validation, device snapshots and a Node.js simulator. Done when multiple simulators report validated state and that state is persisted and queryable.
3. **Orchestration:** Implement mission transitions, eligibility, device reservation, governed commands and acknowledgements. Done when an eligible mission can be assigned and tracked without concurrent reservations or unrestricted commands.
4. **Reliability:** Add stale-state detection, duplicate handling, reconnect reconciliation, searchable event timelines and scenario replay. Done when disconnects, retries, timeouts and replayed failures are observable and covered by tests.
5. **AI-native layer:** Add grounded fleet queries, mission proposals, operator approval and evidence-based fault explanations. Done when backend policy and fresh eligibility checks govern dispatch and AI-generated hypotheses are distinguished from facts.
6. **Evaluation harness:** Version evaluation data, prompts and tool schemas; retain traces and add CI gates. Done when deterministic tests and critical AI policy, schema and approval checks run in CI.
7. **Optional ESP32 demo:** Add a minimal authenticated MQTT client for heartbeat, simulated status and constrained command acknowledgements. Done when it demonstrates the contract without being required for the software MVP.
8. **Demo and documentation:** Document the implemented architecture, MQTT contract, API and test results, and record a walkthrough. Done when the software-only MVP and its failure scenarios can be demonstrated from the documented steps.

The MVP excludes autopilot development, autonomous navigation, unrestricted model-issued commands and claims of flight readiness or safety certification.
