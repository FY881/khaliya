import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Test-only secrets. Never used outside the local Miniflare runtime.
export const TEST_TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
export const TEST_SESSION_SECRET = "test-session-secret-0123456789abcdef";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.toml" },
        remoteBindings: false, // never reach real Cloudflare services from tests
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            LLM_MODE: "mock",
            OWNER_TOTP_SECRET: TEST_TOTP_SECRET,
            SESSION_SECRET: TEST_SESSION_SECRET,
          },
        },
      }),
    ],
    test: {
      setupFiles: ["./test/apply-migrations.ts"],
    },
  };
});
