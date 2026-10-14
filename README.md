# Blub 🐋

一只常驻 Windows 桌面的**深海蓝鲸**。它盯着你的编码 agent、认得你的脸、会陪你打哈欠。

> Blub 是一只用 Electron 写的桌面宠物：透明置顶小窗 + 纯 SVG 几何鲸鱼，接上你的 agent 状态就活起来了。

## 它会做什么

- **映射 agent 状态**：连接本地 agent 服务（默认 `http://127.0.0.1:3080`），把 idle / thinking / tool / approval / done / error 翻译成鲸鱼动作——思考时头顶冒问号、干完活跃出水面、出错翻肚皮冒蒸汽。
- **认主**：用摄像头做本地人脸识别（[human](https://github.com/vladmandic/human) + tfjs-wasm，全程本地推理，不上传任何画面）。第一次见你要"认主仪式"，之后只有主人在场才会解锁亲昵动作。
- **情绪陪伴**：观察你的表情，检测哈欠/说话/托下巴；你打哈欠它会跟着打。
- **看家**：你离开时它替你盯着屏幕，回来会汇报这段时间发生了什么。
- **会议纪要**：旁听会议生成逐句记录（本地）。
- **换装**：给它戴帽子、换配色。
- **托盘常驻**：单击显示/隐藏，双击鲸鱼打开面板。

## 运行

### 方式一：安装包（推荐）

到 [Releases](https://github.com/JingRC/blub/releases) 下载 `Blub-Setup-x.x.x.exe`，双击安装。

### 方式二：从源码跑

```sh
git clone https://github.com/JingRC/blub.git
cd blub
npm install
npm start
```

## 首次启动

第一次打开会弹**初次设置向导**：

1. 配置视觉/文本大模型的 API（OpenAI 兼容格式，密钥存在本地 `data/api-keys.json`，不进版本库）
2. 给鲸鱼起名、填你的昵称
3. 测试连接

跳过也可以用，只是情绪识别等联网功能不可用。

## 隐私

- **人脸数据不出机器**：认主参考照（`data/owner.json`）、人脸样本全部只存本地，推理用 WASM 在本地跑。
- **API 密钥本地保存**：`data/api-keys.json` 已被 `.gitignore` 排除。
- **摄像头画面不留存**：截帧只用于当下推理，不落盘。

## 架构

```
main.js          主进程：窗口/托盘/IPC/状态编排（95KB 的那位）
preload.js       contextBridge：暴露 window.dshPet 给渲染层
emotion.js       情绪引擎：人脸检测 + 云端情绪判定 + 行为闸门
dsh-client.js    agent 状态 client（Node fetch + ws）
providers.js     大模型厂商配置
ask-hub.js       会议"秒答"：本地知识包 + 白名单检索（可选，缺知识包也能跑）
renderer/        鲸鱼 SVG、动画、气泡 UI、初次设置向导
calib/           独立的标定工具（`npm run calib`）
```

## License

[MIT](LICENSE)
