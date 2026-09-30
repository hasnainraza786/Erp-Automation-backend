import { applyDecorators } from '@nestjs/common';
import { ApiOkResponse, ApiProduces } from '@nestjs/swagger';
import type { ZodDto } from 'nestjs-zod';

/** Documents the success response using the output shape of a zod DTO. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ApiOk = (dto: ZodDto<any> & { Output?: unknown }) =>
  ApiOkResponse({ type: (dto.Output ?? dto) as never });

/** Documents a binary file response (PDF, XLSX). */
export const ApiFile = (mime: string) =>
  applyDecorators(
    ApiProduces(mime),
    ApiOkResponse({ content: { [mime]: { schema: { type: 'string', format: 'binary' } } } }),
  );
