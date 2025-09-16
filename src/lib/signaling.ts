export type Signal =
  | { type: 'role'; role: 'offerer' | 'answerer' }
  | { type: 'peer-join' }
  | { type: 'peer-leave' }
  | { type: 'offer'; sdp: any }
  | { type: 'answer'; sdp: any }
  | { type: 'candidate'; candidate: any };

export class SignalingClient {
  private ws?: WebSocket;
  private url: string;
  private onMessage: (msg: Signal | any) => void;

  constructor(room: string, onMessage: (msg: Signal) => void) {
    const loc = typeof window !== 'undefined' ? window.location : { protocol: 'https:', host: '' } as any;
    const proto = loc.protocol === 'https:' ? 'wss' : 'ws';
    this.url = `${proto}://${loc.host}/api/ws/${encodeURIComponent(room)}`;
    this.onMessage = onMessage;
  }

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data as any);
        this.onMessage(data);
      } catch {
        // pass through
        this.onMessage(ev.data as any);
      }
    };
    return new Promise<void>((resolve, reject) => {
      if (!this.ws) return reject(new Error('no ws'));
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(e);
    });
  }

  send(msg: Signal) {
    this.ws?.send(JSON.stringify(msg));
  }

  close() {
    this.ws?.close();
  }
}