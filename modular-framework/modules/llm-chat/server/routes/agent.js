const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const router = express.Router();

const ENABLED = process.env.AGENT_ENABLE === '1';

function runBash(code, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const proc = spawn('/bin/bash', ['-lc', code], { cwd: cwd || process.cwd(), env: process.env });
    let out = '', err = '';
    const to = setTimeout(()=> { try { proc.kill('SIGKILL'); } catch {} }, (timeoutSec||60)*1000);
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', (code) => { clearTimeout(to); resolve({ exitCode: code ?? -1, stdout: out, stderr: err }); });
  });
}
function runPython(code, cwd, timeoutSec) {
  return new Promise((resolve) => {
    const proc = spawn('python', ['-'], { cwd: cwd || process.cwd(), env: process.env, stdio: ['pipe','pipe','pipe'] });
    let out = '', err = '';
    const to = setTimeout(()=> { try { proc.kill('SIGKILL'); } catch {} }, (timeoutSec||60)*1000);
    proc.stdout.on('data', d => out += d.toString());
    proc.stderr.on('data', d => err += d.toString());
    proc.on('close', (code) => { clearTimeout(to); resolve({ exitCode: code ?? -1, stdout: out, stderr: err }); });
    proc.stdin.write(code || '');
    proc.stdin.end();
  });
}

router.post('/agent/execute', async (req, res) => {
  if (!ENABLED) return res.status(403).json({ ok:false, error:'Agent execution disabled. Set AGENT_ENABLE=1 to enable.' });
  const { kind, code, cwd, timeoutSec } = req.body || {};
  if (!kind || !code) return res.status(400).json({ ok:false, error:'kind and code required' });

  try {
    let result;
    if (kind === 'bash') result = await runBash(String(code), cwd, Number(timeoutSec||60));
    else if (kind === 'python') result = await runPython(String(code), cwd, Number(timeoutSec||60));
    else return res.status(400).json({ ok:false, error:'Unsupported kind' });

    res.json({ ok:true, ...result });
  } catch (e) {
    res.status(500).json({ ok:false, error: e?.message || 'execution error' });
  }
});

module.exports = { router };