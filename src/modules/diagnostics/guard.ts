/**
 * Error boundaries for host entry points.
 *
 * Zotero calls into the plugin through callbacks it registers — pane renderers,
 * section buttons, the column data provider, menu commands, dialog handlers.
 * Zotero does nothing useful with an exception from any of them: a rejected
 * `onAsyncRender` leaves the loading spinner up forever, a throwing
 * `dataProvider` blanks a column, a throwing menu command does nothing at all.
 * In every case the user sees an app that hung, with no error and nothing to
 * report — which is exactly the failure that made the existing bug reports
 * undiagnosable.
 *
 * So: **every function Zotero calls is wrapped here.** That rule is machine-
 * checked by `test/diagnostics-guard-invariants.test.ts`, so a new entry point
 * cannot ship unguarded.
 */

import { codeForError, logError } from "../utils";
import type { DiagnosticCode } from "./codes";

/**
 * What a guarded entry point does after a failure. Receives the diagnostic
 * code so the caller can render a coded state; the failure is already logged
 * and recorded by the time this runs.
 */
export type GuardFallback = (code: DiagnosticCode) => void;

/**
 * Wrap a synchronous host callback.
 *
 * `label` is the call-site name that lands in the diagnostic report — make it
 * the thing you'd want to read in a bug report ("column dataProvider"), not the
 * function's identifier.
 */
export function guard<T>(label: string, fn: () => T, onError?: GuardFallback): T | undefined {
  try {
    return fn();
  } catch (e) {
    handle(label, e, onError);
    return undefined;
  }
}

/** Wrap an async host callback. Resolves to `undefined` on failure. */
export async function guardAsync<T>(
  label: string,
  fn: () => Promise<T>,
  onError?: GuardFallback,
): Promise<T | undefined> {
  try {
    return await fn();
  } catch (e) {
    handle(label, e, onError);
    return undefined;
  }
}

/**
 * Attach a DOM listener whose handler is wrapped in a boundary.
 *
 * A throw inside a listener never reaches the code that attached it — the
 * browser logs it somewhere the user will never look and the click simply does
 * nothing. In a modal like the citation-network dialog that reads as a frozen
 * UI. Handlers may be sync or async; a rejected promise is caught too, which a
 * bare `addEventListener` silently drops.
 *
 * `target` is nullable so call sites can pass a `querySelector` result
 * directly; a missing element is a no-op, matching `el?.addEventListener(…)`.
 */
export function bindGuarded(
  target: EventTarget | null | undefined,
  type: string,
  label: string,
  handler: (event: Event) => void | Promise<void>,
  options?: AddEventListenerOptions | boolean,
): void {
  if (!target) return;
  target.addEventListener(
    type,
    (event: Event) => {
      try {
        const result = handler(event);
        if (result && typeof (result as Promise<void>).catch === "function") {
          (result as Promise<void>).catch((e: unknown) => handle(label, e));
        }
      } catch (e) {
        handle(label, e);
      }
    },
    options,
  );
}

function handle(label: string, e: unknown, onError?: GuardFallback): void {
  logError(label, e);
  if (!onError) return;
  try {
    onError(codeForError(e));
  } catch (fallbackError) {
    // The fallback renderer itself failed. Log and swallow: re-throwing here
    // would put the exception back into the host callback the guard exists to
    // protect, defeating the entire point.
    logError(`${label} fallback`, fallbackError);
  }
}
