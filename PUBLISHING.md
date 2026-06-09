# Publishing to npm

Mind Map publishes as a **scoped public package**: `@ravi-labs/mindmap-mcp-server`.
Once published, anyone can install it with one line — `npx @ravi-labs/mindmap-mcp-server install`.

## One-time setup

1. **Create the npm org** (free for public packages) to match the scope:
   <https://www.npmjs.com/org/create> → name it `ravi-labs`.
2. **Log in** on your machine:
   ```bash
   npm login
   ```
   (If the npm account has 2FA, keep your authenticator handy for the publish step.)

## Publish

From the repo root:

```bash
# sanity checks — what will ship, and does it build + test clean?
npm pack --dry-run          # lists tarball contents (dist/ + LICENSE + NOTICE + README)
npm test                    # stdio + http smoke suites

# publish (prepublishOnly rebuilds dist automatically; publishConfig makes it public)
npm publish
```

`publishConfig.access` is already set to `public` in package.json, so you do **not**
need `--access public` on the command line. With 2FA enabled, add `--otp=<code>`.

## Verify

```bash
npm view @ravi-labs/mindmap-mcp-server version
npx -y @ravi-labs/mindmap-mcp-server --version
```

Then the real test — a clean install on any machine:

```bash
npx @ravi-labs/mindmap-mcp-server install
```

## Releasing a new version

```bash
npm version patch     # or minor / major — bumps package.json + git tag
git push --follow-tags
npm publish
```

Consider cutting a matching GitHub release for the tag.

## Notes

- The git tag and npm version should stay in sync (`npm version` does both).
- `files` in package.json whitelists what ships (`dist`, `NOTICE`); source and
  tests are intentionally excluded from the tarball.
- If you ever rename the scope, update every `@ravi-labs/mindmap-mcp-server`
  reference in `README.md`, `src/index.ts`, and `src/install.ts`.
