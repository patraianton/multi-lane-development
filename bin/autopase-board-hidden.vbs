' Запускает доску без окна консоли (для автозапуска при входе в Windows).
Set fso = CreateObject("Scripting.FileSystemObject")
serverPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\autopase-board.mjs"
CreateObject("Wscript.Shell").Run "node """ & serverPath & """", 0, False
