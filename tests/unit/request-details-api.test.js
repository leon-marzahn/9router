import { beforeEach, describe, it, expect, vi } from "vitest";
import { getRequestDetails } from "@/lib/usageDb";
import { GET } from "@/app/api/usage/request-details/route.js";

vi.mock("@/lib/usageDb", () => ({ getRequestDetails: vi.fn() }));

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
    expect(await response.json()).toEqual({ details, pagination });
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
});
