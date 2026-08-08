# Architecture and compatibility boundary

```text
QMK keycode
  -> Codex Control Community Module
  -> vendor Raw HID (32-byte protocol v1)
  -> macOS bridge service
  -> loopback Chrome DevTools Protocol
  -> Codex renderer Micro handler

Codex native six-slot state
  -> bounded renderer snapshot
  -> normalized status-only output report
  -> optional QMK raw_hid_receive callback
  -> keyboard LEDs/display
```

QMK exposes semantic aliases such as `CX_FAST`, but the wire format preserves
physical IDs (`ACT06`–`ACT12`) so the user's live Codex Micro settings remain
authoritative. Firmware never stores task IDs. The bridge is the only component
that knows renderer event names and is therefore the compatibility adapter that
should change after a ChatGPT Desktop update.

The local Unix socket is a stable, allowlisted client API. The QMK wire protocol
is a separate stable contract. The renderer interface is explicitly unstable
and is guarded by `probe`, snapshot validation, handler checks, and tests.

## Release compatibility

Patch releases may repair renderer discovery without changing QMK. Minor
releases may add backward-compatible packet types or CLI features. A wire-format
breaking change requires a protocol version bump and coordinated QMK/bridge
releases. Release notes should state tested ChatGPT Desktop, macOS, Node, QMK,
MCU, and real hardware versions.
