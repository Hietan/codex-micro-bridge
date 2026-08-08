# Security

## Reporting

Use GitHub private vulnerability reporting for security issues. Do not include
prompts, responses, task identifiers, authentication material, CDP dumps, or
unsanitized logs. Only the latest tagged release is supported.

## Security boundary

This project connects to a private Electron renderer debugging interface. A CDP endpoint can execute JavaScript inside the ChatGPT desktop application and must be treated as a privileged local interface.

- Launch CDP only on `127.0.0.1`; never use `0.0.0.0` or expose the port through a tunnel.
- Prefer a random high port and do not reuse it for unrelated applications.
- The bridge control plane is a Unix domain socket with mode `0600`; no HTTP listener is created.
- The control protocol is allowlisted. It has no arbitrary JavaScript or arbitrary command execution request.
- Agent status polling reads only six physical slot records: slot number, task identifier, status, and selected flag. It does not read prompt or response bodies. Task identifiers are not written to USB; only bit masks and six numeric status values leave the renderer bridge.
- Any process running as the same local user may still be able to reach the CDP endpoint or Unix socket.
- The renderer event bus is an undocumented implementation detail. Review changes before using the bridge with a new ChatGPT desktop build.

Run `codex-micro-bridge start --mock` when testing clients that do not need the real application.
