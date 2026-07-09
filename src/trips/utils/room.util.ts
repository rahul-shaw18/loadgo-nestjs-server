import { Logger } from '@nestjs/common';
import { Socket } from 'socket.io';

const logger = new Logger('RoomUtil');

export function joinRoomIfNeeded(socket: Socket, room: string): boolean {
  if (socket.rooms.has(room)) {
    return false;
  }

  socket.join(room);
  logger.debug(`joined room=${room} socket=${socket.id}`);
  return true;
}
