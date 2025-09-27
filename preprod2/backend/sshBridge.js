
import { Client } from 'ssh2';
// Simple POSIX join to avoid pulling in 'path'
const joinPosix = (a, b) => (a.endsWith('/') ? a.slice(0, -1) : a) + '/' + b;

function getSftp(client) {
  return new Promise((resolve, reject) => {
    client.sftp((err, sftp) => (err ? reject(err) : resolve(sftp)));
  });
}

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

export async function listTree(client, rootPath, depth = 2) {
  const maxDepth = Math.max(0, Math.min(5, depth));
  const sftp = await getSftp(client);

  async function walk(path, d) {
    const out = {};
    let entries = [];
    try {
      entries = await readdirAsync(sftp, path);
    } catch (e) {
      // If directory cannot be read, return empty
      return out;
    }
    for (const e of entries) {
      const name = e.filename;
      if (!name || name === '.' || name === '..') continue;
      try {
        if (e.attrs?.isDirectory?.()) {
          if (d > 0) {
            out[name] = { type: 'folder', children: await walk(joinPosix(path, name), d - 1) };
          } else {
            out[name] = { type: 'folder', children: {} };
          }
        } else if (e.attrs?.isFile?.()) {
          out[name] = { type: 'file', size: Number(e.attrs?.size || 0), mtime: Number(e.attrs?.mtime || 0) };
        } else {
          // Skip symlinks and special for now
        }
      } catch {
        // Skip problematic entries
      }
    }
    return out;
  }

  return await walk(rootPath || '/', maxDepth);
}

export async function readFileContent(client, remotePath) {
  const sftp = await getSftp(client);
  return new Promise((resolve, reject) => {
    const chunks = [];
    try {
      const rs = sftp.createReadStream(remotePath, { encoding: 'utf8' });
      rs.on('data', (c) => chunks.push(c));
      rs.on('error', (e) => reject(new Error(e?.message || 'SFTP read error')));
      rs.on('end', () => resolve(chunks.join('')));
    } catch (e) {
      reject(new Error(e?.message || 'SFTP read error'));
    }
  });
}

function readdirAsync(sftp, p) {
  return new Promise((resolve, reject) => {
    sftp.readdir(p, (err, list) => (err ? reject(err) : resolve(list || [])));
  });
}

export function closeSession(client, stream) {
  try { stream.end(); } catch {}
  try { client.end(); } catch {}
}


// --- SFTP helpers ---
function isDirFromMode(mode) {
  // POSIX file type bits
  const S_IFMT = 0o170000;
  const S_IFDIR = 0o040000;
  return ((mode & S_IFMT) === S_IFDIR);
}

export function sftpListRecursive(sftp, basePath, depth = 1) {
  return new Promise((resolve, reject) => {
    sftp.readdir(basePath, async (err, list) => {
      if (err) return reject(err);
      try {
        const entries = await Promise.all(list.map(async (e) => {
          const name = e.filename;
          const full = basePath.endsWith('/') ? (basePath + name) : (basePath + '/' + name);
          const isDir = e?.attrs?.mode ? isDirFromMode(e.attrs.mode) : (e.longname?.startsWith('d'));
          if (isDir && depth > 0) {
            const children = await sftpListRecursive(sftp, full, depth - 1);
            return [name, { type: 'folder', children }];
          }
          return [name, { type: 'file', size: Number(e?.attrs?.size ?? 0) }];
        }));
        const obj = {};
        for (const [k, v] of entries) obj[k] = v;
        resolve(obj);
      } catch (e2) {
        reject(e2);
      }
    });
  });
}

export function sftpReadFile(sftp, path, maxBytes = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    sftp.open(path, 'r', (err, handle) => {
      if (err) return reject(err);
      const chunks = [];
      const buf = Buffer.alloc(32768);
      let pos = 0;

      function readNext() {
        sftp.read(handle, buf, 0, buf.length, pos, (err2, bytesRead, buffer) => {
          if (err2) {
            return sftp.close(handle, () => reject(err2));
          }
          if (bytesRead > 0) {
            chunks.push(buffer.slice(0, bytesRead));
            pos += bytesRead;
            if (pos >= maxBytes) {
              return sftp.close(handle, () => resolve(Buffer.concat(chunks).toString('utf8')));
            }
            return readNext();
          }
          sftp.close(handle, () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
      }

      readNext();
    });
  });
}
  