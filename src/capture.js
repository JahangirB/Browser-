'use strict';
// Grabs the virtual X display with ffmpeg and emits JPEG frames.
// mpdecimate drops frames that did not visibly change, so a static page costs
// (almost) no CPU or bandwidth; max=-N still forces a refresh every few seconds.

const { spawn } = require('child_process');
const EventEmitter = require('events');

const SOI = Buffer.from([0xff, 0xd8]);
const EOI = Buffer.from([0xff, 0xd9]);

class Capture extends EventEmitter {
  constructor({ display, width, height, fps, quality }) {
    super();
    Object.assign(this, { display, width, height, fps, quality });
    this.proc = null;
    this.lastFrame = null;
    this.wanted = false;
  }

  start() {
    this.wanted = true;
    if (this.proc) return;
    const args = [
      '-loglevel', 'error', '-nostdin',
      '-f', 'x11grab', '-draw_mouse', '0',
      '-framerate', String(this.fps),
      '-video_size', `${this.width}x${this.height}`,
      '-i', this.display,
      '-vf', `mpdecimate=hi=512:lo=256:frac=0:max=-${this.fps * 3}`,
      '-fps_mode', 'vfr',
      '-pix_fmt', 'yuvj420p',
      '-c:v', 'mjpeg', '-q:v', String(this.quality),
      '-f', 'mjpeg', 'pipe:1',
    ];
    const p = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = p;
    let buf = Buffer.alloc(0);
    p.stdout.on('data', (chunk) => {
      buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
      for (;;) {
        const s = buf.indexOf(SOI);
        if (s < 0) { buf = Buffer.alloc(0); break; }
        const e = buf.indexOf(EOI, s + 2);
        if (e < 0) { if (s > 0) buf = buf.subarray(s); break; }
        const frame = Buffer.from(buf.subarray(s, e + 2));
        buf = buf.subarray(e + 2);
        this.lastFrame = frame;
        this.emit('frame', frame);
      }
    });
    p.stderr.on('data', (d) => process.stderr.write(`[ffmpeg] ${d}`));
    p.on('exit', (code) => {
      this.proc = null;
      if (this.wanted) {
        console.error(`[ffmpeg] exited (${code}); restarting`);
        setTimeout(() => this.wanted && this.start(), 1000);
      }
    });
  }

  stop() {
    this.wanted = false;
    if (this.proc) this.proc.kill('SIGTERM');
  }
}

module.exports = { Capture };
