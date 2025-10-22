import 'reflect-metadata';
import Anthropic from '@anthropic-ai/sdk';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { BullQueue } from './queue';

async function bootstrap() {
  const queue = new BullQueue({ host: process.env.REDIS_HOST ?? 'localhost', port: Number(process.env.REDIS_PORT ?? 6379) });
  const app = await NestFactory.create(AppModule.forRoot({ client: new Anthropic(), queue }));
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT ?? 3001));
}

bootstrap();
