import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: ["test/unit/**/*.test.ts"],
          environment: "node",
          testTimeout: 15_000,
        },
      },
      {
        test: {
          name: "http",
          include: ["test/http/**/*.test.ts"],
          environment: "node",
          testTimeout: 20_000,
        },
      },
      {
        test: {
          name: "process",
          include: ["test/process/**/*.test.ts"],
          environment: "node",
          testTimeout: 60_000,
        },
      },
      {
        test: {
          name: "integration",
          include: [
            "test/turn/**/*.test.ts",
            "test/prompts/**/*.test.ts",
            "test/tools/**/*.test.ts",
            "test/codegen/**/*.test.ts",
            "test/daemon/**/*.test.ts",
            "test/rest/**/*.test.ts",
            "test/context/**/*.test.ts",
            "test/skill/**/*.test.ts",
            "test/acceptance/**/*.test.ts",
          ],
          environment: "node",
          testTimeout: 30_000,
        },
      },
      {
        test: {
          name: "live",
          include: ["test/live/**/*.test.ts"],
          environment: "node",
          testTimeout: 120_000,
        },
      },
    ],
  },
})
