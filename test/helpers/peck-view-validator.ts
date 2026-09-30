// Strict JSON Schema validator for the vendored peck-view/v1 contract. Test-only:
// ajv is a devDependency and never ships in the package.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import Ajv2020Module from 'ajv/dist/2020.js'
import addFormatsModule from 'ajv-formats'

// ajv and ajv-formats are CommonJS; depending on the toolchain the default
// import is either the constructor or the module object.
type AnyFn = (...args: never[]) => unknown
const Ajv2020 = ((Ajv2020Module as unknown as { default?: AnyFn }).default ?? Ajv2020Module) as unknown as new (
  opts: Record<string, unknown>,
) => {
  addSchema(schema: unknown): void
  getSchema(ref: string): ((v: unknown) => boolean) & { errors?: Array<{ instancePath: string; message?: string; params?: Record<string, unknown> }> | null } | undefined
}
const addFormats = ((addFormatsModule as unknown as { default?: AnyFn }).default ?? addFormatsModule) as unknown as (
  ajv: unknown,
) => void

export const PECK_VIEW_SCHEMA_PATH = resolve(import.meta.dirname, '../../src/read/peck-view/peck-view.schema.json')
export const PECK_VIEW_FIXTURES = resolve(import.meta.dirname, '../fixtures/peck-view')

export type PeckViewTypeName =
  | 'PeckView' | 'AuthorView' | 'PostView' | 'ThreadView' | 'FeedPage' | 'FeedCursor' | 'PostBatch'
  | 'ProfileView' | 'ViewerState' | 'AppList' | 'ReactionPage' | 'SiteStats' | 'ErrorResponse'

const schema = JSON.parse(readFileSync(PECK_VIEW_SCHEMA_PATH, 'utf8')) as { $id: string }
// strict: unknown keywords or ambiguous types are schema bugs, not warnings.
const ajv = new Ajv2020({ strict: true, allErrors: true, allowUnionTypes: true })
addFormats(ajv)
ajv.addSchema(schema)

export function peckViewErrors(type: PeckViewTypeName, value: unknown): string[] {
  const ref = type === 'PeckView' ? schema.$id : `${schema.$id}#/$defs/${type}`
  const validate = ajv.getSchema(ref)
  if (!validate) throw new Error(`peck-view: no $defs/${type}`)
  if (validate(value)) return []
  return (validate.errors ?? []).map((e) => {
    const extra = e.params?.additionalProperty ? ` '${String(e.params.additionalProperty)}'` : ''
    return `${e.instancePath || '(root)'} ${e.message ?? ''}${extra}`
  })
}
