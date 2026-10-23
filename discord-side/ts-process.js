// Starts the Rust TeamSpeak process and speaks its frame protocol over stdin/stdout.
// Frame: [u8 type][u32 BE length][payload]. Type 1 = JSON, type 2 = audio.
'use strict';

const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const path = require('node:path');

const FRAME_JSON = 1;
const FRAME_AUDIO = 2;

class TsProcess extends EventEmitter {
  constructor(binary, configPath, log) {
    super();
    this.binary = binary;
    this.configPath = configPath;
    this.log = log;
    this.proc = null;
    this.buf = Buffer.alloc(0);
    this.stopped = false;
  }

  start() {
    this.buf = Buffer.alloc(0);
    this.log('TS', `Starting ${this.binary}`);
    const proc = spawn(this.binary, [this.configPath], {
      cwd: path.dirname(this.configPath),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.proc = proc;
    proc.stdout.on('data', (chunk) => this._onData(chunk));
    proc.stderr.on('data', (d) => {
      for (const line of d.toString().split('\n')) if (line.trim()) this.log('TS', line.trim());
    });
    proc.stdin.on('error', () => {});
    proc.on('error', (err) => this.log('TS', `Process error: ${err.message}`));
    proc.on('exit', (code) => {
      this.proc = null;
      if (this.stopped) return;
      this.log('TS', `TS process exited (code ${code}), restarting in 5 s`);
      this.emit('restart');
      setTimeout(() => !this.stopped && this.start(), 5000);
    });
    this.emit('started');
  }

  stop() {
    this.stopped = true;
    if (this.proc) this.proc.stdin.end();
  }

  _onData(chunk) {
    this.buf = Buffer.concat([this.buf, chunk]);
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      const type = this.buf[0];
      const payload = this.buf.subarray(5, 5 + len);
      this.buf = this.buf.subarray(5 + len);
      if (type === FRAME_JSON) {
        try {
          this.emit('event', JSON.parse(payload.toString('utf8')));
        } catch (e) {
          this.log('TS', `Invalid JSON: ${e.message}`);
        }
      } else if (type === FRAME_AUDIO && payload.length > 3) {
        this.emit('audio', payload[0], payload.readUInt16BE(1), Buffer.from(payload.subarray(3)));
      }
    }
  }

  _write(type, payload) {
    if (!this.proc || !this.proc.stdin.writable) return;
    const head = Buffer.alloc(5);
    head[0] = type;
    head.writeUInt32BE(payload.length, 1);
    this.proc.stdin.write(Buffer.concat([head, payload]));
  }

  send(obj) {
    this._write(FRAME_JSON, Buffer.from(JSON.stringify(obj), 'utf8'));
  }

  sendAudio(key, opus) {
    const k = Buffer.from(key, 'utf8');
    this._write(FRAME_AUDIO, Buffer.concat([Buffer.from([k.length]), k, opus]));
  }
}

module.exports = { TsProcess };
