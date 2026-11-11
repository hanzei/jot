import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import swagger from '../../../server/docs/swagger.json';
// `types.ts` is read through the compiler below, not imported, so nothing else
// tells vitest's watch mode to re-run this file when it changes.
import '../types';

// `types.ts` is written by hand; `server/docs/swagger.json` is generated from
// the Go handlers and models (`task gen-docs`, kept current by `task
// check-docs`). This compares the two, so a field renamed, added or removed on
// the server, or a new error code, fails here until `types.ts` follows.
//
// It compares field names and enum values only. A changed field type, or a
// field that became optional or nullable, is not caught: the spec is too loose
// on `required` and nullability to check against.
//
// A failure means one of:
//   - the server changed: update `types.ts` (and the clients) to match;
//   - a new spec definition or exported type: add it to MAPPED, or to
//     SPEC_ONLY / TS_ONLY with the reason it has no counterpart.

/**
 * Spec definition -> the exported `types.ts` type that models it. A union type
 * is compared by the fields of all its members together, which is how the flat
 * wire format carries them. Several definitions may map to one type, which
 * must then have exactly their fields combined.
 */
const MAPPED: Record<string, string> = {
  'apierr.Code': 'ApiErrorCode',
  'apierr.ErrorDetail': 'ApiErrorDetail',
  'apierr.ErrorResponse': 'ApiErrorResponse',
  'handlers.AuthResponse': 'AuthResponse',
  'handlers.ChangePasswordRequest': 'ChangePasswordRequest',
  'handlers.ConvertNoteTypeRequest': 'ConvertNoteTypeRequest',
  // One client type serves both the bulk shape (`POST /notes` with items,
  // which has `indent_level`) and the granular one (`POST /notes/{id}/items`).
  'handlers.CreateNoteItem': 'CreateNoteItemRequest',
  'handlers.CreateNoteItemRequest': 'CreateNoteItemRequest',
  'handlers.CreateNoteRequest': 'CreateNoteRequest',
  'handlers.CreateUserRequest': 'CreateUserRequest',
  'handlers.EmptyTrashResponse': 'EmptyTrashResponse',
  'handlers.ImportResponse': 'ImportResponse',
  'handlers.LabelListResponse': 'LabelListResponse',
  'handlers.LoginRequest': 'LoginRequest',
  'handlers.NoteListResponse': 'NoteListResponse',
  'handlers.NoteShareListResponse': 'NoteShareListResponse',
  'handlers.PATListResponse': 'PATListResponse',
  'handlers.PatchNoteItemRequest': 'PatchNoteItemRequest',
  'handlers.RegisterRequest': 'RegisterRequest',
  'handlers.ReorderNoteItemsRequest': 'ReorderNoteItemsRequest',
  'handlers.SessionListResponse': 'SessionListResponse',
  'handlers.SessionResponse': 'ActiveSession',
  'handlers.SetPublicLinkRequest': 'SetPublicLinkRequest',
  'handlers.SetUserPasswordRequest': 'SetUserPasswordRequest',
  'handlers.ShareNoteRequest': 'ShareNoteRequest',
  'handlers.UpdateNoteRequest': 'UpdateNoteRequest',
  'handlers.UpdateUserRequest': 'UpdateMeRequest',
  'handlers.UpdateUserRoleRequest': 'UpdateUserRoleRequest',
  'handlers.UserListResponse': 'UserListResponse',
  'handlers.UserSearchResponse': 'UserSearchResponse',
  'handlers.createPATRequest': 'CreatePATRequest',
  'handlers.patResponse': 'PersonalAccessToken',
  'models.AdminLabelStats': 'AdminLabelStats',
  'models.AdminListItemStats': 'AdminListItemStats',
  'models.AdminNoteStats': 'AdminNoteStats',
  'models.AdminRuntimeStats': 'AdminRuntimeStats',
  'models.AdminSharingStats': 'AdminSharingStats',
  'models.AdminStats': 'AdminStatsResponse',
  'models.AdminStorageStats': 'AdminStorageStats',
  'models.AdminUploadVolumeStats': 'AdminUploadVolumeStats',
  'models.AdminUserStats': 'AdminUserStats',
  'models.Label': 'Label',
  'models.LabelWithCount': 'LabelWithCount',
  'models.Note': 'Note',
  'models.NoteImage': 'NoteImage',
  'models.NoteItem': 'NoteItem',
  'models.NoteShare': 'NoteShare',
  'models.NoteType': 'NoteType',
  'models.NoteUnread': 'NoteUnread',
  'models.PublicLink': 'PublicLink',
  'models.PublicNote': 'PublicNote',
  'models.PublicNoteImage': 'PublicNoteImage',
  'models.PublicNoteItem': 'PublicNoteItem',
  'models.User': 'User',
  'models.UserSettings': 'UserSettings',
  'server.aboutResponse': 'AboutInfo',
  'server.configResponse': 'ServerConfig',
  'server.ssoConfig': 'SSOConfig',
};

