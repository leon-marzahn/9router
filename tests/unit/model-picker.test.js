// @vitest-environment happy-dom
// ModelPicker: filtering / grouping / recent logic, keyboard navigation, and the
// Playground helpers that feed it (picker groups, stored recents, keyboard inset).
import { act, createElement as h, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@/shared/components/ProviderIcon", () => ({ default: () => null }));

const { buildPickerSections, filterModelGroups, moveActive, optionKeys, pushRecent } =
  await import("@/ui/modelPickerLogic");
const { ModelPicker } = await import("@/ui/ModelPicker");
const { getProviderLabel, keyboardInset, parseRecentModels, toPickerGroups } = await import(
  "@/app/(dashboard)/dashboard/basic-chat/workbench/chat"
);

const { useKeyboardInset, useRecentModels } = await import(
  "@/app/(dashboard)/dashboard/basic-chat/workbench/hooks"
);

const GROUPS = [
  {
    providerId: "anthropic",
    providerName: "Anthropic",
    models: [
      { id: "claude/opus", name: "Claude Opus", detail: "claude/opus" },
      { id: "claude/haiku", name: "Claude Haiku" },
    ],
  },
  {
    providerId: "openai",
    providerName: "OpenAI",
    models: [
      { id: "openai/gpt-5", name: "GPT-5" },
      { id: "openai/gpt-5-mini", name: "GPT-5 mini" },
    ],
  },
  { providerId: "empty", providerName: "Empty", models: [] },
];

describe("filterModelGroups", () => {
  it("keeps every non-empty group in order when the query is blank", () => {
    expect(filterModelGroups(GROUPS, "  ").map((g) => g.providerId)).toEqual([
      "anthropic",
      "openai",
    ]);
  });

  it("matches the model name case-insensitively and drops groups without matches", () => {
    const out = filterModelGroups(GROUPS, "HAIKU");
    expect(out).toHaveLength(1);
    expect(out[0].providerName).toBe("Anthropic");
    expect(out[0].models.map((m) => m.id)).toEqual(["claude/haiku"]);
  });

  it("matches the model id", () => {
    expect(filterModelGroups(GROUPS, "gpt-5-mini")[0].models.map((m) => m.id)).toEqual([
      "openai/gpt-5-mini",
    ]);
  });

  it("requires every term, and a provider-name term keeps that provider's models", () => {
    expect(filterModelGroups(GROUPS, "openai mini")[0].models.map((m) => m.id)).toEqual([
      "openai/gpt-5-mini",
    ]);
    expect(filterModelGroups(GROUPS, "anthropic")[0].models).toHaveLength(2);
    expect(filterModelGroups(GROUPS, "nothing-like-this")).toEqual([]);
  });
});

describe("buildPickerSections", () => {
  it("groups by provider with the provider display name as the header", () => {
    const s = buildPickerSections(GROUPS, "");
    expect(s.map((x) => [x.title, x.models.length])).toEqual([
      ["Anthropic", 2],
      ["OpenAI", 2],
    ]);
    expect(s[1].models[0]).toMatchObject({ providerId: "openai", providerName: "OpenAI" });
  });

  it("puts recent models first, skipping unknown ids, but not while searching", () => {
    const recent = ["openai/gpt-5", "gone/model", "claude/haiku"];
    const s = buildPickerSections(GROUPS, "", recent);
    expect(s[0].title).toBe("Recent");
    expect(s[0].models.map((m) => m.id)).toEqual(["openai/gpt-5", "claude/haiku"]);
    expect(buildPickerSections(GROUPS, "gpt", recent).map((x) => x.title)).toEqual(["OpenAI"]);
    expect(buildPickerSections(GROUPS, "", ["gone"]).map((x) => x.title)).toEqual([
      "Anthropic",
      "OpenAI",
    ]);
  });

  it("gives each option a unique key even when a model is listed twice", () => {
    const keys = optionKeys(buildPickerSections(GROUPS, "", ["claude/opus"]));
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys[0]).toBe("__recent::claude/opus");
  });
});

