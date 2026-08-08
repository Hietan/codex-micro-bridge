# Bridge protocol v1

The bridge accepts UTF-8 JSON Lines over a local Unix domain socket. Each line is one complete message. The socket is created with mode `0600` and messages are limited to 16 KiB.

## Lifecycle

The server sends a `ready` message immediately after a client connects:

```json
{"v":1,"type":"ready","mode":"codex","target":"app://codex/index.html","port":9222}
```

The client then sends one request. The server replies with either `ack` or `error`. An `ack` with `status: "dispatched"` confirms only that the event was handed to the Codex renderer event bus; it does not prove that a context-dependent action completed.

## Requests

### Command or dial key

```json
{"v":1,"id":"evt-1","type":"key","key":"ACT06","act":1}
{"v":1,"id":"evt-2","type":"key","key":"ACT06","act":0}
```

`act` is `1` for press and `0` for release. Encoder steps use `ENC_CW` or `ENC_CC` with `act: 2`.

### Agent key

```json
{"v":1,"id":"evt-3","type":"key","key":"AG00","act":1}
```

The bridge derives `slot` from `AG00` through `AG05` and resolves its current
`threadKey` from the native six-slot snapshot immediately before dispatch.
`threadKey` is an optional diagnostic override and is deliberately not stored
in QMK firmware.

### Joystick

```json
{"v":1,"id":"evt-4","type":"joystick","angle":0.75,"distance":1}
```

Angles use Codex Micro's normalized coordinate: right `0`, down `0.25`, left `0.5`, and up `0.75`. Send `distance: 0` to release.

### Health check

```json
{"v":1,"id":"evt-5","type":"ping"}
```

### Agent status snapshot

```json
{"v":1,"id":"state-1","type":"snapshot"}
```

The response contains exactly six records with `id`, `assigned`, native
`status`, and `selected`. It deliberately omits task identifiers, titles,
prompts, and responses.

## Errors

```json
{"v":1,"type":"error","id":"evt-1","error":{"code":"dispatch_failed","message":"..."}}
```

The public socket never accepts JavaScript source or arbitrary Codex command identifiers. It accepts only the event types and key identifiers defined in `src/protocol.ts`.
