Structure Point
  x.i
  y.i
EndStructure

Procedure.i Work()
  Dim nums.i(2)
  nums(0) = 10
  nums(1) = 20
  nums(2) = 30

  NewList names.s()
  AddElement(names())
  names() = "alpha"
  AddElement(names())
  names() = "beta"

  NewList counts.i()
  AddElement(counts())
  counts() = 111
  AddElement(counts())
  counts() = 222

  NewMap scores.i()
  scores("gary") = 42
  scores("sam") = 7

  Define p.Point
  p\x = 100
  p\y = 200

  Define t.i = ElapsedMilliseconds()
  Repeat
  Until ElapsedMilliseconds() - t > 4000

  ProcedureReturn nums(0) + scores("gary") + p\x
EndProcedure

Define result.i
result = Work()
Debug "result=" + Str(result)