const INLINE_BODY = 'request body built inline in shared/src/api/jotApi.ts';

/** Spec definitions `types.ts` has no type for, and why. */
const SPEC_ONLY: Record<string, string> = {
  'handlers.AddLabelRequest': INLINE_BODY,
  'handlers.DeleteNoteItemsRequest': INLINE_BODY,
  'handlers.DuplicateNoteRequest': INLINE_BODY,
  'handlers.RenameLabelRequest': INLINE_BODY,
  'handlers.ReorderNotesRequest': INLINE_BODY,
  'handlers.SetNoteItemsCompletedRequest': INLINE_BODY,
  'handlers.NativeExchangeRequest': 'mobile-only OIDC exchange; body built inline in mobile/src/api/client.ts',
  'handlers.MarkNoteViewedRequest': 'optional body; no client sends it',
  'handlers.DeleteUserNotesResponse': 'admin note purge; only jotctl calls it',
  'handlers.UserInfo': 'the items of GET /users, which types.ts types as the fuller User',
};

const UNION_MEMBER = 'member of a union that is compared as a whole';
const SSE = 'SSE event payload; the spec does not describe the event stream';

/** Exported types the spec has no definition for, and why. */
const TS_ONLY: Record<string, string> = {
  TextNote: UNION_MEMBER,
  ListNote: UNION_MEMBER,
  PublicTextNote: UNION_MEMBER,
  PublicListNote: UNION_MEMBER,
  CreateTextNoteRequest: UNION_MEMBER,
  CreateListNoteRequest: UNION_MEMBER,
  UpdateTextNoteRequest: UNION_MEMBER,
  UpdateListNoteRequest: UNION_MEMBER,
  NoteSSEEvent: SSE,
  LabelsChangedSSEEvent: SSE,
  ProfileIconSSEEvent: SSE,
  NoteImageSSEEvent: SSE,
  SSEEvent: SSE,
  UserRole: 'the spec types role fields as a plain string',
  ThemePreference: 'an inline enum in the spec; compared through the fields that use it',
  NoteSort: 'an inline enum in the spec; compared through the fields that use it',
  GetNotesParams: 'query parameters, not a definition',
  ExportFormat: 'a query parameter value, not a definition',
  FileImportType: 'a multipart form field value, not a definition',
  DiagnosticsCrash: 'client-side diagnostics report; never sent to the API',
};

interface SpecProperty {
  type?: string;
  enum?: string[];
  $ref?: string;
  allOf?: { $ref?: string }[];
}

interface SpecDefinition {
  type?: string;
  enum?: string[];
  properties?: Record<string, SpecProperty>;
}

// Cast rather than assigned: the JSON's inferred type follows every generated
// property, so one these interfaces do not describe (a numeric enum, a property
// with nothing but a description) would fail `tsc` instead of a test here, and
// check-changed.sh runs only the tests when the spec alone changed.
const definitions = swagger.definitions as unknown as Record<string, SpecDefinition>;

/** The values a spec property is limited to, given inline or through a `$ref` to an enum definition. */
function specEnum(property: SpecProperty): string[] | undefined {
  if (property.enum) return property.enum;
  const ref = property.$ref ?? property.allOf?.[0]?.$ref;
  return ref ? definitions[ref.replace('#/definitions/', '')]?.enum : undefined;
}

