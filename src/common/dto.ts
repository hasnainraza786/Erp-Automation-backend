import { createZodDto } from 'nestjs-zod';
import type { z } from 'zod';

type Meta = Record<string, Record<string, unknown>>;

const CONSTRAINT_KEYS = ['minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum', 'enum', 'items', 'properties', 'required'];

/**
 * @nestjs/swagger reads a top-level `type: ["string", "null"]` as an array property.
 * Rewrites those into the equivalent `anyOf` form before Swagger sees them.
 */
function fixNullableTypes(meta: Meta): Meta {
  for (const prop of Object.values(meta)) {
    if (!Array.isArray(prop.type)) continue;
    const types = (prop.type as string[]).filter((t) => t !== 'null');
    const inner: Record<string, unknown> = { type: types.length === 1 ? types[0] : types };
    for (const key of CONSTRAINT_KEYS) {
      if (key === 'required' && !Array.isArray(prop.required)) continue;
      if (key in prop) {
        inner[key] = prop[key];
        delete prop[key];
      }
    }
    prop.anyOf = [inner, { type: 'null' }];
    prop.type = '';
    prop['x-nestjs_zod-empty-type'] = true;
  }
  return meta;
}

function patch<T extends { _OPENAPI_METADATA_FACTORY?: () => Meta }>(cls: T) {
  const original = cls._OPENAPI_METADATA_FACTORY?.bind(cls);
  if (original) cls._OPENAPI_METADATA_FACTORY = () => fixNullableTypes(original());
}

export function createDto<S extends z.ZodType>(schema: S) {
  const Dto = createZodDto(schema);
  patch(Dto as never);
  const descriptor = Object.getOwnPropertyDescriptor(Dto, 'Output');
  if (descriptor?.get) {
    const originalGet = descriptor.get;
    const cache = new WeakMap<object, unknown>();
    Object.defineProperty(Dto, 'Output', {
      configurable: true,
      get(this: object) {
        if (!cache.has(this)) {
          const Output = originalGet.call(this);
          patch(Output);
          cache.set(this, Output);
        }
        return cache.get(this);
      },
    });
  }
  return Dto;
}
