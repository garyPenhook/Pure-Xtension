Procedure.i Work(n.i)
  Define r.i
  r = n * 2
  ProcedureReturn r
EndProcedure

Define i.i
Define total.i = 0
Debug "start"
For i = 1 To 3
  Delay(2000)
  total = total + Work(i)
  Debug "tick=" + Str(i)
Next
Debug "done total=" + Str(total)
End
