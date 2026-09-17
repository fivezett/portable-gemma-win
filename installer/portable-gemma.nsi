; portable-gemma-win インストーラ
;
; 管理者権限は要求しない。既定で %LOCALAPPDATA% に入れるため、
; インストール後もフォルダごと USB などにコピーして持ち運べる。
;
; ビルド: makensis -DSTAGING=<staging dir> -DVERSION=<version> portable-gemma.nsi

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

!define MUI_WELCOMEPAGE_TITLE "${APPNAME} のセットアップ"
!define MUI_WELCOMEPAGE_TEXT "ローカルで動く Gemma 4 (llama.cpp / CUDA) を MCP サーバーとして使えるようにします。$\r$\n$\r$\nこのインストーラは管理者権限を必要とせず、レジストリもアンインストール情報しか書き込みません。$\r$\n$\r$\n必要なもの:$\r$\n  ・NVIDIA のグラフィックスドライバ (CUDA Toolkit は不要)$\r$\n  ・モデル取得用のインターネット接続 (数 GB)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

!define MUI_FINISHPAGE_TITLE "セットアップが完了しました"
!define MUI_FINISHPAGE_TEXT "MCP クライアントに登録するための設定は $INSTDIR\mcp-config.json に書き出しました。$\r$\n$\r$\n登録手順は docs\MCP.md を参照してください。"
!define MUI_FINISHPAGE_RUN "$INSTDIR\gemma-mcp.exe"
!define MUI_FINISHPAGE_RUN_PARAMETERS "doctor"
!define MUI_FINISHPAGE_RUN_TEXT "環境診断 (doctor) を実行する"
!define MUI_FINISHPAGE_SHOWREADME "$INSTDIR\docs\MCP.md"
!define MUI_FINISHPAGE_SHOWREADME_TEXT "MCP クライアントへの登録手順を開く"
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "Japanese"
!insertmacro MUI_LANGUAGE "English"

Var PowerShell

Function .onInit
  StrCpy $PowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
FunctionEnd

Section "本体 (必須)" SEC_CORE
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
  ; 既存の設定は上書きしない
  ${IfNot} ${FileExists} "$INSTDIR\config\gemma.toml"
    CopyFiles /SILENT "$INSTDIR\config\gemma.toml.example" "$INSTDIR\config\gemma.toml"
  ${EndIf}

  CreateDirectory "$INSTDIR\models"
  CreateDirectory "$INSTDIR\logs"
  CreateDirectory "$INSTDIR\runtime"

  ; MCP クライアント用の設定 JSON を書き出す
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

Section "llama.cpp ランタイムを取得 (約 300 MB)" SEC_RUNTIME
  DetailPrint "llama.cpp の Windows バイナリを取得しています..."
  nsExec::ExecToLog '"$PowerShell" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\fetch-runtime.ps1"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "ランタイムの取得に失敗しました。インストール後に scripts\fetch-runtime.ps1 を手動で実行してください。"
  ${EndIf}
SectionEnd

Section /o "Gemma モデルを取得 (数 GB)" SEC_MODEL
  DetailPrint "Gemma の GGUF を取得しています。回線によっては数十分かかります..."
  nsExec::ExecToLog '"$PowerShell" -NoProfile -ExecutionPolicy Bypass -File "$INSTDIR\scripts\fetch-model.ps1"'
  Pop $0
  ${If} $0 != 0
    DetailPrint "モデルの取得に失敗しました。初回のツール呼び出し時に自動でダウンロードされます。"
  ${EndIf}
SectionEnd

Section "スタートメニューに登録" SEC_SHORTCUT
  CreateDirectory "$SMPROGRAMS\${APPNAME}"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\環境診断 (doctor).lnk" "$INSTDIR\gemma-mcp.exe" "doctor"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\llama-server を起動.lnk" "$INSTDIR\scripts\start-llama-server.cmd"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\インストール先を開く.lnk" "$INSTDIR"
  CreateShortcut "$SMPROGRAMS\${APPNAME}\アンインストール.lnk" "$INSTDIR\uninstall.exe"
SectionEnd

!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_CORE} "gemma-mcp.exe 本体、スクリプト、設定テンプレート、ドキュメント。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_RUNTIME} "llama.cpp の Windows CUDA ビルドと CUDA ランタイム DLL を GitHub から取得します。GPU 世代を見て CUDA 13 / 12 を自動で選びます。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_MODEL} "Gemma 4 の GGUF を models\ に取得します。外したままでも、初回のツール呼び出し時に自動でダウンロードされます。"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_SHORTCUT} "スタートメニューにショートカットを作成します。"
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

  ; models\ と config\gemma.toml はユーザーの資産なので確認してから消す
  ${If} ${FileExists} "$INSTDIR\models\*.*"
    MessageBox MB_YESNO|MB_ICONQUESTION "ダウンロード済みのモデル (models フォルダ) も削除しますか?$\r$\n再取得には数 GB のダウンロードが必要です。" IDNO SkipModels
      RMDir /r "$INSTDIR\models"
    SkipModels:
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\config\gemma.toml"
    MessageBox MB_YESNO|MB_ICONQUESTION "設定ファイル (config\gemma.toml) も削除しますか?" IDNO SkipConfig
      RMDir /r "$INSTDIR\config"
    SkipConfig:
  ${EndIf}

  RMDir "$INSTDIR"
  RMDir /r "$SMPROGRAMS\${APPNAME}"
  DeleteRegKey HKCU "${REGKEY}"
  DeleteRegKey HKCU "Software\${SHORTNAME}"
SectionEnd
