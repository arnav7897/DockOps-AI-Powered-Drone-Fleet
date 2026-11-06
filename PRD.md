# DroneOps --- AI-Native Drone Operations & Orchestration Platform
**Product Requirements Document \| MVP** **Stack:** Node.js, Express, MongoDB, MQTT, LLM tool calling, optional ESP32

## 1. Product Vision
DroneOps is a software orchestration and intelligence layer for managing drone operations. It sits above drone-side systems and provides a unified interface for device communication, mission workflows, command governance, operational visibility and AI-assisted decision support.

The platform does not control flight stabilization, navigation or safety-critical autopilot functions. Those remain the responsibility of the drone's flight controller. DroneOps manages operational intent and exchanges approved, high-level requests through MQTT.

## 2. Problem
Drone operations involve multiple devices, asynchronous communication, changing device state and operational decisions. A basic dashboard can display status, but it does not reliably coordinate missions, handle duplicate or delayed messages, explain failures, or safely translate operator intent into actions.

DroneOps addresses this through an event-driven backend, explicit state machines, reliable MQTT messaging and an AI copilot constrained by deterministic backend policies.

## 3. Goals
-   Provide a software-first control plane for registering and managing drone devices.; Use MQTT for device events, status updates, command requests and acknowledgements.; Manage mission creation, assignment, progress, cancellation and completion.; Maintain a consistent view of device and mission state.; Handle disconnects, stale messages, retries, duplicate delivery and command timeouts.; Offer an AI copilot for operational queries, mission proposals and fault investigation.; Make AI behavior testable through versioned evaluations and CI release gates.; Keep hardware optional and limited to a minimal ESP32 MQTT client for demonstration.

## 4. Non-goals
-   Building a drone, flight controller or autopilot.; Implementing autonomous navigation, obstacle avoidance or flight stabilization.; Building a complex ESP32 circuit, charging dock or sensor array.; Sending unrestricted low-level flight commands from an LLM.; Depending on physical hardware for the core MVP.; Claiming safety certification or real-world flight readiness.

## 5. Users
**Fleet operator** - Views connected devices, operational state and active missions. - Creates and tracks missions. - Reviews alerts, command outcomes and AI-generated explanations. - Approves or rejects AI-proposed actions.

**Developer / maintainer** - Runs the backend, MQTT broker and device simulators. - Inspects event flows and replays failure scenarios. - Runs backend, integration, end-to-end and AI evaluation suites.

## 6. Core Product Features

### 6.1 Device Registry and Digital State

-   Register devices with stable IDs, capabilities and MQTT identities.; Track online/offline state, last-seen time, reported status and active mission.; Maintain a latest-known device snapshot and timestamped event history.; Mark state as stale when updates exceed a configurable threshold.; Reconcile device state after reconnecting; do not blindly trust old retained messages.

### 6.2 MQTT Communication Layer

-   Subscribe to device telemetry and status topics.; Validate topic identity, schema version, timestamps and payloads.; Publish allowlisted high-level command requests.; Correlate command IDs with acknowledgements, rejections and timeouts.; Handle QoS 1 redelivery idempotently.; Use Last Will and Testament for unexpected disconnects.; Apply broker authentication and per-device topic ACLs.

### 6.3 Mission Orchestration

-   Create, assign, start, pause, cancel and complete operational missions.; Validate mission inputs and device eligibility before assignment.; Prevent concurrent requests from reserving the same device.; Track mission state through explicit, tested transitions.; Dispatch only approved high-level requests through the command service.; Revalidate device state and authorization immediately before dispatch.

### 6.4 Command Governance

-   Maintain an allowlist of supported command types.; Require unique command IDs, expiry times and correlation IDs.; Reject expired, malformed, unauthorized or duplicate requests.; Track pending, acknowledged, rejected, timed-out and failed commands.; Keep command execution separate from AI proposal generation.

### 6.5 Operational Event Timeline

-   Record device updates, mission transitions, commands, acknowledgements and faults.; Link related records through correlation IDs.; Expose searchable event history for debugging and audit.; Support replay of recorded event sequences against the backend.

### 6.6 Alerts and Fault Investigation

-   Detect stale devices, command timeouts and invalid state transitions.; Identify repeated communication failures and inconsistent reported state.; Group related events into an incident timeline.; Let the AI explain likely causes using retrieved event evidence.; Clearly distinguish observed facts from model-generated hypotheses.

### 6.7 Minimal ESP32 Edge Client (Optional)

