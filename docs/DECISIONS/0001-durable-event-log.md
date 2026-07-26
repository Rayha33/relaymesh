# ADR 0001: Durable event log as canonical coordination state

Status: accepted

## Context

Different AI model sessions hold incompatible context, terminate unexpectedly,
and cannot reliably reconstruct peer state from chat transcripts.

## Decision

RelayMesh stores coordination mutations as a signed append-only event log and
projects operational tables for fast reads. Checkpoints are explicit,
model-independent recovery capsules.

## Consequences

- Agents can be replaced without owning the task history.
- Operators can inspect and verify every state transition.
- Delivery is at-least-once and clients must use idempotency keys.
- Projection migrations must preserve event history.
