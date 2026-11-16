/**
 * A tiny observable for UI state that lives outside any one component tree.
 *
 * The insight page is mounted in `shell.overlay` while its open button lives in the usage
 * panel, so the two need to agree on one boolean without a shared parent. React's context
 * cannot cross those two slots because they render in different trees.
 *
 * `useValue` subscribes with `useSyncExternalStore` when it is available (React 18+) and
 * falls back to `useState` + `useEffect` otherwise, because the Host's React version is
 * not ours to pin.
 */
import * as React from 'react';

/**
 * Create a store around one value.
 *
 * `set` accepts a value or an updater, matching the `useState` call sites this replaces.
 */
export function createStore(initial) {
  let value = initial;
  const listeners = new Set();

  const get = () => value;

  const set = (next) => {
    const resolved = typeof next === 'function' ? next(value) : next;
    if (Object.is(resolved, value)) return;
    value = resolved;
    for (const listener of listeners) listener();
  };

  const subscribe = (listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  };

  return { get, set, subscribe };
}

/**
 * Subscribe a component to a store.
 *
 * Returns the current value and re-renders on change.
 */
export function useValue(store) {
  const subscribe = React.useCallback((onChange) => store.subscribe(onChange), [store]);
  const snapshot = React.useCallback(() => store.get(), [store]);

  // React 18 exposes useSyncExternalStore; older runtimes fall back below.
  if (typeof React.useSyncExternalStore === 'function') {
    return React.useSyncExternalStore(subscribe, snapshot, snapshot);
  }

  const [value, setValue] = React.useState(snapshot);
  React.useEffect(() => store.subscribe(() => setValue(store.get())), [store]);
  return value;
}

/**
 * Whether the cross-session insight page is open.
 *
 * It lives in this module rather than in `index.js` so the usage panel can toggle it
 * without importing the plugin root, which would be a circular import: the root already
 * imports the panels.
 */
export const insightOpen = createStore(false);

/**
 * The agent-family page: whether it is open and which session it belongs to.
 *
 * The session is part of the state because a family has no meaning without one; the
 * opener knows which session it was invoked from and the page lives in a different slot.
 * `sessionId` is kept after closing so reopening from the same session does not flash an
 * empty page while the read is in flight.
 */
export const fleetState = createStore({ open: false, sessionId: '' });

/** Open the family page for one session; an empty id asks the Host for the latest one. */
export function openFleet(sessionId) {
  const id = typeof sessionId === 'string' ? sessionId : '';
  fleetState.set({ open: true, sessionId: id });
}

/** Close it, keeping the last session so a reopen reuses it immediately. */
export function closeFleet() {
  fleetState.set((current) => ({ ...current, open: false }));
}

