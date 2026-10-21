// @vitest-environment happy-dom
// One initial-focus rule for every Dialog: the first field with a mouse/trackpad
// ((hover: hover) and (pointer: fine)), the dialog itself on touch so no keyboard
// pops over the bottom sheet. matchMedia is mocked per case.
import { createElement as h, act } from "react";
import { createRoot } from "react-dom/client";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

const { Dialog, ConfirmDialog, fieldAutofocus } = await import("@/ui/Dialog");
const { BudgetDialog } = await import("@/ui/budget/Budget");
const { Input, Field } = await import("@/ui/Field");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container;
let root;

const setPointer = (fine) => {
  window.matchMedia = (q) => ({
    matches: fine && q === "(hover: hover) and (pointer: fine)",
    media: q,
    addEventListener() {},
    removeEventListener() {},
  });
};
const render = async (el) => act(async () => root.render(el));
const panel = () => document.querySelector("[role=dialog]");

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const budget = () =>
  h(BudgetDialog, {
    title: "Budget",
    initial: null,
    forKey: true,
    onClose() {},
    onSave: async () => {},
  });

describe("fieldAutofocus", () => {
  it("is true only for hover + fine pointer, false when matchMedia is missing", () => {
    setPointer(true);
    expect(fieldAutofocus()).toBe(true);
    setPointer(false);
    expect(fieldAutofocus()).toBe(false);
    window.matchMedia = undefined;
    expect(fieldAutofocus()).toBe(false);
  });
});

describe("Dialog initial focus", () => {
  it("desktop: the key budget dialog focuses its first text field, not the period toggle", async () => {
    setPointer(true);
    await render(budget());
    const active = document.activeElement;
    expect(active.tagName).toBe("INPUT");
    expect(active.getAttribute("placeholder")).toBe("50");
  });

  it("touch: the key budget dialog focuses the dialog itself", async () => {
    setPointer(false);
    await render(budget());
    expect(document.activeElement).toBe(panel());
  });

  it("touch: a data-autofocus text field is not focused either", async () => {
    setPointer(false);
    await render(
      h(Dialog, { open: true, onClose() {}, title: "T" }, h(Field, { label: "Name" }, h(Input, { "data-autofocus": true }))),
    );
    expect(document.activeElement).toBe(panel());
  });

  it("desktop: data-autofocus wins over the first field", async () => {
    setPointer(true);
    await render(
      h(
        Dialog,
        { open: true, onClose() {}, title: "T" },
        h(Input, { placeholder: "first" }),
        h(Input, { placeholder: "second", "data-autofocus": true }),
      ),
    );
    expect(document.activeElement.getAttribute("placeholder")).toBe("second");
  });

  it("touch: a non-text data-autofocus target (ConfirmDialog's Cancel) keeps focus", async () => {
    setPointer(false);
    await render(
      h(ConfirmDialog, { open: true, onClose() {}, onConfirm() {}, title: "Sure?", message: "m" }),
    );
    expect(document.activeElement.textContent).toBe("Cancel");
  });
});

describe("no dialog bypasses the rule with autoFocus", () => {
  it("dashboard pages and src/ui use data-autofocus, not the autoFocus prop", () => {
    const roots = ["src/ui", "src/app/(dashboard)", "src/shared/components"];
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/\.(jsx?|tsx?)$/.test(e.name) && /\sautoFocus(?=[\s=/>])/.test(fs.readFileSync(p, "utf8")))
          hits.push(p);
      }
    };
    for (const r of roots) walk(path.resolve(import.meta.dirname, "../..", r));
    expect(hits).toEqual([]);
  });
});
