import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // Enable CORS
  app.enableCors({ origin: '*' });

  // Global Validation Pipe
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
    }),
  );

  // Swagger Setup
  const config = new DocumentBuilder()
    .setTitle('LoadGo Realtime Server')
    .setDescription(
      'Real-time trip assignment engine — manages driver offer queues, ' +
      'screen timers, and Socket.IO room-based trip lifecycle events. ' +
      'Called by the LoadGo main backend to notify drivers and update trip status.',
    )
    .setVersion('1.0')
    .addTag('Health', 'Server health check')
    .addTag('Trips', 'Trip notification and status management')
    .build();
  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api-docs', app, document);

  await app.listen(process.env.PORT ?? 3000);

  const port = process.env.PORT ?? 3000;
  console.log(`Realtime Server running on port ${port}`);
  console.log(`Health check: http://localhost:${port}/health`);
  console.log(`Swagger docs: http://localhost:${port}/api-docs`);
}
bootstrap();
