const DEVICE_STATE = {
  type: "codex-micro-device-state-changed",
  state: {
    status: "connected",
    error: null,
    battery: { percentage: 100, isCharging: true },
  },
};

const RESOLVE_BUS_SOURCE = `
  const cacheKey = Symbol.for('codex-micro-bridge.event-bus.v1');
  const isBus = (candidate) => candidate && typeof candidate === 'object' &&
    candidate.handlers instanceof Map &&
    (typeof candidate.dispatchHostMessage === 'function' || typeof candidate.dispatchMessage === 'function');
  let bus = globalThis[cacheKey];
  if (!isBus(bus)) {
    bus = null;
    const urls = [...new Set([
      ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
    for (const url of urls) {
      try {
        const namespace = await import(url);
        bus = Object.values(namespace).find(isBus);
        if (bus) break;
      } catch {}
    }
    if (!bus) throw new Error('Codex event bus was not found. The desktop app may have changed.');
    globalThis[cacheKey] = bus;
  }
  const dispatch = bus.dispatchHostMessage ?? bus.dispatchMessage;
`;

export interface ProbeValue {
  hidHandlers: number;
  joystickHandlers: number;
  href: string;
}

export function buildProbeExpression(): string {
  return `(async () => {
    ${RESOLVE_BUS_SOURCE}
    dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
    const deadline = Date.now() + 1500;
    while (
      (bus.handlers.get('codex-micro-hid-event')?.size ?? 0) === 0 &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return {
      hidHandlers: bus.handlers.get('codex-micro-hid-event')?.size ?? 0,
      joystickHandlers: bus.handlers.get('codex-micro-joystick-event')?.size ?? 0,
      href: location.href
    };
  })()`;
}

export function buildDispatchExpression(
  message: Record<string, unknown>,
  requiredHandler: "codex-micro-hid-event" | "codex-micro-joystick-event",
): string {
  return `(async () => {
    ${RESOLVE_BUS_SOURCE}
    if ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0) {
      dispatch.call(bus, ${JSON.stringify(DEVICE_STATE)});
    }
    const deadline = Date.now() + 1500;
    while ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if ((bus.handlers.get(${JSON.stringify(requiredHandler)})?.size ?? 0) === 0) {
      throw new Error(${JSON.stringify(`${requiredHandler} is not active.`)});
    }
    dispatch.call(bus, ${JSON.stringify(message)});
    return true;
  })()`;
}
