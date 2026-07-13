# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-07-13

### Added

- `cvr_segment_search` tool — firmographic discovery: find companies by DB07
  industry code prefix (main + alt industries), employee count (registered
  count with `ANTAL_*` interval fallback), company form, and founding date,
  anchored to a geography (postal codes, postal ranges, or one of the five
  Danish regions mapped to approximate postal ranges). The Lassox search API
  only supports text + address/contact filters server-side, so the tool scans
  companies per postal code via filter-only searches, fetches candidates with
  the existing rate-limit-aware batch machinery, and applies the firmographic
  criteria locally. Every call is bounded by a `maxRequests` budget and
  resumable via a criteria-bound `continuationToken`; progress notifications
  are emitted when the client sends a `progressToken`. Broad nationwide
  segments are intentionally out of scope — curate those in the Lasso portal
  and consume them via the Lists tools.
- Lists (tags) tools bridging segments curated in the Lasso portal:
  `lassox_lists_index` (all visible lists, optional `userId` for private
  lists), `lassox_list_get_entities` (members with skip/take pagination and
  `fields` projection), and `lassox_list_change` (bulk add/remove of Lasso IDs
  to/from lists). `lassox_list_change` is the server's first and only write
  tool: it changes list membership only, never CVR data, and is explicitly
  allowlisted as a write in the policy module, annotated
  `readOnlyHint: false`, and disabled by default in the gateway export.
- `cvr_get_changes` tool — wraps the Lassox delta endpoints
  (`/data/cvr/{company|person|place}/delta` and `/data/cvr/reports/delta`) for
  keeping downstream systems in sync. Supports `since`/`max`, pagination,
  `history`, `metadataOnly` (reports), optional client-side `lassoIds`
  filtering, and `fields` projection. `useLastLoad` defaults to `true` per the
  Lassox recommendation (upstream flips its default on 2026-08-01).

### Changed

- The capability catalogue, policy allowlist, and gateway export now
  distinguish `read` from `write` risk levels.

### Added

- Optional `fields` dot-path projection on `cvr_get_entity` and
  `cvr_batch_get_entities`. Callers can request only the fields they need so a
  response is shrunk from the full record (~14 KB per entity) to just those
  paths — projecting a 100-item batch down to a handful of fields takes the
  response from well over 1 MB to tens of kilobytes. Paths descend nested
  objects and map over arrays (e.g. `address.postalCode`,
  `management.members.name`); naming an object keeps its whole subtree, and
  unknown paths are skipped. Implemented as a reusable `selectFields` helper
  (`src/lasso/fields.ts`).

## [0.3.0] - 2026-06-17

### Added

- `cvr_batch_get_entities` tool — fetch current CVR basic information for many
  entities (companies, production units, or people) in a single call. Lassox has
  no native batch endpoint, so the tool fans out single-entity lookups with
  bounded concurrency (1–20, default 8), retries rate-limit (`429`) responses
  while honouring `retry-after`, and isolates per-item failures so one bad lookup
  never sinks the rest of the batch. Returns `{ total, succeeded, failed,
  results[] }` in input order, where each result is `{ index, label, ok, data |
  error }`. Accepts 1–100 items.
- MCP `notifications/progress` streaming for `cvr_batch_get_entities`: when the
  client includes a `progressToken`, the server emits incremental progress
  (items completed, batch size, and a per-item status message) as each lookup
  settles.
- Reusable bounded-concurrency batch runner and rate-limit retry helper
  (`src/lasso/batch.ts`) for future batch tools.

### Security

