' Starts Watchtower with no console window (for autostart on logon).
Set fso = CreateObject("Scripting.FileSystemObject")
serverPath = fso.GetParentFolderName(WScript.ScriptFullName) & "\watchtower.mjs"
CreateObject("Wscript.Shell").Run "node """ & serverPath & """", 0, False
