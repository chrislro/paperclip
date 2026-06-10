# Architecture Decision Records

This directory records project decisions that should remain understandable after
the original context is gone.

## Format

Each ADR should include:

- Status: Proposed, Accepted, Superseded, or Rejected.
- Context.
- Decision.
- Consequences.
- Verification or rollback notes when relevant.

## Index

| ADR | Status | Decision |
|---|---|---|
| `0001-stable-first-party-api-domain.md` | Accepted | Production extension uses `https://api.tocafichadr.com.br`, not rotating tunnels. |
| `0002-request-scoped-db-sessions.md` | Accepted | Flask removes scoped SQLAlchemy sessions after request teardown. |