// This file is shared/src/__tests__/apiSpec.test.ts. vitest's own path for it
// is used because shared/ has neither Node's types nor a DOM `URL` to turn
// `import.meta.url` into one.
const typesPath = ts.sys.resolvePath(`${expect.getState().testPath}/../../types.ts`);
const program = ts.createProgram([typesPath], { strict: true, noEmit: true, lib: ['lib.es2020.d.ts'], types: [] });
const checker = program.getTypeChecker();
const typesModule = checker.getSymbolAtLocation(program.getSourceFile(typesPath)!)!;
const exported = new Map(
  checker.getExportsOfModule(typesModule).map(symbol => [symbol.name, checker.getDeclaredTypeOfSymbol(symbol)]),
);

const unionMembers = (type: ts.Type): ts.Type[] => (type.isUnion() ? type.types : [type]);

const sorted = (values: Iterable<string>): string[] => [...values].sort();

function fieldNames(type: ts.Type): string[] {
  const names = unionMembers(type).flatMap(member => checker.getPropertiesOfType(member).map(property => property.name));
  return sorted(new Set(names));
}

/** The string literals a type is limited to, ignoring null and undefined; undefined for any other type. */
function literals(type: ts.Type): string[] | undefined {
  const values = new Set<string>();
  for (const member of unionMembers(type)) {
    if (member.flags & (ts.TypeFlags.Null | ts.TypeFlags.Undefined)) continue;
    if (!member.isStringLiteral()) return undefined;
    values.add(member.value);
  }
  return values.size > 0 ? sorted(values) : undefined;
}

/** `literals` for one field, across every union member that has it. */
function fieldLiterals(type: ts.Type, field: string): string[] | undefined {
  const values = new Set<string>();
  for (const member of unionMembers(type)) {
    const property = member.getProperty(field);
    if (!property) continue;
    const memberValues = literals(checker.getTypeOfSymbol(property));
    if (!memberValues) return undefined;
    for (const value of memberValues) values.add(value);
  }
  return values.size > 0 ? sorted(values) : undefined;
}

/** `types.ts` type name -> the spec definitions mapped to it. */
const mappedTypes = new Map<string, string[]>();
for (const [definition, typeName] of Object.entries(MAPPED)) {
  mappedTypes.set(typeName, [...(mappedTypes.get(typeName) ?? []), definition]);
}

describe('types.ts against the generated API spec', () => {
  it('reads both sides', () => {
    expect(Object.keys(definitions).length).toBeGreaterThan(0);
    expect(exported.size).toBeGreaterThan(0);
  });

  it('maps every spec definition or lists it in SPEC_ONLY', () => {
    const accounted = [...Object.keys(MAPPED), ...Object.keys(SPEC_ONLY)];
    // Sorted and compared whole, so the diff names what is new (in the spec
    // only), what is gone (in the tables only) and what is listed twice.
    expect(sorted(accounted)).toEqual(sorted(Object.keys(definitions)));
  });

  it('maps every exported type or lists it in TS_ONLY', () => {
    const accounted = [...mappedTypes.keys(), ...Object.keys(TS_ONLY)];
    expect(sorted(accounted)).toEqual(sorted(exported.keys()));
  });

  it.each([...mappedTypes])('%s matches %j', (typeName, definitionNames) => {
    const type = exported.get(typeName);
    if (!type) throw new Error(`types.ts does not export ${typeName}`);
    const specs = definitionNames.map(name => {
      const definition = definitions[name];
      if (!definition) throw new Error(`the spec has no definition ${name}`);
      return definition;
    });

    const specValues = specs.flatMap(spec => spec.enum ?? []);
    if (specValues.length > 0) {
      expect(literals(type)).toEqual(sorted(specValues));
      return;
    }

    const specFields = specs.flatMap(spec => Object.entries(spec.properties ?? {}));
    expect(fieldNames(type)).toEqual(sorted(new Set(specFields.map(([field]) => field))));

    // Enum values are compared where both sides enumerate them. A field the
    // client deliberately keeps wider than the server (`language` is a plain
    // string) is left alone, as is one the spec types as a plain string.
    for (const [field, property] of specFields) {
      const specFieldValues = specEnum(property);
      const typeFieldValues = fieldLiterals(type, field);
      if (specFieldValues && typeFieldValues) {
        expect(typeFieldValues, `${typeName}.${field}`).toEqual(sorted(specFieldValues));
      }
    }
  });
});
