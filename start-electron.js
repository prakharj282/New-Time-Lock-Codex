// Launcher script - strips ELECTRON_RUN_AS_NODE so electron runs as a proper app
delete process.env.ELECTRON_RUN_AS_NODE;
const { spawn } = require('child_process');
const electronPath = require('electron');
const env = Object.assign({}, process.env);
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(String(electronPath), ['.'], {
    stdio: 'inherit',
    env: env,
    cwd: __dirname
});
child.on('close', (code) => process.exit(code));
