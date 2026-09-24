/**
 * The id of the rem currently being dragged. Held in a module variable rather
 * than state because `dragover` can't read `dataTransfer` for security reasons
 * -- the browser only exposes the payload on `drop`, and we need to know what's
 * being dragged in order to draw the drop indicator.
 */
let draggingId: string | null = null;

export function draggingRemId(): string | null {
  return draggingId;
}

export function setDraggingRemId(id: string | null): void {
  draggingId = id;
}
