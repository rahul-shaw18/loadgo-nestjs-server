import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse } from '@nestjs/swagger';

@ApiTags('Health')
@Controller()
export class AppController {
  @Get('health')
  @ApiOperation({ summary: 'Health check', description: 'Returns server status and uptime in seconds.' })
  @ApiResponse({ status: 200, description: 'Server is healthy', schema: { example: { status: 'ok', uptime: 123.45 } } })
  getHealth() {
    return { status: 'ok', uptime: process.uptime() };
  }
}
