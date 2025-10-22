import { Body, Controller, DynamicModule, Get, Headers, Module, Param, Post, UnauthorizedException, ValidationPipe } from '@nestjs/common';
import { APP_PIPE } from '@nestjs/core';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsObject, IsOptional, IsString, Length, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import type { Brief, RoutingPolicy } from './domain';
import type { JobQueue } from './queue';
import { ContentService, JOB_QUEUE, LLM_CLIENT, POLICY, RANDOM } from './service';

class BriefDto implements Brief {
  @IsString() @Length(1, 64) sku: string;
  @IsIn(['en-US', 'es-US', 'fr-CA']) locale: Brief['locale'];
  @IsObject() facts: Record<string, string>;
  @IsArray() @IsString({ each: true }) mustMention: string[];
  @IsArray() @IsString({ each: true }) banned: string[];
  @IsString() category: string;
}
class BatchDto {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(500) @ValidateNested({ each: true }) @Type(() => BriefDto) briefs: BriefDto[];
}
class ReviewDto {
  @IsIn(['approve', 'reject', 'revise']) decision: 'approve' | 'reject' | 'revise';
  @IsOptional() @IsString() @Length(1, 4000) editedText?: string;
  @IsOptional() @IsString() @Length(1, 1000) note?: string;
}

/** The gateway authenticates and passes the user + role; reviewers and publishers are separate roles. */
function user(h: Record<string, string>, role: 'editor' | 'reviewer' | 'publisher') {
  const u = h['x-user'];
  const roles = (h['x-roles'] ?? '').split(',');
  if (!u || !roles.includes(role)) throw new UnauthorizedException(`requires ${role}`);
  return u;
}

@Controller()
class ContentController {
  constructor(private readonly svc: ContentService) {}

  @Post('batches') create(@Body() dto: BatchDto, @Headers() h: Record<string, string>) { user(h, 'editor'); return this.svc.createBatch(dto.briefs); }
  @Get('review') queue(@Headers() h: Record<string, string>) { user(h, 'reviewer'); return this.svc.reviewQueue(); }
  @Get('items/:id') get(@Param('id') id: string) { return this.svc.get(id); }
  @Post('items/:id/review') review(@Param('id') id: string, @Body() dto: ReviewDto, @Headers() h: Record<string, string>) {
    return this.svc.review(id, user(h, 'reviewer'), dto.decision, dto);
  }
  @Post('items/:id/publish') publish(@Param('id') id: string, @Headers() h: Record<string, string>) { return this.svc.publish(id, user(h, 'publisher')); }
  @Get('metrics') metrics() { return this.svc.metrics(); }
}

@Module({})
export class AppModule {
  static forRoot(deps: { client: unknown; queue: JobQueue; policy?: RoutingPolicy; random?: () => number }): DynamicModule {
    return {
      module: AppModule,
      controllers: [ContentController],
      providers: [
        ContentService,
        { provide: LLM_CLIENT, useValue: deps.client },
        { provide: JOB_QUEUE, useValue: deps.queue },
        { provide: POLICY, useValue: deps.policy ?? { autoApproveAt: 0.85, sampleRate: 0.1 } },
        { provide: RANDOM, useValue: deps.random ?? Math.random },
        { provide: APP_PIPE, useValue: new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }) },
      ],
    };
  }
}
