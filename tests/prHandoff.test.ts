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
      "gh pr view symphony/ANM-295 --json url,author,baseRefName,headRefName,body": {
        exitCode: 0,
        stdout: JSON.stringify({
          url: "https://github.com/anmho/symphony/pull/295",
          author: { login: "anmho" },
          baseRefName: "symphony/ANM-294",
          headRefName: "symphony/ANM-295",
          body: "Linear: https://linear.app/anmho/issue/ANM-295/x\nGraphite: https://app.graphite.dev/github/pr/anmho/symphony/295"
        })
      }
    });

    await expect(
      verifyPullRequestMetadata({
        cwd: "/repo",
        branch: "symphony/ANM-295",
        expectedBaseBranch: "symphony/ANM-294",
        linearTicketUrl: "https://linear.app/anmho/issue/ANM-295/x",
        graphitePrUrl: "https://app.graphite.dev/github/pr/anmho/symphony/295",
        expectedAuthorLogin: "anmho",
        runner
      })
    ).resolves.toEqual({
      url: "https://github.com/anmho/symphony/pull/295",
      baseRefName: "symphony/ANM-294",
      headRefName: "symphony/ANM-295",
      authorLogin: "anmho",
      body: "Linear: https://linear.app/anmho/issue/ANM-295/x\nGraphite: https://app.graphite.dev/github/pr/anmho/symphony/295"
    });
  });

  it("verifies PR metadata immediately after Graphite submit", async () => {
    const calls: string[] = [];
    const runner = fakeRunner({
      "gt submit --stack --no-interactive --no-edit --no-ai": {
        exitCode: 0,
        stdout: "Submitted stack\n"
      },
      "gh pr view symphony/ANM-295 --json url,author,baseRefName,headRefName,body": {
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
      "gh pr view symphony/ANM-295 --json url,author,baseRefName,headRefName,body"
    ]);
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
    expect(instructions).toContain("gh pr view --json url,author,baseRefName,headRefName,body");
  });

  it("warns that Graphite may use the local identity when service account is configured", () => {
    const instructions = buildPrHandoffInstructions(
      makeConfig({ backend: "graphite", fallback: "fail", identity: true }),
      makeIssue()
    );

    expect(instructions).toContain("Graphite submit may still use the local Graphite/GitHub identity");
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
  identity?: boolean;
}): EffectiveWorkflowConfig {
  return {
    github: {
      prIdentity: pr.identity
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
