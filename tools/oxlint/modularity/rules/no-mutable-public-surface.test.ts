import { RuleTester } from "oxlint/plugins-dev"

import { noMutablePublicSurfaceRule } from "./no-mutable-public-surface.ts"

const tester = new RuleTester({ languageOptions: { parserOptions: { lang: "ts" } } })
const mutableExport = { messageId: "mutableExport" }
const mutableMember = { messageId: "mutableMember" }
const mutableField = { messageId: "mutableField" }
const mutableCollection = { messageId: "mutableCollection" }

const ENTRY = "src/caller/index.ts"
const PRIVATE = "src/caller/private/store.ts"
const OTHER_ENTRY = "src/authority/index.ts"
const PRODUCTS_ENTRY = "src/products/index.ts"

tester.run("modularity/no-mutable-public-surface", noMutablePublicSurfaceRule, {
  valid: [
    // Private implementation files are free to use mutable internals.
    { code: "export let counter = 0;", filename: PRIVATE },
    { code: "export interface State { count: number }", filename: PRIVATE },
    { code: "export type Bag = { items: Array<string> }", filename: PRIVATE },
    // Non-entry files outside src/ never participate.
    { code: "export let counter = 0;", filename: "tools/build.ts" },
    // Immutable exports are the required shape.
    { code: "export const limit = 10;", filename: ENTRY },
    { code: "export interface Caller { readonly id: string }", filename: ENTRY },
    {
      code: "export interface Caller { readonly id: string; readonly tags?: ReadonlyArray<string> }",
      filename: ENTRY,
    },
    { code: "export type Row = { readonly cells: readonly string[] }", filename: ENTRY },
    { code: "export type Row = { readonly cells: ReadonlyArray<string> }", filename: ENTRY },
    {
      code: "export interface Store { readonly lookup: ReadonlyMap<string, number>; readonly tags: ReadonlySet<string> }",
      filename: ENTRY,
    },
    { code: "export interface Store { readonly [key: string]: number }", filename: ENTRY },
    { code: "export type Dict = { readonly [key: string]: string }", filename: ENTRY },
    // Schema.TaggedError-style classes: no mutable declared properties.
    {
      code: "export class Denied extends Schema.TaggedError<Denied>()('Denied', {}) {}",
      filename: ENTRY,
    },
    {
      code: "export class Service { private inner: number; readonly id: string }",
      filename: ENTRY,
    },
    { code: "export class Service { #hidden: number; readonly id: string }", filename: ENTRY },
    // Unexported declarations are internal to the entry file.
    { code: "let scratch = 0; export const value = scratch;", filename: ENTRY },
    {
      code: "interface Internal { count: number } export const x: Internal = { count: 0 };",
      filename: ENTRY,
    },
    // Function bodies and local variables are implementation, not surface.
    {
      code: "export function collect(): ReadonlyArray<string> { const acc: Array<string> = []; acc.push('x'); return acc; }",
      filename: ENTRY,
    },
    {
      code: "export const collect = (): ReadonlyArray<string> => { const acc: Array<string> = []; const seen = new Map<string, number>(); return acc; };",
      filename: ENTRY,
    },
    {
      code: "export const collect = function () { const bag: Set<string> = new Set(); return bag.size; };",
      filename: ENTRY,
    },
    // Readonly signatures on exported functions.
    {
      code: "export function sort(input: ReadonlyArray<string>): ReadonlyArray<string> { return input; }",
      filename: ENTRY,
    },
    {
      code: "export declare function sort(input: readonly string[]): readonly string[];",
      filename: ENTRY,
    },
    // Method signatures with readonly types.
    {
      code: "export interface Api { readonly run: (input: ReadonlyArray<string>) => ReadonlyMap<string, number> }",
      filename: ENTRY,
    },
    {
      code: "export interface Api { run(input: ReadonlyArray<string>): readonly string[] }",
      filename: ENTRY,
    },
    // Products entry is still a module entry and follows the same rules —
    // this case simply has nothing mutable in it.
    {
      code: "export interface Boot { readonly env: Readonly<Record<string, string>> }",
      filename: PRODUCTS_ENTRY,
    },
    // Deep readonly nesting.
    {
      code: "export type Config = { readonly servers: readonly { readonly host: string }[] }",
      filename: OTHER_ENTRY,
    },
    { code: "export interface Box<T> { readonly values: ReadonlyArray<T> }", filename: ENTRY },
  ],
  invalid: [
    // Mutable exported bindings.
    { code: "export let counter = 0;", filename: ENTRY, errors: [mutableExport] },
    { code: "export var counter = 0;", filename: ENTRY, errors: [mutableExport] },
    { code: "export let a = 1, b = 2;", filename: ENTRY, errors: [mutableExport] },
    // Mutable interface members.
    {
      code: "export interface Caller { id: string }",
      filename: ENTRY,
      errors: [mutableMember],
    },
    {
      code: "export interface Caller { readonly id: string; score: number }",
      filename: ENTRY,
      errors: [mutableMember],
    },
    {
      code: "export interface Store { [key: string]: number }",
      filename: ENTRY,
      errors: [mutableMember],
    },
    {
      code: "export type Row = { cells: ReadonlyArray<string> }",
      filename: ENTRY,
      errors: [mutableMember],
    },
    {
      code: "export type Row = { readonly id: string; nested: { count: number } }",
      filename: ENTRY,
      errors: [mutableMember, mutableMember],
    },
    // Mutable collection types in exported type positions.
    {
      code: "export interface Bag { readonly items: Array<string> }",
      filename: ENTRY,
      errors: [mutableCollection],
    },
    {
      code: "export interface Bag { readonly items: string[] }",
      filename: ENTRY,
      errors: [mutableCollection],
    },
    {
      code: "export type Bag = { readonly items: Map<string, number> }",
      filename: ENTRY,
      errors: [mutableCollection],
    },
    {
      code: "export type Bag = { readonly items: Set<string> }",
      filename: ENTRY,
      errors: [mutableCollection],
    },
    {
      code: "export type Bag = { readonly items: WeakMap<object, number> }",
      filename: ENTRY,
      errors: [mutableCollection],
    },
    {
      code: "export type Bag = { readonly items: WeakSet<object> }",
      filename: ENTRY,
      errors: [mutableCollection],
    },
    {
      code: "export function sort(input: Array<string>): Array<string> { return input; }",
      filename: ENTRY,
      errors: [mutableCollection, mutableCollection],
    },
    {
      code: "export const sort = (input: string[]): string[] => input;",
      filename: ENTRY,
      errors: [mutableCollection, mutableCollection],
    },
    {
      code: "export interface Api { run(input: Array<string>): Map<string, number> }",
      filename: ENTRY,
      errors: [mutableCollection, mutableCollection],
    },
    // Mutable class fields.
    {
      code: "export class Service { state: number }",
      filename: ENTRY,
      errors: [mutableField],
    },
    {
      code: "export class Service { public state: number }",
      filename: ENTRY,
      errors: [mutableField],
    },
    {
      code: "export class Service { readonly id: string; cache: Map<string, number> }",
      filename: ENTRY,
      errors: [mutableField, mutableCollection],
    },
    // Mutable collections in public method signatures of exported classes.
    {
      code: "export class Service { run(input: Array<string>): ReadonlyArray<string> { return input; } }",
      filename: ENTRY,
      errors: [mutableCollection],
    },
    // Exported variable with mutable collection annotation.
    {
      code: "export const registry: Map<string, number> = new Map();",
      filename: ENTRY,
      errors: [mutableCollection],
    },
    {
      code: "export const registry: Array<string> = [];",
      filename: ENTRY,
      errors: [mutableCollection],
    },
    // Same violations in other module entries are caught too.
    {
      code: "export let counter = 0;",
      filename: PRODUCTS_ENTRY,
      errors: [mutableExport],
    },
    {
      code: "export interface Boot { env: Record<string, string> }",
      filename: OTHER_ENTRY,
      errors: [mutableMember],
    },
  ],
})
