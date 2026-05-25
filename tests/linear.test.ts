import { afterEach, describe, expect, it, vi } from "vitest";
import {
  fetchCandidateIssues,
  fetchHandoffIssues,
  fetchIssueLabelNames,
  fetchRelevantIssues,
  fetchTerminalIssues,
  moveIssueToState,
} from "../src/linear.js";
import type { EffectiveWorkflowConfig } from "../src/types.js";

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

  it("fetches relevant issues without limiting the workflow state", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).not.toContain("state: { name: { in: $states } }");
      expect(body.query).toContain("$projectSlug: String!");
      expect(body.variables).toEqual({ projectSlug: "project" });
      return response({ issues: { nodes: [] } });
    });
    vi.stubGlobal("fetch", fetchMock);

    await fetchRelevantIssues(
      makeConfig({ projectSlug: "project", teamKey: null })
    );

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("fetches configured Linear issue label names", async () => {
    const fetchMock = vi.fn(async () =>
      response({
        issueLabels: {
          nodes: [{ name: "symphony" }, { name: "repo:symphony" }, { name: null }],
          pageInfo: { hasNextPage: false, endCursor: null }
        }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchIssueLabelNames(makeConfig({ projectSlug: null, teamKey: "ANM" }))).resolves.toEqual([
      "symphony",
      "repo:symphony"
    ]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("filters terminal issue queries by configured required labels", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toContain("$teamKey: String!");
      expect(body.query).toContain("$requiredLabels: [String!]");
      expect(body.query).toContain("labels: { some: { name: { in: $requiredLabels } } }");
      expect(body.variables).toEqual({
        states: ["Done"],
        teamKey: "ANM",
        requiredLabels: ["symphony"]
      });
      return response({
        issues: {
          nodes: [
            terminalIssueNode("issue-1", "ANM-1", ["symphony"]),
            terminalIssueNode("issue-2", "ANM-2", ["other"])
          ]
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchTerminalIssues(
        makeConfig({
          projectSlug: null,
          teamKey: "ANM",
          requiredLabels: ["symphony"]
        })
      )
    ).resolves.toMatchObject([{ identifier: "ANM-1" }]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("filters handoff issue queries by configured handoff state and required labels", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      expect(body.query).toContain("query SymphonyHandoffIssues");
      expect(body.query).toContain("$teamKey: String!");
      expect(body.query).toContain("$requiredLabels: [String!]");
      expect(body.variables).toEqual({
        states: ["In Review"],
        teamKey: "ANM",
        requiredLabels: ["symphony"]
      });
      return response({
        issues: {
          nodes: [
            terminalIssueNode("issue-1", "ANM-1", ["symphony"], "In Review"),
            terminalIssueNode("issue-2", "ANM-2", ["other"], "In Review")
          ]
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchHandoffIssues(
        makeConfig({
          projectSlug: null,
          teamKey: "ANM",
          requiredLabels: ["symphony"],
          handoffState: "In Review"
        })
      )
    ).resolves.toMatchObject([{ identifier: "ANM-1" }]);

    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("normalizes Linear attachment URLs onto issues", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string };
      expect(body.query).toContain("attachments(first: 25)");
      return response({
        issues: {
          nodes: [
            {
              ...terminalIssueNode("issue-1", "ANM-1", ["symphony"], "In Review"),
              attachments: {
                nodes: [
                  {
                    title: "GitHub PR",
                    url: "https://github.com/anmho/symphony/pull/41"
                  }
                ]
              }
            }
          ]
        }
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchHandoffIssues(
        makeConfig({
          projectSlug: null,
          teamKey: "ANM",
          requiredLabels: ["symphony"],
          handoffState: "In Review"
        })
      )
    ).resolves.toMatchObject([
      {
        identifier: "ANM-1",
        attachments: ["https://github.com/anmho/symphony/pull/41", "GitHub PR"]
      }
    ]);
  });

  it("moves an issue to a named workflow state", async () => {
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { query: string; variables: Record<string, unknown> };
      if (body.query.includes("query SymphonyIssueTeam")) {
        expect(body.variables).toEqual({ id: "issue-1" });
        return response({ issue: { team: { id: "team-1" } } });
      }
      if (body.query.includes("query SymphonyWorkflowStates")) {
        expect(body.variables).toEqual({ teamId: "team-1" });
        return response({
          workflowStates: {
            nodes: [
              { id: "state-1", name: "Todo" },
              { id: "state-2", name: "Human Review" }
            ]
          }
        });
      }
      if (body.query.includes("mutation SymphonyIssueMoveState")) {
        expect(body.variables).toEqual({ id: "issue-1", stateId: "state-2" });
        return response({ issueUpdate: { success: true } });
      }
      throw new Error(`unexpected query: ${body.query}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await moveIssueToState(makeConfig({ projectSlug: null, teamKey: "ANM" }), "issue-1", "Human Review");

    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});

function makeConfig(tracker: {
  projectSlug: string | null;
  teamKey: string | null;
  requiredLabels?: string[];
  handoffState?: string | null;
}): EffectiveWorkflowConfig {
  return {
    tracker: {
      kind: "linear",
      endpoint: "https://linear.example/graphql",
      apiKey: "lin_test",
      projectSlug: tracker.projectSlug,
      teamKey: tracker.teamKey,
      requiredLabels: tracker.requiredLabels ?? [],
      repoLabelPrefix: "repo:",
      activeStates: ["Todo"],
      terminalStates: ["Done"],
      handoffState: tracker.handoffState ?? null
    }
  } as unknown as EffectiveWorkflowConfig;
}

function response(data: unknown): Response {
  return {
    ok: true,
    json: async () => ({ data })
  } as Response;
}

function terminalIssueNode(id: string, identifier: string, labels: string[], state = "Done") {
  return {
    id,
    identifier,
    title: `Issue ${identifier}`,
    state: { name: state },
    labels: { nodes: labels.map((name) => ({ name })) },
    attachments: { nodes: [] },
    relations: { nodes: [] }
  };
}
