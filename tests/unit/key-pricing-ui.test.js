// @vitest-environment happy-dom
// Per-key pricing UI: the plan editor (fields, rates, how rates resolve, save / delete /
// errors), the key card's plan picker, Settings → Customer pricing, the Usage "By key"
// panel and the budget meter wording. Rendered for real in happy-dom; fetch is mocked.
import { createElement as h } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("@/app/(dashboard)/dashboard/profile/settings/useSettings", () => ({
  notify: () => toast,
}));
vi.mock("@/shared/components", () => ({ ModelSelectModal: () => null }));
// Legacy .js JSX the app frame pulls in through "@/ui"; not under test here.
vi.mock("@/shared/components/LanguageSwitcher", () => ({ default: () => null }));
vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));

const { PlanEditor, PlanDialog, planSummary, usePricePlans } = await import(
  "@/ui/pricing/PricePlan"
);
const { KeyCard } = await import("@/app/(dashboard)/dashboard/endpoint/gatehouse/KeyCard");
const { PricePlans } = await import("@/app/(dashboard)/dashboard/profile/settings/PricePlans");
const { ByKey } = await import("@/app/(dashboard)/dashboard/usage/live/LiveTraffic");
const { keyRows } = await import("@/app/(dashboard)/dashboard/usage/live/useUsage");
const { BudgetMeter } = await import("@/ui/budget/Budget");

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
let container;
let root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  toast.success.mockClear();
  toast.error.mockClear();
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

const render = (el) => act(async () => root.render(el));
const flush = () => act(async () => new Promise((r) => setTimeout(r, 5)));
const all = (sel) => [...document.body.querySelectorAll(sel)];
// Button labels are followed by their icon's ligature name ("Save plansave").
const labelIs = (b, text) => {
  const t = b.textContent.trim();
  return t === text || (t.startsWith(text) && /^[a-z_]+$/.test(t.slice(text.length)));
};
const button = (text, scope = "") => all(`${scope} button`).find((b) => labelIs(b, text));
const byLabel = (label) => document.body.querySelector(`[aria-label="${label}"]`);
const fieldInput = (label) =>
  all("label").find((l) => l.textContent.startsWith(label))?.querySelector("input");

