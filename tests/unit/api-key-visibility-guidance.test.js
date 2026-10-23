// a3ca2f9b: API keys stay viewable after creation, so the UI must not claim the key is
// shown only once. Ported to the fork's Endpoint page (gatehouse), which has no
// "key created" modal: the create dialog says where to find the key, and the key card
// keeps its reveal and copy controls.
import { describe, it, expect } from "vite-plus/test";
import { readFileSync } from "node:fs";

const oldGuidance = "This is the only time you will see this key. Store it securely.";
const guidance = "Store this key securely. You can view or copy it later from the API Keys list.";
const read = (rel) => readFileSync(new URL(`../../${rel}`, import.meta.url), "utf-8");
const gatehouse = read("src/app/(dashboard)/dashboard/endpoint/gatehouse/Gatehouse.tsx");
const keyCard = read("src/app/(dashboard)/dashboard/endpoint/gatehouse/KeyCard.tsx");

describe("API key visibility guidance", () => {
  it("tells the creator the key stays available in the list", () => {
    const dialog = gatehouse.match(/function CreateKey[\s\S]*?<\/Dialog>/)?.[0];
    expect(dialog).toBeDefined();
    expect(dialog).toContain("view or copy it later from the key list");
    expect(gatehouse).not.toContain(oldGuidance);
  });

  it("keeps the key card's reveal and copy controls", () => {
    expect(keyCard).toContain("{show ? k.key : mask(k.key)}");
    expect(keyCard).toContain('label={show ? "Hide key" : "Show key"}');
    expect(keyCard).toContain('<CopyButton value={k.key} label="Copy key" />');
  });

  it.each(["fa", "id", "km", "pt-BR", "th", "zh-CN"])(
    "updates the existing %s translation without retaining the one-time claim",
    (locale) => {
      const translations = JSON.parse(read(`public/i18n/literals/${locale}.json`));
      expect(translations).not.toHaveProperty(oldGuidance);
      expect(translations[guidance]).toEqual(expect.any(String));
      expect(translations[guidance].trim()).not.toBe("");
      expect(translations[guidance]).not.toBe(guidance);
    },
  );
});
