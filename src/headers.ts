import { McpError, isJsonObject, type JsonObject, type JsonValue, type MirroredParameters } from '@particle-academy/prism-mcp';

/**
 * The HTTP headers that mirror request-body fields, checked against the body they mirror (MCP 2026-07-28, Streamable
 * HTTP: "Request Metadata" and "Server Validation"). The body is the source of truth. A header exists so something
 * in front of the server can route on it without parsing the body, so a header that disagrees with the body is
 * refused before any tool runs: otherwise the intermediary and the server act on different values.
 *
 * Shared byte for byte with prism-mcp-server-py (`_headers.py`); the corpus in test/fixtures/mcp-header-mirror.json
 * holds both to the same outcomes and messages.
 */

/** The JSON-RPC error code the specification assigns to a header/body disagreement (`HeaderMismatch`). */
export const HEADER_MISMATCH = -32020;

/** A header that disagrees with the request body. Transports answer it with HTTP 400 and {@link HEADER_MISMATCH}. */
export class HeaderMismatchError extends McpError {
  constructor(message: string) {
    super('protocol_failure', `Header mismatch: ${message}`);
    this.name = 'HeaderMismatchError';
  }
}

export const REPEATED = 'a header that mirrors the request body is repeated.';
const PARAM_PREFIX = 'mcp-param-';
const SENTINEL_PREFIX = '=?base64?';
const SENTINEL_SUFFIX = '?=';
// RFC 4648 section 4 with its padding: the only spelling the specification's encoding produces.
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
// A field value is visible ASCII, space and horizontal tab (RFC 9110 section 5.5).
const FIELD_VALUE = /^[\x20-\x7E\t]*$/;
// An integer, optionally with a zero fraction ("42.0" is 42). No sign but minus, no exponent, no leading zero.
const INTEGER = /^(-?(?:0|[1-9][0-9]*))(?:\.0+)?$/;
const MAX_SAFE = 9007199254740991n;

/** Whether a header name is one this module checks: every `Mcp-*` header mirrors part of the body. */
export function isMirrorHeader(name: string): boolean {
  return name.toLowerCase().startsWith('mcp-');
}

/** Lowercased names to values. A repeated mirror header (in any casing) is refused here, before anything reads it. */
export function headerView(raw: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const view: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, value] of Object.entries(raw ?? {})) {
    const key = name.toLowerCase();
    if (Object.hasOwn(view, key)) {
      if (isMirrorHeader(key)) throw new HeaderMismatchError(REPEATED);
      continue;
    }
    view[key] = value;
  }
  return view;
}

/**
 * A field value with its optional surrounding whitespace removed, or undefined when it is not a legal plain field
 * value. Whitespace around a field value is never part of it, so a value that needs it travels in the sentinel.
 */
function fieldValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.replace(/^[ \t]+|[ \t]+$/g, '');
  return trimmed !== '' && FIELD_VALUE.test(trimmed) ? trimmed : undefined;
}

/** The value a header carries: the sentinel decoded, anything else as written. Undefined when malformed. */
function decoded(value: unknown): string | undefined {
  const field = fieldValue(value);
  if (field === undefined) return undefined;
  if (field.length < SENTINEL_PREFIX.length + SENTINEL_SUFFIX.length
    || !field.startsWith(SENTINEL_PREFIX) || !field.endsWith(SENTINEL_SUFFIX)) return field;
  const payload = field.slice(SENTINEL_PREFIX.length, field.length - SENTINEL_SUFFIX.length);
  if (!BASE64.test(payload)) return undefined;
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(Buffer.from(payload, 'base64'));
  } catch {
    return undefined;
  }
}

function checkStandard(name: string, value: string | undefined, expected: JsonValue | undefined, encoded: boolean): void {
  if (value === undefined) return;
  const actual = encoded ? decoded(value) : fieldValue(value);
  if (actual === undefined) throw new HeaderMismatchError(`the [${name}] header value is malformed.`);
  if (actual !== expected) throw new HeaderMismatchError(`the [${name}] header does not match the request body.`);
}

/**
 * `Mcp-Method`, `Mcp-Name` and, on the stateless revision, `MCP-Protocol-Version`: each must equal the body field it
 * mirrors. A header present on a request it does not apply to has nothing to agree with, so it is refused too.
 *
 * Presence is not yet required. The specification requires these three on every 2026-07-28 request, and the
 * published prism-mcp clients do not send them yet; requiring them now would refuse every one of those clients.
 */
