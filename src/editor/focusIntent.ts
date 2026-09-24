/**
 * Where the cursor should land when a rem is asked to take focus.
 *
 * `onFocusRequest(id)` only says *which* rem. Most requests want the end of
 * it (a new bullet, a revealed search hit), but arrowing down into the next
 * rem wants its start. Rather than widening a callback threaded through every
 * row, the few callers that care leave a note here first.
 */
export type FocusPlace = 'start' | 'end';

const intents = new Map<string, FocusPlace>();

export function setFocusIntent(nodeId: string, place: FocusPlace): void {
  intents.set(nodeId, place);
}

/** Read and forget the intent for a rem; 'end' when nobody said. */
export function takeFocusIntent(nodeId: string): FocusPlace {
  const place = intents.get(nodeId) ?? 'end';
  intents.delete(nodeId);
  return place;
}
