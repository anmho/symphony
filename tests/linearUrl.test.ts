import { describe, expect, it } from "vitest";
import { linearIssueUrl } from "../src/linearUrl.js";

describe("linearIssueUrl", () => {
  it("builds a linear issue url from identifier", () => {
    expect(linearIssueUrl("ANM-277")).toBe("https://linear.app/anmho/issue/ANM-277");
  });

  it("supports custom org slugs", () => {
    expect(linearIssueUrl("APP-1", "acme")).toBe("https://linear.app/acme/issue/APP-1");
  });

  it("rejects invalid identifiers", () => {
    expect(linearIssueUrl("not-an-issue")).toBeNull();
  });
});
