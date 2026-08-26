Procedure.i Add(a.i, b.i)
  Define c.i
  c = a + b
  Debug "line4 c=" + Str(c)
  c = c + 1
  Debug "line6 c=" + Str(c)
  ProcedureReturn c
EndProcedure

Define x.i = 1
Define y.i = 2
Define z.i = Add(x, y)
Debug "line13 z=" + Str(z)
Define w.i = z + 1
Debug "line15 w=" + Str(w)
End
