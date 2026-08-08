# Contributing

This is an experimental local integration with an undocumented renderer API.
Compatibility, strict validation, and loopback-only operation take priority.

Before opening a pull request:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm test
npm pack --dry-run
```

Changes to Raw HID must be coordinated with the QMK repository and documented
in `docs/protocol.md` plus the firmware protocol document. Add tests for every
accepted and rejected packet shape. Renderer discovery changes should read the
minimum state necessary and must never collect prompt/response bodies.

Compatibility reports should include sanitized macOS, Node, ChatGPT Desktop,
QMK, keyboard, and bridge versions. Never attach CDP dumps, task IDs, prompts,
responses, auth data, Unix sockets, plist files containing personal paths, or
private logs.
