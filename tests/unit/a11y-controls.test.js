// @vitest-environment happy-dom
// Accessibility contract of the shared controls the UI smoke's axe / tap checks
// flagged: labelled form fields, 40px mobile sizes, the Checkbox tap area, focusable
// scroll regions, and the dialogs/rows built from them. Rendered for real in happy-dom.
import { createElement as h, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Legacy .js JSX the "@/ui" barrel pulls in through the app frame; not under test.
vi.mock("@/shared/components/LanguageSwitcher", () => ({ default: () => null }));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));

const Input = (await import("@/shared/components/Input")).default;
const Select = (await import("@/shared/components/Select")).default;
const Button = (await import("@/shared/components/Button")).default;
const Toggle = (await import("@/shared/components/Toggle")).default;
const { Checkbox } = await import("@/ui/Checkbox");
const { CodeBlock } = await import("@/ui/CodeBlock");
const AddApiKeyModal = (await import("@/app/(dashboard)/dashboard/providers/[id]/AddApiKeyModal"))
  .default;
const ConnectionRow = (await import("@/app/(dashboard)/dashboard/providers/[id]/ConnectionRow"))
  .default;
const { Overview } = await import("@/app/(dashboard)/dashboard/proxy-pools/workbench/Overview");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container;
let root;
beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});
const render = (el) => act(() => root.render(el));

/** Text of a node minus aria-hidden parts (icon ligatures). */
function visibleText(node) {
  const c = node.cloneNode(true);
  for (const x of c.querySelectorAll("[aria-hidden=true]")) x.remove();
  return c.textContent.trim();
}

/** Accessible name from aria-label, a <label for>, or a wrapping <label>. */
function labelOf(el) {
  if (el.getAttribute("aria-label")) return el.getAttribute("aria-label");
  if (el.id) {
    const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (l) return visibleText(l);
  }
  const wrap = el.closest("label");
  return wrap ? visibleText(wrap) : "";
}

describe("legacy Input / Select", () => {
  it("ties the visible label to the control", () => {
    render(
      h("div", null, [
        h(Input, { key: "i", label: "Priority", type: "number", value: 1, onChange: () => {} }),
        h(Select, {
          key: "s",
          label: "Proxy Pool",
          value: "a",
          onChange: () => {},
          options: [{ value: "a", label: "A" }],
        }),
      ]),
    );
    expect(labelOf(container.querySelector("input"))).toBe("Priority");
    expect(labelOf(container.querySelector("select"))).toBe("Proxy Pool");
  });

  it("keeps a caller-supplied id", () => {
    render(h(Input, { label: "Name", id: "my-name", value: "", onChange: () => {} }));
    expect(container.querySelector("input").id).toBe("my-name");
    expect(container.querySelector("label").getAttribute("for")).toBe("my-name");
  });

  it("is 40px tall on mobile", () => {
    render(h(Input, { label: "Name", value: "", onChange: () => {} }));
    expect(container.querySelector("input").className).toContain("max-md:h-10");
  });
});

describe("legacy Button / Toggle", () => {
  it.each(["xs", "sm", "md"])("size %s is 40px tall on mobile", (size) => {
    render(h(Button, { size }, "Go"));
    expect(container.querySelector("button").className).toContain("max-md:h-10");
  });

  it("Toggle stretches its hit area past 40px without growing", () => {
    render(h(Toggle, { checked: false, onChange: () => {}, label: "Active", size: "sm" }));
    const cls = container.querySelector("[role=switch]").className;
    expect(cls).toContain("after:-inset-y-3");
    expect(cls).toContain("h-[18px]");
  });
});

describe("Checkbox", () => {
  it("bare: aria-label, hidden native input, ::after tap area", () => {
    const onChange = vi.fn();
    render(h(Checkbox, { "aria-label": "Select A", checked: false, onChange }));
    const input = container.querySelector("input[type=checkbox]");
    expect(input.getAttribute("aria-label")).toBe("Select A");
    expect(input.className).toContain("sr-only");
    expect(container.querySelector("label").className).toContain("after:-inset-3");
    act(() => input.click());
    expect(onChange).toHaveBeenCalledOnce();
  });

  it("with a caption: labelled by its text, 40px tall on mobile", () => {
    render(h(Checkbox, { label: "Select all", checked: true, onChange: () => {} }));
    expect(labelOf(container.querySelector("input"))).toBe("Select all");
    expect(container.querySelector("label").className).toContain("max-md:min-h-10");
  });
});

describe("CodeBlock", () => {
  it("makes the scrollable body keyboard-focusable and named", () => {
    render(h(CodeBlock, { title: "settings.json", text: "{}" }));
    const pre = container.querySelector("pre");
    expect(pre.tabIndex).toBe(0);
    expect(pre.getAttribute("aria-label")).toBe("settings.json");
  });

  it("takes an explicit label when the title is a node", () => {
    render(h(CodeBlock, { title: h("b", null, "x"), label: "Client request", text: "{}" }));
    expect(container.querySelector("pre").getAttribute("aria-label")).toBe("Client request");
  });
});

describe("provider add-key dialog", () => {
  it("labels every field", () => {
    render(
      h(AddApiKeyModal, {
        isOpen: true,
        provider: "openai",
        providerName: "OpenAI",
        proxyPools: [{ id: "p1", name: "Office egress" }],
        onSave: () => {},
        onClose: () => {},
      }),
    );
    const fields = document.querySelectorAll("[role=dialog] input, [role=dialog] select");
    expect(fields.length).toBeGreaterThanOrEqual(4);
    for (const f of fields) expect(labelOf(f), f.outerHTML).not.toBe("");
  });
});

describe("connection row", () => {
  it("move buttons are 40px squares on mobile", () => {
    render(
      h(ConnectionRow, {
        connection: { id: "c1", name: "Demo", isActive: true, priority: 1 },
        proxyPools: [],
        isOAuth: false,
        isFirst: false,
        isLast: false,
        onMoveUp: () => {},
        onMoveDown: () => {},
        onToggleActive: () => {},
        onUpdateProxy: () => {},
        onEdit: () => {},
        onDelete: () => {},
      }),
    );
    for (const name of ["Move up", "Move down"])
      expect(container.querySelector(`[aria-label="${name}"]`).className).toContain(
        "max-md:size-10",
      );
  });
});

describe("proxy pools overview", () => {
  it("row checkboxes are named and use the Checkbox tap area", () => {
    const pools = [
      { id: "a", name: "Office egress", proxyUrl: "http://a", isActive: true },
      { id: "b", name: "Residential EU", proxyUrl: "http://b", isActive: true },
    ];
    render(
      h(Overview, {
        api: { list: pools },
        onOpen: () => {},
        onAdd: () => {},
      }),
    );
    const boxes = [...container.querySelectorAll("input[type=checkbox]")];
    expect(boxes.map(labelOf)).toEqual(
      expect.arrayContaining(["Select Office egress", "Select Residential EU"]),
    );
    for (const b of boxes) expect(b.className).toContain("sr-only");
  });
});
