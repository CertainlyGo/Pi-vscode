import assert from "node:assert/strict";
import { test } from "node:test";
import { pluginsFromSettings, skillsFromCommands } from "../src/capabilities/capability-service";

test("extracts skills from pi commands", () => {
  const skills = skillsFromCommands([
    { name: "session-name", source: "extension" },
    {
      name: "skill:brave-search",
      description: "Web search via Brave API",
      source: "skill",
      location: "user",
      path: "/home/u/.pi/agent/skills/brave-search/SKILL.md",
    },
    { name: "fix-tests", source: "prompt" },
    { name: "skill:zeta", source: "skill" },
  ]);

  assert.deepEqual(
    skills.map((skill) => skill.name),
    ["brave-search", "zeta"],
  );
  assert.equal(skills[0]?.description, "Web search via Brave API");
  assert.equal(skills[0]?.location, "user");
  assert.equal(skills[1]?.description, undefined);
});

test("lists packages, extensions and extension commands without duplicates", () => {
  const plugins = pluginsFromSettings({
    userSettings: {
      packages: ["pi-skills", { source: "npm:my-pkg", skills: [] }],
      extensions: ["/u/ext/a.ts"],
    },
    projectSettings: { packages: [{ source: "npm:my-pkg", extensions: [] }] },
    commands: [
      { name: "hello", source: "extension", description: "say hi", path: "/u/ext/a.ts" },
      { name: "other", source: "extension", description: "standalone", path: "/u/ext/b.ts" },
      { name: "not-an-extension", source: "prompt" },
    ],
  });

  assert.deepEqual(
    plugins.map((plugin) => plugin.name),
    ["npm:my-pkg", "pi-skills", "/u/ext/a.ts", "/other"],
  );
  // Project settings win over user settings for the same package.
  const myPkg = plugins.find((plugin) => plugin.name === "npm:my-pkg");
  assert.equal(myPkg?.scope, "project");
  assert.equal(myPkg?.detail, "filtered: extensions");
  // The extension file is listed once, not again as a command.
  assert.equal(plugins.filter((plugin) => plugin.path === "/u/ext/a.ts").length, 1);
  assert.equal(plugins.find((plugin) => plugin.path === "/u/ext/b.ts")?.kind, "command");
  assert.equal(plugins.find((plugin) => plugin.path === "/u/ext/b.ts")?.detail, "standalone");
});
