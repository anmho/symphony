import { describe, expect, it } from "vitest";
import {
  buildPrHandoffInstructions,
  preparePrHandoffBackend,
  submitGraphiteStack,
  submitGraphiteStackAndVerify,
  verifyPullRequestMetadata
} from "../src/prHandoff.js";
import type { CommandRunner } from "../src/prHandoff.js";
import type { EffectiveWorkflowConfig, NormalizedIssue } from "../src/types.js";

describe("PR handoff backend", () => {
  it("uses Graphite when gt is installed and the repo is initialized", async () => {
    const calls: string[] = [];
    const runner = fakeRunner({
      "gt --version": { exitCode: 0, stdout: "1.7.14\n" },
      "gt log --stack --no-interactive": { exitCode: 0, stdout: "main\n◉ symphony/ANM-295\n" },
      "gt submit --dry-run --stack --no-interactive --no-edit --no-ai": {
        exitCode: 0,
        stdout: "Would submit stack\n"
      }
    }, calls);

    await expect(
      preparePrHandoffBackend(makeConfig({ backend: "graphite", fallback: "fail" }), "/repo", runner)
    ).resolves.toEqual({ backend: "graphite", version: "1.7.14" });
    expect(calls).toEqual([
      "gt --version",
      "gt log --stack --no-interactive",
      "gt submit --dry-run --stack --no-interactive --no-edit --no-ai"
    ]);
  });

  it("fails clearly when Graphite is missing and fallback is disabled", async () => {
    const runner = fakeRunner({
      "gt --version": { exitCode: 127, stderr: "gt: command not found" }
    });

    await expect(
      preparePrHandoffBackend(makeConfig({ backend: "graphite", fallback: "fail" }), "/repo", runner)
    ).rejects.toThrow("graphite_unavailable: gt --version failed");
  });

  it("falls back to GitHub when Graphite is missing and fallback is enabled", async () => {
    const runner = fakeRunner({
      "gt --version": { exitCode: 127, stderr: "gt: command not found" }
    });

    await expect(
      preparePrHandoffBackend(makeConfig({ backend: "graphite", fallback: "github" }), "/repo", runner)
    ).resolves.toEqual({
      backend: "github",
      fallbackReason: "graphite_unavailable: gt --version failed: gt: command not found"
    });
  });

  it("surfaces Graphite submit failures", async () => {
    const runner = fakeRunner({
      "gt submit --stack --no-interactive --no-edit --no-ai": {
        exitCode: 1,
        stderr: "branch is not restacked"
      }
    });

    await expect(submitGraphiteStack("/repo", runner)).rejects.toThrow(
      "graphite_submit_failed: gt submit --stack --no-interactive --no-edit --no-ai failed: branch is not restacked"
    );
  });

  it("enforces PR base/head metadata and the Linear Ticket link", async () => {
    const runner = fakeRunner({
      "gh pr view symphony/ANM-295 --json url,author,baseRefName,headRefName,body,reviewRequests": {
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/anmho/symphony/pull/295",
          author: { login: "anmho" },
          baseRefName: "symphony/ANM-294",
          headRefName: "symphony/ANM-295",
          body: "Linear: https://linear.app/anmho/issue/ANM-295/x\nGraphite: https://app.graphite.com/github/pr/anmho/symphony/295",
          reviewRequests: [{ login: "anmho" }]
        })
      }
    });

    await expect(
      verifyPullRequestMetadata({
        cwd: "/repo",
        branch: "symphony/ANM-295",
        expectedBaseBranch: "symphony/ANM-294",
        linearTicketUrl: "https://linear.app/anmho/issue/ANM-295/x",
        graphitePrUrl: "https://app.graphite.com/github/pr/anmho/symphony/295",
        expectedAuthorLogin: "anmho",
        expectedReviewerLogin: "anmho",
        runner
      })
    ).resolves.toEqual({
      url: "https://github.com/anmho/symphony/pull/295",
      baseRefName: "symphony/ANM-294",
      headRefName: "symphony/ANM-295",
      authorLogin: "anmho",
      body: "Linear: https://linear.app/anmho/issue/ANM-295/x\nGraphite: https://app.graphite.com/github/pr/anmho/symphony/295",
      reviewRequestLogins: ["anmho"]
    });
  });

  it("accepts the configured GitHub App PR author", async () => {
    const runner = fakeRunner({
      "gh pr view symphony/ANM-391 --json url,author,baseRefName,headRefName,body,reviewRequests": {
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/anmho/symphony/pull/391",
          author: { login: "app/anmho-symphony" },
          baseRefName: "main",
          headRefName: "symphony/ANM-391",
          body: "Linear: https://linear.app/anmho/issue/ANM-391/x",
          reviewRequests: [{ login: "anmho" }]
        })
      }
    });

    await expect(
      verifyPullRequestMetadata({
        cwd: "/repo",
        branch: "symphony/ANM-391",
        expectedBaseBranch: "main",
        linearTicketUrl: "https://linear.app/anmho/issue/ANM-391/x",
        expectedAuthorLogin: "app/anmho-symphony",
        expectedReviewerLogin: "anmho",
        runner
      })
    ).resolves.toMatchObject({
      authorLogin: "app/anmho-symphony"
    });
  });

  it("rejects the local GitHub user when a GitHub App PR author is required", async () => {
    const runner = fakeRunner({
      "gh pr view symphony/ANM-391 --json url,author,baseRefName,headRefName,body,reviewRequests": {
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/anmho/symphony/pull/391",
          author: { login: "anmho" },
          baseRefName: "main",
          headRefName: "symphony/ANM-391",
          body: "Linear: https://linear.app/anmho/issue/ANM-391/x"
        })
      }
    });

    await expect(
      verifyPullRequestMetadata({
        cwd: "/repo",
        branch: "symphony/ANM-391",
        expectedBaseBranch: "main",
        linearTicketUrl: "https://linear.app/anmho/issue/ANM-391/x",
        expectedAuthorLogin: "app/anmho-symphony",
        runner
      })
    ).rejects.toThrow("github_pr_author_mismatch: expected app/anmho-symphony, got anmho");
  });

  it("rejects missing PR author metadata when an expected author is configured", async () => {
    const runner = fakeRunner({
      "gh pr view symphony/ANM-391 --json url,author,baseRefName,headRefName,body,reviewRequests": {
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/anmho/symphony/pull/391",
          author: null,
          baseRefName: "main",
          headRefName: "symphony/ANM-391",
          body: "Linear: https://linear.app/anmho/issue/ANM-391/x"
        })
      }
    });

    await expect(
      verifyPullRequestMetadata({
        cwd: "/repo",
        branch: "symphony/ANM-391",
        expectedBaseBranch: "main",
        linearTicketUrl: "https://linear.app/anmho/issue/ANM-391/x",
        expectedAuthorLogin: "app/anmho-symphony",
        runner
      })
    ).rejects.toThrow("github_pr_author_mismatch: expected app/anmho-symphony, got ");
  });

  it("verifies PR metadata immediately after Graphite submit", async () => {
    const calls: string[] = [];
    const runner = fakeRunner({
      "gt submit --stack --no-interactive --no-edit --no-ai": {
        exitCode: 0,
        stdout: "Submitted stack\n"
      },
      "gh pr view symphony/ANM-295 --json url,author,baseRefName,headRefName,body,reviewRequests": {
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/anmho/symphony/pull/295",
          author: { login: "anmho" },
          baseRefName: "symphony/ANM-294",
          headRefName: "symphony/ANM-295",
          body: "Linear Ticket: https://linear.app/anmho/issue/ANM-295/x"
        })
      }
    }, calls);

    await submitGraphiteStackAndVerify({
      cwd: "/repo",
      branch: "symphony/ANM-295",
      expectedBaseBranch: "symphony/ANM-294",
      linearTicketUrl: "https://linear.app/anmho/issue/ANM-295/x",
      runner
    });

    expect(calls).toEqual([
      "gt submit --stack --no-interactive --no-edit --no-ai",
      "gh pr view symphony/ANM-295 --json url,author,baseRefName,headRefName,body,reviewRequests"
    ]);
  });

  it("blocks Graphite local-auth fallback when the PR author is not the configured identity", async () => {
    const runner = fakeRunner({
      "gt submit --stack --no-interactive --no-edit --no-ai": {
        exitCode: 0,
        stdout: "Submitted stack\n"
      },
      "gh pr view symphony/ANM-391 --json url,author,baseRefName,headRefName,body,reviewRequests": {
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/anmho/symphony/pull/391",
          author: { login: "anmho" },
          baseRefName: "main",
          headRefName: "symphony/ANM-391",
          body: "Linear: https://linear.app/anmho/issue/ANM-391/x"
        })
      }
    });

    await expect(
      submitGraphiteStackAndVerify({
        cwd: "/repo",
        branch: "symphony/ANM-391",
        expectedBaseBranch: "main",
        linearTicketUrl: "https://linear.app/anmho/issue/ANM-391/x",
        expectedAuthorLogin: "app/anmho-symphony",
        runner
      })
    ).rejects.toThrow("github_pr_author_mismatch: expected app/anmho-symphony, got anmho");
  });

  it("rejects PR handoff when the configured reviewer was not requested", async () => {
    const runner = fakeRunner({
      "gh pr view symphony/ANM-391 --json url,author,baseRefName,headRefName,body,reviewRequests": {
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/anmho/symphony/pull/391",
          author: { login: "app/anmho-symphony" },
          baseRefName: "main",
          headRefName: "symphony/ANM-391",
          body: "Linear: https://linear.app/anmho/issue/ANM-391/x",
          reviewRequests: []
        })
      }
    });

    await expect(
      verifyPullRequestMetadata({
        cwd: "/repo",
        branch: "symphony/ANM-391",
        expectedBaseBranch: "main",
        linearTicketUrl: "https://linear.app/anmho/issue/ANM-391/x",
        expectedAuthorLogin: "app/anmho-symphony",
        expectedReviewerLogin: "anmho",
        runner
      })
    ).rejects.toThrow("github_pr_reviewer_missing: expected anmho");
  });

  it("adds Graphite handoff instructions to the prompt", () => {
    const instructions = buildPrHandoffInstructions(
      makeConfig({ backend: "graphite", fallback: "github" }),
      makeIssue()
    );

    expect(instructions).toContain("gt submit --stack --no-interactive --no-edit --no-ai");
    expect(instructions).toContain("fall back to the GitHub PR flow");
    expect(instructions).toContain("https://linear.app/anmho/issue/ANM-295/x");
  });

  it("adds machine-user handoff instructions to GitHub prompts", () => {
    const instructions = buildPrHandoffInstructions(
      makeConfig({ backend: "github", fallback: "fail", identity: true }),
      makeIssue()
    );

    expect(instructions).toContain("configured GitHub machine-user PR identity");
    expect(instructions).toContain("vault kv get -mount=secret -field=token prod/providers/github/symphony");
    expect(instructions).toContain("Graphite: after the PR exists");
    expect(instructions).toContain("gh pr view --json url,author,baseRefName,headRefName,body,reviewRequests");
  });

  it("adds GitHub App author expectations to GitHub prompts", () => {
    const instructions = buildPrHandoffInstructions(
      makeConfig({ backend: "github", fallback: "fail", identity: "github_app" }),
      makeIssue()
    );

    expect(instructions).toContain("configured GitHub App PR identity (anmho-symphony)");
    expect(instructions).toContain("Expected GitHub PR author login: app/anmho-symphony.");
    expect(instructions).toContain("Request review from anmho before moving Linear to review.");
    expect(instructions).toContain("GH_TOKEN` and `GITHUB_TOKEN");
    expect(instructions).toContain("3862765+anmho-symphony[bot]@users.noreply.github.com");
  });

  it("routes Graphite handoff through GitHub tooling when a PR identity is configured", () => {
    const instructions = buildPrHandoffInstructions(
      makeConfig({ backend: "graphite", fallback: "fail", identity: true }),
      makeIssue()
    );

    expect(instructions).toContain("Use Graphite only for stack inspection before handoff");
    expect(instructions).toContain("Do not run mutating `gt submit` while a GitHub PR identity is configured");
    expect(instructions).toContain("open or update the PR with GitHub tooling under the configured identity");
    expect(instructions).toContain("Graphite: after the PR exists");
  });
});

