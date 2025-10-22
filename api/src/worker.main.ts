import 'reflect-metadata';
import Anthropic from '@anthropic-ai/sdk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BullQueue } from './queue';

/** Worker-only process: no HTTP server; scales horizontally on queue depth (KEDA in k8s). */
async function bootstrap() {
  const queue = new BullQueue({ host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) });
  const ctx = await NestFactory.createApplicationContext(AppModule.forRoot({ client: new Anthropic(), queue }));
  ctx.enableShutdownHooks();
}

bootstrap();
