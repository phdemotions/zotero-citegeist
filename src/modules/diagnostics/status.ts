/**
 * Conditions that hold for the whole session, as opposed to failures that
 * happened once.
 *
 * The ring buffer keeps the last N failures and the settings pane can clear it.
 * A condition recorded there once at startup, such as a cache opened read-only
 * (CG-DB03), falls out of the report after enough later failures or one click
 * on Clear, while the condition itself is still in force. A line set here stays
 * in every report until the module that owns it clears it.
 *
 * Imports nothing, so the cache layer can set its line without a dependency
 * cycle. Lines are pasted into public issues: no library content, no paths.
 */

const conditions = new Map<string, string>();

/** Set the report line for `key`, or remove it with `null`. */
export function setSessionCondition(key: string, line: string | null): void {
  if (line === null) conditions.delete(key);
  else conditions.set(key, line);
}

/** Every current condition line, in the order they were first set. */
export function sessionConditions(): string[] {
  return [...conditions.values()];
}
