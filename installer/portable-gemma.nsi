;  portable-gemma-win installer
;
; Never asks for administrator rights. It installs into %LOCALAPPDATA% by default, so the
; folder stays copyable to a USB stick after installation.
;
; Build: makensis -DSTAGING=<staging dir> -DVERSION=<version> portable-gemma.nsi

Unicode true

!ifndef VERSION
  !define VERSION "0.1.0"
!endif
!ifndef STAGING
  !define STAGING "..\build\staging"
!endif

!define APPNAME "Portable Gemma"
!define SHORTNAME "PortableGemma"
!define PUBLISHER "portable-gemma-win"
!define REGKEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\${SHORTNAME}"

Name "${APPNAME} ${VERSION}"
OutFile "..\dist\portable-gemma-setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\${SHORTNAME}"
InstallDirRegKey HKCU "Software\${SHORTNAME}" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show
ShowUnInstDetails show

!include "MUI2.nsh"
!include "LogicLib.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!define MUI_WELCOMEPAGE_TITLE "${APPNAME} Setup"
!define MUI_WELCOMEPAGE_TEXT "Sets up Gemma 4 running locally through llama.cpp on CUDA, served over MCP.$\r$\n$\r$\nNo administrator rights are needed, and the only registry keys written are the uninstall entries.$\r$\n$\r$\nRequirements:$\r$\n  - An NVIDIA graphics driver (no CUDA Toolkit)$\r$\n  - Internet access to download the model (several GB)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "Setup complete"
!define MUI_FINISHPAGE_TEXT "The configuration for your MCP client was written to $INSTDIR\mcp-config.json.$\r$\n$\r$\nSee docs\MCP.md for how to register it."
!define MUI_FINISHPAGE_RUN "$INSTDIR\gemma-mcp.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "doctor"
!define MUI_FINISHPAGE_RUN_TEXT "Run the environment check (doctor)"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\docs\MCP.md"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "Open the MCP client setup guide"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

Var PowerShell

Function .onInit
  StrCpy $PowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
FunctionEnd

Section "Core (required)" SEC_CORE
  SectionIn RO
  SetOutPath "$INSTDIR"

  File "${STAGING}\gemma-mcp.exe"
  File "${STAGING}\README.md"

  SetOutPath "$INSTDIR\scripts"
  File /r "${STAGING}\scripts\*.*"

  SetOutPath "$INSTDIR\docs"
  File /r "${STAGING}\docs\*.*"

  SetOutPath "$INSTDIR\config"
  File "${STAGING}\config\gemma.toml.example"
  ; Never overwrite an existing configuration.
  ${IfNot} ${FileExists} "$INSTDIR\config\gemma.toml"
    CopyFiles /SILENT "$INSTDIR\config\gemma.toml.example" "$INSTDIR\config\gemma.toml"
  ${EndIf}

  CreateDirectory "$INSTDIR\models"
  CreateDirectory "$INSTDIR\logs"
  CreateDirectory "$INSTDIR\runtime"

  ; Write out the JSON snippet for MCP clients.
  SetOutPath "$INSTDIR"
  nsExec::ExecToStack '"$INSTDIR\gemma-mcp.exe" print-config'
  Pop $0
  Pop $1
  ${If} $0 == 0
    FileOpen $2 "$INSTDIR\mcp-config.json" w
    FileWrite $2 $1
    FileClose $2
  ${EndIf}

  WriteRegStr HKCU "Software\${SHORTNAME}" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "${REGKEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${REGKEY}" "Publisher" "${PUBLISHER}"
  WriteRegStr HKCU "${REGKEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${REGKEY}" "UninstallString" '"$INSTDIR\uninstall.exe"'
  WriteRegDWORD HKCU "${REGKEY}" "NoModify" 1
  WriteRegDWORD HKCU "${REGKEY}" "NoRepair" 1

  WriteUninstaller "$INSTDIR\uninstall.exe"
SectionEnd

Section "Download the llama.cpp runtime (~300 MB)" SEC_RUNTIME
  DetailPrint "Downloading the llama.cpp Windows binaries..."
  nsExec::ExecToLog '"$PowerShell" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\fetch-runtime.ps1"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Runtime download failed. Run scripts\fetch-runtime.ps1 by hand after installation."
  ${EndIf}
SectionEnd

Section /o "Download the Gemma model (several GB)" SEC_MODEL
  DetailPrint "Downloading the Gemma GGUF. On a slow line this takes tens of minutes..."
  nsExec::ExecToLog '"$PowerShell" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\fetch-model.ps1"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "Model download failed. It will be fetched on the first tool call instead."
  ${EndIf}
SectionEnd

Section "Start menu shortcuts" SEC_SHORTCUT
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Environment check (doctor).lnk" "$INSTDIR\gemma-mcp.exe" "doctor"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Start llama-server.lnk" "$INSTDIR\scripts\start-llama-server.cmd"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Open install folder.lnk" "$INSTDIR"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\Uninstall.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "The gemma-mcp.exe server, scripts, configuration template and documentation."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_RUNTIME} "Downloads the llama.cpp Windows CUDA build and the CUDA runtime DLLs from GitHub, picking CUDA 13 or 12 based on the GPU."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MODEL} "Downloads the Gemma 4 GGUF into models\. Leave it off and the model is fetched on the first tool call instead."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SHORTCUT} "Creates shortcuts in the Start menu."
!insertmacro MUI_FUNCTION_DESCRIPTION_END

Section "Uninstall"
  Delete "$INSTDIR\gemma-mcp.exe"
  Delete "$INSTDIR\README.md"
  Delete "$INSTDIR\mcp-config.json"
  Delete "$INSTDIR\uninstall.exe"
  RMDir /r "$INSTDIR\scripts"
  RMDir /r "$INSTDIR\docs"
  RMDir /r "$INSTDIR\runtime"
  RMDir /r "$INSTDIR\logs"

  ; models\ and config\gemma.toml belong to the user, so ask before deleting them.
  ${If} ${FileExists} "$INSTDIR\models\*.*"
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete the downloaded models (the models folder)?$\r$\nGetting them back means downloading several GB again." IDNO SkipModels
      RMDir /r "$INSTDIR\models"
    SkipModels:
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\config\gemma.toml"
    MessageBox MB_YESNO|MB_ICONQUESTION "Also delete the configuration file (config\gemma.toml)?" IDNO SkipConfig
      RMDir /r "$INSTDIR\config"
    SkipConfig:
  ${EndIf}

  RMDir "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey HKCU "Software\${SHORTNAME}"
SectionEnd
