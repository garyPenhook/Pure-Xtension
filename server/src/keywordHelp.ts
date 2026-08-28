// Language-keyword -> purebasic.com reference-topic URL. Unlike built-in functions
// (one command = one page, from commandindex.html), keywords are documented in
// prose topics that often cover several related keywords on one page (e.g.
// If/ElseIf/Else/EndIf all live on if_endif.html) with no anchor per keyword, and
// several keywords (Goto, End, Swap) aren't in commandindex.html at all. There's
// no machine-readable index for this, so the mapping below was hand-built by
// fetching https://www.purebasic.com/documentation/index.html's "Language
// fundamentals" section (which lists exactly this keyword set) and confirming
// each reference/*.html target returns HTTP 200 (verified 2026-08-24; see PLAN.md).
//
// Keeps only the keywords present in syntaxes/purebasic.tmLanguage.json's
// control/declaration/storage-keyword patterns.

const REF_BASE = "https://www.purebasic.com/documentation/reference/";

const KEYWORD_TOPICS: Record<string, string> = {
  if: "if_endif",
  elseif: "if_endif",
  else: "if_endif",
  endif: "if_endif",

  for: "for_next",
  to: "for_next",
  step: "for_next",
  next: "for_next",
  foreach: "foreach_next",

  while: "while_wend",
  wend: "while_wend",
  repeat: "repeat_until",
  until: "repeat_until",

  select: "select_endselect",
  case: "select_endselect",
  default: "select_endselect",
  endselect: "select_endselect",

  break: "break_continue",
  continue: "break_continue",

  return: "gosub_return",
  gosub: "gosub_return",
  fakereturn: "gosub_return",

  goto: "others",
  end: "others",
  swap: "others",

  procedure: "procedures",
  procedurec: "procedures",
  proceduredll: "procedures",
  procedurecdll: "procedures",
  endprocedure: "procedures",
  declare: "procedures",
  declarec: "procedures",
  declaredll: "procedures",
  procedurereturn: "procedures",

  structure: "structures",
  endstructure: "structures",
  structureunion: "structures",
  endstructureunion: "structures",
  extends: "structures",
  array: "structures",

  interface: "interfaces",
  endinterface: "interfaces",

  import: "import_endimport",
  importc: "import_endimport",
  endimport: "import_endimport",

  enumeration: "enumerations",
  enumerationbinary: "enumerations",
  endenumeration: "enumerations",

  macro: "macros",
  endmacro: "macros",
  undefmacro: "macros",

  datasection: "data",
  enddatasection: "data",
  data: "data",
  dataaddress: "data",
  restore: "data",

  global: "global",
  protected: "protected",
  static: "static",
  define: "define",
  dim: "dim",
  newlist: "newlist",
  list: "newlist",
  newmap: "newmap",
  map: "newmap",
  threaded: "threaded",
  shared: "shared",

  and: "variables",
  or: "variables",
  not: "variables",
  xor: "variables",
};

export function getKeywordHelpUrl(word: string): string | undefined {
  const topic = KEYWORD_TOPICS[word.toLowerCase()];
  return topic ? `${REF_BASE}${topic}.html` : undefined;
}

/** True for any reserved PureBasic language keyword (If, Procedure, EndIf, ...) -- reused by rename to reject both the target of a rename and any proposed replacement name that collides with one. */
export function isKeyword(word: string): boolean {
  return word.toLowerCase() in KEYWORD_TOPICS;
}
