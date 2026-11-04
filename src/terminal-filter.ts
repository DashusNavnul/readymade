import { StringDecoder } from 'node:string_decoder';

/** Holds incomplete control sequences so historical queries never reach the terminal parser. */
export class HistoricalTerminalFilter {
  private mode: 'ground' | 'escape' | 'csi' | 'osc' | 'dcs' | 'string' = 'ground';
  private buffer = ''; private historical = false; private stringEscape = false;
  private decoder = new StringDecoder('utf8'); private pendingHistorical = false; private utf8Remaining = 0;
  reset(): void { this.mode = 'ground'; this.buffer = ''; this.historical = false; this.stringEscape = false; this.decoder = new StringDecoder('utf8'); this.pendingHistorical = false; this.utf8Remaining = 0; }
  feed(bytes: Uint8Array, historical: boolean): string {
    const text = this.decoder.write(Buffer.from(bytes));
    const origin = historical || this.pendingHistorical;
    for (const byte of bytes) {
      if (this.utf8Remaining && byte >= 0x80 && byte <= 0xbf) this.utf8Remaining--;
      else this.utf8Remaining = byte >= 0xc2 && byte <= 0xdf ? 1 : byte >= 0xe0 && byte <= 0xef ? 2 : byte >= 0xf0 && byte <= 0xf4 ? 3 : 0;
    }
    this.pendingHistorical = origin && this.utf8Remaining > 0;
    let result = '';
    for (const char of text) {
      const code = char.charCodeAt(0);
      if (this.mode !== 'ground' && !['osc', 'dcs', 'string'].includes(this.mode) && (char === '\x1b' || char === '\x9b' || char === '\x9d' || char === '\x90')) {
        this.buffer = char; this.historical ||= origin; this.mode = char === '\x1b' ? 'escape' : char === '\x9b' ? 'csi' : char === '\x9d' ? 'osc' : 'dcs'; continue;
      }
      if (this.mode === 'ground') {
        if (char === '\x1b' || '\x9b\x9d\x90\x98\x9e\x9f'.includes(char)) {
          this.buffer = char; this.historical = origin; this.stringEscape = false;
          this.mode = char === '\x1b' ? 'escape' : char === '\x9b' ? 'csi' : char === '\x9d' ? 'osc' : char === '\x90' ? 'dcs' : 'string';
        } else if (!(origin && char === '\x05')) result += char;
        continue;
      }
      this.buffer += char; this.historical ||= origin;
      if (this.buffer.length > 65536 || char === '\x18' || char === '\x1a') { this.mode = 'ground'; this.buffer = ''; continue; }
      if (this.mode === 'escape') {
        if (char === '[') this.mode = 'csi';
        else if (char === ']') this.mode = 'osc';
        else if (char === 'P') this.mode = 'dcs';
        else if (['X', '^', '_'].includes(char)) this.mode = 'string';
        else if (code >= 0x30 && code <= 0x7e) { if (!(this.historical && char === 'Z')) result += this.buffer; this.mode = 'ground'; this.buffer = ''; }
      } else if (this.mode === 'csi') {
        if (code >= 0x40 && code <= 0x7e) {
          const query = ['c', 'n', 't', 'x'].includes(char) || char === 'p' && this.buffer.includes('$') || ['u', 'S'].includes(char) && this.buffer.includes('?');
          if (!this.historical || !query) result += this.buffer;
          this.mode = 'ground'; this.buffer = '';
        }
      } else {
        const done = char === '\x9c' || this.stringEscape && char === '\\' || this.mode === 'osc' && char === '\x07';
        if (done) {
          const content = this.buffer.replace(/^(?:\x1b[\]P_X^]|[\x90\x98\x9d-\x9f])/, '');
          const clipboard = this.mode === 'osc' && /^52;/.test(content);
          const query = this.mode === 'dcs' && /^[+$]q/.test(content) || this.mode === 'osc' && /^(?:4|10|11|12);/.test(content) && content.includes('?');
          if (!clipboard && (!this.historical || !query)) result += this.buffer;
          this.mode = 'ground'; this.buffer = ''; this.stringEscape = false;
        } else this.stringEscape = char === '\x1b';
      }
    }
    return result;
  }
}

