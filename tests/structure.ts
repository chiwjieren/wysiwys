import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { expect } from "chai";
import { GuardErrorCode } from "@wysiwys/shared";

const idl = JSON.parse(readFileSync("target/idl/wysiwys_guard.json", "utf8"));
const srcDir = "programs/wysiwys_guard/src";
const sources = [
  ...readdirSync(srcDir).filter((f) => f.endsWith(".rs")).map((f) => join(srcDir, f)),
  ...readdirSync(join(srcDir, "instructions")).map((f) => join(srcDir, "instructions", f)),
].map((path) => ({ path, text: readFileSync(path, "utf8") }));

describe("structure (security rules 2, 3, 8)", () => {
  it("exposes exactly the six instructions (policy changes only through apply_policy_change)", () => {
    expect(idl.instructions.map((i: any) => i.name).sort()).to.deep.equal(
      ["apply_policy_change", "guarded_config_execute", "guarded_execute", "initialize_guard", "on_report", "request_review"],
    );
  });

  it("signs with the executor only in the two Squads execute handlers", () => {
    const hits = sources.flatMap((s) => (s.text.match(/invoke_signed\(/g) ?? []).map(() => s.path)).sort();
    expect(hits).to.deep.equal([
      join(srcDir, "instructions", "guarded_config_execute.rs"),
      join(srcDir, "instructions", "guarded_execute.rs"),
    ]);
  });

  it("never uses init_if_needed", () => {
    expect(sources.some((s) => s.text.includes("init_if_needed"))).to.equal(false);
  });

  it("error codes match packages/shared", () => {
    for (const e of idl.errors) {
      expect(GuardErrorCode[e.name as keyof typeof GuardErrorCode], e.name).to.equal(e.code);
    }
    expect(idl.errors.length).to.equal(Object.keys(GuardErrorCode).length);
  });
});
