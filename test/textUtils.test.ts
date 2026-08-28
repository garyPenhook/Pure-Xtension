import { test } from "node:test";
import assert from "node:assert/strict";
import { qualifiedWordAt } from "../server/src/textUtils";

test("qualifiedWordAt returns just the bare name for an unqualified word", () => {
  const text = "CreateFerrari()";
  assert.deepEqual(qualifiedWordAt(text, 3), { name: "CreateFerrari" });
});

test("qualifiedWordAt resolves the module when the cursor sits on the symbol half of Module::Symbol", () => {
  const text = "Ferrari::CreateFerrari()";
  const offset = text.indexOf("CreateFerrari") + 2;
  assert.deepEqual(qualifiedWordAt(text, offset), { module: "Ferrari", name: "CreateFerrari" });
});

test("qualifiedWordAt resolves the symbol when the cursor sits on the module half of Module::Symbol", () => {
  const text = "Ferrari::CreateFerrari()";
  const offset = 2; // inside "Ferrari"
  assert.deepEqual(qualifiedWordAt(text, offset), { module: "Ferrari", name: "CreateFerrari" });
});

test("qualifiedWordAt doesn't treat a lone :: with nothing on one side as qualified", () => {
  assert.deepEqual(qualifiedWordAt("::Foo", 3), { name: "Foo" });
  assert.deepEqual(qualifiedWordAt("Foo::", 1), { name: "Foo" });
});

test("qualifiedWordAt returns undefined off any word", () => {
  // Offset 2 sits on the '+' itself, with a space on either side -- neither
  // adjacent character is a word char, unlike offset 1 (the 'a'/' ' boundary,
  // which wordAt/wordRangeAt count as still touching "a").
  assert.equal(qualifiedWordAt("a + b", 2), undefined);
});

test("qualifiedWordAt handles a qualified reference used inside an expression", () => {
  const text = 'Debug Ferrari::#FerrariName$';
  const offset = text.indexOf("#FerrariName$") + 5;
  assert.deepEqual(qualifiedWordAt(text, offset), { module: "Ferrari", name: "#FerrariName$" });
});
