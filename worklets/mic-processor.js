/**
 * معالج الميكروفون (AudioWorklet) — يعمل خارج الخيط الرئيسي.
 * كل 40 مللي ثانية يرسل:
 *   pcm      : الصوت بعد تحويله إلى 16 كيلوهرتز PCM 16-bit (ما يطلبه Gemini Live)
 *   rms/env  : شدة الصوت والغلاف المُنعَّم
 *   speaking : هل يوجد كلام الآن (كشف نشاط صوتي بعتبة تتكيف مع ضجيج المكان)
 *   vad      : true عند بداية الكلام، false عند نهايته، null إن لم يتغير شيء
 */
class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.pos = 0;
    this.acc = 0;
    this.accN = 0;
    this.out = new Int16Array(640);
    this.outN = 0;
    this.sum = 0;
    this.cnt = 0;
    this.env = 0;
    this.floor = 0.004;
    this.speaking = false;
    this.above = 0;
    this.below = 0;
    this.cfg = { absThreshold: 0.012, ratio: 3, onsetMs: 120, hangMs: 480 };
    this.port.onmessage = (e) => Object.assign(this.cfg, e.data);
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const s = ch[i];
      this.sum += s * s;
      this.cnt++;
      this.acc += s;
      this.accN++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = this.acc / this.accN;
        this.acc = 0;
        this.accN = 0;
        this.out[this.outN++] = Math.max(-32768, Math.min(32767, Math.round(v * 32767)));
        if (this.outN === this.out.length) this.flush();
      }
    }
    return true;
  }

  flush() {
    const blockMs = 40;
    const rms = Math.sqrt(this.sum / Math.max(1, this.cnt));
    this.sum = 0;
    this.cnt = 0;
    this.env += (rms - this.env) * (rms > this.env ? 0.6 : 0.25);
    // أرضية الضجيج: تهبط بسرعة وترتفع ببطء، ولا تتحدث أثناء الكلام
    if (!this.speaking) this.floor += (this.env - this.floor) * (this.env < this.floor ? 0.2 : 0.01);
    const thr = Math.max(this.cfg.absThreshold, this.floor * this.cfg.ratio);
    if (this.env > thr) {
      this.above = Math.min(this.cfg.onsetMs, this.above + blockMs);
      this.below = 0;
    } else {
      this.below += blockMs;
      // تسريب تدريجي بدل التصفير: الفجوات القصيرة بين المقاطع لا تُلغي بداية الكلام
      this.above = Math.max(0, this.above - blockMs * 0.5);
    }
    let vad = null;
    if (!this.speaking && this.env > thr && this.above >= this.cfg.onsetMs) {
      this.speaking = true;
      this.below = 0;
      vad = true;
    } else if (this.speaking && this.below >= this.cfg.hangMs) {
      this.speaking = false;
      this.above = 0;
      vad = false;
    }
    const pcm = this.out.slice(0);
    this.outN = 0;
    // active: صوت فعلي فوق العتبة في هذه الكتلة (دون فترة التعليق بعد نهاية الكلام)
    this.port.postMessage({ pcm: pcm.buffer, rms, env: this.env, speaking: this.speaking, active: this.env > thr, vad }, [pcm.buffer]);
  }
}
registerProcessor('mic-processor', MicProcessor);
