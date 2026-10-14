@echo off
rem 鲸鱼桌宠 —— 真实启动脚本：由「启动桌宠.vbs」在后台调用，也可以直接双击运行（会多开一个窗口）
rem 日志：data\pet-run.log
rem 注意：本文件必须是 ANSI/GBK 编码。存成 UTF-8 时 cmd 会按 GBK 解码，注释里的多字节汉字
rem 可能把行尾吃掉、把下一行并进注释里（比如把 set 那行并掉），命令就没执行——启动会静默失败。

cd /d "%~dp0"

rem 环境变量里如果带着 ELECTRON_RUN_AS_NODE（VS Code / Code Runner 之类的地方跑脚本时会继承下来），
rem electron.exe 就把自己当纯 Node 执行：app.commandLine 是 undefined，启动直接报错。
rem cmd 里 set "VAR=" 等于删掉这个变量（置空），Electron 就不会误判了。
set "ELECTRON_RUN_AS_NODE="

rem 已经在跑的时候：别再抢日志文件。底下那行重定向是独占打开的，会被在跑的实例一直握着，
rem 第二次启动就卡在这一行报"另一个程序正在使用此文件"。这里改成不写日志地再起一次——
rem Electron 的单实例机制会把已经在跑的那只叫到最前，新起的这个自己退出，
rem 所以看起来就是"再点一下，鲸鱼冒出来"。
tasklist /fi "imagename eq electron.exe" /nh 2>nul | find /i "electron.exe" >nul
if not errorlevel 1 (
  echo 桌宠已经在运行，已把它叫到最前。
  node_modules\electron\dist\electron.exe . >nul 2>&1
  exit /b 0
)

node_modules\electron\dist\electron.exe . --remote-debugging-port=9333 > data\pet-run.log 2>&1