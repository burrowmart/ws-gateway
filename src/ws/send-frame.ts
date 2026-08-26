import WebSocket from 'ws';
import type { AuthedSocket, ServerFrame } from './types';

/** Guards against sending into a socket that's already closing/closed. */
export function sendFrame(socket: AuthedSocket, frame: ServerFrame): void {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(frame));
}
