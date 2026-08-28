!macro NSIS_HOOK_PREUNINSTALL
  ; 0.3.18: 壳启动自检会把快捷方式改成中文名,卸载时一并清理
  Delete "$DESKTOP\看板助手.lnk"
  Delete "$SMPROGRAMS\看板助手.lnk"
!macroend
