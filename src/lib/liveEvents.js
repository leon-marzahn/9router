import { EventEmitter } from "node:events";

/**
 * In-process "something changed" bus for dashboard live updates.
 * Events carry only a topic name — never data. Clients refetch through the
 * normal (authenticated, sanitized) API, so secrets can't leak via the stream.
 * Kept on globalThis so Next's per-route module instances share one bus.
 */
const KEY = Symbol.for("9router.liveEvents");
const bus = globalThis[KEY] ?? (globalThis[KEY] = new EventEmitter());
bus.setMaxListeners(100);

export const LIVE_TOPICS = ["providers"];

export function emitLive(topic) {
  try {
    bus.emit(topic);
  } catch {
    // listeners must never break a DB write
  }
}

export function onLive(topic, fn) {
  bus.on(topic, fn);
  return () => bus.off(topic, fn);
}
