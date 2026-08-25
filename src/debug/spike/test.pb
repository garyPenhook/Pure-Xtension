Procedure.i Inner(a.i, b.i)
  Define c.i = a + b
  Define t.i = ElapsedMilliseconds()
  Repeat
  Until ElapsedMilliseconds() - t > 4000
  ProcedureReturn c
EndProcedure

Procedure.i Outer(x.i)
  Define r.i = Inner(x, x*2)
  ProcedureReturn r
EndProcedure

Define result.i
result = Outer(5)
Debug "result=" + Str(result)
