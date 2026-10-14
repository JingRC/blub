// 生成安装包 / 桌面 / 任务栏用的 .ico 图标（从 assets/tray.png 放大重绘）。
// 用法：node scripts/build-icon.js
// 产出：build/icon.ico（多尺寸 256/128/64/48/32/16）+ build/icon.png（512，预览用）
//
// tray.png 只有 32x32，直接放大会糊；这里用 sharp 做两步：
//   1. 放大到 512，加圆角透明底（和桌宠窗口的深蓝底呼应）
//   2. 缩到各尺寸，拼成 .ico
const sharp = require("sharp");
const toIco = require("png-to-ico").default || require("png-to-ico");
const path = require("path");
const fs = require("fs");

const SRC = path.join(__dirname, "..", "assets", "tray.png");
const OUT_DIR = path.join(__dirname, "..", "build");
const OUT_ICO = path.join(OUT_DIR, "icon.ico");
const OUT_PNG = path.join(OUT_DIR, "icon.png");

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });

  // 1. 放大 + 深蓝圆角背景，让白色鲸鱼在任务栏上也看得清
  const big = await sharp(SRC)
    .resize(512, 512, { kernel: sharp.kernel.lanczos3 }) // 先无损放大（lanczos）
    .flatten({ background: "#0b1622" })                  // 深蓝底
    .png()
    .toBuffer();

  // 2. 512 预览
  fs.writeFileSync(OUT_PNG, big);

  // 3. 各尺寸 PNG
  const sizes = [256, 128, 64, 48, 32, 16];
  const layers = await Promise.all(
    sizes.map((s) =>
      sharp(big).resize(s, s, { kernel: sharp.kernel.lanczos3 }).png().toBuffer()
    )
  );

  // 4. 拼 ico
  const ico = await toIco(layers);
  fs.writeFileSync(OUT_ICO, ico);
  console.log(`✅ icon.ico 生成成功：${OUT_ICO}`);
  console.log(`   预览 icon.png：${OUT_PNG}`);
}

main().catch((e) => {
  console.error("图标生成失败：", e);
  process.exit(1);
});