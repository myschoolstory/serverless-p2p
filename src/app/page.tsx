'use client';

import { useCallback, useMemo, useRef, useState } from 'react';
import { SignalingClient, type Signal } from '@/lib/signaling';

type TransferState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected' }
  | { status: 'transferring'; sentBytes: number; totalBytes: number }
  | { status: 'receiving'; receivedBytes: number; totalBytes?: number }
  | { status: 'done' }
  | { status: 'error'; message: string };

export default function Home() {
  const [room, setRoom] = useState<string>('');
  const [joined, setJoined] = useState(false);
  const [role, setRole] = useState<'offerer' | 'answerer' | null>(null);
  const [state, setState] = useState<TransferState>({ status: 'idle' });
  const [log, setLog] = useState<string[]>([]);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const sigRef = useRef<SignalingClient | null>(null);

  const pendingCandidates = useRef<any[]>([]);
  const addLog = useCallback((l: string) => setLog((prev) => [l, ...prev].slice(0, 200)), []);

  const createPC = useCallback(() => {
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: ['stun:stun.l.google.com:19302'] }],
    });
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sigRef.current?.send({ type: 'candidate', candidate: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = () => {
      addLog(`pc state: ${pc.connectionState}`);
      if (pc.connectionState === 'connected') setState({ status: 'connected' });
      if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
        setState({ status: 'error', message: 'Peer connection lost' });
      }
    };
    pc.ondatachannel = (ev) => {
      addLog('datachannel received');
      setupDataChannel(ev.channel);
    };
    pcRef.current = pc;
    return pc;
  }, [addLog]);

  const setupDataChannel = (dc: RTCDataChannel) => {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 1 << 20; // 1MB
    dc.onopen = () => {
      addLog('datachannel open');
    };
    dc.onmessage = (ev) => {
      const data = ev.data as ArrayBuffer | string;
      if (typeof data === 'string') {
        try {
          const meta = JSON.parse(data);
          if (meta.type === 'file-meta') {
            const total = meta.size as number;
            setState({ status: 'receiving', receivedBytes: 0, totalBytes: total });
            incoming.current = { name: meta.name, type: meta.mime, size: total, chunks: [] };
          }
        } catch {
          // ignore misc text
        }
      } else {
        // receiving file chunk
        if (incoming.current) {
          incoming.current.chunks.push(new Uint8Array(data));
          const rec = incoming.current.chunks.reduce((a, b) => a + b.byteLength, 0);
          setState({ status: 'receiving', receivedBytes: rec, totalBytes: incoming.current.size });
          if (rec >= incoming.current.size) {
            // assemble
            const blob = new Blob(incoming.current.chunks, { type: incoming.current.type || 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = incoming.current.name || 'download';
            a.click();
            URL.revokeObjectURL(url);
            setState({ status: 'done' });
            addLog('file received');
            incoming.current = null;
          }
        }
      }
    };
    dc.onclose = () => addLog('datachannel closed');
    dcRef.current = dc;
  };

  const incoming = useRef<{
    name?: string;
    type?: string;
    size: number;
    chunks: Uint8Array[];
  } | null>(null);

  const join = useCallback(async () => {
    if (!room) {
      alert('Enter a room id');
      return;
    }
    setJoined(true);
    setState({ status: 'connecting' });
    const sig = new SignalingClient(room, async (msg: Signal) => {
      if (msg.type === 'role') {
        setRole(msg.role);
        addLog(`assigned role: ${msg.role}`);
        const pc = createPC();
        if (msg.role === 'offerer') {
          const dc = pc.createDataChannel('file');
          setupDataChannel(dc);
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          sig.send({ type: 'offer', sdp: offer });
        }
      } else if (msg.type === 'peer-join') {
        addLog('peer joined');
      } else if (msg.type === 'offer') {
        const pc = pcRef.current ?? createPC();
        await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        sig.send({ type: 'answer', sdp: answer });
        // flush queued candidates
        for (const c of pendingCandidates.current) {
          await pc.addIceCandidate(new RTCIceCandidate(c));
        }
        pendingCandidates.current = [];
      } else if (msg.type === 'answer') {
        const pc = pcRef.current;
        if (pc) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
          // flush queued candidates
          for (const c of pendingCandidates.current) {
            await pc.addIceCandidate(new RTCIceCandidate(c));
          }
          pendingCandidates.current = [];
        }
      } else if (msg.type === 'candidate') {
        const pc = pcRef.current;
        if (pc) {
          if (pc.remoteDescription) {
            await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
          } else {
            pendingCandidates.current.push(msg.candidate);
          }
        } else {
          pendingCandidates.current.push(msg.candidate);
        }
      } else if (msg.type === 'peer-leave') {
        addLog('peer left');
      }
    });
    sigRef.current = sig;
    try {
      await sig.connect();
      addLog('connected to signaling');
    } catch (e: any) {
      addLog('signaling failed');
      setState({ status: 'error', message: e?.message ?? 'signaling error' });
    }
  }, [room, createPC, addLog]);

  const leave = useCallback(() => {
    sigRef.current?.close();
    pcRef.current?.close();
    dcRef.current?.close();
    setJoined(false);
    setRole(null);
    setState({ status: 'idle' });
    addLog('left room');
  }, [addLog]);

  const onPickFile = useCallback(async (file: File) => {
    const dc = dcRef.current;
    if (!dc || dc.readyState !== 'open') {
      alert('Peer not connected yet');
      return;
    }

    // send metadata first
    dc.send(JSON.stringify({ type: 'file-meta', name: file.name, size: file.size, mime: file.type }));
    const chunkSize = 64 * 1024; // 64KB
    let offset = 0;
    setState({ status: 'transferring', sentBytes: 0, totalBytes: file.size });
    while (offset < file.size) {
      const slice = file.slice(offset, offset + chunkSize);
      const buf = await slice.arrayBuffer();

      // backpressure: wait if buffer is high
      if (dc.bufferedAmount > 8 << 20) {
        await new Promise<void>((resolve) => {
          const handler = () => {
            dc.removeEventListener('bufferedamountlow', handler);
            resolve();
          };
          dc.addEventListener('bufferedamountlow', handler, { once: true });
        });
      }

      dc.send(buf);
      offset += chunkSize;
      setState({ status: 'transferring', sentBytes: Math.min(offset, file.size), totalBytes: file.size });
      // micro-yield
      await new Promise((r) => setTimeout(r, 0));
    }
    addLog('file sent');
    setState({ status: 'done' });
  }, []);

  const statusText = useMemo(() => {
    switch (state.status) {
      case 'idle':
        return 'Idle';
      case 'connecting':
        return 'Connecting...';
      case 'connected':
        return 'Connected. Ready to transfer.';
      case 'transferring':
        return `Sending ${((state.sentBytes / state.totalBytes) * 100).toFixed(1)}%`;
      case 'receiving':
        return `Receiving ${state.totalBytes ? ((state.receivedBytes / state.totalBytes) * 100).toFixed(1) : ''}%`;
      case 'done':
        return 'Done';
      case 'error':
        return `Error: ${state.message}`;
    }
  }, [state]);

  const shareUrl = useMemo(() => {
    if (!room) return '';
    if (typeof window === 'undefined') return '';
    const url = new URL(window.location.href);
    url.searchParams.set('room', room);
    return url.toString();
  }, [room]);

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      <div className="max-w-3xl mx-auto p-6">
        <h1 className="text-2xl font-semibold mb-2">P2P Share</h1>
        <p className="text-sm opacity-70 mb-6">
          Share files peer-to-peer using a temporary signaling room running on Vercel Functions.
        </p>

        <div className="flex flex-col sm:flex-row gap-3 mb-6">
          <input
            className="flex-1 rounded-md border border-black/10 dark:border-white/15 bg-transparent px-3 py-2 outline-none"
            placeholder="Enter room id (e.g. team-standup)"
            value={room}
            onChange={(e) => setRoom(e.target.value)}
            disabled={joined}
          />
          {!joined ? (
            <button
              className="rounded-md bg-foreground text-background px-4 py-2 font-medium hover:opacity-90"
              onClick={join}
            >
              Join
            </button>
          ) : (
            <button
              className="rounded-md border border-black/10 dark:border-white/15 px-4 py-2 font-medium hover:bg-black/[.03] dark:hover:bg-white/[.06]"
              onClick={leave}
            >
              Leave
            </button>
          )}
        </div>

        {room && (
          <div className="mb-4 text-xs">
            Share this link with your peer after you join:
            <div className="mt-1 rounded border border-black/10 dark:border-white/15 p-2 font-mono break-all">
              {shareUrl || '—'}
            </div>
          </div>
        )}

        <div className="mb-6 text-sm">
          <div>Role: <span className="font-mono">{role ?? '-'}</span></div>
          <div>Status: <span className="font-mono">{statusText}</span></div>
        </div>

        <div className="mb-8">
          <label className="block text-sm mb-2">Send a file</label>
          <input
            type="file"
            disabled={!joined}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onPickFile(f);
            }}
          />
        </div>

        <div className="space-y-2">
          <div className="text-sm font-medium">Logs</div>
          <div className="rounded-md border border-black/10 dark:border-white/15 p-3 text-xs h-48 overflow-auto bg-black/[.02] dark:bg-white/[.03]">
            {log.length === 0 ? <div className="opacity-60">No logs yet</div> : (
              <ul className="space-y-1">
                {log.map((l, i) => (<li key={i} className="font-mono">{l}</li>))}
              </ul>
            )}
          </div>
        </div>

        <footer className="mt-10 text-xs opacity-70">
          This app uses WebRTC for data transfer and an ephemeral WebSocket on Vercel Edge for signaling only.
        </footer>
      </div>
    </div>
  );
}