describe("pushRecent / moveActive", () => {
  it("moves the id to the front, dedupes and caps", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["a", "b"], "c", 2)).toEqual(["c", "a"]);
  });

  it("wraps arrows and handles Home/End and other keys", () => {
    expect(moveActive("ArrowDown", -1, 3)).toBe(0);
    expect(moveActive("ArrowDown", 2, 3)).toBe(0);
    expect(moveActive("ArrowUp", 0, 3)).toBe(2);
    expect(moveActive("ArrowUp", 2, 3)).toBe(1);
    expect(moveActive("Home", 2, 3)).toBe(0);
    expect(moveActive("End", 0, 3)).toBe(2);
    expect(moveActive("a", 0, 3)).toBeNull();
    expect(moveActive("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("Playground helpers", () => {
  it("maps provider groups to picker groups with the request model as detail", () => {
    const out = toPickerGroups([
      {
        providerId: "p",
        providerName: "P",
        providerType: "p",
        connections: [],
        models: [{ id: "p/m", requestModel: "p/m", name: "M", providerId: "p", providerName: "P" }],
      },
    ]);
    expect(out).toEqual([
      { providerId: "p", providerName: "P", models: [{ id: "p/m", name: "M", detail: "p/m" }] },
    ]);
  });

  it("labels groups with the provider's display name, not the account name", () => {
    expect(getProviderLabel({ id: "c1", provider: "openai", name: "ada@example.com" })).toBe(
      "OpenAI",
    );
    expect(
      getProviderLabel({
        id: "c2",
        provider: "openai-compatible-x",
        name: "Account 1",
        providerSpecificData: { nodeName: "My Node" },
      }),
    ).toBe("My Node");
    expect(getProviderLabel({ id: "c3", provider: "unknown-thing", name: "Acct" })).toBe("Acct");
  });

  it("reads stored recents defensively", () => {
    expect(parseRecentModels('["a",1,"b"]')).toEqual(["a", "b"]);
    expect(parseRecentModels("{}")).toEqual([]);
    expect(parseRecentModels("not json")).toEqual([]);
    expect(parseRecentModels(null)).toEqual([]);
  });

  it("measures the keyboard only when it really covers the layout viewport", () => {
    expect(keyboardInset(800, { height: 450, offsetTop: 0, scale: 1 })).toBe(350);
    expect(keyboardInset(800, { height: 450, offsetTop: 100, scale: 1 })).toBe(250);
    expect(keyboardInset(800, { height: 760, offsetTop: 0, scale: 1 })).toBe(0);
    expect(keyboardInset(800, { height: 400, offsetTop: 0, scale: 2 })).toBe(0);
  });
});

describe("Playground hooks", () => {
  let root;
  let host;
  afterEach(() => {
    void act(() => root?.unmount());
    host?.remove();
    localStorage.clear();
  });
  function mount(useHook) {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    const out = { current: null };
    function Probe() {
      const value = useHook();
      useEffect(() => {
        out.current = value;
      });
      return null;
    }
    host = document.createElement("div");
    root = createRoot(host);
    void act(() => root.render(h(Probe)));
    return out;
  }

  it("remembers recently picked models in localStorage", () => {
    localStorage.setItem("basic-chat.recentModels", JSON.stringify(["a"]));
    const out = mount(useRecentModels);
    expect(out.current[0]).toEqual(["a"]);
    void act(() => out.current[1]("b"));
    expect(out.current[0]).toEqual(["b", "a"]);
    expect(JSON.parse(localStorage.getItem("basic-chat.recentModels"))).toEqual(["b", "a"]);
  });

  it("follows the visual viewport for the keyboard inset", () => {
    const listeners = {};
    const vv = {
      height: 800,
      offsetTop: 0,
      scale: 1,
      addEventListener: (t, f) => (listeners[t] = f),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal("visualViewport", vv);
    vi.stubGlobal("innerHeight", 800);
    try {
      const out = mount(useKeyboardInset);
      expect(out.current).toBe(0);
      vv.height = 450;
      void act(() => listeners.resize());
      expect(out.current).toBe(350);
      void act(() => root.unmount());
      root = null;
      expect(vv.removeEventListener).toHaveBeenCalledTimes(2);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("<ModelPicker>", () => {
  let root;
  let host;
  afterEach(() => {
    void act(() => root?.unmount());
    host?.remove();
  });

  function render(props) {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    void act(() => root.render(h(ModelPicker, { groups: GROUPS, ...props })));
  }
  const input = () => document.querySelector("[role=dialog] input");
  const type = (value) =>
    void act(() => {
      const el = input();
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    });
  const key = (k) =>
    void act(() => input().dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true })));

  it("shows the current model, filters, and picks with the keyboard", () => {
    const onChange = vi.fn();
    render({ value: "claude/haiku", onChange, recent: ["openai/gpt-5"] });
    const trigger = host.querySelector("[data-model-picker]");
    expect(trigger.textContent).toContain("Claude Haiku");
    void act(() => trigger.click());

    const headers = [...document.querySelectorAll("[role=group]")].map(
      (g) => g.firstElementChild.textContent,
    );
    expect(headers).toEqual(["historyRecent1", "Anthropic2", "OpenAI2"]);
    // starts on the current model
    expect(document.querySelector('[role=option][aria-selected="true"]').textContent).toContain(
      "Claude Haiku",
    );

    type("gpt");
    expect([...document.querySelectorAll("[role=option]")].map((o) => o.textContent)).toEqual([
      "GPT-5",
      "GPT-5 mini",
    ]);
    key("ArrowDown");
    expect(input().getAttribute("aria-activedescendant")).toBe(
      document.querySelectorAll("[role=option]")[1].id,
    );
    key("Enter");
    expect(onChange).toHaveBeenCalledWith("openai/gpt-5-mini");
    expect(document.querySelector("[role=dialog]")).toBeNull();
  });

  it("says when nothing matches and picks on click", () => {
    const onChange = vi.fn();
    render({ value: null, onChange });
    expect(host.querySelector("[data-model-picker]").textContent).toContain("Select model");
    void act(() => host.querySelector("[data-model-picker]").click());
    type("zzz");
    expect(document.querySelector("[role=dialog]").textContent).toContain("No models match.");
    key("Enter");
    expect(onChange).not.toHaveBeenCalled();
    type("");
    void act(() => document.querySelectorAll("[role=option]")[0].click());
    expect(onChange).toHaveBeenCalledWith("claude/opus");
  });
});
