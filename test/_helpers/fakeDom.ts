/**
 * A small DOM for rendering the item pane under vitest's node environment.
 *
 * It implements what citationPane.ts and diagnostics/surface.ts call and no
 * more: element creation, text, classes, attributes, children, selectors made
 * of one tag and/or `.class`/`#id` parts with no spaces, and click listeners.
 * Setting `innerHTML` keeps only the text, which is all a test reads back from
 * the pane's plain empty-state markup. An unsupported selector throws, so a
 * pane change that outgrows the fake fails loudly instead of matching nothing.
 */

type Listener = (event: { preventDefault(): void }) => unknown;

export class FakeElement {
  className = "";
  id = "";
  type = "";
  title = "";
  disabled = false;
  readonly style: Record<string, string> = {};
  readonly childNodes: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  private ownText = "";
  private readonly attributes = new Map<string, string>();
  private readonly listeners = new Map<string, Listener[]>();

  constructor(
    readonly ownerDocument: FakeDocument,
    readonly tagName: string,
  ) {}

  get textContent(): string {
    return this.ownText + this.childNodes.map((child) => child.textContent).join("");
  }

  set textContent(value: string) {
    for (const child of [...this.childNodes]) child.remove();
    this.ownText = value;
  }

  get innerHTML(): string {
    return this.textContent;
  }

  set innerHTML(markup: string) {
    this.textContent = markup.replace(/<[^>]*>/g, "");
  }

  appendChild<T extends FakeElement>(child: T): T {
    child.remove();
    child.parentElement = this;
    this.childNodes.push(child);
    return child;
  }

  remove(): void {
    const parent = this.parentElement;
    if (!parent) return;
    parent.childNodes.splice(parent.childNodes.indexOf(this), 1);
    this.parentElement = null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, String(value));
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name: string): boolean {
    return this.attributes.has(name);
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
  }

  addEventListener(type: string, listener: Listener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  /** Fire `click` and resolve once every listener, sync or async, has settled. */
  async click(): Promise<void> {
    const results = (this.listeners.get("click") ?? []).map((listener) =>
      listener({ preventDefault() {} }),
    );
    await Promise.all(results);
  }

  matches(selector: string): boolean {
    const parsed = /^([a-z][\w-]*)?((?:[.#][\w-]+)*)$/i.exec(selector.trim());
    if (!parsed) throw new Error(`fakeDom: unsupported selector "${selector}"`);
    const [, tag, parts] = parsed;
    if (tag && tag.toLowerCase() !== this.tagName.toLowerCase()) return false;
    const classes = this.className.split(/\s+/);
    for (const part of parts.match(/[.#][\w-]+/g) ?? []) {
      if (part.startsWith(".") && !classes.includes(part.slice(1))) return false;
      if (part.startsWith("#") && this.id !== part.slice(1)) return false;
    }
    return true;
  }

  querySelectorAll(selector: string): FakeElement[] {
    const found: FakeElement[] = [];
    const visit = (element: FakeElement): void => {
      for (const child of element.childNodes) {
        if (child.matches(selector)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

export class FakeDocument {
  /** Timers never fire: the copy-feedback revert is not under test. */
  readonly defaultView = { setTimeout: (): number => 0 };

  createElement(tagName: string): FakeElement {
    return new FakeElement(this, tagName);
  }

  createTextNode(text: string): FakeElement {
    const node = new FakeElement(this, "#text");
    node.textContent = text;
    return node;
  }
}
