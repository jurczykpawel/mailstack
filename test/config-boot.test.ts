import { afterEach, expect, it, vi } from "vitest";

afterEach(() => { vi.doUnmock("../src/core/config/bundled.ts"); vi.resetModules(); });
it("refuses Worker startup before serving any request with invalid configuration", async () => {
  vi.doMock("../src/core/config/bundled.ts", () => ({ CONFIG_JSON: '{"version":2}', BUILD_CONFIG_SHA: "unused" }));
  await expect(import("../src/index")).rejects.toThrow("$.version");
});
