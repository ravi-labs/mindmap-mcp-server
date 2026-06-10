---
name: mindmap-brainstorm
description: Brainstorm an idea with your portable Mind Map memory so a thread you start in one AI tool continues in another. Use when the user wants to brainstorm, ideate, "think through", or explore options/approaches/ideas — especially when the topic may have prior history in another tool or session. Loads prior idea-threads, brainstorms, then saves the result so it travels across tools.
---

# Mind Map Brainstorm

Brainstorm **with memory**: continue idea-threads across Claude, Cursor, Copilot, and Cowork without ever re-explaining the idea. This skill orchestrates the flow; *your own* brainstorming ability does the thinking. Mind Map is the shared memory underneath — not a replacement for how you brainstorm.

## When to use

Trigger when the user wants to brainstorm / ideate / "think through" / "explore options or approaches" / "what could we do about X" — and especially when the topic might already have history elsewhere.

## Flow — do these in order

1. **Load prior context.** Call the `mindmap_brainstorm` tool with the topic. It returns the user's persona plus prior brainstorms and related memories to build on, and promotes the brainstorms you reuse.
   - If the `mindmap_*` tools aren't available, tell the user the Mind Map MCP server isn't connected (so memory won't carry across tools), then continue without it.

2. **Brainstorm — your way.** Using the returned context, brainstorm with your full capability (and any dedicated brainstorming technique you have). Build **on** the prior threads rather than repeating them. Diverge widely first, then converge to a few strong directions.

3. **Save what's worth keeping.** When the session produces something durable — a decision, a shortlist, a plan — call `mindmap_capture` with `kind: "brainstorm"`, a clear `title`, a portable `summary`, and `key_points`. That capture is what lets the idea resume in the user's *next* tool.

## Principles

- **Memory layer, not puppeteer.** Mind Map carries the *context*; it does not drive other tools' features. Use the portable context and your own ability — don't try to invoke another tool's skills.
- **Continue, don't duplicate.** Prefer extending an existing brainstorm (the tool surfaces related ones with their ids) over starting a near-duplicate.
- **Write portably.** Compose each capture so a *different* tool with zero prior context could pick it up cold.
