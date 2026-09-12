!define APP_NAME "GSP - GameStablePing"
!define APP_VERSION "0.3.0"
!define APP_PUBLISHER "GSP Team"
!define APP_URL "https://gameapi.anikenji.tech"
!define APP_EXE "GSP.exe"
!define SERVICE_EXE "gsp-service.exe"
!define SERVICE_NAME "GamePingBooster"

Unicode True
RequestExecutionLevel admin

; Modern UI
!include "MUI2.nsh"
!include "FileFunc.nsh"

; General Settings
Name "${APP_NAME}"
OutFile "../dist/gsp-setup.exe"
InstallDir "$PROGRAMFILES64\GSP"
InstallDirRegKey HKLM "Software\GSP" "Install_Dir"

SetCompressor /SOLID zlib
CRCCheck off

; Interface Settings
!define MUI_ABORTWARNING
!define MUI_ICON "../client/favicon.ico"
!define MUI_UNICON "../client/favicon.ico"

; Installer Pages
!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES

; Finish Page: Option to launch app
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP_EXE}"
!define MUI_FINISHPAGE_RUN_TEXT "Khoi chay GSP ngay bay gio"
!insertmacro MUI_PAGE_FINISH

; Uninstaller Pages
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_UNPAGE_FINISH

!insertmacro MUI_LANGUAGE "English"

; -------------------------------------------------------------
; Installer Section
; -------------------------------------------------------------
Section "MainSection" SEC01
    SetOutPath "$INSTDIR"
    SetOverwrite on

    ; Copy Files
    File "../dist/client/GSP.exe"
    File "../dist/client/gsp-service.exe"
    File "../dist/client/wintun.dll"
    File "../dist/client/config.json"
    File "../dist/client/Add-Game.ps1"
    File "../client/favicon.ico"

    ; Copy Profiles
    CreateDirectory "$INSTDIR\profiles"
    SetOutPath "$INSTDIR\profiles"
    File "../dist/client/profiles/pubg-vn.json"

    ; Copy Native Wintun
    CreateDirectory "$INSTDIR\native\wintun"
    SetOutPath "$INSTDIR\native\wintun"
    File "../dist/client/wintun.dll"

    SetOutPath "$INSTDIR"

    ; 1. Pre-install Wintun Driver as SYSTEM
    DetailPrint "Installing Wintun Network Driver..."
    nsExec::ExecToLog '"$INSTDIR\${SERVICE_EXE}" --install-driver'

    ; 2. Register Windows Service
    DetailPrint "Configuring Windows Service..."
    nsExec::ExecToLog 'sc.exe create ${SERVICE_NAME} binPath= ""$INSTDIR\${SERVICE_EXE}"" start= auto obj= LocalSystem DisplayName= "${APP_NAME} Service"'
    nsExec::ExecToLog 'sc.exe description ${SERVICE_NAME} "Dich vu dinh tuyen toi uu giam ping game GSP"'
    nsExec::ExecToLog 'sc.exe start ${SERVICE_NAME}'

    ; 3. Write Registry Keys for Install Dir and Add/Remove Programs
    WriteRegStr HKLM "Software\GSP" "Install_Dir" "$INSTDIR"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP" "DisplayName" "${APP_NAME}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP" "DisplayVersion" "${APP_VERSION}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP" "Publisher" "${APP_PUBLISHER}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP" "URLInfoAbout" "${APP_URL}"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP" "DisplayIcon" "$INSTDIR\${APP_EXE},0"
    WriteRegStr HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP" "UninstallString" '"$INSTDIR\uninstall.exe"'
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP" "NoModify" 1
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP" "NoRepair" 1

    ; Estimate Size
    ${GetSize} "$INSTDIR" "/S=OKB" $0 $1 $2
    IntFmt $0 "0x%08X" $0
    WriteRegDWORD HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP" "EstimatedSize" "$0"

    ; 4. Create Uninstaller
    WriteUninstaller "$INSTDIR\uninstall.exe"

    ; 5. Create Shortcuts
    CreateDirectory "$SMPROGRAMS\GSP"
    CreateShortcut "$SMPROGRAMS\GSP\${APP_NAME}.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\favicon.ico" 0
    CreateShortcut "$SMPROGRAMS\GSP\Uninstall GSP.lnk" "$INSTDIR\uninstall.exe" "" "$INSTDIR\uninstall.exe" 0
    CreateShortcut "$DESKTOP\GSP.lnk" "$INSTDIR\${APP_EXE}" "" "$INSTDIR\favicon.ico" 0

SectionEnd

; -------------------------------------------------------------
; Uninstaller Section
; -------------------------------------------------------------
Section "Uninstall"
    DetailPrint "Stopping and removing GSP Service..."
    nsExec::ExecToLog 'sc.exe stop ${SERVICE_NAME}'
    nsExec::ExecToLog 'sc.exe delete ${SERVICE_NAME}'

    DetailPrint "Stopping running processes..."
    nsExec::ExecToLog 'taskkill.exe /F /IM ${APP_EXE}'
    nsExec::ExecToLog 'taskkill.exe /F /IM ${SERVICE_EXE}'

    DetailPrint "Removing Wintun Driver..."
    nsExec::ExecToLog '"$INSTDIR\${SERVICE_EXE}" --remove-driver'

    ; Delete Files
    Delete "$INSTDIR\GSP.exe"
    Delete "$INSTDIR\gsp-service.exe"
    Delete "$INSTDIR\wintun.dll"
    Delete "$INSTDIR\config.json"
    Delete "$INSTDIR\Add-Game.ps1"
    Delete "$INSTDIR\favicon.ico"
    Delete "$INSTDIR\uninstall.exe"
    Delete "$INSTDIR\profiles\pubg-vn.json"
    Delete "$INSTDIR\native\wintun\wintun.dll"

    RMDir "$INSTDIR\profiles"
    RMDir "$INSTDIR\native\wintun"
    RMDir "$INSTDIR\native"
    RMDir "$INSTDIR"

    ; Delete Shortcuts
    Delete "$DESKTOP\GSP.lnk"
    Delete "$SMPROGRAMS\GSP\${APP_NAME}.lnk"
    Delete "$SMPROGRAMS\GSP\Uninstall GSP.lnk"
    RMDir "$SMPROGRAMS\GSP"

    ; Delete Registry Keys
    DeleteRegKey HKLM "Software\Microsoft\Windows\CurrentVersion\Uninstall\GSP"
    DeleteRegKey HKLM "Software\GSP"

SectionEnd
