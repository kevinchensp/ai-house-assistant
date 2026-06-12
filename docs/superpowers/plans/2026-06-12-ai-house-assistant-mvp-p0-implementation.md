# AI House Assistant MVP P0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a runnable internal AI house assistant MVP skeleton with P0 backend rules, MCP access, event logging, and a simple客服工作台 frontend.

**Architecture:** Use a TypeScript monorepo with shared schemas, an Express API backend, and a Vite React frontend. The backend owns all model/MCP access, validates structured model output with Zod, applies deterministic search policy, and returns recommendations plus copy-ready sales replies.

**Tech Stack:** TypeScript, pnpm/npm workspaces, Express, Zod, Vitest, Vite, React.

---

## File Structure

```text
package.json
tsconfig.base.json
vitest.config.ts
.env.example
apps/server
apps/web
packages/shared
docs/superpowers/plans/2026-06-12-ai-house-assistant-mvp-p0-implementation.md
```

Responsibilities:

```text
packages/shared: Zod schemas, shared types, budget/location/recommendation helpers.
apps/server: Express API, MCP client, provider abstraction, orchestration, event logger.
apps/web: Internal客服页面 with chat input, requirement summary, recommendation cards, reply copy area, feedback controls.
```

## Tasks

### Task 1: Scaffold Tooling

- [ ] Create root Node workspace files.
- [ ] Create `packages/shared`, `apps/server`, and `apps/web` package manifests.
- [ ] Add TypeScript, Vitest, Vite, React, Express, and Zod dependencies.
- [ ] Add scripts: `dev`, `build`, `test`, `typecheck`.

### Task 2: Shared Schemas And Rules

- [ ] Write failing tests for budget range parsing, schema validation, location resolution, distance sorting, and recommendation scoring.
- [ ] Implement Zod schemas for requirement extraction, search plan, recommendation, sales reply, events, houses, and buildings.
- [ ] Implement deterministic helpers: `parseBudgetAround`, `resolveLocation`, `distanceMeters`, `rankHouses`.
- [ ] Run shared package tests.

### Task 3: Server Core

- [ ] Write failing tests for MCP JSON-RPC request shape, detail fallback, search orchestration, and event logging.
- [ ] Implement environment config.
- [ ] Implement MCP client with `initialize`, `tools/list`, and `tools/call`.
- [ ] Implement fallback detail behavior so missing images do not break the assistant response.
- [ ] Implement mock LLM provider and provider interface.
- [ ] Implement assistant orchestrator.
- [ ] Run server tests.

### Task 4: API And Frontend

- [ ] Implement `POST /api/ai-house-assistant/chat`.
- [ ] Implement `GET /api/health`.
- [ ] Build Vite React internal workspace page.
- [ ] Add chat input, requirement summary, recommendation cards, generated reply, and feedback buttons.
- [ ] Wire frontend to backend API using `VITE_API_BASE_URL`.

### Task 5: Verification And Docs

- [ ] Run `npm test`.
- [ ] Run `npm run typecheck`.
- [ ] Run `npm run build`.
- [ ] Update `docs/TODO.md` to mark scaffolded P0 items.
- [ ] Commit implementation changes.

## Self-Review Notes

This plan covers the P0 scaffold and deterministic assistant core. It intentionally uses a mock provider for model calls so the app can run without a model key; real domestic/OpenAI providers can be added behind the same interface after the API contract is proven.
