// 打包前清理旧产物：删除 macOS bundle 目录里残留的 .dmg，
// 避免「修正 mac 下打包失败」的问题复发（具体原因见 commit 690b22e）。
// 其他平台直接跳过，脚本只依赖 Node 标准库，跨平台一致。
const fs = require('fs');
const path = require('path');

function cleanMacosBundle() {
  const dir = path.join('src-tauri', 'target', 'release', 'bundle', 'macos');
  if (!fs.existsSync(dir)) return;

  for (const entry of fs.readdirSync(dir)) {
    if (entry.endsWith('.dmg')) {
      try {
        fs.rmSync(path.join(dir, entry), { force: true });
        console.log(`[clean-bundle] removed ${entry}`);
      } catch (err) {
        // 最佳努力：清理失败不阻塞打包
        console.warn(`[clean-bundle] skip ${entry}: ${err.message}`);
      }
    }
  }
}

try {
  cleanMacosBundle();
} catch (err) {
  // 整段失败也吞掉 —— 打包才是正事
  console.warn(`[clean-bundle] aborted: ${err.message}`);
}