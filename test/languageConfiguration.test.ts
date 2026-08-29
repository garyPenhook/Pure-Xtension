import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

interface RegexSpec {
  pattern: string;
  flags?: string;
}

const configPath = path.join(__dirname, "..", "..", "language-configuration.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

function toRegex(spec: string | RegexSpec): RegExp {
  if (typeof spec === "string") {
    return new RegExp(spec);
  }
  return new RegExp(spec.pattern, spec.flags);
}

const increasePattern = toRegex(config.indentationRules.increaseIndentPattern);
const decreasePattern = toRegex(config.indentationRules.decreaseIndentPattern);

for (const line of ["If x = 1", "if x = 1", "IF x = 1", "iF x = 1"]) {
  test(`increaseIndentPattern matches "${line}"`, () => {
    assert.match(line, increasePattern);
  });
}

for (const line of ["Procedure.i Foo()", "procedure.i foo()", "PROCEDURE.i FOO()"]) {
  test(`increaseIndentPattern matches "${line}"`, () => {
    assert.match(line, increasePattern);
  });
}

for (const line of ["EndIf", "endif", "ENDIF", "EndProcedure", "endprocedure"]) {
  test(`decreaseIndentPattern matches "${line}"`, () => {
    assert.match(line, decreasePattern);
  });
}

test("increaseIndentPattern does not match an unrelated line", () => {
  assert.doesNotMatch("x = 1 + 2", increasePattern);
});

test("decreaseIndentPattern does not match an unrelated line", () => {
  assert.doesNotMatch("x = 1 + 2", decreasePattern);
});
