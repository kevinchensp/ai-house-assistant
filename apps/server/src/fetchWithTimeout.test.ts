import { describe, expect, it, vi } from "vitest";
import { fetchWithTimeout } from "./fetchWithTimeout";

describe("fetchWithTimeout", () => {
  it("aborts hanging requests after the configured timeout", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
      });
    });

    const request = expect(fetchWithTimeout(fetchMock as typeof fetch, "https://example.test", {}, 1000)).rejects.toThrow(
      "request timed out after 1000ms"
    );
    await vi.advanceTimersByTimeAsync(1000);

    await request;
    expect(fetchMock).toHaveBeenCalledWith("https://example.test", expect.objectContaining({ signal: expect.any(AbortSignal) }));
    vi.useRealTimers();
  });
});
