/** Bounded structural extraction: retain usage objects, never response content. */
type Frame = { array: boolean; path: string; key?: string; wantsKey: boolean };
const USAGE_PATHS = new Set([
  '$["usage"]',
  '$["message"]["usage"]',
  '$["response"]["usage"]',
]);
const MAX_USAGE = 64 * 1024;

export class UsageParser {
  private mode?: 'json' | 'sse';
  private prefix = '';
  private dataLine = false;
  private skipLine = false;
  private frames: Frame[] = [];
  private quoted = false;
  private escaped = false;
  private keyString = false;
  private keyText = '';
  private capture?: { depth: number; text: string; overflow: boolean };
  private invalid = false;

  constructor(
    private readonly accept: (usage: Record<string, unknown>) => void
  ) {}

  write(text: string): void {
    for (const char of text) {
      if (!this.mode) {
        if (/\s/.test(char)) continue;
        this.mode = char === '{' || char === '[' ? 'json' : 'sse';
      }
      if (this.mode === 'json') this.json(char);
      else if (char === '\n') {
        if (this.dataLine) this.json('\n');
        this.prefix = '';
        this.dataLine = this.skipLine = false;
      } else if (this.dataLine) this.json(char);
      else if (!this.skipLine) {
        this.prefix += char;
        if (this.prefix === 'data:') this.dataLine = true;
        else if (!'data:'.startsWith(this.prefix)) this.skipLine = true;
      }
    }
  }

  private json(char: string): void {
    if (this.invalid) return;
    if (this.capture && !this.capture.overflow) {
      this.capture.text += char;
      if (this.capture.text.length > MAX_USAGE) {
        this.capture.text = '';
        this.capture.overflow = true;
      }
    }
    if (this.quoted) {
      if (this.keyString && this.keyText.length <= 256) this.keyText += char;
      if (this.escaped) this.escaped = false;
      else if (char === '\\') this.escaped = true;
      else if (char === '"') {
        this.quoted = false;
        if (this.keyString) {
          const frame = this.frames[this.frames.length - 1];
          try {
            frame.key = JSON.parse(this.keyText) as string;
          } catch {
            frame.key = undefined;
          }
          frame.wantsKey = false;
        }
      }
      return;
    }
    const parent = this.frames[this.frames.length - 1];
    if (char === '"') {
      this.quoted = true;
      this.keyString = !!parent && !parent.array && parent.wantsKey;
      this.keyText = this.keyString ? '"' : '';
    } else if (char === '{' || char === '[') {
      if (this.frames.length >= 128) {
        this.invalid = true;
        return;
      }
      const path = !parent
        ? '$'
        : parent.array
          ? `${parent.path}[]`
          : `${parent.path}[${JSON.stringify(parent.key ?? '?')}]`;
      if (parent) parent.key = undefined;
      this.frames.push({ array: char === '[', path, wantsKey: char === '{' });
      if (char === '{' && USAGE_PATHS.has(path))
        this.capture = {
          depth: this.frames.length,
          text: '{',
          overflow: false,
        };
    } else if (char === '}' || char === ']') {
      if (this.capture?.depth === this.frames.length) {
        if (!this.capture.overflow) {
          try {
            this.accept(
              JSON.parse(this.capture.text) as Record<string, unknown>
            );
          } catch {
            /* Malformed usage is unknown, never guessed. */
          }
        }
        this.capture = undefined;
      }
      this.frames.pop();
    } else if (char === ',' && parent) {
      parent.wantsKey = !parent.array;
      parent.key = undefined;
    }
  }
}
