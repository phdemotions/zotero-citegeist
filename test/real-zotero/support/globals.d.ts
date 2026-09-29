/**
 * Globals in the chrome window where scaffold runs the real-Zotero specs:
 * Mocha's BDD interface, chai's `expect`, and the Zotero and Gecko host objects.
 *
 * Declarations only. esbuild bundles the specs without type-checking them, and
 * `npm run typecheck` covers src/ alone, so these exist to keep editors and
 * ESLint quiet. The host objects ship no types, hence `any`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
type MochaCallback = (this: any) => void | Promise<void>;

declare function describe(title: string, fn: (this: any) => void): void;
declare function it(title: string, fn: MochaCallback): void;
declare function before(fn: MochaCallback): void;
declare function after(fn: MochaCallback): void;
declare function beforeEach(fn: MochaCallback): void;
declare function afterEach(fn: MochaCallback): void;
declare const expect: any;

declare const Zotero: any;
declare const Services: any;
declare const ChromeUtils: any;
declare const Components: any;
declare const IOUtils: any;
declare const PathUtils: any;
