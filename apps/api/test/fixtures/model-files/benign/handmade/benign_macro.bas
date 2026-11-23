Sub Workbook_Open()
    Dim d As Object
    Set d = CreateObject("Scripting.Dictionary")
    d.Add "a", 1
    Sheets("Sheet1").Range("A1").Value = Environ("USERNAME")
End Sub
