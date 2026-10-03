// 一键打包：pnpm dist
// 自动使用国内镜像下载 Electron，并在打包后精简语言包
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://npmmirror.com/mirrors/electron/';

const fs = require('fs');
const path = require('path');
const packager = require('@electron/packager').packager;

const APP_NAME = '时光轴';
const KEEP_LOCALES = ['zh-CN.pak', 'en-US.pak'];

packager({
  dir: __dirname,
  name: APP_NAME,
  platform: 'win32',
  arch: 'x64',
  out: path.join(__dirname, 'dist'),
  overwrite: true,
  icon: path.join(__dirname, 'build', 'icon.ico'),
  asar: true,
  appVersion: require('./package.json').version,
  ignore: [/^\/(dist|node_modules|\.npmrc|pnpm-workspace\.yaml|pnpm-lock\.yaml|pack\.js|README\.md|docs)($|\/)/]
}).then(function (paths) {
  const outDir = paths[0];
  const loc = path.join(outDir, 'locales');
  let removed = 0;
  if (fs.existsSync(loc)) {
    fs.readdirSync(loc).forEach(function (f) {
      if (KEEP_LOCALES.indexOf(f) < 0) { fs.unlinkSync(path.join(loc, f)); removed++; }
    });
  }
  let total = 0;
  (function walk(d) {
    fs.readdirSync(d).forEach(function (f) {
      const fp = path.join(d, f);
      const st = fs.statSync(fp);
      if (st.isDirectory()) walk(fp); else total += st.size;
    });
  })(outDir);
  console.log('');
  console.log('打包完成 -> ' + outDir);
  console.log('精简语言包: ' + removed + ' 个');
  console.log('程序体积: ' + (total / 1024 / 1024).toFixed(1) + ' MB');
}).catch(function (e) {
  console.error('打包失败:', e);
  process.exit(1);
});