-   Use one ESP32 development board as a lightweight MQTT client.; Connect to the broker over Wi-Fi using a device-specific identity.; Publish heartbeat, connectivity and a small set of simulated device-status fields.; Subscribe only to its permitted command topic.; Validate command schema and expiry before acknowledging receipt.; Publish command acknowledgements and connection status.; Keep the ESP32 independent of flight-critical functions; it is not an autopilot.; The entire MVP must remain usable with a Node.js device simulator if no ESP32 is available.

## 7. AI-Native Capabilities

### 7.1 Operations Copilot

-   Accept natural-language questions about devices, missions and incidents.; Convert mission requests into structured proposals.; Explain device eligibility and why a request was rejected.; Ask for clarification when required mission information is missing.; Require explicit operator approval before any state-changing action.

### 7.2 Read-Only Fleet Assistant

-   Answer questions such as "Which devices are offline?" or "Which missions are delayed?"; Use backend tools to retrieve current state.; Include relevant device IDs, mission IDs and event references.; Say when data is unavailable or stale instead of inventing an answer.

### 7.3 Constrained Agent Tools

Expose narrow tools such as: - `getFleetSnapshot()` - `getDeviceStatus(deviceId)` - `getMissionStatus(missionId)` - `getRecentEvents(filters)` - `checkDeviceEligibility(requirements)` - `proposeMission(input)` - `requestApproval(proposalId)` - `dispatchApprovedRequest(proposalId, approvalId)`

The model receives neither MQTT credentials nor unrestricted broker access. The backend remains the authority for permissions, validation and dispatch. Approval is not a permanent authorization: eligibility and policy must be checked again at dispatch time.

### 7.4 Fault Explanation

-   Retrieve relevant events, telemetry summaries and command outcomes.; Generate a concise incident explanation with supporting event IDs.; Separate evidence, likely causes and recommended diagnostic steps.; Never present an unverified model inference as a confirmed device fact.

## 8. AI Evaluation and Harness Engineering

Treat prompts, tools and model behavior as versioned software artifacts.

**Evaluation dataset** - Valid and ambiguous mission requests. - Missing, malformed and stale tool results. - Unknown device or mission IDs. - Conflicting or unavailable device state. - Prompt injection attempting to override policy. - Requests to dispatch without approval. - Duplicate tool calls and transient tool failures. - Questions whose answers are absent from backend data.

**Evaluation dimensions** - Structured-output and schema validity. - Correct tool selection and argument accuracy. - Groundedness against backend results. - Mission eligibility agreement with deterministic rules. - Refusal behavior for unsupported or unauthorized requests. - Prompt-injection and policy-bypass resistance. - Approval-bypass rate, which must be zero in critical tests. - Latency, token usage and tool-call failure rate.

**Engineering workflow** - Version prompts, tool schemas, policies and datasets. - Store traces for tool calls and failed evaluation cases. - Run deterministic backend tests independently of model evaluations. - Run AI regression evaluations when prompts, tools or models change. - Block CI on critical policy violations, approval bypasses or schema regressions. - Compare evaluation reports across model and prompt versions.

## 9. Architecture

1.  **API layer:** Express routes, authentication, authorization and request validation.
2.  **Domain layer:** Device registry, mission lifecycle, eligibility and command policies.
3.  **MQTT adapter:** Subscriptions, publishers, topic validation and acknowledgements.
4.  **Persistence layer:** MongoDB models for devices, missions, commands and events.
5.  **AI layer:** LLM adapter, copilot, constrained tools, prompt versions and evaluation runner.
6.  **Simulation layer:** Node.js device simulators that publish events and consume commands.
7.  **Optional edge layer:** ESP32 MQTT client.
8.  **Dashboard:** Lightweight operational view with device state, missions, alerts and event timeline.

## 10. MQTT Contract

**Topics**

``` text
devices/{deviceId}/status
devices/{deviceId}/events
devices/{deviceId}/commands
devices/{deviceId}/ack
missions/{missionId}/events
```

**Message envelope**

``` json
{
  "schemaVersion": 1,
  "messageId": "msg-001",
  "deviceId": "device-001",
  "timestamp": "2026-11-06T10:00:00.000Z",
  "type": "STATUS_UPDATE",
  "payload": {
    "connectivity": "online",
    "operationalState": "idle"
  }
}
```

**Command envelope**

``` json
{
  "schemaVersion": 1,
  "commandId": "cmd-001",
  "missionId": "mission-001",
  "command": "MISSION_REQUEST",
  "issuedAt": "2026-11-06T10:00:05.000Z",
  "expiresAt": "2026-11-06T10:00:20.000Z",
  "payload": {}
}
```