- Bumped the transitive `hono` override to `>=4.12.25` to clear a high-severity
  path-traversal advisory
  ([GHSA-wwfh-h76j-fc44](https://github.com/advisories/GHSA-wwfh-h76j-fc44))
  pulled in via the MCP SDK's HTTP transport. The vulnerable `serve-static`
  path is not used by this server.

## [0.2.1] - 2026-05-13

### Added

- Apache-2.0 `LICENSE` file and package metadata.
- `SECURITY.md` with the project security contact.
- GitHub Actions CI and Dependabot configuration.
- HTTP transport hardening: loopback default binding, optional bearer token,
  configurable CORS allowlist, 10 MiB default request-body cap, and explicit
  override for controlled deployments.
- Package publish allowlist and `prepack` build guard.

### Security

- Added a `fast-uri` override alongside the existing MCP HTTP transport
  transitive dependency overrides.
- Updated `zod`, `vitest`, and `@types/node` to current compatible releases.

## [0.2.0] - 2026-05-08

Adds seven new read-only Lassox tools (key figures, financial analysis,
person network, ownership graph, Creditsafe rating, and two Teledata tools)
and hardens the HTTP client against accidental key leakage.

### Added

- `cvr_get_reports` tool — fetch annual report key figures (nøgletal) for a
  Danish company via Lassox `GET /{lassoId}/reports`. Accepts an optional ISO
  4217 `currency` code for Lassox currency conversion. Restricted to company
  Lasso IDs (`CVR-1-*`).
- `lassox_financial_analysis` tool — run the Lassox Financial Analysis
  (Regnskabsanalyse) Module API via `POST /modules/reportanalysis/{lassoId}`.
  Returns HTML-formatted textual analysis plus the latest and previous reports.
  May require a separate Lassox subscription. Restricted to company Lasso IDs.
- `cvr_get_network` tool — fetch a person's professional network via the
  Lassox Network Module API (`GET /modules/network/{lassoId}`). Restricted to
  person Lasso IDs (`CVR-3-*`). May require a separate subscription.
- `cvr_get_ownership_graph` tool — build ownership and voting-rights graphs
  via the Lassox Ownership Structure Module API
  (`POST /modules/relations/graph`). Supports `relationTypes`, `enrichments`
  (`companyinfo`, `personinfo`, `reports`, `ultimateOwners`), and depth
  controls (capped at 25 ids and depth 0–10 to keep responses bounded). May
  require a separate subscription.
- `creditsafe_get_rating` tool — fetch Creditsafe ratings for Danish companies
  via Lassox (`GET /data/creditsafe/rating/{cvr}`). Accepts either a raw 8-digit
  CVR or a `CVR-1-*` Lasso ID, plus optional `skipCache`.
- `teledata_get_company_phones` tool — fetch phone numbers registered to a
  Danish company (`GET /data/teledata/{lassoId}/phonenumbers`). Restricted to
  company Lasso IDs.
- `teledata_lookup_phone` tool — reverse-lookup a Danish phone number
  (`GET /data/teledata/{phoneNumber}`). Optional `includeCompany` enriches
  with CVR data when the number belongs to a company.
- `LassoClient.post()` for Lassox Module APIs, sharing the existing auth,
  timeout, and error-mapping with `get()`.

### Security

- `LassoClient` now refuses non-`https://` base URLs (loopback `http://` is
  allowed for local mocks) so the Lassox API key cannot accidentally be sent
  over plain HTTP via a misconfigured `LASSO_BASE_URL`.
- Added `npm` `overrides` for `ip-address` (≥10.1.1, fixes
  [GHSA-v2v4-37r5-5v8g](https://github.com/advisories/GHSA-v2v4-37r5-5v8g))
  and `hono` (≥4.12.16, fixes
  [GHSA-9vqf-7f2p-gf9v](https://github.com/advisories/GHSA-9vqf-7f2p-gf9v) and
  [GHSA-69xw-7hcm-h432](https://github.com/advisories/GHSA-69xw-7hcm-h432))
  to clear transitive Dependabot alerts pulled in via the MCP SDK's HTTP
  transport. The vulnerable code paths are not used by this server.

### Changed

- README scope section now lists every supported Lassox API surface, including
  the new network, ownership-graph, Creditsafe, and Teledata tools.

## [0.1.1] - 2026-05-01

Hardening release for the Lassox CVR MCP server. This release keeps the v0.1.0
tool surface backward-compatible while making the server easier for MCP clients
and operators to reason about.

### Added

- `lassox_search_capabilities` discovery tool with descriptions, examples,
  identifier formats, and safety notes for the CVR tools.
- MCP tool annotations on every registered tool:
  `readOnlyHint`, `destructiveHint`, `idempotentHint`, and `openWorldHint`.
- Optional `LASSO_TIMEOUT_MS` environment variable for request timeout tuning.
- Optional `LASSO_AUDIT_LOG` JSONL audit events for tool starts, finishes, and
  failures, using hashed targets and redacted errors.
- Internal read-only policy allowlist so future expansion has an explicit safety
  boundary.

### Security

- Redacts `lasso-api-key`, `LASSO_API_KEY`, and `apiKey`-style secret material
  from formatted errors.
- Keeps API-key handling env-only; no tool accepts API keys as input.

### Changed

- README now includes a "Start here" discovery guide, hardening environment
  variables, and audit/security notes.

## [0.1.0] - 2026-04-27

Initial release of the Lassox CVR MCP server. Exposes core CVR lookup and
search to MCP-compatible agents over stdio, with an optional Streamable HTTP
transport for non-stdio clients.

### Added

- `cvr_search` tool — search companies and people, with optional `status`,
  `continuationToken`, and structured `filters` (`city`, `postalCode`,
  `street`, `email`, `telephone`, `cvr`).
- `cvr_get_entity` tool — fetch current basic information for a company,
  production unit, or person by structured `entityType`+`id` or by `lassoId`.
- `cvr_get_entity_history` tool — fetch historical basic information,
  returned unchanged from Lassox (`value`, `from`, `to`, `current`).
- `cvr_get_related` tool — fetch documented related entities
  (company→person, company→place, productionUnit→company), with optional
  `history` flag.
- stdio transport (`dist/stdio.js`) as the default for local agent clients.
- Streamable HTTP transport (`dist/http.js`) on `POST /mcp`, configurable
  via `PORT`.
- Lassox API client with `lasso-api-key` header authentication, 30s request
  timeout, and `429` handling that surfaces `retry-after` to the caller.
- Vitest unit tests for the client and CVR tool wiring.
- Optional live smoke test (`npm run smoke:live`) gated on `LASSO_API_KEY`.

### Security

- API key is read from the `LASSO_API_KEY` environment variable only and is
  never accepted as a tool argument.
- No request or response bodies are logged by the server.

[Unreleased]: https://github.com/Borgels/mcp-server-lassox/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/Borgels/mcp-server-lassox/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/Borgels/mcp-server-lassox/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/Borgels/mcp-server-lassox/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/Borgels/mcp-server-lassox/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/Borgels/mcp-server-lassox/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Borgels/mcp-server-lassox/releases/tag/v0.1.0
