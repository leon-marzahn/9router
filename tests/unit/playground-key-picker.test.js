// Pure logic of the Playground key picker (basic-chat/workbench/playgroundKeys.ts):
// placeholder → real id swap, re-filtering on key switch, deleted keys falling back to
// the Playground key, no sending without a loaded list, and no secret in key state.
import { describe, expect, it } from "vite-plus/test";
import {
  PLAYGROUND_KEY_ID,
  allowedFor,
  billsAnotherKey,
  filterGroups,
  parseKeys,
  requestModelIds,
  resolveKeyId,
} from "@/app/(dashboard)/dashboard/basic-chat/workbench/playgroundKeys";

const key = (id, extra = {}) => ({
  id,
  name: id,
  isActive: true,
  restricted: false,
  playground: false,
  ...extra,
});
const groups = [
  {
    providerId: "p1",
    providerName: "P1",
    providerType: "p1",
    connections: [],
    models: [
      {
        id: "p1/a",
        requestModel: "p1/a",
        name: "a",
        providerId: "p1",
        providerName: "P1",
        source: "static",
      },
      {
        id: "p1/b",
        requestModel: "p1/b",
        name: "b",
        providerId: "p1",
        providerName: "P1",
        source: "static",
      },
    ],
  },
  {
    providerId: "p2",
    providerName: "P2",
    providerType: "p2",
    connections: [],
    models: [
      {
        id: "p2/c",
        requestModel: "p2/c",
        name: "c",
        providerId: "p2",
        providerName: "P2",
        source: "live",
      },
    ],
  },
];

describe("resolveKeyId", () => {
  it("is null until the list loads, or when it failed: nothing is sent", () => {
    expect(resolveKeyId(null, "k1")).toBeNull();
    expect(resolveKeyId(parseKeys(null), "")).toBeNull();
    expect(resolveKeyId(parseKeys({ error: "x" }), "")).toBeNull();
  });

  it("swaps the placeholder for the real Playground id once it exists", () => {
    const before = [key(PLAYGROUND_KEY_ID, { playground: true }), key("k1")];
    expect(resolveKeyId(before, PLAYGROUND_KEY_ID)).toBe(PLAYGROUND_KEY_ID);
    const after = [key("k1"), key("real-pg", { playground: true })];
    expect(resolveKeyId(after, PLAYGROUND_KEY_ID)).toBe("real-pg");
    expect(resolveKeyId(after, "")).toBe("real-pg");
  });

  it("keeps a saved key, and falls back to the Playground key when it was deleted or disabled", () => {
    const keys = [key("k1"), key("off", { isActive: false }), key("pg", { playground: true })];
    expect(resolveKeyId(keys, "k1")).toBe("k1");
    expect(resolveKeyId(keys, "deleted")).toBe("pg");
    expect(resolveKeyId(keys, "off")).toBe("pg");
    expect(resolveKeyId([key("k1")], "deleted")).toBe(PLAYGROUND_KEY_ID);
  });
});

describe("parseKeys", () => {
  it("keeps only id, name and flags, never a secret field", () => {
    const parsed = parseKeys({
      keys: [
        { id: "k1", name: "acme", key: "sk-secret", isActive: true, restricted: true },
        { name: "no id" },
        null,
      ],
    });
    expect(parsed).toEqual([
      { id: "k1", name: "acme", isActive: true, restricted: true, playground: false },
    ]);
    expect(JSON.stringify(parsed)).not.toContain("sk-secret");
    expect(parseKeys({ keys: [{ id: "abcdefghijk" }] })[0].name).toBe("abcdefgh");
  });
});

describe("model filtering", () => {
  it("lists the request model ids", () => {
    expect(requestModelIds(groups)).toEqual(["p1/a", "p1/b", "p2/c"]);
  });

  it("re-filters on key switch and ignores an answer for another key", () => {
    const restricted = key("r1", { restricted: true });
    const other = key("r2", { restricted: true });
    const fetched = { keyId: "r1", models: ["p1/b"] };
    expect(
      filterGroups(groups, allowedFor(restricted, fetched)).flatMap((g) =>
        g.models.map((m) => m.id),
      ),
    ).toEqual(["p1/b"]);
    // Switched to r2 before its answer arrived: nothing allowed yet (not r1's list).
    expect(filterGroups(groups, allowedFor(other, fetched))).toEqual([]);
    // An open key sees everything.
    expect(allowedFor(key("k1"), fetched)).toBeNull();
    expect(filterGroups(groups, null)).toBe(groups);
    expect(allowedFor(null, null)).toBeNull();
  });
});

describe("billsAnotherKey", () => {
  it("is true only for a selected non-Playground key", () => {
    const keys = [key("k1"), key("pg", { playground: true })];
    expect(billsAnotherKey(keys, "k1")).toBe(true);
    expect(billsAnotherKey(keys, "pg")).toBe(false);
    expect(billsAnotherKey(keys, null)).toBe(false);
    expect(billsAnotherKey(null, "k1")).toBe(false);
  });
});