Use QoS 0 for replaceable, frequent status updates where occasional loss is acceptable. Use QoS 1 for commands and acknowledgements, with idempotency because delivery may be duplicated. Use retained messages selectively and always enforce freshness checks.

## 11. Suggested Stack

  Concern                  Technology
  ------------------------ ---------------------------------------------------
  Runtime / API            Node.js LTS, Express
  MQTT client / broker     MQTT.js, Eclipse Mosquitto
  Database                 MongoDB, Mongoose
  Validation               Zod
  Authentication           JWT, role-based authorization
  Real-time updates        Socket.IO or server-sent events
  AI                       Provider-agnostic LLM adapter with tool calling
  Tests                    Jest or Vitest, Supertest, MQTT integration tests
  Device simulation        Node.js
  Optional edge client     ESP32, Arduino framework or ESP-IDF
  Local environment / CI   Docker Compose, GitHub Actions

Avoid Kubernetes, Kafka, multiple databases and unnecessary hardware in the MVP.

## 12. Core Data Models

-   **Device:** deviceId, name, capabilities, connectivityState, operationalState, lastSeenAt, activeMissionId.; **Mission:** missionId, type, parameters, status, assignedDeviceId, createdBy, approvalId, timestamps, failureReason.; **Command:** commandId, deviceId, missionId, commandType, status, issuedAt, expiresAt, acknowledgedAt, failureReason.; **Event:** eventId, eventType, entityType, entityId, correlationId, source, timestamp, metadata.; **AI evaluation run:** runId, modelVersion, promptVersion, datasetVersion, scores, failedCaseIds, createdAt.

## 13. API Outline

-   `POST /api/v1/devices` --- register a device.; `GET /api/v1/devices` --- list devices and latest state.; `GET /api/v1/devices/:id/events` --- device event history.; `POST /api/v1/missions` --- create a mission.; `POST /api/v1/missions/:id/assign` --- request assignment.; `POST /api/v1/missions/:id/cancel` --- request cancellation.; `GET /api/v1/missions/:id` --- mission details.; `GET /api/v1/events` --- search operational events.; `POST /api/v1/ai/chat` --- copilot interaction.; `POST /api/v1/ai/proposals/:id/approve` --- approve a proposal.; `GET /api/v1/health` --- service health.

Do not expose a generic API for publishing arbitrary MQTT topics or commands.

## 14. Testing Strategy

**Unit:** payload validation, authorization, eligibility rules, mission transitions, idempotency and expiry.

**Integration:** MQTT connect/reconnect, invalid topics, QoS 1 duplicate delivery, acknowledgement correlation, Last Will handling and database persistence.

**End-to-end:** successful mission workflow, offline device, stale state, assignment race, command timeout, rejected command and reconnect reconciliation.

**AI:** correct tool choice, valid structured proposals, grounded answers, unknown IDs, prompt injection, refusal behavior, stale tool output and approval enforcement.

**CI gates:** all deterministic tests pass; critical AI policy and approval tests pass; evaluation reports and failed traces are retained.

## 15. MVP Delivery Plan

1.  **Software foundation:** Mosquitto, MongoDB, Express API and device registry.
2.  **Event-driven communication:** MQTT ingestion, validation, state snapshots and Node.js simulator.
3.  **Orchestration:** mission lifecycle, eligibility, reservations, commands and acknowledgements.
4.  **Reliability:** stale-state detection, idempotency, reconnect handling, event timeline and scenario replay.
5.  **AI-native layer:** read-only assistant, mission proposals, approval workflow and fault explanations.
6.  **Evaluation harness:** fixed datasets, adversarial cases, traces and CI release gates.
7.  **Optional ESP32 demo:** heartbeat/status publisher and constrained command acknowledgement.
8.  **Demo and documentation:** architecture, MQTT contract, API, test results and recorded walkthrough.

## 16. Definition of Done

-   Multiple simulated devices communicate through MQTT.; Device state and event history are persisted and queryable.; Missions follow enforced state transitions and eligibility rules.; Commands are allowlisted, correlated, expiry-checked and idempotent.; Disconnects, stale state and failed commands are observable.; The copilot answers from backend data and proposes valid structured actions.; No AI action can bypass backend authorization or operator approval.; Critical AI evaluations and deterministic tests run in CI.; The platform works without physical hardware; ESP32 is an optional edge demonstration.

## 17. Positioning

**DroneOps --- AI-Native Drone Operations & Orchestration Platform**

A software control plane for drone operations, combining MQTT-based device communication, mission orchestration, reliable command workflows and an evaluated AI copilot. The ESP32 is an optional edge client, not the core product.
