import { Client } from 'ssh2';

export function connectSSH({ host, port = 22, username, authMethod, password, privateKey, passphrase }) {
  return new Promise((resolve, reject) => {
    const client = new Client();

    const cfg = { host, port, username, tryKeyboard: false, readyTimeout: 20000 };
    if (authMethod === 'password') cfg.password = password;
    else if (authMethod === 'key') {
      cfg.privateKey = Buffer.from(privateKey || '', 'utf8');
      if (passphrase) cfg.passphrase = passphrase;
    } else return reject(new Error('Unsupported authMethod'));

    client.on('ready', () => {
      client.shell({ term: 'xterm-256color', cols: 120, rows: 32 }, (err, stream) => {
        if (err) { client.end(); return reject(err); }
        resolve({ client, stream });
      });
    });

    client.on('error', (e) => reject(new Error(e?.message || 'SSH error')));
    client.connect(cfg);
  });
}

export function resizePty(stream, cols, rows) {
  try { stream.setWindow(rows, cols, 600, 800); } catch {}
}

export function closeSession(client, stream) {
  try { stream.end(); } catch {}
  try { client.end(); } catch {}
}
