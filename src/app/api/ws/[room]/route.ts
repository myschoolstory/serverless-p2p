export const runtime = 'edge';

type Role = 'offerer' | 'answerer';
type WSState = { room: string; role: Role };

type Rooms = Map<string, Set<WebSocket>>;
type WSStateMap = Map<WebSocket, WSState>;

function getStore(): { rooms: Rooms; wsState: WSStateMap } {
  const g = globalThis as any;
  if (!g.__p2pRooms) {
    g.__p2pRooms = new Map<string, Set<WebSocket>>();
    g.__p2pWSState = new Map<WebSocket, WSState>();
  }
  return { rooms: g.__p2pRooms as Rooms, wsState: g.__p2pWSState as WSStateMap };
}

function broadcastToRoom(rooms: Rooms, room: string, from: WebSocket, data: any) {
  const set = rooms.get(room);
  if (!set) return;
  for (const ws of set) {
    if (ws !== from) {
      try {
        ws.send(data as any);
      } catch {
        // ignore
      }
    }
  }
}

export async function GET(req: Request, { params }: { params: { room: string } }) {
  if (req.headers.get('upgrade') !== 'websocket') {
    return new Response('Expected websocket', { status: 400 });
  }

  const roomId = params.room;
  const { rooms, wsState } = getStore();

  let set = rooms.get(roomId);
  if (!set) {
    set = new Set<WebSocket>();
    rooms.set(roomId, set);
  }

  if (set.size >= 2) {
    return new Response('Room full', { status: 403 });
  }

  // @ts-ignore - WebSocketPair is provided by the Edge Runtime
  const { 0: client, 1: server } = new (globalThis as any).WebSocketPair();

  // @ts-ignore - accept is provided by Edge Runtime WS
  server.accept();

  const role: Role = set.size === 0 ? 'offerer' : 'answerer';

  set.add(server);
  wsState.set(server, { room: roomId, role });

  const sendJSON = (ws: WebSocket, obj: any) => {
    try {
      ws.send(JSON.stringify(obj));
    } catch {
      // ignore
    }
  };

  sendJSON(server, { type: 'role', role });

  if (set.size === 2) {
    for (const ws of set) {
      sendJSON(ws, { type: 'peer-join' });
    }
  }

  server.addEventListener('message', (ev: MessageEvent) => {
    const state = wsState.get(server);
    const room = state?.room;
    if (!room) return;

    const data = ev.data;

    if (typeof data === 'string') {
      // Forward JSON signaling or plain text as-is
      broadcastToRoom(rooms, room, server, data);
    } else {
      // Binary payload (unused by signaling, but supported for generic relay if needed)
      broadcastToRoom(rooms, room, server, data);
    }
  });

  const cleanup = () => {
    const st = wsState.get(server);
    if (!st) return;
    const peers = rooms.get(st.room);
    if (peers) {
      peers.delete(server);
      if (peers.size === 0) {
        rooms.delete(st.room);
      } else {
        for (const ws of peers) {
          sendJSON(ws, { type: 'peer-leave' });
        }
      }
    }
    wsState.delete(server);
  };

  server.addEventListener('close', cleanup);
  server.addEventListener('error', cleanup);

  return new Response(null, {
    status: 101,
    // @ts-ignore - non-standard init for Edge Runtime
    webSocket: client,
  } as any);
}