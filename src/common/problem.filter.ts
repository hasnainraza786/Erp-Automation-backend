import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ZodValidationException } from 'nestjs-zod';
import type { FastifyReply } from 'fastify';
import { ZodError } from 'zod';

interface Problem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { path: string; message: string }[];
}

/** Every error leaves the API as RFC 7807 problem+json. */
@Catch()
export class ProblemFilter implements ExceptionFilter {
  private readonly logger = new Logger('HTTP');

  catch(exception: unknown, host: ArgumentsHost) {
    const reply = host.switchToHttp().getResponse<FastifyReply>();
    const problem = this.toProblem(exception);
    if (problem.status >= 500) this.logger.error(exception);
    reply.status(problem.status).header('content-type', 'application/problem+json').send(problem);
  }

  private toProblem(exception: unknown): Problem {
    if (exception instanceof ZodValidationException) {
      const zodError = exception.getZodError() as ZodError;
      return {
        type: 'validation_error',
        title: 'Validation failed',
        status: 400,
        detail: zodError.issues.map((e) => `${e.path.join('.') || 'body'}: ${e.message}`).join('; '),
        errors: zodError.issues.map((e) => ({ path: e.path.join('.'), message: e.message })),
      };
    }
    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const res = exception.getResponse();
      const detail =
        typeof res === 'string' ? res : ((res as { message?: string | string[] }).message ?? exception.message);
      return {
        type: HttpStatus[status]?.toLowerCase() ?? 'error',
        title: HttpStatus[status] ?? 'Error',
        status,
        detail: Array.isArray(detail) ? detail.join('; ') : detail,
      };
    }
    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === 'P2002') {
        const target = (exception.meta?.target as string[] | undefined)?.join(', ');
        return { type: 'conflict', title: 'Conflict', status: 409, detail: `Duplicate value for ${target ?? 'unique field'}` };
      }
      if (exception.code === 'P2025') {
        return { type: 'not_found', title: 'Not Found', status: 404, detail: 'Record not found' };
      }
      if (exception.code === 'P2003') {
        return { type: 'conflict', title: 'Conflict', status: 409, detail: 'Referenced record does not exist or is in use' };
      }
    }
    return { type: 'internal_error', title: 'Internal Server Error', status: 500, detail: 'Unexpected error' };
  }
}