async function type(input, value) {
  const setter = Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(input),
    "value",
  ).set;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function select(el, value) {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
  await act(async () => {
    setter.call(el, value);
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
const click = (el) => act(async () => el.click());

const PRO = {
  name: "Pro",
  markupPercent: 15,
  minFee: 0.002,
  rates: [{ model: "real/fake-1", input: 1, output: 2, cached: null }],
};

describe("planSummary", () => {
  it("describes markup, minimum fee and rates", () => {
    expect(planSummary({ name: "D", markupPercent: 0, minFee: null, rates: [] })).toBe("At cost");
    expect(planSummary(PRO)).toMatch(/^\+15% over cost · min \$0\.002 \/ request · 1 custom rate$/);
    expect(planSummary({ ...PRO, rates: [PRO.rates[0], PRO.rates[0]] })).toMatch(/2 custom rates/);
  });
});

describe("PlanEditor", () => {
  it("edits fields and rates, shows how rates resolve, and saves the parsed plan", async () => {
    const onSave = vi.fn(async () => {});
    await render(
      h(PlanEditor, {
        initial: PRO,
        resolved: { "real/fake-1": "Real upstream", "bare-1": null },
        onSave,
      }),
    );
    expect(document.body.textContent).toContain("Only via Real upstream");

    await type(fieldInput("Name"), "Pro 2");
    await type(fieldInput("Markup"), "25%");
    await type(fieldInput("Minimum"), "");
    await click(button("Add rate…"));
    const models = all('input[aria-label="Model"]');
    expect(models).toHaveLength(2);
    await type(models[1], "bare-1");
    expect(document.body.textContent).toContain("Bare model id: any provider");
    const inputs = all('input[aria-label="input price per 1M"]');
    const outputs = all('input[aria-label="output price per 1M"]');
    await type(inputs[1], "$3");
    await type(outputs[1], "4");
    await click(button("Add rate…"));
    await type(all('input[aria-label="Model"]')[2], "x/y");
    expect(document.body.textContent).toContain("Checked when saved");
    await click(byLabel("Remove x/y"));

    await click(button("Save plan"));
    expect(onSave).toHaveBeenCalledWith({
      name: "Pro 2",
      markupPercent: 25,
      minFee: null,
      rates: [
        { model: "real/fake-1", input: 1, output: 2, cached: null },
        { model: "bare-1", input: 3, output: 4, cached: null },
      ],
    });
  });

  it("shows the server's error and supports a fixed name, cancel and delete", async () => {
    const onSave = vi.fn(async () => {
      throw new Error("Give the plan a name");
    });
    const onRemove = vi.fn(async () => {});
    const onCancel = vi.fn();
    await render(
      h(PlanEditor, { initial: null, fixedName: "Default", onSave, onRemove, onCancel }),
    );
    expect(fieldInput("Name")).toBeUndefined();
    await click(button("Save plan"));
    expect(document.body.textContent).toContain("Give the plan a name");
    expect(onSave.mock.calls[0][0].name).toBe("Default");
    await click(button("Cancel"));
    expect(onCancel).toHaveBeenCalled();
    await click(button("Delete plan"));
    await flush();
    expect(onRemove).toHaveBeenCalled();
  });

  it("PlanDialog closes after a save or a delete", async () => {
    const onClose = vi.fn();
    const onSave = vi.fn(async () => {});
    const onRemove = vi.fn(async () => {});
    await render(h(PlanDialog, { title: "Plan", initial: PRO, onClose, onSave, onRemove }));
    await click(button("Save plan"));
    expect(onSave).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await click(button("Delete plan"));
    await flush();
    expect(onRemove).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

/** Fetch mock for the plan routes; records calls. */
function mockApi(list) {
  const calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url, init = {}) => {
      calls.push([String(url), init.method || "GET", init.body ? JSON.parse(init.body) : null]);
      const body = init.method === "POST" ? { id: "plan_new" } : init.method ? { ok: 1 } : list;
      return new Response(JSON.stringify(body), { status: 200 });
    }),
  );
  return calls;
}

describe("usePricePlans", () => {
  it("falls back to an empty list when loading fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 500 })),
    );
    const Probe = () => {
      const { list } = usePricePlans();
      return h("pre", null, JSON.stringify(list));
    };
    await render(h(Probe));
    await flush();
    expect(JSON.parse(container.textContent)).toEqual({ plans: {}, keyPlans: {}, resolved: {} });
  });
});

describe("KeyCard price plan", () => {
  const key = {
    id: "k1",
    name: "Acme",
    key: "sk-test-0000000000",
    isActive: true,
    createdAt: "2026-01-01T00:00:00Z",
    access: { restricted: false, allow: [] },
  };
  const plans = { default: { ...PRO, name: "Default", rates: [] }, plan_pro: PRO };
  const props = (over) => ({
    k: key,
    onActive: vi.fn(),
    onAccess: vi.fn(),
    onDelete: vi.fn(),
    confirm: vi.fn(),
    onBudgetSave: vi.fn(async () => {}),
    onBudgetRemove: vi.fn(async () => {}),
    plans,
    resolved: {},
    planId: "plan_pro",
    onPlanAssign: vi.fn(async () => {}),
    onPlanSave: vi.fn(async () => "plan_new"),
    ...over,
  });

  it("assigns a plan, edits the current one, and creates + assigns a new one", async () => {
    const p = props();
    await render(h(KeyCard, p));
    expect(document.body.textContent).toContain("+15% over cost");
    const picker = byLabel("Price plan for Acme");
    await select(picker, "default");
    expect(p.onPlanAssign).toHaveBeenCalledWith("default");

    await click(button("Edit plan"));
    expect(document.body.textContent).toContain('Plan "Pro"');
    await click(button("Save plan"));
    expect(p.onPlanSave).toHaveBeenCalledWith("plan_pro", expect.objectContaining({ name: "Pro" }));

    await select(picker, "__new");
    expect(document.body.textContent).toContain('New plan for "Acme"');
    await type(fieldInput("Name"), "Acme special");
    await click(button("Save plan"));
    await flush();
    expect(p.onPlanSave).toHaveBeenLastCalledWith(null, expect.objectContaining({ name: "Acme special" }));
    expect(p.onPlanAssign).toHaveBeenLastCalledWith("plan_new");
  });

  it("edits the default plan under its fixed name, and waits while plans load", async () => {
    await render(h(KeyCard, props({ planId: "default" })));
    await click(button("Edit plan"));
    expect(document.body.textContent).toContain("Applies to every key without a plan");
    await render(h(KeyCard, props({ plans: null })));
    expect(byLabel("Price plan for Acme").disabled).toBe(true);
  });
});

describe("Settings → Customer pricing", () => {
  const list = {
    plans: { default: { name: "Default", markupPercent: 0, minFee: null, rates: [] }, plan_pro: PRO },
    keyPlans: { k1: "plan_pro", k2: "plan_pro" },
    resolved: { "real/fake-1": "Real upstream" },
  };

  it("saves the default plan, creates, edits and deletes named plans", async () => {
    const calls = mockApi(list);
    await render(h(PricePlans));
    await flush();
    expect(document.body.textContent).toContain("2 keys");

    await type(fieldInput("Markup"), "20");
    await click(button("Save default plan"));
    await flush();
    expect(calls).toContainEqual([
      "/api/pricing/plans/default",
      "PUT",
      { name: "Default", markupPercent: 20, minFee: null, rates: [] },
    ]);
    expect(toast.success).toHaveBeenCalledWith("Default plan saved");

    await click(button("New plan"));
    const dialog = document.body.querySelector("[role=dialog]");
    await type(dialog.querySelector("input"), "Starter");
    await click(button("Save plan", "[role=dialog]"));
    await flush();
    expect(calls.some(([u, m, b]) => u === "/api/pricing/plans" && m === "POST" && b.name === "Starter")).toBe(true);

    await click(button("Edit"));
    await click(button("Save plan", "[role=dialog]"));
    await flush();
    expect(calls.some(([u, m]) => u === "/api/pricing/plans/plan_pro" && m === "PUT")).toBe(true);

    await click(button("Delete"));
    expect(document.body.textContent).toContain("2 keys move to the default plan");
    await click(button("Delete plan", "[role=dialog]"));
    await flush();
    expect(calls.some(([u, m]) => u === "/api/pricing/plans/plan_pro" && m === "DELETE")).toBe(true);
    expect(toast.success).toHaveBeenCalledWith("Plan deleted");
  });

  it("says when there are no named plans", async () => {
    mockApi({ plans: { default: list.plans.default }, keyPlans: {}, resolved: {} });
    await render(h(PricePlans));
    await flush();
    expect(document.body.textContent).toContain("No plans yet.");
  });
});

describe("Usage → By key", () => {
  it("folds per-model buckets per key, skips local, and falls back to cost", () => {
    const rows = keyRows({
      "local-no-key": { requests: 9, cost: 9, charge: 9 },
      "a|m1": { keyId: "k1", keyName: "Acme", requests: 2, cost: 1, charge: 2 },
      "a|m2": { keyId: "k1", keyName: "Acme", requests: 1, cost: 1, charge: 1 },
      "b|m1": { keyName: "Old", requests: 1, cost: 4 },
    });
    expect(rows).toEqual([
      { key: "Old", name: "Old", requests: 1, cost: 4, charge: 4 },
      { key: "k1", name: "Acme", requests: 3, cost: 2, charge: 3 },
    ]);
  });

  it("shows charged, cost and margin (negative in red) and expands past five keys", async () => {
    const rows = Array.from({ length: 6 }, (_, i) => ({
      key: `k${i}`,
      name: `Key ${i}`,
      requests: 1,
      cost: 2,
      charge: i === 0 ? 1 : 3,
    }));
    await render(h(ByKey, { rows }));
    expect(document.body.textContent).toContain("−$1.00");
    expect(document.body.textContent).not.toContain("Key 5");
    await click(button("All 6 keys"));
    expect(document.body.textContent).toContain("Key 5");
    await click(button("Show less"));
    expect(document.body.textContent).not.toContain("Key 5");
  });
});

describe("budget meter", () => {
  it("measures a key's limit on what it was charged", async () => {
    await render(
      h(BudgetMeter, {
        entry: {
          budget: { enabled: true, period: "month", spendLimit: 10, tokenLimit: null, requestLimit: null, warnAt: [], hardStop: false, contactEmail: "" },
          status: {
            periodStart: "2026-10-01T00:00:00Z",
            resetsAt: "2026-11-01T00:00:00Z",
            cost: 2,
            charge: 4,
            spend: 4,
            spendBasis: "charge",
            tokens: 0,
            requests: 1,
            ratio: 0.4,
            state: "ok",
            blocked: false,
          },
        },
      }),
    );
    expect(document.body.textContent).toMatch(/\$4\.00 of \$10\.00 charged/);
  });
});
