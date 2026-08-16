# Repository Guidelines

## Project Structure & Module Organization

`src/daemon/` contains the Node.js service: adapters normalize Claude/Codex transcripts, `ingest/` scans and watches them, `db/` owns SQLite schema and queries, and `server/` exposes the local HTTP API. Live hooks and browser-managed terminal support live in `live/` and `pty/`. `src/web/` is the framework-free Web UI (`app.ts`, `styles.css`, and `index.html`). Build tooling is in `scripts/`; `bin/te-hook.mjs` is the hook executable. Read `spec.md` before making architectural changes.

## Build, Test, and Development Commands

- `npm install` installs dependencies and runs the post-install hook setup.
- `npm run typecheck` runs strict TypeScript checking without emitting files.
- `npm run build` bundles the daemon and web UI into `dist/` with esbuild.
- `npm run dev` builds and starts the service directly from TypeScript sources.
- `npm start` runs the compiled daemon; use this after `npm run build`.
- `npm run scan` performs one transcript scan, while `npm run stats` prints index totals.

## Coding Style & Naming Conventions

Write strict ES module TypeScript targeting Node 22. Follow the existing style: two-space indentation, semicolons, single quotes, and explicit types where inference is unclear. Use `camelCase` for variables and functions, `PascalCase` for types/classes, and descriptive lowercase filenames such as `shellIntegration.ts`. Keep browser code dependency-free unless a justified change updates the build design. Run `npm run typecheck` before sharing changes.

## Testing Guidelines

There is no automated test suite yet. For changes, at minimum run `npm run typecheck` and `npm run build`. After every completed change, restart the service and verify the affected flow (`npm run dev`, `npm run scan`, or `npm run stats`); do not treat a build alone as sufficient runtime validation. Add focused tests alongside new test infrastructure; name test files after the unit they cover (for example, `redact.test.ts`).

## Commit & Pull Request Guidelines

The repository has no commit history yet, so use short imperative subjects such as `Add transcript retry handling`. Keep commits scoped. Pull requests should explain behavior and risk, link related issues when available, list verification commands, and include screenshots for Web UI changes. Do not commit `dist/`, `node_modules/`, database files, logs, tokens, or local configuration.

## Security & Configuration

The service is intentionally local-only and stores runtime state in `~/.thousandEyes`. Never log or commit access tokens, transcripts containing secrets, or `redact.json` contents. Preserve redaction before persistence and keep the HTTP listener bound to `127.0.0.1`.