export function checkStandardHeaders(headers: Record<string, string>, method: string, params: JsonObject, stateless: boolean): void {
  checkStandard('Mcp-Method', headers['mcp-method'], method, false);
  const name = method === 'tools/call' && typeof params.name === 'string' ? params.name : undefined;
  checkStandard('Mcp-Name', headers['mcp-name'], name, true);
  if (stateless) {
    const meta = isJsonObject(params._meta) ? params._meta : {};
    checkStandard('MCP-Protocol-Version', headers['mcp-protocol-version'],
      meta['io.modelcontextprotocol/protocolVersion'], false);
  }
  if (method !== 'tools/call' && Object.keys(headers).some((key) => key.startsWith(PARAM_PREFIX))) {
    throw new HeaderMismatchError('Mcp-Param headers apply only to tools/call.');
  }
}

/** The body value at a mirrored path; null and a path through a non-object both mean "no value". */
function bodyValue(args: JsonObject, path: readonly string[]): JsonValue | undefined {
  let value: JsonValue | undefined = args;
  for (const segment of path) {
    value = isJsonObject(value) && Object.hasOwn(value, segment) ? value[segment] : undefined;
  }
  return value === null ? undefined : value;
}

function matches(type: string, header: string, body: JsonValue): boolean {
  if (type === 'integer') {
    const match = INTEGER.exec(header);
    // A safe integer is at most 17 characters with its sign; a longer header cannot equal one and is never converted.
    return match !== null && match[1].length <= 17 && BigInt(match[1]) === BigInt(body as number);
  }
  if (type === 'boolean') return header === (body ? 'true' : 'false');
  return header === body;
}

function validBody(type: string, body: JsonValue): boolean {
  if (type === 'integer') {
    return typeof body === 'number' && Number.isInteger(body) && BigInt(body) <= MAX_SAFE && BigInt(body) >= -MAX_SAFE;
  }
  return typeof body === (type === 'boolean' ? 'boolean' : 'string');
}

/**
 * Every `Mcp-Param-*` header against the tool's `x-mcp-header` declarations and the call's own arguments.
 *
 * - A header the tool does not declare is refused. So is a header for a value the body does not carry: a header
 *   never becomes an argument, the body is the only source of the call's arguments.
 * - A header that is present is decoded (the `=?base64?...?=` sentinel) and must equal the body value. Integers
 *   compare by value, so `3.0` is `3`, exactly and without floating point.
 * - When `required`, a body value needs its header. That is the 2026-07-28 rule for a header-carrying transport; the
 *   earlier revisions define no mirrored headers, so a client speaking one of them is not asked for any.
 *
 * Returns the decoded values, by lowercased name, for the tool's context. Arguments are never modified.
 */
export function checkMirroredHeaders(mirrored: MirroredParameters, headers: Record<string, string>, args: JsonObject,
  required: boolean): Record<string, string> {
  const declared = new Set(Object.keys(mirrored.parameters).map((name) => name.toLowerCase()));
  for (const key of Object.keys(headers)) {
    if (key.startsWith(PARAM_PREFIX) && !declared.has(key.slice(PARAM_PREFIX.length))) {
      throw new HeaderMismatchError('an Mcp-Param header is not declared by this tool.');
    }
  }
  const values: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, { path, type }] of Object.entries(mirrored.parameters)) {
    const label = `Mcp-Param-${name}`;
    const key = name.toLowerCase();
    const present = Object.hasOwn(headers, PARAM_PREFIX + key);
    const body = bodyValue(args, path);
    if (body === undefined) {
      if (present) throw new HeaderMismatchError(`the [${label}] header is present but the request body has no value for it.`);
      continue;
    }
    if (!present) {
      if (required) throw new HeaderMismatchError(`the [${label}] header is required.`);
      continue;
    }
    const header = decoded(headers[PARAM_PREFIX + key]);
    if (header === undefined) throw new HeaderMismatchError(`the [${label}] header value is malformed.`);
    if (!validBody(type, body)) throw new HeaderMismatchError(`the request body value for [${label}] is not a valid ${type}.`);
    if (!matches(type, header, body)) throw new HeaderMismatchError(`the [${label}] header does not match the request body.`);
    values[key] = header;
  }
  return values;
}
