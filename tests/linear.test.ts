import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchCandidateIssues } from "../src/linear";
import type { EffectiveWorkflowConfig } from "../src/types";

describe("linear client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("builds team-only issue queries without unused project variables", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toContain("$teamKey: String!");
      expect(body.query).not.toContain("$projectSlug");
      expect(body.variables).toEqual({ states: ["Todo"], teamKey: "ANM" });
      return response({ issues: { nodes: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchCandidateIssues(makeConfig({ projectSlug: null, teamKey: "ANM" }));

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("builds project-only issue queries without unused team variables", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toContain("$projectSlug: String!");
      expect(body.query).not.toContain("$teamKey");
      expect(body.variables).toEqual({ states: ["Todo"], projectSlug: "project" });
      return response({ issues: { nodes: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchCandidateIssues(makeConfig({ projectSlug: "project", teamKey: null }));

    expect(fetchMock).toHaveBeenCalledOnce();
  });
});

function makeConfig(tracker: { projectSlug: string | null; teamKey: string | null }): EffectiveWorkflowConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example/graphql",
      apiKey: "lin_test",
      projectSlug: tracker.projectSlug,
      teamKey: tracker.teamKey,
      requiredLabels: [],
      repoLabelPrefix: "repo:",
      activeStates: ["Todo"],
      terminalStates: ["Done"]
    }
  } as unknown as EffectiveWorkflowConfig;
}

function response(data: unknown): Response {
  return {
    ok: true,
    json: async () => ({ data })
  } as Response;
}
