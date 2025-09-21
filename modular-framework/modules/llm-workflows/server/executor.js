const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function sanitizeCwd(cwd) {
  if (!cwd) return undefined;
  // prevent weird characters and traversal outside sandbox assigned
  return cwd.replace(/\0/g,'').trim();
}

function execBash({ cmd, cwd, env, timeoutMs=20000 }, onStdout, onStderr) {
  return new Promise((resolve) => {
    const child = spawn('bash', ['-lc', cmd], { cwd: cwd || undefined, env: { ...process.env, ...(env||{}) } });
    let killed = false;
    const timer = setTimeout(()=> { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => onStdout?.(d.toString()));
    child.stderr.on('data', d => onStderr?.(d.toString()));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, killed });
    });
  });
}

function execPython({ script, cwd, env, timeoutMs=20000 }, onStdout, onStderr) {
  return new Promise((resolve) => {
    const child = spawn('python3', ['-c', script], { cwd: cwd || undefined, env: { ...process.env, ...(env||{}) } });
    let killed = false;
    const timer = setTimeout(()=> { killed = true; child.kill('SIGKILL'); }, timeoutMs);
    child.stdout.on('data', d => onStdout?.(d.toString()));
    child.stderr.on('data', d => onStderr?.(d.toString()));
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, killed });
    });
  });
}

function writeFileSafe({ baseDir, filePath, content }) {
  const rel = filePath.replace(/^~\//, '');
  const safePath = path.normalize(path.join(baseDir, rel));
  if (!safePath.startsWith(baseDir)) {
    throw new Error('Path traversal not allowed');
  }
  fs.mkdirSync(path.dirname(safePath), { recursive: true });
  fs.writeFileSync(safePath, content);
  return safePath;
}

module.exports = { execBash, execPython, writeFileSafe, sanitizeCwd };

