; Flowstate uninstaller: always removes the app and its autostart entry, then
; asks what to do with config + history. The Parakeet model in
; %LOCALAPPDATA%\flowstate\models is large and stays unless the user says no.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "Flowstate"
  ${ifNot} ${Silent}
    MessageBox MB_YESNO|MB_ICONQUESTION "Flowstate has been removed.$\r$\n$\r$\nKeep your settings, dictionary, snippets and history in:$\r$\n$APPDATA\flowstate$\r$\n$\r$\nYes = keep them (a reinstall picks up where you left off).$\r$\nNo = delete them permanently." IDYES keepData
    RMDir /r "$APPDATA\flowstate"
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete the downloaded speech model (about 600 MB) in:$\r$\n$LOCALAPPDATA\flowstate\models$\r$\n$\r$\nYes = delete it.  No = keep it." IDNO keepData
    RMDir /r "$LOCALAPPDATA\flowstate\models"
    keepData:
  ${endIf}
!macroend
