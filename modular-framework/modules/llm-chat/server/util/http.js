function isReadable(x) { return x && typeof x.pipe === 'function'; }

async function readUpstreamBody(data) {
  if (!data) return '';
  if (typeof data === 'string') return data;
  if (isReadable(data)) {
    return await new Promise((resolve) => {
      let buf = '';
      try {
        data.setEncoding('utf8');
        data.on('data', (c) => buf += c);
        data.on('end', () => resolve(buf));
        data.on('error', () => resolve('[error reading upstream stream]'));
      } catch {
        resolve('[unreadable upstream stream]');
      }
    });
  }
  try { return JSON.stringify(data); } catch { return '[unstringifiable upstream data]'; }
}

async function extractErrAsync(err) {
  const status = err?.response?.status;
  const body = await readUpstreamBody(err?.response?.data);
  const baseMsg = err?.message || 'Unknown error';
  const trimmed = body ? body.slice(0, 4000) : '';
  return status ? `Upstream ${status}: ${trimmed || baseMsg}` : baseMsg;
}

async function isUnsupportedParamErrorAsync(err, paramName) {
  const body = await readUpstreamBody(err?.response?.data);
  const raw = body || err?.message || '';
  const msg = raw.toLowerCase();
  return msg.includes('unsupported') && msg.includes(`'${paramName.toLowerCase()}'`);
}

module.exports = { readUpstreamBody, extractErrAsync, isUnsupportedParamErrorAsync };
