# P2P Share

A serverless, peer-to-peer file sharing app built with Next.js (React + TypeScript) and TailwindCSS. It uses:
- WebRTC DataChannels for direct, end-to-end encrypted file transfer between peers.
- A temporary signaling "peer server" implemented as a Vercel Edge Function with WebSockets to exchange SDP/ICE only. No file data passes through the server.

## How it works

- When two users join the same room, the Edge Function assigns roles (offerer/answerer) and relays signaling messages between them over a WebSocket.
- The peers negotiate a WebRTC connection and create a DataChannel.
- Files are sent in chunks over the DataChannel directly between browsers.

Serverless details:
- The signaling endpoint lives at `/api/ws/[room]` and runs on the Edge Runtime (`export const runtime = 'edge'`).
- Each room allows up to two peers and is cleaned up when connections close.

## Getting Started (Local)

1) Install and run:
```bash
npm install
npm run dev
```

2) Open http://localhost:3000

3) Create a room name (e.g. `demo-room`), click Join, and share the URL with someone else. When the second peer joins the same room, the connection is established and you can transfer a file.

Note: Edge WebSocket support is best tested on Vercel deployments. Local dev generally works in modern Next.js versions, but if you see issues, deploy to Vercel to validate.

## Deploy on Vercel

- Push this repo to GitHub and import it in Vercel.
- No extra configuration is needed; the Edge route handler at `src/app/api/ws/[room]/route.ts` will handle WebSocket upgrades.

## Security and limits

- WebRTC is end-to-end encrypted. The Edge function is used only for signaling (SDP/ICE) and never sees file contents.
- Rooms are ephemeral and limited to two peers. Connections exist only while the WebSocket/RTCPeerConnection is open.

## Tech stack

- Next.js App Router
- React 19 + TypeScript
- TailwindCSS v4
- Vercel Edge Functions (WebSocketPair)

## Project scripts

- `npm run dev` - Start the dev server
- `npm run build` - Build for production
- `npm run start` - Start production server
- `npm run lint` - Lint
