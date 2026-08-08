// The React-store discovery strategy is adapted from the MIT-licensed Codex
// Deck project: https://github.com/dazer1234/codex-stream-deck

export interface NativeAgentSlot {
  id: number;
  threadKey: string | null;
  status: string;
  selected: boolean;
}

export interface AgentSnapshot {
  slots: NativeAgentSlot[];
}

export function buildAgentSnapshotExpression(): string {
  return `(async () => {
    const urls = [...new Set([
      ...[...document.querySelectorAll('link[href], script[src]')].map((element) => element.href || element.src),
      ...performance.getEntriesByType('resource').map((entry) => entry.name)
    ])].filter((url) => url.includes('/assets/') && url.endsWith('.js'));
    const slotSignalsUrl = urls.find((url) => url.includes('/assets/codex-micro-slot-signals-'));
    if (!slotSignalsUrl) throw new Error('Codex Micro slot signals are not loaded.');

    const root = document.getElementById('root');
    const reactKey = root && Object.getOwnPropertyNames(root).find((key) => key.startsWith('__reactContainer$'));
    if (!root || !reactKey) throw new Error('Codex React root was not found.');

    const slotSignals = await import(slotSignalsUrl);
    const resolvers = Object.values(slotSignals).filter((candidate) =>
      candidate && typeof candidate === 'object' &&
      typeof candidate.resolve === 'function' &&
      typeof candidate.createSubscriberAtom === 'function'
    );
    if (resolvers.length === 0) throw new Error('Codex Micro slot resolver was not found.');

    let queue = [root[reactKey]];
    const seen = new Set();
    let slots = null;
    while (queue.length && seen.size < 30000 && !slots) {
      const fiber = queue.pop();
      if (!fiber || seen.has(fiber)) continue;
      seen.add(fiber);
      const maps = [];
      if (fiber.memoizedProps?.value instanceof Map) maps.push(fiber.memoizedProps.value);
      let dependency = fiber.dependencies?.firstContext;
      while (dependency) {
        if (dependency.memoizedValue instanceof Map) maps.push(dependency.memoizedValue);
        dependency = dependency.next;
      }
      for (const chain of maps) {
        for (const node of chain.values()) {
          if (!node?.store || typeof node.store.get !== 'function') continue;
          for (const resolver of resolvers) {
            try {
              const atom = resolver.resolve(node, chain);
              const candidate = node.store.get(atom);
              if (Array.isArray(candidate) && candidate.length === 6 &&
                  candidate.every((slot, index) => slot?.id === index)) {
                slots = candidate;
                break;
              }
            } catch {}
          }
          if (slots) break;
        }
        if (slots) break;
      }
      queue.push(fiber.child, fiber.sibling);
    }
    if (!slots) throw new Error('Codex Micro slot store was not found.');

    const activeThreadKey = document.querySelector('[data-app-action-sidebar-thread-id][aria-current="page"]')
      ?.getAttribute('data-app-action-sidebar-thread-id') ??
      document.querySelector('[data-above-composer-conversation-id]')
      ?.getAttribute('data-above-composer-conversation-id') ?? null;
    return {
      slots: slots.map((slot, index) => ({
        id: index,
        threadKey: typeof slot.threadKey === 'string' ? slot.threadKey : null,
        status: typeof slot.status === 'string' ? slot.status : 'off',
        selected: Boolean(slot.selected || (activeThreadKey && slot.threadKey === activeThreadKey))
      }))
    };
  })()`;
}

export function validateAgentSnapshot(value: unknown): AgentSnapshot {
  if (!value || typeof value !== "object" || !("slots" in value) || !Array.isArray(value.slots)) {
    throw new Error("Codex Agent snapshot has an invalid shape.");
  }
  const slots = value.slots.map((slot, index) => {
    if (!slot || typeof slot !== "object") throw new Error(`Codex Agent slot ${index} is invalid.`);
    const record = slot as Record<string, unknown>;
    if (record.id !== index || (record.threadKey !== null && typeof record.threadKey !== "string") ||
        typeof record.status !== "string" || typeof record.selected !== "boolean") {
      throw new Error(`Codex Agent slot ${index} is invalid.`);
    }
    return {
      id: index,
      threadKey: record.threadKey as string | null,
      status: record.status,
      selected: record.selected,
    };
  });
  if (slots.length !== 6) throw new Error("Codex Agent snapshot must contain exactly six slots.");
  return { slots };
}
