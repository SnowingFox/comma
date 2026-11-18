// AudioWorklet: forwards the first input channel to the main thread in ~43 ms batches
// (2048 frames at 48 kHz). Plain JS: worklets load as a separate module, outside the bundle.
class CommaPcmTap extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.filled = 0;
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (channel) {
      let offset = 0;
      while (offset < channel.length) {
        const n = Math.min(channel.length - offset, this.buffer.length - this.filled);
        this.buffer.set(channel.subarray(offset, offset + n), this.filled);
        this.filled += n;
        offset += n;
        if (this.filled === this.buffer.length) {
          this.port.postMessage(this.buffer.slice(0));
          this.filled = 0;
        }
      }
    }
    return true;
  }
}

registerProcessor("comma-pcm-tap", CommaPcmTap);
