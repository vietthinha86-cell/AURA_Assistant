const { spawn, execSync } = require('child_process');
const path = require('path');

const p = 'D:\\ảnh\\SWT301\\test topic';
console.log('Testing spawn explorer for:', p);

const child = spawn('explorer.exe', [p], { detached: true, stdio: 'ignore' });
child.unref();

setTimeout(() => {
  const psPath = path.join(__dirname, 'check_explorer_windows.ps1');
  const out = execSync(`powershell -ExecutionPolicy Bypass -File "${psPath}"`, { encoding: 'utf8' });
  console.log('Open Explorer Windows:\n' + out);
}, 2500);
