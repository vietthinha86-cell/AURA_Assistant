const { spawn } = require('child_process');
const path = require('path');

const projectRoot = path.resolve(__dirname);
const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe');

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
delete env.ELECTRON_NO_ASAR;

console.log('Launching Electron Step 6 Autotest...');
const proc = spawn(electronPath, ['.', '--autotest-step6'], {
  cwd: projectRoot,
  env,
  stdio: 'inherit'
});

proc.on('close', (code) => {
  console.log(`Electron process exited with code ${code}`);
  process.exit(code || 0);
});