function fakeRunner(
  responses: Record<string, { exitCode: number; stdout?: string; stderr?: string }>,
  calls: string[] = []
): CommandRunner {
  return async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    const response = responses[key] ?? { exitCode: 1, stderr: `unexpected command: ${key}` };
    return {
      exitCode: response.exitCode,
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? ""
    };
  };
}

function makeConfig(pr: {
  backend: "github" | "graphite";
  fallback: "fail" | "github";
  identity?: boolean | "github_app";
}): EffectiveWorkflowConfig {
  return {
    github: {
      prIdentity: pr.identity === "github_app"
        ? {
            kind: "github_app",
            appSlug: "anmho-symphony",
            tokenCommand:
              "symphony github-app-token --app-id 3862765 --installation-id 135623998 --private-key-command 'vault kv get -mount=secret -field=private_key prod/providers/github/symphony'",
            authorName: "anmho Symphony",
            authorEmail: "3862765+anmho-symphony[bot]@users.noreply.github.com",
            reviewerLogin: "anmho",
            reviewerLogins: ["anmho"]
          }
        : pr.identity
        ? {
            kind: "machine_user",
            tokenCommand: "vault kv get -mount=secret -field=token prod/providers/github/symphony",
            authorName: "Symphony",
            authorEmail: "anmho-symphony@users.noreply.github.com"
          }
        : null
    },
    pullRequest: {
      backend: pr.backend,
      graphiteFallback: pr.fallback
    },
    digest: {
      enabled: false,
      recipient: "andyminhtuanho@gmail.com",
      sender: "Symphony <agent@anmho.com>",
      intervalMs: 3600000,
      windowMs: 3600000,
      resendApiKey: null,
      resendEndpoint: "https://api.resend.com/emails"
    }
  } as EffectiveWorkflowConfig;
}

function makeIssue(): NormalizedIssue {
  return {
    id: "ANM-295",
    identifier: "ANM-295",
    title: "symphony: add optional Graphite stack backend for PR handoff",
    description: null,
    priority: null,
    state: "Todo",
    branchName: null,
    url: "https://linear.app/anmho/issue/ANM-295/x",
    labels: ["symphony"],
    comments: [],
    attachments: [],
    blockedBy: [],
    createdAt: null,
    updatedAt: null
  };
}
