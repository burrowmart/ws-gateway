import { ApiProperty } from '@nestjs/swagger';

export class TicketResponse {
  @ApiProperty({ description: 'Short-lived, single-use token — pass as wss://.../ws?ticket=' })
  ticket!: string;

  @ApiProperty({ description: 'Seconds until the ticket expires (and can no longer be used)' })
  expiresIn!: number;
}
