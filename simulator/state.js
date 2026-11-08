const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function simulatorState(directory, deviceId) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${deviceId}.json`);
  let initialState;
  try { initialState = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (err) { if (err.code !== 'ENOENT') throw err; }
  function saveState(state) {
    const temp = `${file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify(state)); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(temp, file);
      const dir = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch (err) { if (err.code !== 'ENOENT') throw err; }
    }
  }
  return { initialState, saveState };
}
module.exports = { simulatorState };
