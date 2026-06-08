# Contributing to Mind Map

Thanks for your interest in improving Mind Map! This is a local-first, open-source
MCP memory server, and contributions are welcome.

## Guiding principles

Before proposing a feature, it helps to know what the project is *for*. Two
principles shape every decision:

1. **Local-first, always.** Your memories are plain files on your machine. No
   feature should require central hosting or sending memory to a third party. If
   something needs a network, it must be opt-in and user-owned.
2. **The value is forgetting well, not storing.** The product's job is graceful
   decay and trustworthy recall — not accumulation. Features (and especially the
   gamified surface) should reward a small, clean, trusted memory, **never**
   volume. A change that incentivizes hoarding is off-mission.

## Development setup

```bash
git clone https://github.com/ravi-labs/mindmap-mcp-server.git
cd mindmap-mcp-server
npm install
npm run build
npm test          # runs the stdio + http smoke suites in throwaway data dirs
```

Useful scripts:

- `npm run dev` — watch mode via tsx
- `npm run build` — type-check + emit `dist/`
- `npm test` — end-to-end smoke tests
- `node dist/index.js install --local` — wire your local checkout into your MCP clients

## Project layout

| Path | What it holds |
| --- | --- |
| `src/index.ts` | entry point, CLI dispatch, transport selection, background pruner |
| `src/server.ts` | `McpServer` factory |
| `src/tools.ts` | all 13 MCP tool definitions |
| `src/store.ts` | local-file storage layer (threads + index + config) |
| `src/decay.ts` | the consolidation engine: tiering, decay, health |
| `src/search.ts` | token-overlap federated search |
| `src/http.ts` | optional Streamable HTTP transport (auth + origin checks) |
| `src/install.ts` | the auto-configurator for local MCP clients |

## Making a change

1. Fork and branch from `main` (`feat/...`, `fix/...`).
2. Keep TypeScript strict — no `any`; run `npm run build` clean.
3. Add or update a smoke-test assertion in `scripts/` when you change behavior.
4. Run `npm test` and make sure both suites pass.
5. Open a PR describing **what** changed and **why**, and how it respects the two
   guiding principles above.

## Reporting bugs / ideas

Open an issue at
<https://github.com/ravi-labs/mindmap-mcp-server/issues>. For anything
security-sensitive (e.g. the HTTP transport), please flag it clearly in the issue.

## License

By contributing, you agree that your contributions will be licensed under the
[Apache License 2.0](LICENSE), consistent with the rest of the project.
