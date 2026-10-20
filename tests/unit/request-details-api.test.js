import { beforeEach, describe, it, expect, vi } from "vite-plus/test";
import { getRequestDetails, getRequestDetailById } from "@/lib/usageDb";
import { GET } from "@/app/api/usage/request-details/route.js";
import { GET as GET_ONE } from "@/app/api/usage/request-details/[id]/route.js";

vi.mock("@/lib/usageDb", () => ({ getRequestDetails: vi.fn(), getRequestDetailById: vi.fn() }));

const request = () => new Request("http://localhost/api/usage/request-details?page=1&pageSize=20");
const pagination = { page: 1, pageSize: 20, totalItems: 1, totalPages: 1 };

describe("request-details API", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns all four captured payloads with metadata", async () => {
    const details = [{
      id: "abc",
      provider: "opencode",
      model: "deepseek-v4-flash-free",
      timestamp: "2026-08-05T00:00:00Z",
      status: "success",
      tokens: { prompt_tokens: 10, completion_tokens: 5 },
      request: { messages: [{ role: "user", content: "secret prompt" }] },
      providerRequest: { messages: [{ role: "user", content: "secret prompt" }] },
      providerResponse: { choices: [{ message: { content: "secret answer" } }] },
      response: { content: "secret answer" },
    }];
    getRequestDetails.mockResolvedValue({ details, pagination });
    const response = await GET(request());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({ details: details.map((d) => ({ ...d, providerName: expect.any(String) })), pagination });
    expect(getRequestDetails).toHaveBeenCalledWith({ page: 1, pageSize: 20 });
  });

  it("handles empty details", async () => {
    getRequestDetails.mockResolvedValue({ details: [], pagination });
    expect(await (await GET(request())).json()).toEqual({ details: [], pagination });
  });

  it("preserves older metadata-only records", async () => {
    const details = [{ id: "x", status: "error", latency: { total: 100 } }];
    getRequestDetails.mockResolvedValue({ details, pagination });
    expect((await (await GET(request())).json()).details).toEqual(details);
  });

  it("summary=1 drops the captured bodies but keeps metadata", async () => {
    const details = [{
      id: "abc", model: "m", tokens: { prompt_tokens: 1, credits: 2 }, cost: 0.5, latency: { ttft: 10 },
      request: { a: 1 }, providerRequest: { b: 1 }, providerResponse: { c: 1 }, response: { d: 1 },
    }];
    getRequestDetails.mockResolvedValue({ details, pagination });
    const res = await GET(new Request("http://localhost/api/usage/request-details?page=1&pageSize=20&summary=1"));
    expect((await res.json()).details).toEqual([
      { id: "abc", model: "m", tokens: { prompt_tokens: 1, credits: 2 }, cost: 0.5, latency: { ttft: 10 } },
    ]);
  });
});

describe("request-details/:id API", () => {
  beforeEach(() => vi.clearAllMocks());
  const one = (id) => GET_ONE(new Request(`http://localhost/api/usage/request-details/${id}`), { params: Promise.resolve({ id }) });

  it("returns one detail with bodies, not cached", async () => {
    const detail = { id: "abc", request: { messages: [] }, response: { content: "x" } };
    getRequestDetailById.mockResolvedValue(detail);
    const res = await one("abc");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toEqual(detail);
    expect(getRequestDetailById).toHaveBeenCalledWith("abc");
  });

  it("404s for an unknown id and 400s for an oversized one", async () => {
    getRequestDetailById.mockResolvedValue(null);
    expect((await one("nope")).status).toBe(404);
    expect((await one("x".repeat(201))).status).toBe(400);
  });
});
