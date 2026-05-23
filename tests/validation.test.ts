import { describe, expect, it } from "vitest";
import { validateConfiguredRepoRouteLabels } from "../src/validation.js";
import type { EffectiveWorkflowConfig } from "../src/types.js";

describe("config validation", () => {
  it("does not warn when every configured repo route has a Linear label", async () => {
    const warnings = await validateConfiguredRepoRouteLabels(
      makeConfig({
        repoRoutes: {
          symphony: "/tmp/symphony",
          auth: "/tmp/auth"
        }
      }),
      async () => ["repo:symphony", "repo:auth"]
    );

    expect(warnings).toEqual([]);
  });

  it("warns for each configured repo route without a matching Linear label", async () => {
    const warnings = await validateConfiguredRepoRouteLabels(
      makeConfig({
        repoRoutes: {
          symphony: "/tmp/symphony",
          auth: "/tmp/auth",
          terraform: "/tmp/terraform"
        }
      }),
      async () => ["repo:symphony"]
    );

    expect(warnings.map((warning) => warning.message)).toEqual([
      "Missing Linear label for configured repo route: repo:auth",
      "Missing Linear label for configured repo route: repo:terraform"
    ]);
  });

  it("warns without failing when Linear labels cannot be fetched", async () => {
    const warnings = await validateConfiguredRepoRouteLabels(
      makeConfig({
        repoRoutes: {
          symphony: "/tmp/symphony"
        }
      }),
      async () => {
        throw new Error("linear_http_error: 503 unavailable");
      }
    );

    expect(warnings).toEqual([
      {
        code: "linear_label_lookup_unavailable",
        message: "Could not verify Linear repo route labels: linear_http_error: 503 unavailable"
      }
    ]);
  });
});

function makeConfig(overrides: { repoRoutes: Record<string, string> }): EffectiveWorkflowConfig {
  return {
    tracker: {
      repoLabelPrefix: "repo:"
    },
    workspace: {
      repoRoutes: overrides.repoRoutes
    }
  } as unknown as EffectiveWorkflowConfig;
}
