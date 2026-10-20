import { describe, expect, it } from "vite-plus/test";
import {
  compareVersions,
  floatingTags,
  highestStable,
  parseVersion,
  previousTag,
} from "../../scripts/ci/floating-tags.mjs";

describe("floatingTags", () => {
  it("backport only moves its own major and minor, never latest or the newer major", () => {
    const tags = ["v100.7.0", "v101.0.0", "v101.0.1", "v100.7.1"];
    expect(floatingTags("100.7.1", tags)).toEqual(["100", "100.7"]);
  });

  it("backport to an older minor only moves that minor", () => {
    const tags = ["v100.6.0", "v100.7.0", "v101.0.0", "v100.6.1"];
    expect(floatingTags("100.6.1", tags)).toEqual(["100.6"]);
  });

  it("a new highest release moves all three", () => {
    const tags = ["v100.7.0", "v101.0.0", "v101.0.1", "v101.0.2"];
    expect(floatingTags("101.0.2", tags)).toEqual(["latest", "101", "101.0"]);
  });

  it("counts the version itself even before the tag is fetched", () => {
    expect(floatingTags("v101.1.0", ["v101.0.0"])).toEqual(["latest", "101", "101.1"]);
  });

  it("a republish of an older patch moves nothing", () => {
    expect(floatingTags("101.0.0", ["v101.0.0", "v101.0.1"])).toEqual([]);
  });

  it("prereleases never move floating tags and never count as highest", () => {
    expect(floatingTags("102.0.0-rc.1", ["v101.0.0", "v102.0.0-rc.1"])).toEqual([]);
    expect(floatingTags("101.0.1", ["v101.0.0", "v102.0.0-rc.1", "v101.0.1"])).toEqual([
      "latest",
      "101",
      "101.0",
    ]);
  });

  it("sorts minors numerically: 100.10 is above 100.9", () => {
    const tags = ["v100.9.0", "v100.10.0", "v100.9.1"];
    expect(floatingTags("100.10.0", tags)).toEqual(["latest", "100", "100.10"]);
    expect(floatingTags("100.9.1", tags)).toEqual(["100.9"]);
  });

  it("the first release in a new major moves all three", () => {
    expect(floatingTags("102.0.0", ["v100.7.1", "v101.0.1", "v102.0.0"])).toEqual([
      "latest",
      "102",
      "102.0",
    ]);
  });

  it("ignores unrelated and malformed tags, and rejects malformed input", () => {
    expect(floatingTags("100.0.0", ["vnext", "v1.2", "release-200.0.0"])).toEqual([
      "latest",
      "100",
      "100.0",
    ]);
    expect(floatingTags("not-a-version", ["v100.0.0"])).toEqual([]);
  });
});

describe("compareVersions", () => {
  const cmp = (a, b) => Math.sign(compareVersions(parseVersion(a), parseVersion(b)));
  it("follows semver precedence", () => {
    expect(cmp("100.10.0", "100.9.0")).toBe(1);
    expect(cmp("1.0.0-rc.1", "1.0.0")).toBe(-1);
    expect(cmp("1.0.0-rc.2", "1.0.0-rc.10")).toBe(-1);
    expect(cmp("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    expect(cmp("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    expect(cmp("1.0.0-beta", "1.0.0-alpha")).toBe(1);
    expect(cmp("v1.2.3", "1.2.3")).toBe(0);
  });
});

describe("highestStable / previousTag", () => {
  const tags = ["v100.7.0", "v101.0.0", "v101.0.1", "v100.7.1", "v102.0.0-rc.1", "v100.10.0"];

  it("finds the highest stable tag", () => {
    expect(highestStable(tags)).toBe("v101.0.1");
    expect(highestStable([])).toBeNull();
  });

  it("diffs a backport against the previous patch, not the newest release", () => {
    expect(previousTag("v100.7.1", tags)).toBe("v100.7.0");
    expect(previousTag("v101.0.2", tags)).toBe("v101.0.1");
    expect(previousTag("v100.10.0", tags)).toBe("v100.7.1");
  });

  it("stable releases skip prereleases; prereleases may diff against one", () => {
    expect(previousTag("v102.0.0", tags)).toBe("v101.0.1");
    expect(previousTag("v102.0.0-rc.2", tags)).toBe("v102.0.0-rc.1");
    expect(previousTag("v100.0.0", tags)).toBeNull();
  });
});
