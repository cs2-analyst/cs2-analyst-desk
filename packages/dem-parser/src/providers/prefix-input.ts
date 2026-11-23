/** Keep the earliest complete tick groups within bounded local evidence budgets. */
export function boundLocalEvidenceInput(input: unknown): { id: string; header: { map_name: string };
  events: unknown[]; stateRows: unknown[]; truncated: boolean } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid-local-evidence-input');
  const raw = input as Record<string, unknown>;
  const header = raw.header as Record<string, unknown> | null;
  if (typeof raw.id !== 'string' || !header || typeof header.map_name !== 'string'
    || !Array.isArray(raw.events) || !Array.isArray(raw.stateRows)) throw new Error('invalid-local-evidence-input');
  // A max-heap retains the earliest budget+1 ticks without allocating another
  // unbounded array. If the budget cuts through a tick, omit that entire tick.
  const overflowTick = (items: unknown[], budget: number): number => {
    const heap: number[] = [];
    for (const item of items) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('unlocatable-local-evidence-tick');
      const tick = (item as Record<string, unknown>).tick;
      if (!Number.isSafeInteger(tick) || (tick as number) < 0) throw new Error('unlocatable-local-evidence-tick');
      const n = tick as number;
      if (heap.length < budget + 1) {
        heap.push(n);
        for (let i = heap.length - 1; i > 0;) {
          const parent = Math.floor((i - 1) / 2);
          if (heap[parent] >= heap[i]) break;
          [heap[parent], heap[i]] = [heap[i], heap[parent]];i = parent;
        }
      } else if (n < heap[0]) {
        heap[0] = n;
        for (let i = 0;;) {
          const left = i * 2 + 1, right = left + 1;
          let largest = i;
          if (left < heap.length && heap[left] > heap[largest]) largest = left;
          if (right < heap.length && heap[right] > heap[largest]) largest = right;
          if (largest === i) break;
          [heap[i], heap[largest]] = [heap[largest], heap[i]];i = largest;
        }
      }
    }
    return items.length > budget ? heap[0] : Infinity;
  };
  const cutoff = Math.min(overflowTick(raw.events, 20000), overflowTick(raw.stateRows, 4096));
  const before = (item: unknown) => (item as { tick: number }).tick < cutoff;
  return { id: raw.id, header: { map_name: header.map_name },
    events: raw.events.filter(before), stateRows: raw.stateRows.filter(before),
    truncated: raw.truncated === true || cutoff !== Infinity };
}
