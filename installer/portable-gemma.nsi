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
!include "Sections.nsh"

!define MUI_ABORTWARNING
!define MUI_ICON "${NSISDIR}\Contrib\Graphics\Icons\modern-install.ico"
!define MUI_UNICON "${NSISDIR}\Contrib\Graphics\Icons\modern-uninstall.ico"

!define MUI_WELCOMEPAGE_TITLE "${APPNAME} Setup"
!define MUI_WELCOMEPAGE_TEXT "Sets up Gemma 4 running locally through llama.cpp, served over MCP.$\r$\n$\r$\nThe next page picks the inference runtime: CUDA for NVIDIA cards, or OpenVINO for Intel CPUs, integrated and Arc GPUs, and NPUs. Your hardware decides which one is preselected.$\r$\n$\r$\nNo administrator rights are needed, and the only registry keys written are the uninstall entries.$\r$\n$\r$\nRequirements:$\r$\n  - A graphics driver (no CUDA Toolkit, no OpenVINO install)$\r$\n  - Internet access to download the runtime and the model"

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
; Index of the selected runtime section, for the radio-button behaviour below.
Var RuntimeChoice

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

SectionGroup /e "Inference runtime" SECGRP_RUNTIME

  Section "NVIDIA - CUDA (~300 MB)" SEC_CUDA
    DetailPrint "Downloading the llama.cpp CUDA build..."
    nsExec::ExecToLog '"$PowerShell" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\fetch-runtime.ps1"'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Runtime download failed. Run scripts\fetch-runtime.ps1 by hand after installation."
    ${Else}
      ; Point the configuration at what was just installed, so nothing else is needed.
      nsExec::ExecToLog '"$INSTDIR\gemma-mcp.exe" set-backend cuda'
      Pop $0
    ${EndIf}
  SectionEnd

  Section /o "Intel - OpenVINO (~75 MB)" SEC_OPENVINO
    DetailPrint "Downloading the llama.cpp OpenVINO build..."
    nsExec::ExecToLog '"$PowerShell" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\fetch-runtime.ps1" -Backend openvino'
    Pop $0
    ${If} $0 != 0
      DetailPrint "Runtime download failed. Run scripts\fetch-runtime.ps1 -Backend openvino by hand after installation."
    ${Else}
      nsExec::ExecToLog '"$INSTDIR\gemma-mcp.exe" set-backend openvino'
      Pop $0
    ${EndIf}
  SectionEnd

  Section /o "Skip - install a runtime later" SEC_NO_RUNTIME
    DetailPrint "No runtime installed. Run scripts\fetch-runtime.ps1 when you are ready."
  SectionEnd

SectionGroupEnd

Function .onInit
  StrCpy $PowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"

  ; Preselect by hardware: an NVIDIA driver answers nvidia-smi, and anything else is
  ; better served by OpenVINO, which also runs on plain CPUs.
  nsExec::ExecToStack 'nvidia-smi --query-gpu=name --format=csv,noheader'
  Pop $0
  ${If} $0 == 0
    StrCpy $RuntimeChoice ${SEC_CUDA}
    !insertmacro SelectSection ${SEC_CUDA}
    !insertmacro UnselectSection ${SEC_OPENVINO}
  ${Else}
    StrCpy $RuntimeChoice ${SEC_OPENVINO}
    !insertmacro UnselectSection ${SEC_CUDA}
    !insertmacro SelectSection ${SEC_OPENVINO}
  ${EndIf}
FunctionEnd

; Exactly one runtime at a time. Skip is a real option: the runtime can be fetched later
; with scripts\fetch-runtime.ps1.
Function .onSelChange
  !insertmacro StartRadioButtons $RuntimeChoice
    !insertmacro RadioButton ${SEC_CUDA}
    !insertmacro RadioButton ${SEC_OPENVINO}
    !insertmacro RadioButton ${SEC_NO_RUNTIME}
  !insertmacro EndRadioButtons
FunctionEnd

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
  !insertmacro MUI_DESCRIPTION_TEXT ${SECGRP_RUNTIME} "Which llama.cpp build to install. Pick the one matching your hardware; the selection is written to config\gemma.toml."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CUDA} "For NVIDIA cards. Downloads the official llama.cpp Windows CUDA build with its runtime DLLs, choosing CUDA 13 or 12 from the GPU's compute capability. Needs Turing (GTX 1600 / RTX 2000) or newer for CUDA 13."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_OPENVINO} "For Intel CPUs, integrated and Arc GPUs, and NPUs. Downloads the OpenVINO build produced by this project, since upstream ships none for Windows."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_NO_RUNTIME} "Installs no runtime. Use scripts\fetch-runtime.ps1 later, then gemma-mcp.exe set-backend."
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MODEL} "Downloads the Gemma 4 GGUF into models\, using the quantisation that suits the chosen runtime. Leave it off and the model is fetched on the first tool call instead."
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
