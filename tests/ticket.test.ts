import { afterEach, describe, expect, it, vi } from "vitest";
import { createSymphonyTicket } from "../src/ticket.js";
import type { EffectiveWorkflowConfig } from "../src/types.js";

describe("ticket creation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("rejects an unknown repo key before querying or creating in Linear", async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error("Linear should not be called for unknown repo keys");
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      createSymphonyTicket(makeConfig(), {
        title: "unknown: test issue",
        repoKey: "missing",
        description: "body"
      })
    ).rejects.toThrow("ticket_create_unknown_repo: missing");

    expect(fetchMock).not.toHaveBeenCalled();
  });
});

function makeConfig(): EffectiveWorkflowConfig {
  return {
    tracker: {
      teamKey: "ANM",
      requiredLabels: ["symphony"],
      repoLabelPrefix: "repo:"
    },
    workspace: {
      repoRoutes: {
        symphony: "/tmp/symphony"
      }
    }
  } as unknown as EffectiveWorkflowConfig;
}
